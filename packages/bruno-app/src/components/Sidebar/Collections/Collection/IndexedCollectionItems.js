import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import classnames from 'classnames';
import {
  IconChevronRight,
  IconClipboard,
  IconClock,
  IconCode,
  IconCopy,
  IconDots,
  IconEdit,
  IconFileExport,
  IconFileImport,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconInfoCircle,
  IconPlayerPlay,
  IconSettings,
  IconSortAZ,
  IconSortZA,
  IconTerminal2,
  IconTrash
} from '@tabler/icons';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { getEmptyImage } from 'react-dnd-html5-backend';
import { useDrag, useDrop } from 'react-dnd';
import { addTab, focusTab, makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import { addResponseExample, collectionIndexNodeActivated, collectionIndexNodesResequenced } from 'providers/ReduxStore/slices/collections';
import {
  cloneCollectionItemByPath,
  deleteCollectionItemByPath,
  loadRequest,
  moveCollectionItemByPath,
  newFolderByPath,
  pasteItem,
  renameCollectionItemByPath,
  saveRequest,
  sendRequest,
  showInFolder,
  updateItemsSequences
} from 'providers/ReduxStore/slices/collections/actions';
import { clearSidebarReveal, copyRequest, insertTaskIntoQueue, setFocusedSidebarPath } from 'providers/ReduxStore/slices/app';
import useKeybinding from 'hooks/useKeybinding';
import SearchHighlight from '../SearchHighlight';
import CollectionItemIcon from './CollectionItem/CollectionItemIcon';
import StyledWrapper from './CollectionItem/StyledWrapper';
import RenameCollectionItem from './CollectionItem/RenameCollectionItem';
import CloneCollectionItem from './CollectionItem/CloneCollectionItem';
import DeleteCollectionItem from './CollectionItem/DeleteCollectionItem';
import RunCollectionItem from './CollectionItem/RunCollectionItem';
import GenerateCodeItem from './CollectionItem/GenerateCodeItem';
import CollectionItemInfo from './CollectionItem/CollectionItemInfo';
import ExportFolder from './CollectionItem/ExportFolder';
import ImportIntoFolder from './ImportIntoFolder';
import { getDefaultRequestPaneTab, getInitialExampleName } from 'utils/collections';
import { findItemInCollection, findItemInCollectionByPathname, normalizeItemPathname } from 'utils/collections';
import { excludeDescendantItems } from 'utils/collections/multiSelect';
import { uuid } from 'utils/common';
import { foldSearchText } from '@usebruno/common';
import { sortByNameThenSequence } from 'utils/common/index';
import { scrollToTheActiveTab, doesTabMatchRequestNode } from 'utils/tabs';
import ExampleItem from './CollectionItem/ExampleItem';
import ExampleIcon from 'components/Icons/ExampleIcon';
import NetworkError from 'components/ResponsePane/NetworkError/index';
import { isEqual } from 'lodash';
import NewRequest from 'components/Sidebar/NewRequest';
import NewFolder from 'components/Sidebar/NewFolder';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import toast from 'react-hot-toast';
import { getRevealInFolderLabel } from 'utils/common/platform';
import { openDevtoolsAndSwitchToTerminal } from 'utils/terminal';
import { useSidebarAccordion } from 'components/Sidebar/SidebarAccordionContext';

const ROW_HEIGHT = 28;
const MAX_LIST_HEIGHT = 520;

const sortNodes = (nodes = []) => {
  // Match the classic renderer's ordering: folders first using
  // sortByNameThenSequence semantics, then requests by sequence.
  const folders = nodes.filter((node) => node.type === 'folder');
  const requests = nodes.filter((node) => node.type !== 'folder');

  const sortedRequests = [...requests].sort((a, b) => {
    const aSeq = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) {
      return aSeq - bSeq;
    }

    return (a.name || '').localeCompare(b.name || '');
  });

  return [...sortByNameThenSequence(folders), ...sortedRequests];
};

const nodeMatchesSearch = (node, searchText) => {
  if (!searchText) {
    return true;
  }

  const text = foldSearchText(searchText);
  return [node.name, node.method, node.url, node.pathname]
    .filter(Boolean)
    .some((value) => foldSearchText(value).includes(text));
};

const normalizeRequestType = (type) => {
  const normalizedType = String(type || '').toLowerCase();
  const typeMap = {
    http: 'http-request',
    graphql: 'graphql-request',
    grpc: 'grpc-request',
    ws: 'ws-request',
    websocket: 'ws-request'
  };

  return typeMap[normalizedType] || normalizedType || 'http-request';
};

const getIndexedNodeChain = (index, node) => {
  const nodesByUid = index?.nodesByUid || {};
  const chain = [];
  let current = node;
  const seen = new Set();

  while (current?.uid && !seen.has(current.uid)) {
    seen.add(current.uid);
    chain.unshift(current);
    current = current.parentUid ? nodesByUid[current.parentUid] : null;
  }

  return chain;
};

const getIndexedNodeDisplayDepth = (index, node) => {
  const chain = getIndexedNodeChain(index, node);
  if (chain.length) {
    return chain.length;
  }

  return Math.max(0, (node.depth || 0) + 1);
};

const normalizeForPathCompare = (pathname) => String(pathname || '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '');

const getIndexedRequestTabUid = ({ collectionUid, pathname, uid }) => {
  return `indexed-request:${collectionUid}:${pathname || uid}`;
};

const isSameOrDescendantPath = (targetPathname, sourcePathname) => {
  const target = normalizeForPathCompare(targetPathname);
  const source = normalizeForPathCompare(sourcePathname);
  return target === source || target.startsWith(`${source}/`);
};

// Sort a parent's children (folders first, then requests) by the chosen mode
// and persist the new sequence. Shared by the folder context menu (parentKey =
// folder node uid) and the collection root context menu (parentKey = 'root').
// Computed from index nodes; 'created' additionally fetches filesystem
// birthtimes since the format has no created field.
export const SORT_LABELS = {
  'name-asc': 'Sorted A→Z',
  'name-desc': 'Sorted Z→A',
  'created-asc': 'Sorted by created'
};

export const sortIndexedChildren = async ({ store, dispatch, collectionUid, parentKey, mode = 'name-asc' }) => {
  const freshIndex = store.getState().collections.collectionIndexes?.[collectionUid];
  const childUids = freshIndex?.childrenByParentUid?.[parentKey] || [];
  const children = childUids.map((uid) => freshIndex.nodesByUid[uid]).filter(Boolean);
  if (!children.length) {
    return;
  }

  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  let comparator;
  if (mode === 'name-desc') {
    comparator = (a, b) => byName(b, a);
  } else if (mode === 'created-asc') {
    let createdTimes = {};
    try {
      createdTimes = await window.ipcRenderer.invoke(
        'renderer:get-items-created-times',
        children.map((n) => n.pathname)
      ) || {};
    } catch (error) {
      toast.error(error?.message || 'Unable to read creation times');
      return;
    }
    comparator = (a, b) => (createdTimes[a.pathname] || 0) - (createdTimes[b.pathname] || 0) || byName(a, b);
  } else {
    comparator = byName;
  }

  const ordered = [
    ...children.filter((n) => n.type === 'folder').sort(comparator),
    ...children.filter((n) => n.type !== 'folder').sort(comparator)
  ];

  const itemsToResequence = ordered.map((candidate, position) => ({
    pathname: candidate.pathname,
    type: candidate.type === 'folder' ? 'folder' : normalizeRequestType(candidate.type),
    seq: position + 1
  }));

  try {
    dispatch(collectionIndexNodesResequenced({ collectionUid, itemsToResequence }));
    await dispatch(updateItemsSequences({ itemsToResequence, collectionUid }));
    toast.success(SORT_LABELS[mode] || 'Sorted');
  } catch (error) {
    toast.error(error?.message || 'Unable to sort items');
  }
};

const useVisibleRows = ({ index, expandedNodeUids, searchText }) => {
  return useMemo(() => {
    if (!index?.nodesByUid) {
      return [];
    }

    const nodesByUid = index.nodesByUid;
    const childrenByParentUid = index.childrenByParentUid || {};
    const trimmedSearchText = searchText?.trim();

    if (trimmedSearchText) {
      // Build a filtered tree rather than a flat list so a matched folder shows
      // its children (and the path to a matched request stays visible).
      const matched = new Set(
        Object.values(nodesByUid).filter((node) => nodeMatchesSearch(node, trimmedSearchText)).map((node) => node.uid)
      );
      if (!matched.size) {
        return [];
      }

      const included = new Set();
      const includeAncestors = (uid) => {
        let node = nodesByUid[uid];
        while (node && !included.has(node.uid)) {
          included.add(node.uid);
          node = node.parentUid ? nodesByUid[node.parentUid] : null;
        }
      };
      const includeSubtree = (uid) => {
        const stack = [uid];
        while (stack.length) {
          const current = stack.pop();
          included.add(current);
          for (const childUid of childrenByParentUid[current] || []) {
            stack.push(childUid);
          }
        }
      };
      for (const uid of matched) {
        includeAncestors(uid);
        if (nodesByUid[uid]?.type === 'folder') {
          includeSubtree(uid);
        }
      }

      const searchRows = [];
      const walkFiltered = (parentUid) => {
        const children = sortNodes(
          (childrenByParentUid[parentUid || 'root'] || [])
            .map((uid) => nodesByUid[uid])
            .filter((node) => node && included.has(node.uid))
        );
        for (const child of children) {
          searchRows.push(child);
          if (child.type === 'folder') {
            walkFiltered(child.uid);
          }
        }
      };
      walkFiltered(null);
      return searchRows;
    }

    const rows = [];
    const walk = (parentUid) => {
      const children = sortNodes((childrenByParentUid[parentUid || 'root'] || []).map((uid) => nodesByUid[uid]).filter(Boolean));
      for (const child of children) {
        rows.push(child);
        if (child.type === 'folder' && expandedNodeUids.has(child.uid)) {
          walk(child.uid);
        }
      }
    };

    walk(null);
    return rows;
  }, [index, expandedNodeUids, searchText]);
};

// Rendered only while a row's examples are expanded, so the full-collection
// subscription (needed by ExampleItem) stays out of the hot row render path.
const IndexedRowExamples = ({ collectionUid, item }) => {
  const collection = useSelector((state) => state.collections.collections?.find((c) => c.uid === collectionUid), isEqual);

  return (
    <div>
      {(item.examples || []).map((example, exampleIndex) => (
        <ExampleItem
          key={example.uid || exampleIndex}
          example={example}
          item={item}
          index={exampleIndex}
          collection={collection}
        />
      ))}
    </div>
  );
};

const IndexedRow = React.memo(({ node, collectionUid, searchText, expandedNodeUids, onToggleFolder, multiSelect }) => {
  const dispatch = useDispatch();
  const store = useStore();
  const { dropdownContainerRef } = useSidebarAccordion();
  const rowRef = useRef(null);
  const menuDropdownRef = useRef(null);
  const isRequest = node.type !== 'folder';
  const isFolder = !isRequest;
  // During search the filtered tree is always shown fully expanded.
  const isExpanded = (searchText && searchText.trim()) ? true : expandedNodeUids.has(node.uid);
  const [renameItemModalOpen, setRenameItemModalOpen] = useState(false);
  const [examplesExpanded, setExamplesExpanded] = useState(false);
  const [cloneItemModalOpen, setCloneItemModalOpen] = useState(false);
  const [deleteItemModalOpen, setDeleteItemModalOpen] = useState(false);
  const [newRequestModalOpen, setNewRequestModalOpen] = useState(false);
  const [newFolderModalOpen, setNewFolderModalOpen] = useState(false);
  const [runCollectionModalOpen, setRunCollectionModalOpen] = useState(false);
  const [generateCodeItemModalOpen, setGenerateCodeItemModalOpen] = useState(false);
  const [itemInfoModalOpen, setItemInfoModalOpen] = useState(false);
  const [exportFolderModalOpen, setExportFolderModalOpen] = useState(false);
  const [importIntoFolderModalOpen, setImportIntoFolderModalOpen] = useState(false);
  const [dropType, setDropType] = useState(null);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);

  // Sidebar shortcuts — only active while this row has keyboard focus.
  // Bound per-row (rows are virtualized, so only visible rows hold bindings),
  // mirroring the classic renderer's CollectionItem.
  useKeybinding('cloneItem', () => {
    setCloneItemModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('copyItem', () => {
    handleCopyItem();
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('pasteItem', () => {
    handlePasteItem();
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('renameItem', () => {
    setRenameItemModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('deleteItem', () => {
    setDeleteItemModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  const handleRowFocus = () => {
    setIsKeyboardFocused(true);
    dispatch(setFocusedSidebarPath(node.pathname));
  };

  const handleRowBlur = () => {
    setIsKeyboardFocused(false);
    dispatch(setFocusedSidebarPath(null));
  };

  const existingRequestTab = useSelector((state) => {
    if (!isRequest) {
      return null;
    }

    return state.tabs.tabs.find((tab) => doesTabMatchRequestNode(tab, {
      collectionUid,
      pathname: node.pathname,
      uid: node.uid
    })) || null;
  }, isEqual);
  const isTabForItemPresent = Boolean(existingRequestTab);
  const activeTabUid = useSelector((state) => state.tabs.activeTabUid);
  const isActiveTabRow = Boolean(existingRequestTab && existingRequestTab.uid === activeTabUid);
  const sidebarReveal = useSelector((state) => state.app.sidebarReveal);
  const [revealFlash, setRevealFlash] = useState(false);
  useEffect(() => {
    if (!sidebarReveal || sidebarReveal.collectionUid !== collectionUid) {
      return;
    }
    if (normalizeForPathCompare(sidebarReveal.pathname) !== normalizeForPathCompare(node.pathname)) {
      return;
    }
    setRevealFlash(true);
    const timer = setTimeout(() => setRevealFlash(false), 1800);
    return () => clearTimeout(timer);
  }, [sidebarReveal?.nonce]);
  const { hasCopiedItems } = useSelector((state) => state.app.clipboard);
  const index = useSelector((state) => state.collections.collectionIndexes?.[collectionUid]);
  // Subscribe to primitives/O(1) lookups only. The old selectors deep-compared
  // the whole collection and flattened the hydrated tree per visible row on
  // every store action — the main renderer cost while typing or streaming a
  // response with a large collection open.
  const collectionPathname = useSelector(
    (state) => state.collections.collections?.find((c) => c.uid === collectionUid)?.pathname
  );
  // Requests resolve O(1) from loadedRequestsByPath — the same store the
  // request panel renders from, kept consistent on load/change/move/unlink.
  const loadedEntry = useSelector((state) => (
    isRequest
      ? state.collections.loadedRequestsByPath?.[collectionUid]?.[normalizeItemPathname(node.pathname)] || null
      : null
  ));
  // Folders need the hydrated tree item (children for folder Run); recompute
  // the tree walk only when the collection's items reference changes.
  const collectionItems = useSelector((state) => (
    isFolder ? state.collections.collections?.find((c) => c.uid === collectionUid)?.items : null
  ));
  const folderItem = useMemo(
    () => (collectionItems ? findItemInCollectionByPathname({ items: collectionItems }, node.pathname) : null),
    [collectionItems, node.pathname]
  );
  const item = isRequest ? loadedEntry : folderItem;
  const displayItem = item || {
    ...node,
    type: normalizeRequestType(node.type),
    partial: false,
    loading: false,
    error: false,
    gridmanIndexOnly: true,
    request: {
      gridmanIndexOnly: true,
      method: node.method || '',
      url: node.url || ''
    }
  };
  const getActionCompatibleItem = () => {
    const hydratedItem = item || displayItem;

    return {
      ...hydratedItem,
      ...node,
      type: isFolder ? 'folder' : normalizeRequestType(hydratedItem.type || node.type),
      items: isFolder ? (hydratedItem.items || []) : undefined,
      request: isFolder ? undefined : (hydratedItem.request || displayItem.request)
    };
  };
  const actionItem = getActionCompatibleItem();
  const displayDepth = getIndexedNodeDisplayDepth(index, node);
  // Show the examples chevron from the index's exampleCount even before the
  // request is hydrated, so large (lazy) collections still indicate examples.
  const hasExamples = isRequest
    && normalizeRequestType(node.type) === 'http-request'
    && (Boolean(item?.examples?.length) || (node.exampleCount || 0) > 0);

  const openRequest = () => {
    // The request panel renders indexed tabs from loadedRequestsByPath, so a
    // hydrated sidebar item alone is not enough to skip loading — after a
    // move/clone the tree can be hydrated while the loaded entry is gone.
    const loadedEntry = store.getState().collections.loadedRequestsByPath?.[collectionUid]?.[
      normalizeItemPathname(node.pathname)
    ];
    const shouldLoadRequest = !existingRequestTab
      || !loadedEntry
      || !item
      || item.loading
      || item.partial
      || item.gridmanIndexOnly
      || !item.request
      || item.request?.gridmanIndexOnly;
    const tabUid = getIndexedRequestTabUid({ collectionUid, pathname: node.pathname, uid: node.uid });

    dispatch(collectionIndexNodeActivated({ collectionUid, node }));

    if (existingRequestTab) {
      dispatch(focusTab({ uid: existingRequestTab.uid }));
    } else {
      dispatch(
        addTab({
          uid: tabUid,
          collectionUid,
          requestPaneTab: getDefaultRequestPaneTab(node),
          type: 'request',
          itemUid: node.uid,
          itemPathname: node.pathname
        })
      );
    }

    if (shouldLoadRequest) {
      dispatch(loadRequest({ collectionUid, pathname: node.pathname }));
    }
  };

  const activateNodeChain = (targetNode = node) => {
    const chain = getIndexedNodeChain(index, targetNode);
    for (const chainNode of chain) {
      dispatch(collectionIndexNodeActivated({ collectionUid, node: chainNode }));
    }
  };

  const ensureNodeHydrated = () => {
    activateNodeChain(node);
    return getActionCompatibleItem();
  };

  const isItemRequestReady = (candidate) => Boolean(
    candidate?.request
    && !candidate.partial
    && !candidate.loading
    && !candidate.gridmanIndexOnly
    && !candidate.request?.gridmanIndexOnly
  );

  const getFreshTreeItem = (pathname = node.pathname) => {
    const collections = store.getState().collections.collections;
    const freshCollection = collections?.find((c) => c.uid === collectionUid);
    return freshCollection ? findItemInCollectionByPathname(freshCollection, pathname) : null;
  };

  // Load the request file from disk if needed and return the hydrated tree item.
  const hydrateRequestItem = async () => {
    activateNodeChain(node);
    const treeItem = getFreshTreeItem();
    if (isItemRequestReady(treeItem)) {
      return treeItem;
    }

    await dispatch(loadRequest({ collectionUid, pathname: node.pathname }));
    return getFreshTreeItem();
  };

  const handleRunRequest = async () => {
    try {
      const runItem = await hydrateRequestItem();
      if (!runItem) {
        toast.error('Unable to load request');
        return;
      }

      dispatch(sendRequest(runItem, collectionUid)).catch(() =>
        toast.custom((t) => <NetworkError onClose={() => toast.dismiss(t.id)} />, {
          duration: 5000
        }));
    } catch (error) {
      toast.error(error?.message || 'Unable to run request');
    }
  };

  // Create the example immediately (Postman-style, no modal): the name
  // defaults to the request name with a unique suffix on collision, and the
  // example opens in a tab where it can be renamed.
  const handleCreateExampleClick = async () => {
    try {
      const treeItem = await hydrateRequestItem();
      if (!treeItem) {
        toast.error('Unable to load request');
        return;
      }
      await handleCreateExample(getInitialExampleName(treeItem));
    } catch (error) {
      toast.error(error?.message || 'Unable to load request');
    }
  };

  const handleCreateExample = async (name, description = '') => {
    const treeItem = getFreshTreeItem();
    if (!treeItem) {
      toast.error('Unable to locate request');
      return;
    }

    const exampleData = {
      name,
      description,
      status: 200,
      statusText: 'OK',
      headers: [],
      body: {
        type: 'text',
        content: ''
      }
    };

    const existingExamples = treeItem.draft?.examples || treeItem.examples || [];
    const exampleIndex = existingExamples.length;
    const exampleUid = uuid();

    dispatch(addResponseExample({
      itemUid: treeItem.uid,
      collectionUid,
      example: {
        ...exampleData,
        uid: exampleUid
      }
    }));

    await dispatch(saveRequest(treeItem.uid, collectionUid, true));

    // Task middleware opens the example in a new tab once the file reloads
    dispatch(insertTaskIntoQueue({
      uid: exampleUid,
      type: 'OPEN_EXAMPLE',
      collectionUid,
      itemUid: treeItem.uid,
      exampleIndex
    }));

    toast.success(`Example "${name}" created successfully`);
  };

  // The collection runner executes the request objects the renderer sends,
  // so every request under the folder must be hydrated before running.
  const hydrateFolderSubtree = async () => {
    const freshIndex = store.getState().collections.collectionIndexes?.[collectionUid];
    const subtreeNodes = Object.values(freshIndex?.nodesByUid || {})
      .filter((candidate) => isSameOrDescendantPath(candidate.pathname, node.pathname))
      .sort((a, b) => (a.depth || 0) - (b.depth || 0));

    for (const subtreeNode of subtreeNodes) {
      dispatch(collectionIndexNodeActivated({ collectionUid, node: subtreeNode }));
    }

    const pendingPathnames = [];
    for (const subtreeNode of subtreeNodes) {
      if (subtreeNode.type === 'folder') {
        continue;
      }
      const treeItem = getFreshTreeItem(subtreeNode.pathname);
      if (!isItemRequestReady(treeItem)) {
        pendingPathnames.push(subtreeNode.pathname);
      }
    }

    const CONCURRENCY = 8;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, pendingPathnames.length) }, async () => {
      while (cursor < pendingPathnames.length) {
        const pathname = pendingPathnames[cursor];
        cursor += 1;
        try {
          await dispatch(loadRequest({ collectionUid, pathname }));
        } catch (error) {
          console.warn('Failed to load request for folder run', pathname, error);
        }
      }
    });
    await Promise.all(workers);
  };

  const handleFolderRun = async () => {
    const toastId = toast.loading('Preparing folder run...');
    try {
      await hydrateFolderSubtree();
      toast.dismiss(toastId);
      setRunCollectionModalOpen(true);
    } catch (error) {
      toast.dismiss(toastId);
      toast.error(error?.message || 'Unable to prepare folder run');
    }
  };

  const handleCopyItem = () => {
    const hydratedItem = ensureNodeHydrated();
    dispatch(copyRequest(hydratedItem));
    toast.success(`${isFolder ? 'Folder' : 'Request'} copied`);
  };

  const handlePasteItem = () => {
    ensureNodeHydrated();
    dispatch(pasteItem(collectionUid, isFolder ? node.uid : node.parentUid || null))
      .then(() => {
        toast.success('Item pasted successfully');
      })
      .catch((err) => {
        toast.error(err ? err.message : 'An error occurred while pasting the item');
      });
  };

  const handleShowInFolder = () => {
    ensureNodeHydrated();
    dispatch(showInFolder(node.pathname)).catch((error) => {
      console.error('Error opening the folder', error);
      toast.error('Error opening the folder');
    });
  };

  const viewFolderSettings = () => {
    ensureNodeHydrated();
    if (isTabForItemPresent) {
      dispatch(focusTab({ uid: node.uid }));
      return;
    }

    dispatch(
      addTab({
        uid: node.uid,
        collectionUid,
        type: 'folder-settings'
      })
    );
  };

  const handleGenerateCode = async () => {
    ensureNodeHydrated();
    const hydratedItem = getActionCompatibleItem();
    const requestUrl = hydratedItem?.draft?.request?.url ?? hydratedItem?.request?.url;
    if (!requestUrl && node.pathname) {
      try {
        const loadedFile = await dispatch(loadRequest({ collectionUid, pathname: node.pathname }));
        if (!loadedFile?.data?.request?.url) {
          toast.error('URL is required');
          return;
        }
      } catch (err) {
        toast.error(err?.message || 'Unable to load request');
        return;
      }
    } else if (!requestUrl) {
      toast.error('URL is required');
      return;
    }

    setGenerateCodeItemModalOpen(true);
  };

  const openModalAfterHydration = (openModal) => {
    ensureNodeHydrated();
    openModal(true);
  };

  const openPathModal = (openModal) => {
    openModal(true);
  };

  // Sort this folder's children via the shared helper (see sortIndexedChildren).
  const handleSortFolderChildren = (mode = 'name-asc') => {
    return sortIndexedChildren({ store, dispatch, collectionUid, parentKey: node.uid, mode });
  };

  const buildMenuItems = () => {
    const items = [];

    if (isFolder) {
      items.push(
        {
          id: 'new-request',
          leftSection: IconFilePlus,
          label: 'New Request',
          onClick: () => openModalAfterHydration(setNewRequestModalOpen)
        },
        {
          id: 'new-folder',
          leftSection: IconFolderPlus,
          label: 'New Folder',
          onClick: () => openPathModal(setNewFolderModalOpen)
        },
        {
          id: 'run',
          leftSection: IconPlayerPlay,
          label: 'Run',
          onClick: handleFolderRun
        },
        {
          id: 'sort',
          leftSection: IconSortAZ,
          label: 'Sort',
          submenu: [
            { id: 'sort-az', leftSection: IconSortAZ, label: 'Name (A→Z)', onClick: () => handleSortFolderChildren('name-asc') },
            { id: 'sort-za', leftSection: IconSortZA, label: 'Name (Z→A)', onClick: () => handleSortFolderChildren('name-desc') },
            { id: 'sort-created', leftSection: IconClock, label: 'Created (oldest first)', onClick: () => handleSortFolderChildren('created-asc') }
          ]
        }
      );
    }

    items.push(
      {
        id: 'clone',
        leftSection: IconCopy,
        label: 'Clone',
        onClick: () => openPathModal(setCloneItemModalOpen)
      },
      {
        id: 'copy',
        leftSection: IconCopy,
        label: 'Copy',
        onClick: handleCopyItem
      }
    );

    if (isFolder && hasCopiedItems) {
      items.push({
        id: 'paste',
        leftSection: IconClipboard,
        label: 'Paste',
        onClick: handlePasteItem
      });
    }

    items.push({
      id: 'rename',
      leftSection: IconEdit,
      label: 'Rename',
      onClick: () => openPathModal(setRenameItemModalOpen)
    });

    if (isFolder) {
      items.push(
        {
          id: 'import',
          leftSection: IconFileImport,
          label: 'Import',
          onClick: () => openPathModal(setImportIntoFolderModalOpen)
        },
        {
          id: 'export',
          leftSection: IconFileExport,
          label: 'Export',
          onClick: () => openPathModal(setExportFolderModalOpen)
        }
      );
    }

    if (!isFolder && !['http-request', 'graphql-request'].includes(normalizeRequestType(node.type))) {
      items.push({
        id: 'run',
        leftSection: IconPlayerPlay,
        label: 'Run',
        onClick: handleRunRequest
      });
    }

    if (!isFolder && ['http-request', 'graphql-request', 'http', 'graphql'].includes(actionItem.type)) {
      items.push({
        id: 'generate-code',
        leftSection: IconCode,
        label: 'Generate Code',
        onClick: handleGenerateCode
      });
    }

    if (!isFolder && normalizeRequestType(node.type) === 'http-request') {
      items.push({
        id: 'create-example',
        leftSection: ExampleIcon,
        label: 'Create Example',
        onClick: handleCreateExampleClick
      });
    }

    items.push({
      id: 'show-in-folder',
      leftSection: IconFolder,
      label: getRevealInFolderLabel(),
      onClick: handleShowInFolder
    });

    items.push({ id: 'separator-1', type: 'divider' });

    items.push({
      id: 'info',
      leftSection: IconInfoCircle,
      label: 'Info',
      onClick: () => openModalAfterHydration(setItemInfoModalOpen)
    });

    if (isFolder) {
      items.push(
        {
          id: 'settings',
          leftSection: IconSettings,
          label: 'Settings',
          onClick: viewFolderSettings
        },
        {
          id: 'open-terminal',
          leftSection: IconTerminal2,
          label: 'Open in Terminal',
          onClick: async () => {
            ensureNodeHydrated();
            await openDevtoolsAndSwitchToTerminal(dispatch, node.pathname || collectionPathname);
          }
        }
      );
    }

    items.push({
      id: 'delete',
      leftSection: IconTrash,
      label: 'Delete',
      className: 'delete-item',
      onClick: () => openPathModal(setDeleteItemModalOpen)
    });

    return items;
  };

  const createDragItem = () => {
    const basePayload = {
      uid: node.uid,
      type: isFolder ? 'folder' : normalizeRequestType(node.type),
      sourcePathname: node.pathname,
      sourceCollectionUid: collectionUid,
      sourceCollectionPathname: collectionPathname
    };

    // Group drag: when the dragged row is part of a multi-selection, carry
    // one entry per selected item (same shape as the single payload).
    const selectedUids = multiSelect?.selectedItemUids;
    if (!selectedUids || selectedUids.size <= 1 || !selectedUids.has(node.uid)) {
      return basePayload;
    }

    const nodesByUid = store.getState().collections.collectionIndexes?.[collectionUid]?.nodesByUid || {};
    const selectedNodes = [...selectedUids]
      .map((uid) => nodesByUid[uid])
      .filter(Boolean)
      .sort((a, b) => normalizeForPathCompare(a.pathname).localeCompare(normalizeForPathCompare(b.pathname)));
    // Skip selected items living inside another selected folder — moving the
    // folder moves them.
    const draggableItems = excludeDescendantItems(selectedNodes).map((selectedNode) => ({
      uid: selectedNode.uid,
      name: selectedNode.name,
      type: selectedNode.type === 'folder' ? 'folder' : normalizeRequestType(selectedNode.type),
      sourcePathname: selectedNode.pathname,
      sourceCollectionUid: collectionUid,
      sourceCollectionPathname: collectionPathname
    }));

    if (draggableItems.length <= 1) {
      return draggableItems[0] || basePayload;
    }

    return { ...basePayload, name: node.name, isMultiSelect: true, items: draggableItems };
  };

  const [{ isDragging }, drag, dragPreview] = useDrag({
    type: 'collection-item',
    item: createDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging()
    }),
    options: {
      dropEffect: 'move'
    }
  });

  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, [dragPreview]);

  const determineDropType = (monitor) => {
    const hoverBoundingRect = rowRef.current?.getBoundingClientRect();
    const clientOffset = monitor.getClientOffset();
    if (!hoverBoundingRect || !clientOffset) {
      return null;
    }

    const clientY = clientOffset.y - hoverBoundingRect.top;
    const folderUpperThreshold = hoverBoundingRect.height * 0.35;
    const fileUpperThreshold = hoverBoundingRect.height * 0.5;

    if (isFolder) {
      return clientY < folderUpperThreshold ? 'adjacent' : 'inside';
    }

    return clientY < fileUpperThreshold ? 'adjacent' : null;
  };

  const canItemBeDropped = ({ draggedItem, dropType }) => {
    if (!collectionPathname || !node.pathname || !dropType || draggedItem.uid === node.uid) {
      return false;
    }

    const sourcePathname = draggedItem.sourcePathname || draggedItem.pathname;
    if (!sourcePathname) {
      return false;
    }

    if (draggedItem.sourceCollectionUid === collectionUid && isSameOrDescendantPath(node.pathname, sourcePathname)) {
      return false;
    }

    return true;
  };

  // After an adjacent drop, persist sibling order the way the classic
  // renderer does. Computed purely from index nodes (pathname + seq), so no
  // hydration is needed; folder moves trigger a full re-index and are skipped.
  const resequenceAfterAdjacentDrop = async ({ movedPathname }) => {
    const freshIndex = store.getState().collections.collectionIndexes?.[collectionUid];
    if (!freshIndex || !movedPathname) {
      return;
    }

    const normalizedMoved = normalizeForPathCompare(movedPathname);
    const movedNode = Object.values(freshIndex.nodesByUid || {})
      .find((candidate) => normalizeForPathCompare(candidate.pathname) === normalizedMoved);
    if (!movedNode) {
      return;
    }

    const parentKey = node.parentUid || 'root';
    const siblingNodes = (freshIndex.childrenByParentUid?.[parentKey] || [])
      .map((uid) => freshIndex.nodesByUid[uid])
      .filter(Boolean)
      .filter((candidate) => (candidate.type === 'folder') === (movedNode.type === 'folder'));

    if (!siblingNodes.some((candidate) => candidate.uid === movedNode.uid)) {
      return;
    }

    const ordered = sortNodes(siblingNodes).filter((candidate) => candidate.uid !== movedNode.uid);
    const targetPosition = ordered.findIndex((candidate) => candidate.uid === node.uid);
    const insertAt = targetPosition === -1 ? ordered.length : targetPosition;
    ordered.splice(insertAt, 0, movedNode);

    const itemsToResequence = ordered.map((candidate, position) => ({
      pathname: candidate.pathname,
      type: candidate.type === 'folder' ? 'folder' : normalizeRequestType(candidate.type),
      seq: position + 1
    }));

    dispatch(collectionIndexNodesResequenced({ collectionUid, itemsToResequence }));
    await dispatch(updateItemsSequences({ itemsToResequence, collectionUid }));
  };

  // A multi-select drag carries one entry per selected item; a plain drag is
  // treated as a single-entry group so both flow through the same logic.
  const getDraggedItems = (draggedPayload) => (
    draggedPayload?.isMultiSelect && Array.isArray(draggedPayload.items) ? draggedPayload.items : [draggedPayload]
  );

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: 'collection-item',
    hover: (draggedPayload, monitor) => {
      if (draggedPayload.uid === node.uid) {
        return;
      }

      const nextDropType = determineDropType(monitor);
      const allDroppable = getDraggedItems(draggedPayload).every(
        (draggedItem) => canItemBeDropped({ draggedItem, dropType: nextDropType })
      );
      setDropType(allDroppable ? nextDropType : null);
    },
    drop: async (draggedPayload, monitor) => {
      const nextDropType = determineDropType(monitor);
      const draggedItems = getDraggedItems(draggedPayload);

      // No partial group moves: every selected item must be droppable here.
      const allDroppable = draggedItems.every(
        (draggedItem) => canItemBeDropped({ draggedItem, dropType: nextDropType })
      );
      if (!allDroppable) {
        if (draggedItems.length > 1 && nextDropType) {
          toast.error('Cannot move the selected items here');
        }
        setDropType(null);
        return;
      }

      try {
        let lastMoveResult = null;
        for (const draggedItem of draggedItems) {
          lastMoveResult = await dispatch(moveCollectionItemByPath({
            sourceCollectionUid: draggedItem.sourceCollectionUid || collectionUid,
            targetCollectionUid: collectionUid,
            sourcePathname: draggedItem.sourcePathname || draggedItem.pathname,
            targetPathname: node.pathname,
            dropType: nextDropType
          }));
        }

        // Reorder within the same folder returns skipped=true (the file is
        // already in the right directory), but we still need to persist the new
        // sibling order, so resequence whenever we have a resulting pathname.
        if (nextDropType === 'adjacent' && lastMoveResult?.pathname) {
          await resequenceAfterAdjacentDrop({ movedPathname: lastMoveResult.pathname });
        }

        if (draggedItems.length > 1) {
          multiSelect?.clearItemSelection?.();
          toast.success(`Moved ${draggedItems.length} items`);
        }
      } catch (error) {
        toast.error(error?.message || 'Unable to move item');
      } finally {
        setDropType(null);
      }
    },
    canDrop: (draggedPayload) => !getDraggedItems(draggedPayload).some((draggedItem) => draggedItem.uid === node.uid),
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop()
    })
  });

  const handleClick = (event) => {
    if (event && event.detail !== 1) {
      return;
    }

    // Multi-select: ctrl/cmd-click toggles, shift-click selects the visible
    // range from the last selected item. Neither opens the request.
    if (event && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      multiSelect?.toggleItemSelection?.(node.uid);
      return;
    }
    if (event && event.shiftKey) {
      event.preventDefault();
      multiSelect?.selectItemRange?.(node.uid);
      return;
    }
    // Plain click: collapse the selection to just this item, then perform the
    // normal open/toggle behavior.
    multiSelect?.selectSingleItem?.(node.uid);

    setTimeout(scrollToTheActiveTab, 50);

    if (isRequest) {
      openRequest();
      return;
    }

    onToggleFolder(node.uid);
  };

  const handleDoubleClick = () => {
    if (isRequest) {
      dispatch(makeTabPermanent({ uid: node.uid }));
    }
  };

  const handleExamplesCollapse = (event) => {
    event.stopPropagation();
    event.preventDefault();
    const next = !examplesExpanded;
    setExamplesExpanded(next);
    // Hydrate the request so item.examples is populated when expanding an
    // indexed (partial) request that we only know has examples from the index.
    if (next && !item?.examples?.length && node.pathname) {
      activateNodeChain(node);
      dispatch(loadRequest({ collectionUid, pathname: node.pathname })).catch(() => {});
    }
  };

  const handleContextMenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    menuDropdownRef.current?.show();
  };

  return (
    <StyledWrapper>
      {renameItemModalOpen && (
        <RenameCollectionItem
          item={actionItem}
          collectionUid={collectionUid}
          onClose={() => setRenameItemModalOpen(false)}
          onRename={({ name, filename }) => dispatch(renameCollectionItemByPath({
            collectionUid,
            sourcePathname: node.pathname,
            newName: name,
            newFilename: filename
          }))}
        />
      )}
      {cloneItemModalOpen && (
        <CloneCollectionItem
          item={actionItem}
          collectionUid={collectionUid}
          onClose={() => setCloneItemModalOpen(false)}
          onClone={({ name, filename }) => dispatch(cloneCollectionItemByPath({
            collectionUid,
            sourcePathname: node.pathname,
            newName: name,
            newFilename: filename
          }))}
        />
      )}
      {deleteItemModalOpen && (
        <DeleteCollectionItem
          item={actionItem}
          collectionUid={collectionUid}
          onClose={() => setDeleteItemModalOpen(false)}
          onDelete={() => dispatch(deleteCollectionItemByPath({
            collectionUid,
            sourcePathname: node.pathname,
            type: isFolder ? 'folder' : normalizeRequestType(node.type)
          }))}
        />
      )}
      {newRequestModalOpen && (
        <NewRequest item={actionItem} collectionUid={collectionUid} onClose={() => setNewRequestModalOpen(false)} />
      )}
      {newFolderModalOpen && (
        <NewFolder
          item={actionItem}
          collectionUid={collectionUid}
          onClose={() => setNewFolderModalOpen(false)}
          onCreate={({ folderName, directoryName }) => dispatch(newFolderByPath({
            collectionUid,
            parentPathname: node.pathname,
            folderName,
            directoryName
          }))}
        />
      )}
      {runCollectionModalOpen && (
        <RunCollectionItem collectionUid={collectionUid} item={actionItem} onClose={() => setRunCollectionModalOpen(false)} />
      )}
      {generateCodeItemModalOpen && (
        <GenerateCodeItem collectionUid={collectionUid} item={actionItem} onClose={() => setGenerateCodeItemModalOpen(false)} />
      )}
      {itemInfoModalOpen && (
        <CollectionItemInfo item={actionItem} onClose={() => setItemInfoModalOpen(false)} />
      )}
      {exportFolderModalOpen && (
        <ExportFolder
          folderName={node.name || node.filename}
          folderPathname={node.pathname}
          collectionPathname={collectionPathname}
          onClose={() => setExportFolderModalOpen(false)}
        />
      )}
      {importIntoFolderModalOpen && (
        <ImportIntoFolder
          collectionUid={collectionUid}
          targetDirectory={node.pathname}
          targetName={node.name || node.filename}
          onClose={() => setImportIntoFolderModalOpen(false)}
        />
      )}
      <div
        ref={(element) => {
          rowRef.current = element;
          drag(drop(element));
        }}
        className={classnames('flex collection-item-name relative items-center', {
          'cursor-pointer': true,
          'opacity-50': isDragging,
          'item-focused-in-tab': isActiveTabRow,
          'item-keyboard-focused': isKeyboardFocused,
          'item-multi-selected': Boolean(multiSelect?.selectedItemUids?.has(node.uid)),
          'reveal-flash': revealFlash,
          'item-hovered': isOver && canDrop && dropType,
          'drop-target': isOver && canDrop && dropType === 'inside',
          'drop-target-above': isOver && canDrop && dropType === 'adjacent'
        })}
        style={{ height: ROW_HEIGHT }}
        title={node.pathname}
        tabIndex={0}
        onFocus={handleRowFocus}
        onBlur={handleRowBlur}
        onContextMenu={handleContextMenu}
      >
        <div className="flex items-center h-full w-full">
          {Array.from({ length: displayDepth }).map((_, index) => (
            <div
              key={`${node.uid}-indent-${index}`}
              className="indent-block"
              style={{
                width: 16,
                minWidth: 16,
                height: '100%'
              }}
            >
              &nbsp;
            </div>
          ))}
          <div
            className="flex flex-grow items-center h-full overflow-hidden"
            style={{ paddingLeft: 8 }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
          >
            {node.type === 'folder' ? (
              <ActionIcon style={{ width: 16, minWidth: 16 }}>
                <IconChevronRight
                  size={16}
                  strokeWidth={2}
                  className={classnames('chevron-icon', { 'rotate-90': isExpanded })}
                  style={{ color: 'rgb(160 160 160)' }}
                />
              </ActionIcon>
            ) : hasExamples ? (
              <ActionIcon style={{ width: 16, minWidth: 16 }}>
                <IconChevronRight
                  size={16}
                  strokeWidth={2}
                  className={classnames('chevron-icon', { 'rotate-90': examplesExpanded })}
                  style={{ color: 'rgb(160 160 160)' }}
                  onClick={handleExamplesCollapse}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                  }}
                  data-testid="request-item-chevron"
                />
              </ActionIcon>
            ) : (
              // Reserve the chevron slot so requests without examples keep the
              // same icon/name alignment as folders and requests that have one.
              <div style={{ width: 16, minWidth: 16 }} />
            )}
            <div className="ml-1 flex w-full h-full items-center overflow-hidden">
              {node.type === 'folder' ? (
                <IconFolder size={16} strokeWidth={1.7} className="mr-2" />
              ) : (
                <CollectionItemIcon item={displayItem} />
              )}
              <span className="item-name">
                <SearchHighlight text={node.name || node.filename || 'Untitled'} searchText={searchText} />
              </span>
            </div>
          </div>
          <MenuDropdown
            ref={menuDropdownRef}
            items={buildMenuItems()}
            placement="bottom-start"
            data-testid="indexed-collection-item-menu"
            popperOptions={{ strategy: 'fixed' }}
            appendTo={dropdownContainerRef?.current || document.body}
          >
            <ActionIcon
              className="menu-icon"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <IconDots size={18} className="collection-item-menu-icon" />
            </ActionIcon>
          </MenuDropdown>
        </div>
      </div>
      {hasExamples && examplesExpanded ? (
        item?.examples?.length ? (
          <IndexedRowExamples collectionUid={collectionUid} item={item} />
        ) : (
          <div className="text-xs text-muted" style={{ paddingLeft: 8 + displayDepth * 16 + 24 }}>
            Loading examples...
          </div>
        )
      ) : null}
    </StyledWrapper>
  );
});

IndexedRow.displayName = 'IndexedRow';

const IndexedCollectionItems = ({ collectionUid, searchText, multiSelect }) => {
  const dispatch = useDispatch();
  const index = useSelector((state) => state.collections.collectionIndexes?.[collectionUid]);
  const [expandedNodeUids, setExpandedNodeUids] = useState(() => new Set());
  const visibleRows = useVisibleRows({ index, expandedNodeUids, searchText });

  // Shift-click ranges must follow the virtualized list's visible order.
  // The rows read it via a ref so the wrapped callback stays stable and the
  // memoized rows don't re-render whenever visibility changes.
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const baseSelectItemRange = multiSelect?.selectItemRange;
  const selectItemRangeInVisibleOrder = useCallback((targetUid) => {
    baseSelectItemRange?.(targetUid, visibleRowsRef.current.map((row) => row.uid));
  }, [baseSelectItemRange]);
  const rowMultiSelect = useMemo(() => (
    multiSelect ? { ...multiSelect, selectItemRange: selectItemRangeInVisibleOrder } : multiSelect
  ), [multiSelect, selectItemRangeInVisibleOrder]);
  const virtuosoRef = useRef(null);
  const pendingRevealNodeUidRef = useRef(null);
  const sidebarReveal = useSelector((state) => state.app.sidebarReveal);

  // Virtualize against the sidebar's own scroll container instead of giving the
  // list a fixed height. This removes the nested inner scrollbar so an expanded
  // collection reads top-to-bottom with a single scroll, like Postman.
  //
  // A callback ref (not a mount effect) handles the first open: the container
  // div only renders after indexing finishes, so detection must run when the
  // node actually attaches, not on initial mount when it may not exist yet.
  const containerRef = useRef(null);
  const [scrollParent, setScrollParent] = useState(null);
  const attachContainer = useCallback((node) => {
    containerRef.current = node;
    if (!node || scrollParent) {
      return;
    }
    let el = node.parentElement;
    while (el) {
      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        setScrollParent(el);
        return;
      }
      el = el.parentElement;
    }
  }, [scrollParent]);

  // Reveal-in-sidebar: expand the ancestor chain of the revealed request,
  // then scroll the virtualized list to its row once rows recompute.
  // Re-attempts as the index builds (deps include node count) so revealing
  // into a just-opened collection works once indexing completes.
  useEffect(() => {
    if (!sidebarReveal?.pending || sidebarReveal.collectionUid !== collectionUid || !index?.nodesByUid) {
      return;
    }

    const normalizedTarget = normalizeForPathCompare(sidebarReveal.pathname);
    const node = Object.values(index.nodesByUid)
      .find((candidate) => normalizeForPathCompare(candidate.pathname) === normalizedTarget);
    if (!node) {
      return;
    }

    setExpandedNodeUids((current) => {
      const next = new Set(current);
      const seen = new Set();
      let parentUid = node.parentUid;
      while (parentUid && !seen.has(parentUid)) {
        seen.add(parentUid);
        next.add(parentUid);
        parentUid = index.nodesByUid[parentUid]?.parentUid;
      }
      // If the revealed node is itself a folder, expand it too so its contents
      // are shown (e.g. revealing a folder matched by name in search).
      if (node.type === 'folder') {
        next.add(node.uid);
      }
      return next;
    });
    pendingRevealNodeUidRef.current = node.uid;
  }, [sidebarReveal?.nonce, sidebarReveal?.pending, index?.totalNodes]);

  useEffect(() => {
    if (!pendingRevealNodeUidRef.current) {
      return;
    }
    const rowIndex = visibleRows.findIndex((row) => row.uid === pendingRevealNodeUidRef.current);
    if (rowIndex < 0) {
      return;
    }
    // The Virtuoso handle attaches a beat after this component mounts (the
    // reveal often lands in the same commit the collection expands). Do NOT
    // consume the reveal until a scroll actually ran — consuming with a null
    // ref silently ate the reveal and the row never came into view.
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) {
      const retry = requestAnimationFrame(() => {
        // re-trigger this effect after the ref attaches
        setExpandedNodeUids((current) => new Set(current));
      });
      return () => cancelAnimationFrame(retry);
    }
    // scrollIntoView scrolls only when the row is off-screen. Clicking a
    // request also fires a reveal (via tab activation), and centering the
    // row the user just clicked yanked the sidebar around.
    if (virtuoso.scrollIntoView) {
      virtuoso.scrollIntoView({ index: rowIndex, behavior: 'smooth' });
    } else {
      virtuoso.scrollToIndex?.({ index: rowIndex, align: 'center' });
    }
    pendingRevealNodeUidRef.current = null;
    dispatch(clearSidebarReveal());
  }, [visibleRows, dispatch]);

  // Stable identity so memoized rows don't re-render on unrelated parent
  // renders just because the handler was recreated.
  const onToggleFolder = useCallback((uid) => {
    setExpandedNodeUids((current) => {
      const next = new Set(current);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  }, []);

  if (!index) {
    return null;
  }

  if (!visibleRows.length && index.status === 'indexing') {
    return (
      <div className="text-xs text-muted ml-8 py-1">
        Indexing collection...
      </div>
    );
  }

  if (!visibleRows.length && searchText?.trim()) {
    return null;
  }

  // Fallback height only used until the scroll parent is found (or if none is).
  const listHeight = Math.min(Math.max(visibleRows.length * ROW_HEIGHT, ROW_HEIGHT), MAX_LIST_HEIGHT);

  const virtuosoProps = scrollParent
    ? { customScrollParent: scrollParent }
    : { style: { height: listHeight } };

  return (
    <div ref={attachContainer}>
      {index.status === 'indexing' ? (
        <div className="text-xs text-muted ml-8 py-1">
          Indexing {index.totalScanned || 0} items...
        </div>
      ) : null}
      <Virtuoso
        ref={virtuosoRef}
        {...virtuosoProps}
        data={visibleRows}
        computeItemKey={(_index, node) => node.pathname || node.uid}
        itemContent={(_index, node) => (
          <IndexedRow
            node={node}
            collectionUid={collectionUid}
            searchText={searchText}
            expandedNodeUids={expandedNodeUids}
            onToggleFolder={onToggleFolder}
            multiSelect={rowMultiSelect}
          />
        )}
      />
    </div>
  );
};

export default IndexedCollectionItems;
