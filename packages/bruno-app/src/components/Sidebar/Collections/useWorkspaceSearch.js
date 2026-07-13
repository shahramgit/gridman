import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizePath } from 'utils/common/path';

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_RESULT_LIMIT = 250;

// Streams main-process workspace search results (folded content index over
// names/urls/headers/bodies/examples) and groups the hits per collection so
// the sidebar can render itself as a FILTER over the ordinary collection
// rows — search is not a separate renderer (sidebar unification Phase 3b).
//
// Returns:
//   isActive            - a content search is in effect (query >= 2 chars)
//   status              - 'idle' | 'searching' | 'ready' | 'failed'
//   error               - message when status === 'failed'
//   totalResults        - raw hit count across collections
//   matchesByCollection - Map<normalized collection pathname, {
//     collectionMatched  - the collection itself matched (name scope)
//     matchedPathnames   - Set<normalized item pathname>
//     matchMeta          - Map<normalized item pathname, { field, text, type }>
//   }>
//
// A new search keeps the previous results visible until the new session's
// first batch (or an empty 'ready') arrives — clearing eagerly made every
// keystroke flash an empty sidebar.
const useWorkspaceSearch = ({ searchText, searchOptions, activeWorkspace }) => {
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const sessionRef = useRef(null);
  const pendingClearRef = useRef(false);

  const isActive = searchText.trim().length >= 2;

  const collectionPaths = useMemo(() => {
    return (activeWorkspace?.collections || [])
      .map((collection) => collection.path)
      .filter(Boolean);
  }, [activeWorkspace?.collections]);
  // Primitive key so effects don't re-run on unrelated workspace-slice updates
  // (the workspace object identity changes on every config broadcast).
  const collectionPathsKey = collectionPaths.join('\n');

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
        limit: SEARCH_RESULT_LIMIT,
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

  // Per-collection entry objects are kept REFERENTIALLY STABLE across
  // streaming batches: a collection's entry is reused when its hit list did
  // not change, so only the collections a batch actually touched re-filter
  // and re-render. Body/example scopes hit hundreds of files across many
  // collections — rebuilding every entry per batch re-rendered every matched
  // row in the workspace on each batch.
  const prevEntriesRef = useRef(new Map());
  const matchesByCollection = useMemo(() => {
    const grouped = new Map();
    for (const result of results) {
      const collectionKey = normalizePath(result.collectionPathname);
      if (!collectionKey) {
        continue;
      }
      let group = grouped.get(collectionKey);
      if (!group) {
        group = { collectionMatched: false, hits: [] };
        grouped.set(collectionKey, group);
      }
      if (result.type === 'collection') {
        group.collectionMatched = true;
      } else {
        group.hits.push(result);
      }
    }

    const map = new Map();
    for (const [collectionKey, group] of grouped) {
      // Hits only ever append within a search session and are replaced
      // wholesale when a new session's first batch lands, so (session +
      // count + matched flag) identifies the hit list.
      const signature = `${sessionRef.current}:${group.collectionMatched ? 1 : 0}:${group.hits.length}`;
      const previous = prevEntriesRef.current.get(collectionKey);
      if (previous && previous.signature === signature) {
        map.set(collectionKey, previous.entry);
        continue;
      }

      const entry = { collectionMatched: group.collectionMatched, matchedPathnames: new Set(), matchMeta: new Map() };
      for (const result of group.hits) {
        const pathname = normalizePath(result.pathname);
        if (!pathname) {
          continue;
        }
        entry.matchedPathnames.add(pathname);
        // First match per file wins (the main process emits one hit per file).
        if (!entry.matchMeta.has(pathname)) {
          entry.matchMeta.set(pathname, {
            field: result.matchField,
            text: result.matchText,
            type: result.type
          });
        }
      }
      map.set(collectionKey, entry);
    }

    prevEntriesRef.current = new Map(
      [...map.entries()].map(([key, entry]) => {
        const group = grouped.get(key);
        return [key, { entry, signature: `${sessionRef.current}:${group.collectionMatched ? 1 : 0}:${group.hits.length}` }];
      })
    );
    return map;
  }, [results]);

  return {
    isActive,
    status,
    error,
    totalResults: results.length,
    matchesByCollection
  };
};

export default useWorkspaceSearch;
