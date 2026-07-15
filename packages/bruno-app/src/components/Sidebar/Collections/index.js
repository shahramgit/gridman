import React, { useState, useMemo, useEffect, useRef, useDeferredValue, Profiler } from 'react';
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
import { setWorkspaceSearchActive } from 'providers/ReduxStore/slices/app';
import { perfLog } from 'utils/common/perfLogger';

// Attribute sidebar render stalls that don't show up as a redux dispatch:
// React commits (mount/reveal of result rows, example expansion on load) log
// here when they exceed the threshold, so a pasted client log pinpoints
// whether a lag spike is a render and how big — no guessing.
const SIDEBAR_SLOW_COMMIT_MS = 90;
const onSidebarCommit = (id, phase, actualDuration) => {
  if (actualDuration >= SIDEBAR_SLOW_COMMIT_MS) {
    perfLog('slow sidebar commit', { phase, ms: Math.round(actualDuration) });
  }
};

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
  // loads. The fold work runs on a worker-thread pool (off the UI and main
  // threads) and the whole GSB workspace warms in single-digit seconds, so
  // start EARLY — a session's first search pays inline for whatever hasn't
  // warmed yet, which is exactly the 'first search is slow' report. Once per
  // workspace per session.
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
      const warmStart = performance.now();
      perfLog('warm: search-index start', { collections: collectionPaths.length });
      window.ipcRenderer.invoke('renderer:warm-workspace-search', {
        workspacePath,
        collectionPaths
      }).then(() => {
        perfLog('warm: search-index DONE', { afterMs: Math.round(performance.now() - warmStart) });
      }).catch(() => {}).finally(() => {
        // Chain the collection-index warm AFTER the search warm so the two
        // full-workspace scans never race each other (see the eager-attach
        // gate in bruno-electron ipc/collection.js for the third pipeline).
        const state = store.getState().collections;
        let requested = 0;
        for (const collection of state.collections || []) {
          if (!state.collectionIndexes?.[collection.uid]) {
            requested += 1;
            dispatch(refreshCollectionIndex({ collectionUid: collection.uid })).catch(() => {});
          }
        }
        perfLog('warm: collection-indexes start', { requested });
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [activeWorkspace?.pathname, activeWorkspace?.collections]);

  // The collection-index warm (metadata scans) chains after the search warm
  // above — sequenced, not raced, since both read the whole workspace.
  const dispatch = useDispatch();
  const store = useStore();

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

  // Mirror the active-search state into redux so the ipc layer holds background
  // eager-hydration tree updates while results are on screen (each such update
  // re-renders the mounted filtered list; on GSB that was 400-700ms per batch
  // for ~85s while scrolling). Cleared on unmount so hydration resumes.
  useEffect(() => {
    dispatch(setWorkspaceSearchActive(workspaceSearch.isActive));
    return () => { dispatch(setWorkspaceSearchActive(false)); };
  }, [workspaceSearch.isActive, dispatch]);

  // During a content search only entries with hits (or a matching collection
  // name) stay in the list; everything else collapses out. Registered-but-
  // unloaded collections with hits keep their placeholder row so search never
  // silently hides a collection the user could open.
  const liveVisibleEntries = useMemo(() => {
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
  // Every intermediate query prefix matches a different collection SET, so
  // typing swapped whole Collection blocks (headers + filtered rows) in and
  // out per keystroke — deferring the swap keeps typing and scrolling
  // responsive and commits the new list when the frame has room.
  const visibleEntries = useDeferredValue(liveVisibleEntries);

  // GLOBAL row budget across matched collections: a broad prefix like 'تام'
  // matches dozens of collections, and a per-collection cap alone still
  // committed thousands of rows at once (a 45s+ renderer block, measured).
  // Each collection gets an equal slice of ~300 rows, min 5, max 60; the
  // per-collection 'Show N more matches' expander reveals the rest on demand.
  const filterRowAllowance = workspaceSearch.isActive && visibleEntries.length
    ? Math.max(5, Math.min(60, Math.ceil(300 / visibleEntries.length)))
    : null;

  // PROGRESSIVE REVEAL: even budgeted, mounting every matched collection's
  // block in one commit was a single 0.9s (prod) / 2.5s (dev) main-thread
  // task landing exactly when the user starts scrolling the results. In
  // filter mode collections mount a few per animation frame instead, so the
  // browser paints (and scroll stays live) between chunks.
  const REVEAL_CHUNK = 3;
  // Keyed by the QUERY, not the entries array: streaming batches change the
  // array identity constantly, and resetting per batch unmounted/remounted
  // everything beyond the first chunk over and over (measured as ~100
  // back-to-back 130ms stalls). Render-phase derived state (not an effect):
  // a NEW query must start capped in the SAME render, or the first commit
  // mounts everything with the stale count — the giant commit this exists
  // to prevent.
  const revealKey = workspaceSearch.isActive ? searchText.trim() : null;
  const [reveal, setReveal] = useState({ key: null, count: Infinity });
  if (workspaceSearch.isActive && reveal.key !== revealKey) {
    setReveal({ key: revealKey, count: REVEAL_CHUNK });
  }
  const revealCount = workspaceSearch.isActive ? (reveal.key === revealKey ? reveal.count : REVEAL_CHUNK) : Infinity;
  useEffect(() => {
    if (!workspaceSearch.isActive || revealCount >= visibleEntries.length) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      setReveal((current) => (
        current.key === revealKey ? { key: current.key, count: current.count + REVEAL_CHUNK } : current
      ));
    });
    return () => cancelAnimationFrame(raf);
  }, [revealCount, visibleEntries.length, revealKey, workspaceSearch.isActive]);
  const renderedEntries = workspaceSearch.isActive ? visibleEntries.slice(0, revealCount) : visibleEntries;

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
        <Profiler id="sidebar-search" onRender={onSidebarCommit}>
          {renderedEntries.map(({ entry, searchMatches }) => (
            entry.type === 'loaded' ? (
              <Collection
              // Filtering starts with the content search (>= 2 chars). A
              // single character used to trigger the renderer-side name
              // filter across every collection — with plain-row rendering
              // that mounted thousands of rows and froze the first keystroke.
                searchText={workspaceSearch.isActive ? searchText : ''}
                searchMatches={searchMatches}
                filterRowAllowance={filterRowAllowance}
                collection={entry.collection}
                key={entry.key}
              />
            ) : (
              <UnloadedCollection entry={entry} workspacePath={activeWorkspace?.pathname} key={entry.key} />
            )
          ))}
        </Profiler>
        {workspaceSearch.isActive && workspaceSearch.status === 'ready' && !visibleEntries.length ? (
          <div className="px-4 py-2 text-muted">No matches found.</div>
        ) : null}
      </div>
    </StyledWrapper>
  );
};

export default Collections;
