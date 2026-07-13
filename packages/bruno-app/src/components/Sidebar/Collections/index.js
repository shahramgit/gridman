import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import toast from 'react-hot-toast';
import { IconBox, IconLoader2, IconSearch } from '@tabler/icons';
import Collection from './Collection';
import StyledWrapper from './StyledWrapper';
import CreateOrOpenCollection from './CreateOrOpenCollection';
import CollectionSearch from './CollectionSearch/index';
import InlineCollectionCreator from './InlineCollectionCreator';
import useWorkspaceSearch from './useWorkspaceSearch';
import { openMultipleCollections, refreshCollectionIndex } from 'providers/ReduxStore/slices/collections/actions';
import { isScratchCollection } from 'utils/collections';
import { normalizePath } from 'utils/common/path';
import { buildSidebarEntries, getSidebarEntryName } from 'utils/collections/sidebarEntries';

const SEARCH_OPTIONS_STORAGE_KEY = 'gridman.sidebar-search-options';

const DEFAULT_SEARCH_OPTIONS = {
  matchCase: false,
  scopes: {
    collections: true,
    names: true,
    url: true,
    headers: true,
    body: true,
    examples: true
  }
};

const readStoredSearchOptions = () => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SEARCH_OPTIONS_STORAGE_KEY));
    if (!stored || typeof stored !== 'object') {
      return DEFAULT_SEARCH_OPTIONS;
    }
    return {
      matchCase: Boolean(stored.matchCase),
      scopes: { ...DEFAULT_SEARCH_OPTIONS.scopes, ...(stored.scopes || {}) }
    };
  } catch (error) {
    return DEFAULT_SEARCH_OPTIONS;
  }
};

// Placeholder row for a collection registered in workspace.yml whose data is
// not loaded (still opening, or the open failed). Registered collections must
// never vanish from the sidebar; clicking the row (re)opens the collection.
const UnloadedCollection = ({ entry, workspacePath }) => {
  const dispatch = useDispatch();
  const [isOpening, setIsOpening] = useState(false);
  const name = getSidebarEntryName(entry);
  const notFoundLocally = Boolean(entry.workspaceCollection?.notFoundLocally);

  const handleClick = () => {
    if (isOpening || notFoundLocally) return;
    setIsOpening(true);
    dispatch(openMultipleCollections([entry.workspaceCollection.path], { workspacePath }))
      .catch(() => toast.error(`Unable to open collection "${name}"`))
      .finally(() => setIsOpening(false));
  };

  return (
    <div
      className="flex items-center py-1 pl-2 pr-2 gap-1 cursor-pointer opacity-60 hover:opacity-100"
      title={notFoundLocally ? `${entry.workspaceCollection.path} (not found on disk)` : entry.workspaceCollection.path}
      data-testid="sidebar-unloaded-collection-row"
      onClick={handleClick}
    >
      <IconBox size={16} strokeWidth={1.5} style={{ minWidth: 16 }} />
      <span className="truncate">{name}</span>
      {isOpening ? <IconLoader2 className="animate-spin" size={14} strokeWidth={1.5} /> : null}
      {notFoundLocally ? <span className="text-xs text-muted whitespace-nowrap">not found</span> : null}
    </div>
  );
};

const Collections = ({ showSearch, isCreatingCollection, onCreateClick, onDismissCreate, onOpenAdvancedCreate }) => {
  const [searchText, setSearchText] = useState('');
  const [searchOptions, setSearchOptionsState] = useState(readStoredSearchOptions);

  const setSearchOptions = (nextOptions) => {
    setSearchOptionsState(nextOptions);
    try {
      window.localStorage.setItem(SEARCH_OPTIONS_STORAGE_KEY, JSON.stringify(nextOptions));
    } catch (error) {
      // localStorage unavailable; options stay in-memory for the session
    }
  };
  const { collections, collectionSortOrder } = useSelector((state) => state.collections);
  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);

  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);

  // Pre-build the search index in the background when the search box opens, so
  // the first keystroke matches an already-warm index instead of triggering a
  // full filesystem scan (large workspaces have tens of thousands of files).
  useEffect(() => {
    if (!showSearch || !activeWorkspace?.pathname) {
      return;
    }
    const collectionPaths = (activeWorkspace.collections || []).map((wc) => wc.path).filter(Boolean);
    if (!collectionPaths.length) {
      return;
    }
    window.ipcRenderer.invoke('renderer:warm-workspace-search', {
      workspacePath: activeWorkspace.pathname,
      collectionPaths
    }).catch(() => {});
  }, [showSearch, activeWorkspace?.pathname]);

  // Also warm the search index in the background shortly after a workspace
  // loads — delayed so it never competes with collection opening/indexing at
  // startup. By the time the user first opens search, the index is usually
  // already built (the whole GSB workspace warms in single-digit seconds on
  // the fold worker pool). Once per workspace per session.
  const warmedWorkspacesRef = useRef(new Set());
  useEffect(() => {
    const workspacePath = activeWorkspace?.pathname;
    if (!workspacePath || warmedWorkspacesRef.current.has(workspacePath)) {
      return;
    }
    const collectionPaths = (activeWorkspace.collections || []).map((wc) => wc.path).filter(Boolean);
    if (!collectionPaths.length) {
      return;
    }
    const timer = setTimeout(() => {
      warmedWorkspacesRef.current.add(workspacePath);
      window.ipcRenderer.invoke('renderer:warm-workspace-search', {
        workspacePath,
        collectionPaths
      }).catch(() => {});
    }, 8000);
    return () => clearTimeout(timer);
  }, [activeWorkspace?.pathname, activeWorkspace?.collections]);

  // Warm the COLLECTION indexes too (metadata scans, serialized by the main
  // process; the whole GSB workspace measures ~2s). With indexes prebuilt,
  // the first content search filters instantly instead of triggering
  // on-demand index builds whose streaming batches jank scrolling.
  const dispatch = useDispatch();
  const store = useStore();
  const indexWarmedWorkspacesRef = useRef(new Set());
  useEffect(() => {
    const workspacePath = activeWorkspace?.pathname;
    if (!workspacePath || indexWarmedWorkspacesRef.current.has(workspacePath)) {
      return;
    }
    const timer = setTimeout(() => {
      indexWarmedWorkspacesRef.current.add(workspacePath);
      const state = store.getState().collections;
      for (const collection of state.collections || []) {
        if (!state.collectionIndexes?.[collection.uid]) {
          dispatch(refreshCollectionIndex({ collectionUid: collection.uid })).catch(() => {});
        }
      }
    }, 10000);
    return () => clearTimeout(timer);
  }, [activeWorkspace?.pathname]);

  const nonScratchCollections = useMemo(() => {
    return collections.filter((c) => !isScratchCollection(c, workspaces));
  }, [collections, workspaces]);

  // Build the sidebar list in workspace.yml order by default while keeping Git
  // scoped to the workspace. Every registered collection is listed: loaded
  // ones render the full Collection row, not-yet-loaded ones render a
  // placeholder that opens the collection on click (see buildSidebarEntries).
  const sidebarEntries = useMemo(() => {
    if (!activeWorkspace?.collections?.length) return [];
    return buildSidebarEntries({
      workspaceCollections: activeWorkspace.collections,
      loadedCollections: nonScratchCollections,
      collectionSortOrder
    });
  }, [activeWorkspace, collectionSortOrder, nonScratchCollections]);

  const hasWorkspaceCollections = activeWorkspace?.collections?.length > 0;

  // Content search (>= 2 chars) filters the ordinary sidebar rows instead of
  // rendering a separate results tree — one renderer, one search (Phase 3b).
  const workspaceSearch = useWorkspaceSearch({ searchText, searchOptions, activeWorkspace });

  // During a content search only entries with hits (or a matching collection
  // name) stay in the list; everything else collapses out. Registered-but-
  // unloaded collections with hits keep their placeholder row so search never
  // silently hides a collection the user could open.
  const visibleEntries = useMemo(() => {
    if (!workspaceSearch.isActive) {
      return sidebarEntries.map((entry) => ({ entry, searchMatches: null }));
    }
    return sidebarEntries
      .map((entry) => {
        const entryPath = entry.type === 'loaded' ? entry.collection.pathname : entry.workspaceCollection.path;
        const searchMatches = workspaceSearch.matchesByCollection.get(normalizePath(entryPath)) || null;
        return searchMatches ? { entry, searchMatches } : null;
      })
      .filter(Boolean);
  }, [workspaceSearch.isActive, workspaceSearch.matchesByCollection, sidebarEntries]);

  if (!sidebarEntries.length && !hasWorkspaceCollections) {
    return (
      <StyledWrapper>
        {isCreatingCollection && (
          <InlineCollectionCreator
            onComplete={onDismissCreate}
            onCancel={onDismissCreate}
            onOpenAdvanced={onOpenAdvancedCreate}
          />
        )}
        {!isCreatingCollection && <CreateOrOpenCollection onCreateClick={onCreateClick} />}
      </StyledWrapper>
    );
  }

  return (
    <StyledWrapper data-testid="collections">
      {showSearch && (
        <CollectionSearch
          searchText={searchText}
          setSearchText={setSearchText}
          searchOptions={searchOptions}
          setSearchOptions={setSearchOptions}
        />
      )}

      <div className="collections-list">
        {isCreatingCollection && (
          <InlineCollectionCreator
            onComplete={onDismissCreate}
            onCancel={onDismissCreate}
            onOpenAdvanced={onOpenAdvancedCreate}
          />
        )}
        {workspaceSearch.isActive ? (
          <div className="px-3 py-2 text-xs text-muted flex items-center gap-2">
            {workspaceSearch.status === 'searching'
              ? <IconLoader2 className="animate-spin" size={14} />
              : <IconSearch size={14} />}
            <span>
              {workspaceSearch.status === 'searching'
                ? 'Searching workspace...'
                : `${workspaceSearch.totalResults} result${workspaceSearch.totalResults === 1 ? '' : 's'}`}
            </span>
          </div>
        ) : null}
        {workspaceSearch.isActive && workspaceSearch.error ? (
          <div className="px-4 py-2 text-red-600">{workspaceSearch.error}</div>
        ) : null}
        {visibleEntries.map(({ entry, searchMatches }) => (
          entry.type === 'loaded' ? (
            <Collection
              searchText={searchText}
              searchMatches={searchMatches}
              collection={entry.collection}
              key={entry.key}
            />
          ) : (
            <UnloadedCollection entry={entry} workspacePath={activeWorkspace?.pathname} key={entry.key} />
          )
        ))}
        {workspaceSearch.isActive && workspaceSearch.status === 'ready' && !visibleEntries.length ? (
          <div className="px-4 py-2 text-muted">No matches found.</div>
        ) : null}
      </div>
    </StyledWrapper>
  );
};

export default Collections;
