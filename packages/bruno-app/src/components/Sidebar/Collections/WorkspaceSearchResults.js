import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { IconChevronRight, IconFolder, IconLoader2, IconSearch } from '@tabler/icons';
import classnames from 'classnames';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import { collectionIndexNodeActivated } from 'providers/ReduxStore/slices/collections';
import { loadRequest, openMultipleCollections } from 'providers/ReduxStore/slices/collections/actions';
import { getDefaultRequestPaneTab } from 'utils/collections';
import SearchHighlight from './SearchHighlight';
import { isTabForItemPresent as isTabForItemPresentSelector } from 'src/selectors/tab';
import { isEqual } from 'lodash';

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
  const query = searchText.trim().toLowerCase();
  if (!query) {
    return true;
  }

  return [node.name, node.filename, node.method, node.url]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
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
    case 'content':
      return 'content';
    case 'name':
    default:
      return 'name';
  }
};

const WorkspaceSearchTreeRow = ({ node, searchText, workspacePath, collapsedNodeUids, onToggleNode }) => {
  const dispatch = useDispatch();
  const isRequest = node.nodeKind === 'request';
  const isCollapsed = collapsedNodeUids.has(node.uid);
  const showMatchContext = node.matchText && !doesVisibleRowMatch(node, searchText);
  const isTabForItemPresent = useSelector(isTabForItemPresentSelector({ itemUid: node.uid }), isEqual);
  const collectionExists = useSelector((state) => {
    return Boolean(state.collections.collections?.find((collection) => collection.uid === node.collectionUid));
  });

  const openRequest = async () => {
    if (!collectionExists) {
      await dispatch(openMultipleCollections([node.collectionPathname], { workspacePath }));
    }

    dispatch(collectionIndexNodeActivated({ collectionUid: node.collectionUid, node }));

    if (isTabForItemPresent) {
      dispatch(focusTab({ uid: node.uid }));
    } else {
      dispatch(addTab({
        uid: node.uid,
        collectionUid: node.collectionUid,
        requestPaneTab: getDefaultRequestPaneTab(node),
        type: 'request',
        itemUid: node.uid,
        itemPathname: node.pathname
      }));
    }

    dispatch(loadRequest({ collectionUid: node.collectionUid, pathname: node.pathname }));
  };

  const handleClick = () => {
    if (isRequest) {
      openRequest();
      return;
    }

    onToggleNode(node.uid);
  };

  return (
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
        {!isRequest ? (
          <IconChevronRight
            size={15}
            strokeWidth={2}
            className={classnames('transition-transform', { 'rotate-90': !isCollapsed })}
            style={{ color: 'rgb(160 160 160)' }}
          />
        ) : null}
      </span>

      {isRequest ? (
        <span className="text-xs font-semibold text-green-700 text-left mt-1" style={{ width: 42, minWidth: 42 }}>
          {node.method || ''}
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
  );
};

const WorkspaceSearchResults = ({ searchText, activeWorkspace }) => {
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [collapsedNodeUids, setCollapsedNodeUids] = useState(() => new Set());
  const sessionRef = useRef(null);
  const collectionPaths = useMemo(() => {
    return (activeWorkspace?.collections || [])
      .map((collection) => collection.path)
      .filter(Boolean);
  }, [activeWorkspace]);

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
      setResults([]);
      setCollapsedNodeUids(new Set());
    });

    const removeBatchListener = ipcRenderer.on('main:workspace-collection-search-batch', ({ searchSessionId, results: batch = [] }) => {
      if (sessionRef.current !== searchSessionId) {
        return;
      }
      setResults((current) => {
        const seen = new Set(current.map((result) => result.pathname));
        const next = [...current];
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
      setResults([]);
      setStatus('idle');
      setError('');
      setCollapsedNodeUids(new Set());
      return;
    }

    const searchSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionRef.current = searchSessionId;
    setStatus('searching');
    setResults([]);
    setError('');
    setCollapsedNodeUids(new Set());

    const timer = setTimeout(() => {
      window.ipcRenderer.invoke('renderer:start-workspace-collection-search', {
        searchSessionId,
        workspacePath: activeWorkspace.pathname,
        collectionPaths,
        query: trimmedSearchText,
        limit: 250
      }).catch((err) => {
        if (sessionRef.current === searchSessionId) {
          setStatus('failed');
          setError(err?.message || 'Search failed');
        }
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [activeWorkspace, collectionPaths, searchText]);

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
