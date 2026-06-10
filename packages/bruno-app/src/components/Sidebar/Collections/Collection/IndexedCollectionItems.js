import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import classnames from 'classnames';
import {
  IconChevronRight,
  IconClipboard,
  IconCode,
  IconCopy,
  IconDots,
  IconEdit,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconInfoCircle,
  IconPlayerPlay,
  IconSettings,
  IconTerminal2,
  IconTrash
} from '@tabler/icons';
import { useDispatch, useSelector } from 'react-redux';
import { getEmptyImage } from 'react-dnd-html5-backend';
import { useDrag, useDrop } from 'react-dnd';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import { collectionIndexNodeActivated } from 'providers/ReduxStore/slices/collections';
import {
  cloneCollectionItemByPath,
  deleteCollectionItemByPath,
  loadRequest,
  moveCollectionItemByPath,
  newFolderByPath,
  pasteItem,
  renameCollectionItemByPath,
  showInFolder
} from 'providers/ReduxStore/slices/collections/actions';
import { copyRequest } from 'providers/ReduxStore/slices/app';
import SearchHighlight from '../SearchHighlight';
import CollectionItemIcon from './CollectionItem/CollectionItemIcon';
import StyledWrapper from './CollectionItem/StyledWrapper';
import RenameCollectionItem from './CollectionItem/RenameCollectionItem';
import CloneCollectionItem from './CollectionItem/CloneCollectionItem';
import DeleteCollectionItem from './CollectionItem/DeleteCollectionItem';
import RunCollectionItem from './CollectionItem/RunCollectionItem';
import GenerateCodeItem from './CollectionItem/GenerateCodeItem';
import CollectionItemInfo from './CollectionItem/CollectionItemInfo';
import { getDefaultRequestPaneTab } from 'utils/collections';
import { findItemInCollection, findItemInCollectionByPathname } from 'utils/collections';
import { isTabForItemPresent as isTabForItemPresentSelector } from 'src/selectors/tab';
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
  return [...nodes].sort((a, b) => {
    const aFolder = a.type === 'folder' ? 0 : 1;
    const bFolder = b.type === 'folder' ? 0 : 1;
    if (aFolder !== bFolder) {
      return aFolder - bFolder;
    }

    const aSeq = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) {
      return aSeq - bSeq;
    }

    return (a.name || '').localeCompare(b.name || '');
  });
};

const nodeMatchesSearch = (node, searchText) => {
  if (!searchText) {
    return true;
  }

  const text = searchText.toLowerCase();
  return [node.name, node.method, node.url, node.pathname]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(text));
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

const normalizeForPathCompare = (pathname) => String(pathname || '').replace(/\\/g, '/').replace(/\/+$/, '');

const isSameOrDescendantPath = (targetPathname, sourcePathname) => {
  const target = normalizeForPathCompare(targetPathname);
  const source = normalizeForPathCompare(sourcePathname);
  return target === source || target.startsWith(`${source}/`);
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
      return sortNodes(Object.values(nodesByUid).filter((node) => nodeMatchesSearch(node, trimmedSearchText)));
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

const IndexedRow = ({ node, collectionUid, searchText, expandedNodeUids, onToggleFolder }) => {
  const dispatch = useDispatch();
  const { dropdownContainerRef } = useSidebarAccordion();
  const rowRef = useRef(null);
  const menuDropdownRef = useRef(null);
  const isRequest = node.type !== 'folder';
  const isFolder = !isRequest;
  const isExpanded = expandedNodeUids.has(node.uid);
  const [renameItemModalOpen, setRenameItemModalOpen] = useState(false);
  const [cloneItemModalOpen, setCloneItemModalOpen] = useState(false);
  const [deleteItemModalOpen, setDeleteItemModalOpen] = useState(false);
  const [newRequestModalOpen, setNewRequestModalOpen] = useState(false);
  const [newFolderModalOpen, setNewFolderModalOpen] = useState(false);
  const [runCollectionModalOpen, setRunCollectionModalOpen] = useState(false);
  const [generateCodeItemModalOpen, setGenerateCodeItemModalOpen] = useState(false);
  const [itemInfoModalOpen, setItemInfoModalOpen] = useState(false);
  const [dropType, setDropType] = useState(null);
  const isTabForItemPresent = useSelector(isTabForItemPresentSelector({ itemUid: node.uid }), isEqual);
  const { hasCopiedItems } = useSelector((state) => state.app.clipboard);
  const index = useSelector((state) => state.collections.collectionIndexes?.[collectionUid]);
  const collection = useSelector((state) => state.collections.collections?.find((c) => c.uid === collectionUid), isEqual);
  const item = useSelector((state) => {
    const collection = state.collections.collections?.find((c) => c.uid === collectionUid);
    return collection ? (
      findItemInCollection(collection, node.uid) || findItemInCollectionByPathname(collection, node.pathname)
    ) : null;
  }, isEqual);
  const displayItem = item || {
    ...node,
    type: normalizeRequestType(node.type),
    partial: false,
    loading: false,
    error: false,
    request: {
      method: node.method || '',
      url: node.url || ''
    }
  };
  const hasHydratedChildren = Boolean(item?.items?.length);
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

  const openRequest = () => {
    dispatch(collectionIndexNodeActivated({ collectionUid, node }));

    if (isTabForItemPresent) {
      dispatch(focusTab({ uid: node.uid }));
    } else {
      dispatch(
        addTab({
          uid: node.uid,
          collectionUid,
          requestPaneTab: getDefaultRequestPaneTab(node),
          type: 'request',
          itemUid: node.uid,
          itemPathname: node.pathname
        })
      );
    }

    if (!item || item.loading || item.partial || !item.request) {
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
          disabled: !hasHydratedChildren,
          title: hasHydratedChildren ? 'Run this folder' : 'Run is available after this folder has loaded child request data',
          onClick: () => openModalAfterHydration(setRunCollectionModalOpen)
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

    if (!isFolder && ['http-request', 'graphql-request', 'http', 'graphql'].includes(actionItem.type)) {
      items.push({
        id: 'generate-code',
        leftSection: IconCode,
        label: 'Generate Code',
        onClick: handleGenerateCode
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
            await openDevtoolsAndSwitchToTerminal(dispatch, node.pathname || collection?.pathname);
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
    return {
      uid: node.uid,
      type: isFolder ? 'folder' : normalizeRequestType(node.type),
      sourcePathname: node.pathname,
      sourceCollectionUid: collectionUid,
      sourceCollectionPathname: collection?.pathname
    };
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
    if (!collection?.pathname || !node.pathname || !dropType || draggedItem.uid === node.uid) {
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

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: 'collection-item',
    hover: (draggedItem, monitor) => {
      if (draggedItem.uid === node.uid) {
        return;
      }

      const nextDropType = determineDropType(monitor);
      setDropType(canItemBeDropped({ draggedItem, dropType: nextDropType }) ? nextDropType : null);
    },
    drop: async (draggedItem, monitor) => {
      const nextDropType = determineDropType(monitor);
      if (!canItemBeDropped({ draggedItem, dropType: nextDropType })) {
        setDropType(null);
        return;
      }

      try {
        await dispatch(moveCollectionItemByPath({
          sourceCollectionUid: draggedItem.sourceCollectionUid || collectionUid,
          targetCollectionUid: collectionUid,
          sourcePathname: draggedItem.sourcePathname || draggedItem.pathname,
          targetPathname: node.pathname,
          dropType: nextDropType
        }));
      } catch (error) {
        toast.error(error?.message || 'Unable to move item');
      } finally {
        setDropType(null);
      }
    },
    canDrop: (draggedItem) => draggedItem.uid !== node.uid,
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop()
    })
  });

  const handleClick = () => {
    if (isRequest) {
      openRequest();
      return;
    }

    onToggleFolder(node.uid);
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
      <div
        ref={(element) => {
          rowRef.current = element;
          drag(drop(element));
        }}
        className={classnames('flex collection-item-name relative items-center', {
          'cursor-pointer': true,
          'opacity-50': isDragging,
          'item-hovered': isOver && canDrop && dropType,
          'drop-target': isOver && canDrop && dropType === 'inside',
          'drop-target-above': isOver && canDrop && dropType === 'adjacent'
        })}
        style={{ height: ROW_HEIGHT }}
        title={node.pathname}
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
            ) : null}
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
    </StyledWrapper>
  );
};

const IndexedCollectionItems = ({ collectionUid, searchText }) => {
  const index = useSelector((state) => state.collections.collectionIndexes?.[collectionUid]);
  const [expandedNodeUids, setExpandedNodeUids] = useState(() => new Set());
  const visibleRows = useVisibleRows({ index, expandedNodeUids, searchText });

  const onToggleFolder = (uid) => {
    setExpandedNodeUids((current) => {
      const next = new Set(current);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

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

  const listHeight = Math.min(Math.max(visibleRows.length * ROW_HEIGHT, ROW_HEIGHT), MAX_LIST_HEIGHT);

  return (
    <div>
      {index.status === 'indexing' ? (
        <div className="text-xs text-muted ml-8 py-1">
          Indexing {index.totalScanned || 0} items...
        </div>
      ) : null}
      <Virtuoso
        style={{ height: listHeight }}
        data={visibleRows}
        itemContent={(_index, node) => (
          <IndexedRow
            node={node}
            collectionUid={collectionUid}
            searchText={searchText}
            expandedNodeUids={expandedNodeUids}
            onToggleFolder={onToggleFolder}
          />
        )}
      />
    </div>
  );
};

export default IndexedCollectionItems;
