import React, { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { IconChevronRight, IconFolder, IconLoader2, IconSearch } from '@tabler/icons';
import classnames from 'classnames';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import { collectionIndexNodeActivated } from 'providers/ReduxStore/slices/collections';
import { loadRequest, mountCollection, openMultipleCollections } from 'providers/ReduxStore/slices/collections/actions';
import { getDefaultRequestPaneTab, findItemInCollectionByPathname } from 'utils/collections';
import { normalizePath } from 'utils/common/path';
import { foldSearchText } from '@usebruno/common';
import ExampleIcon from 'components/Icons/ExampleIcon';
import MethodBadge from 'ui/MethodBadge';
import SearchHighlight from './SearchHighlight';

const SEARCH_DEBOUNCE_MS = 200;

const splitRelativePath = (value = '') => {
  return String(value)
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment !== '.');
};

const sortTreeNodes = (nodes = []) => {
  const typeRank = {
    collection: 0,
    folder: 1,
    request: 2
  };

  return [...nodes].sort((a, b) => {
    const rankDiff = (typeRank[a.nodeKind || a.type] ?? 3) - (typeRank[b.nodeKind || b.type] ?? 3);
    if (rankDiff) {
      return rankDiff;
    }

    return String(a.name || '').localeCompare(String(b.name || ''));
  });
};

const makeTreeNode = (node) => ({
  ...node,
  children: node.children || [],
  childMap: node.childMap || new Map()
});

const ensureChildNode = (parent, node) => {
  const existing = parent.childMap.get(node.uid);
  if (existing) {
    Object.assign(existing, node);
    return existing;
  }

  const child = makeTreeNode(node);
  parent.childMap.set(child.uid, child);
  parent.children.push(child);
  return child;
};

const buildSearchTree = (results = []) => {
  const rootNodes = [];
  const collectionMap = new Map();

  const ensureCollectionNode = (result) => {
    const uid = `collection:${result.collectionPathname}`;
    const existing = collectionMap.get(uid);
    if (existing) {
      if (result.type === 'collection') {
        Object.assign(existing, {
          matchField: result.matchField,
          matchText: result.matchText
        });
      }
      return existing;
    }

    const node = makeTreeNode({
      uid,
      type: 'collection',
      name: result.collectionName || 'Collection',
      pathname: result.collectionPathname,
      collectionPathname: result.collectionPathname,
      collectionUid: result.collectionUid,
      depth: 0,
      matchField: result.type === 'collection' ? result.matchField : undefined,
      matchText: result.type === 'collection' ? result.matchText : undefined
    });
    collectionMap.set(uid, node);
    rootNodes.push(node);
    return node;
  };

  const ensureFolderPath = (collectionNode, result, segments = []) => {
    let parent = collectionNode;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isMatchedFolder = result.type === 'folder' && result.collectionRelativePath === currentPath;
      parent = ensureChildNode(parent, {
        uid: `folder:${result.collectionPathname}:${currentPath}`,
        type: 'folder',
        name: isMatchedFolder ? (result.name || segment) : segment,
        pathname: isMatchedFolder ? result.pathname : '',
        collectionPathname: result.collectionPathname,
        collectionUid: result.collectionUid,
        collectionRelativePath: currentPath,
        depth: parent.depth + 1,
        isMatchedFolder
      });
    }

    return parent;
  };

  for (const result of results) {
    const collectionNode = ensureCollectionNode(result);

    if (result.type === 'collection') {
      continue;
    }

    if (result.type === 'folder') {
      ensureFolderPath(collectionNode, result, splitRelativePath(result.collectionRelativePath));
      continue;
    }

    const parent = ensureFolderPath(collectionNode, result, splitRelativePath(result.parentCollectionRelativePath));
    ensureChildNode(parent, {
      ...result,
      nodeKind: 'request',
      depth: parent.depth + 1
    });
  }

  const sortChildren = (node) => {
    node.children = sortTreeNodes(node.children);
    for (const child of node.children) {
      sortChildren(child);
    }
    return node;
  };

  return sortTreeNodes(rootNodes).map(sortChildren);
};

const flattenSearchTree = (nodes = [], collapsedNodeUids = new Set()) => {
  const rows = [];

  const walk = (node) => {
    rows.push(node);
    // Requests are leaves in the flattened tree; their examples (when present)
    // are rendered inline by the row component itself on expand.
    if (node.nodeKind !== 'request' && !collapsedNodeUids.has(node.uid)) {
      for (const child of node.children || []) {
        walk(child);
      }
    }
  };

  for (const node of nodes) {
    walk(node);
  }

  return rows;
};

const doesVisibleRowMatch = (node, searchText) => {
  const query = foldSearchText(searchText.trim());
  if (!query) {
    return true;
  }

  return [node.name, node.filename, node.method, node.url]
    .filter(Boolean)
    .some((value) => foldSearchText(value).includes(query));
};

const formatMatchLabel = (field) => {
  switch (field) {
    case 'url':
      return 'url';
    case 'path':
      return 'path';
    case 'method':
      return 'method';
    case 'filename':
      return 'file';
    case 'headers':
      return 'headers';
    case 'body':
      return 'body';
    case 'examples':
      return 'example';
    case 'content':
      return 'content';
    case 'name':
    default:
      return 'name';
  }
};

const WorkspaceSearchTreeRow = ({ node, searchText, workspacePath, collapsedNodeUids, onToggleNode }) => {
  const dispatch = useDispatch();
  const store = useStore();
  const isRequest = node.nodeKind === 'request';
  const [examplesExpanded, setExamplesExpanded] = useState(false);
  // A folder/collection matched only by name has no search children; let it be
  // expanded to browse its actual contents (lazily loaded from the index).
  const [browseExpanded, setBrowseExpanded] = useState(false);
  const [browseChildren, setBrowseChildren] = useState(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  // Rows unmount on every result change; their polling loops must stop instead
  // of running to timeout and calling setState on an unmounted component.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);
  const isCollapsed = collapsedNodeUids.has(node.uid);
  const showMatchContext = node.matchText && !doesVisibleRowMatch(node, searchText);

  // Resolve the renderer's collection (by pathname) for this search node. Its
  // uid is the source of truth for tabs/loadRequest - using the search node's
  // hash uid can mismatch a freshly opened collection and never resolve.
  const findCollection = () => store.getState().collections.collections.find(
    (collection) => normalizePath(collection.pathname) === normalizePath(node.collectionPathname)
  );

  // Open the collection (if needed), wait for it to load, mount classic ones.
  const ensureCollectionLoaded = async () => {
    let collection = findCollection();
    if (!collection) {
      await dispatch(openMultipleCollections([node.collectionPathname], { workspacePath }));
      const startedAt = Date.now();
      while (!collection && !cancelledRef.current && Date.now() - startedAt < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        collection = findCollection();
      }
    }
    if (!collection) {
      return null;
    }
    const hasIndex = Boolean(store.getState().collections.collectionIndexes?.[collection.uid]);
    if (!hasIndex && collection.mountStatus !== 'mounted' && collection.mountStatus !== 'mounting') {
      dispatch(mountCollection({
        collectionUid: collection.uid,
        collectionPathname: collection.pathname,
        brunoConfig: collection.brunoConfig
      }));
    }
    return collection;
  };

  const openRequest = async () => {
    const collection = await ensureCollectionLoaded();
    if (!collection) {
      toast.error('Unable to open the collection for this result');
      return;
    }
    const collectionUid = collection.uid;
    // Browse rows carry a synthetic uid; resolve the real index node by pathname
    // so activation inserts the correct tree item and the tab's itemUid matches
    // it (otherwise the request opens but its panes never hydrate).
    const index = store.getState().collections.collectionIndexes?.[collectionUid];
    const realNode = (index?.nodesByUid
      && Object.values(index.nodesByUid).find((n) => normalizePath(n.pathname) === normalizePath(node.pathname)))
    || node;
    if (index?.nodesByUid) {
      dispatch(collectionIndexNodeActivated({ collectionUid, node: realNode }));
    }

    const tabUid = `indexed-request:${collectionUid}:${node.pathname}`;
    const existing = store.getState().tabs.tabs.find((tab) => tab.uid === tabUid);
    if (existing) {
      dispatch(focusTab({ uid: existing.uid }));
    } else {
      dispatch(addTab({
        uid: tabUid,
        collectionUid,
        requestPaneTab: getDefaultRequestPaneTab(node),
        type: 'request',
        itemUid: realNode.uid || node.parentRequestUid || node.uid,
        itemPathname: node.pathname
      }));
    }

    dispatch(loadRequest({ collectionUid, pathname: node.pathname }));
  };

  // Open a specific example: load the request so its examples (with uids)
  // exist, resolve the example by index/name, then open its tab.
  const openExample = async (example) => {
    const collection = await ensureCollectionLoaded();
    if (!collection) {
      toast.error('Unable to open the collection for this example');
      return;
    }
    const collectionUid = collection.uid;
    await dispatch(loadRequest({ collectionUid, pathname: node.pathname }));

    const resolveExample = () => {
      const c = findCollection();
      const item = c ? findItemInCollectionByPathname(c, node.pathname) : null;
      const resolved = item?.examples?.[example.index]
        || item?.examples?.find((ex) => ex.name === example.name);
      return item && resolved ? { item, example: resolved } : null;
    };
    let found = resolveExample();
    const startedAt = Date.now();
    while (!found && !cancelledRef.current && Date.now() - startedAt < 8000) {
      await new Promise((r) => setTimeout(r, 100));
      found = resolveExample();
    }
    if (cancelledRef.current) {
      return;
    }
    if (!found) {
      toast.error('Unable to open the example');
      return;
    }

    const existing = store.getState().tabs.tabs.find((tab) => tab.uid === found.example.uid);
    if (existing) {
      dispatch(focusTab({ uid: found.example.uid }));
    } else {
      dispatch(addTab({
        uid: found.example.uid,
        exampleUid: found.example.uid,
        collectionUid,
        type: 'response-example',
        itemUid: found.item.uid
      }));
    }
  };

  // Search children come from matched results. A folder/collection matched only
  // by name has none, so it is "browsable": expanding it lazily loads its real
  // contents from the collection index.
  const hasSearchChildren = !isRequest && (node.children?.length || 0) > 0;
  const isBrowsable = !isRequest && !hasSearchChildren;
  const isExpandable = hasSearchChildren || isBrowsable;
  const isOpen = hasSearchChildren ? !isCollapsed : browseExpanded;

  // Map either a warm-index node or a classic tree item to the row shape this
  // component renders.
  const toBrowseChild = (source, uidKey) => ({
    uid: `browse:${node.uid}:${uidKey}`,
    nodeKind: source.type === 'folder' ? 'folder' : 'request',
    type: source.type === 'folder' ? 'folder' : source.type,
    name: source.name || source.filename || 'Untitled',
    filename: source.filename,
    pathname: source.pathname,
    method: source.method || source.request?.method,
    url: source.url || source.request?.url,
    collectionPathname: node.collectionPathname,
    collectionUid: node.collectionUid,
    parentRequestUid: source.uid,
    exampleCount: source.exampleCount || source.examples?.length || 0,
    depth: (node.depth || 0) + 1,
    children: []
  });

  // Read children from the warm index (large collections) or, when there is no
  // index, the classic in-memory tree (small collections). Returns
  // { children, settled }: `settled` means the answer is final (index ready /
  // tree mounted), so an empty container stops the poll immediately instead of
  // spinning to the timeout.
  const readChildren = (collectionUid) => {
    const state = store.getState().collections;
    const index = state.collectionIndexes?.[collectionUid];
    if (index?.nodesByUid) {
      const indexReady = index.status === 'ready';
      let parentKey = 'root';
      if (node.type !== 'collection') {
        // O(1) via the index's pathname map; scan only as a fallback for
        // normalization mismatches.
        const mappedUid = index.uidByPathname?.[normalizePath(node.pathname)];
        const indexNode = (mappedUid && index.nodesByUid[mappedUid])
          || Object.values(index.nodesByUid)
            .find((candidate) => normalizePath(candidate.pathname) === normalizePath(node.pathname));
        if (!indexNode) {
          // Missing from a ready index -> it will not appear; keep waiting
          // only while indexing is still running.
          return { children: null, settled: indexReady };
        }
        parentKey = indexNode.uid;
      }
      const childUids = index.childrenByParentUid?.[parentKey] || [];
      const children = childUids.map((uid) => index.nodesByUid[uid]).filter(Boolean).map((n) => toBrowseChild(n, n.uid));
      return { children, settled: indexReady || children.length > 0 };
    }
    const collection = state.collections.find((c) => c.uid === collectionUid);
    const parent = node.type === 'collection'
      ? collection
      : (collection && findItemInCollectionByPathname(collection, node.pathname));
    if (parent?.items?.length) {
      return { children: parent.items.map((item) => toBrowseChild(item, item.uid)), settled: true };
    }
    // The items array exists (empty) from the moment a collection registers,
    // long before its tree loads — a just-opened collection must keep polling
    // or it renders "(empty)". Empty is final only once the mount finished.
    const treeSettled = Boolean(parent)
      && collection?.mountStatus === 'mounted'
      && !collection?.isLoading;
    return { children: parent ? [] : null, settled: treeSettled };
  };

  const loadBrowseChildren = async () => {
    setBrowseLoading(true);
    try {
      const collection = await ensureCollectionLoaded();
      if (cancelledRef.current) {
        return;
      }
      if (!collection) {
        toast.error('Unable to open the collection for this result');
        setBrowseChildren([]);
        return;
      }
      // Poll until the answer settles. A freshly opened collection streams its
      // tree in via watcher events even after it reports mounted, so an empty
      // answer is accepted only after it stays settled-empty for ~2s straight;
      // any sign of loading resets the streak. Items appearing win instantly.
      let children = null;
      let emptySettledTicks = 0;
      const startedAt = Date.now();
      while (!cancelledRef.current && Date.now() - startedAt < 15000) {
        const { children: next, settled } = readChildren(collection.uid);
        if (next?.length) {
          children = next;
          break;
        }
        if (settled) {
          emptySettledTicks += 1;
          if (emptySettledTicks >= 10) {
            children = next || [];
            break;
          }
        } else {
          emptySettledTicks = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (cancelledRef.current) {
        return;
      }
      setBrowseChildren(children ? sortTreeNodes(children) : []);
    } finally {
      if (!cancelledRef.current) {
        setBrowseLoading(false);
      }
    }
  };

  const toggleBrowse = () => {
    const next = !browseExpanded;
    setBrowseExpanded(next);
    if (next && browseChildren === null && !browseLoading) {
      loadBrowseChildren();
    }
  };

  const handleClick = () => {
    if (isRequest) {
      openRequest();
      return;
    }
    if (hasSearchChildren) {
      onToggleNode(node.uid);
      return;
    }
    toggleBrowse();
  };

  const examples = isRequest ? (node.examples || []) : [];
  const hasExamples = examples.length > 0 || (node.exampleCount || 0) > 0;

  return (
    <>
      <button
        type="button"
        className={classnames('w-full text-left hover:bg-gray-100 flex items-start gap-1 pr-2 py-1', {
          'font-semibold': node.type === 'collection'
        })}
        style={{ minHeight: 28, paddingLeft: 8 + (node.depth || 0) * 14 }}
        title={node.pathname || node.collectionPathname}
        onClick={handleClick}
      >
        <span className="flex items-center justify-center mt-0.5" style={{ width: 16, minWidth: 16 }}>
          {isExpandable ? (
            <IconChevronRight
              size={15}
              strokeWidth={2}
              className={classnames('transition-transform', { 'rotate-90': isOpen })}
              style={{ color: 'rgb(160 160 160)' }}
            />
          ) : (!isRequest) ? null : hasExamples ? (
            <IconChevronRight
              size={15}
              strokeWidth={2}
              className={classnames('transition-transform', { 'rotate-90': examplesExpanded })}
              style={{ color: 'rgb(160 160 160)' }}
              data-testid="search-request-examples-chevron"
              onClick={(e) => {
                e.stopPropagation();
                setExamplesExpanded((open) => !open);
              }}
            />
          ) : null}
        </span>

        {isRequest ? (
          <span className="text-left mt-1" style={{ width: 52, minWidth: 52 }}>
            {node.method ? <MethodBadge method={node.method} /> : null}
          </span>
        ) : (
          <span className="flex items-center justify-center text-muted mt-0.5" style={{ width: 18, minWidth: 18 }}>
            <IconFolder size={15} strokeWidth={1.8} />
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <SearchHighlight text={node.name || node.filename || 'Untitled'} searchText={searchText} />
          </span>
          {showMatchContext ? (
            <span className="block text-xs text-muted truncate font-normal">
              {formatMatchLabel(node.matchField)}: <SearchHighlight text={node.matchText} searchText={searchText} />
            </span>
          ) : null}
        </span>
      </button>

      {isRequest && hasExamples && examplesExpanded
        ? examples.map((example) => (
            <button
              key={`${node.uid}:example:${example.index}`}
              type="button"
              className="w-full text-left hover:bg-gray-100 flex items-center gap-1 pr-2 py-1"
              style={{ minHeight: 26, paddingLeft: 8 + (node.depth || 0) * 14 + 30 }}
              title={`${example.name} (example)`}
              data-testid="search-example-row"
              onClick={() => openExample(example)}
            >
              <span className="flex items-center justify-center text-muted" style={{ width: 16, minWidth: 16 }}>
                <ExampleIcon size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">
                <SearchHighlight text={example.name || 'Example'} searchText={searchText} />
              </span>
            </button>
          ))
        : null}

      {isBrowsable && browseExpanded && (
        browseLoading && browseChildren === null ? (
          <div className="text-xs text-muted py-1" style={{ paddingLeft: 8 + ((node.depth || 0) + 1) * 14 + 18 }}>
            Loading…
          </div>
        ) : browseChildren && browseChildren.length ? (
          browseChildren.map((child) => (
            <WorkspaceSearchTreeRow
              key={child.uid}
              node={child}
              searchText={searchText}
              workspacePath={workspacePath}
              collapsedNodeUids={collapsedNodeUids}
              onToggleNode={onToggleNode}
            />
          ))
        ) : browseChildren ? (
          <div className="text-xs text-muted py-1" style={{ paddingLeft: 8 + ((node.depth || 0) + 1) * 14 + 18 }}>
            (empty)
          </div>
        ) : null
      )}
    </>
  );
};

const WorkspaceSearchResults = ({ searchText, searchOptions, activeWorkspace }) => {
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [collapsedNodeUids, setCollapsedNodeUids] = useState(() => new Set());
  const sessionRef = useRef(null);
  // When a new search starts we keep the previous results on screen until the
  // new session's first data arrives — clearing eagerly made every keystroke
  // flash an empty list (and a bare spinner during index rebuilds).
  const pendingClearRef = useRef(false);
  const collectionPaths = useMemo(() => {
    return (activeWorkspace?.collections || [])
      .map((collection) => collection.path)
      .filter(Boolean);
  }, [activeWorkspace?.collections]);
  // Primitive key so effects don't re-run on unrelated workspace-slice updates
  // (the workspace object identity changes on every config broadcast).
  const collectionPathsKey = collectionPaths.join('\n');

  const tree = useMemo(() => buildSearchTree(results), [results]);
  const visibleRows = useMemo(() => flattenSearchTree(tree, collapsedNodeUids), [tree, collapsedNodeUids]);

  const toggleNode = (uid) => {
    setCollapsedNodeUids((current) => {
      const next = new Set(current);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  useEffect(() => {
    const { ipcRenderer } = window;
    const removeStartedListener = ipcRenderer.on('main:workspace-collection-search-started', ({ searchSessionId }) => {
      if (sessionRef.current !== searchSessionId) {
        return;
      }
      setStatus('searching');
      setError('');
    });

    const removeBatchListener = ipcRenderer.on('main:workspace-collection-search-batch', ({ searchSessionId, results: batch = [] }) => {
      if (sessionRef.current !== searchSessionId) {
        return;
      }
      // First data of a new session replaces the previous search's results;
      // later batches of the same session append.
      const replacing = pendingClearRef.current;
      pendingClearRef.current = false;
      if (replacing) {
        setCollapsedNodeUids(new Set());
      }
      setResults((current) => {
        const base = replacing ? [] : current;
        const seen = new Set(base.map((result) => result.pathname));
        const next = [...base];
        for (const result of batch) {
          if (!seen.has(result.pathname)) {
            seen.add(result.pathname);
            next.push(result);
          }
        }
        return next;
      });
    });

    const removeReadyListener = ipcRenderer.on('main:workspace-collection-search-ready', ({ searchSessionId }) => {
      if (sessionRef.current !== searchSessionId) {
        return;
      }
      // No batches arrived for this session -> genuinely no matches.
      if (pendingClearRef.current) {
        pendingClearRef.current = false;
        setResults([]);
        setCollapsedNodeUids(new Set());
      }
      setStatus('ready');
    });

    const removeFailedListener = ipcRenderer.on('main:workspace-collection-search-failed', ({ searchSessionId, error }) => {
      if (sessionRef.current !== searchSessionId) {
        return;
      }
      setError(error || 'Search failed');
      setStatus('failed');
    });

    return () => {
      removeStartedListener();
      removeBatchListener();
      removeReadyListener();
      removeFailedListener();
    };
  }, []);

  useEffect(() => {
    const trimmedSearchText = searchText.trim();
    if (trimmedSearchText.length < 2 || !activeWorkspace?.pathname || !collectionPaths.length) {
      sessionRef.current = null;
      pendingClearRef.current = false;
      setResults([]);
      setStatus('idle');
      setError('');
      setCollapsedNodeUids(new Set());
      return;
    }

    const searchSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionRef.current = searchSessionId;
    // Keep the previous results visible; they are replaced when the new
    // session's first batch (or an empty 'ready') arrives.
    pendingClearRef.current = true;
    setStatus('searching');
    setError('');

    const timer = setTimeout(() => {
      window.ipcRenderer.invoke('renderer:start-workspace-collection-search', {
        searchSessionId,
        workspacePath: activeWorkspace.pathname,
        collectionPaths,
        query: trimmedSearchText,
        limit: 250,
        options: {
          matchCase: Boolean(searchOptions?.matchCase),
          scopes: searchOptions?.scopes
        }
      }).catch((err) => {
        if (sessionRef.current === searchSessionId) {
          setStatus('failed');
          setError(err?.message || 'Search failed');
        }
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [activeWorkspace?.pathname, collectionPathsKey, searchText, searchOptions?.matchCase, searchOptions?.scopes]);

  if (searchText.trim().length < 2) {
    return (
      <div className="px-4 py-2 text-muted">
        Type at least 2 characters to search.
      </div>
    );
  }

  if (error) {
    return <div className="px-4 py-2 text-red-600">{error}</div>;
  }

  return (
    <div className="workspace-search-results">
      <div className="px-3 py-2 text-xs text-muted flex items-center gap-2">
        {status === 'searching' ? <IconLoader2 className="animate-spin" size={14} /> : <IconSearch size={14} />}
        <span>
          {status === 'searching' ? 'Searching workspace...' : `${results.length} result${results.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {visibleRows.map((node) => (
        <WorkspaceSearchTreeRow
          key={node.uid}
          node={node}
          searchText={searchText}
          workspacePath={activeWorkspace.pathname}
          collapsedNodeUids={collapsedNodeUids}
          onToggleNode={toggleNode}
        />
      ))}

      {status === 'ready' && !results.length ? (
        <div className="px-4 py-2 text-muted">No matches found.</div>
      ) : null}
    </div>
  );
};

export default WorkspaceSearchResults;
