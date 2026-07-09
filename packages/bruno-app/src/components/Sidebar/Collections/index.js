import React, { useState, useMemo, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { IconBox, IconLoader2 } from '@tabler/icons';
import Collection from './Collection';
import StyledWrapper from './StyledWrapper';
import CreateOrOpenCollection from './CreateOrOpenCollection';
import CollectionSearch from './CollectionSearch/index';
import InlineCollectionCreator from './InlineCollectionCreator';
import WorkspaceSearchResults from './WorkspaceSearchResults';
import { openMultipleCollections } from 'providers/ReduxStore/slices/collections/actions';
import { isScratchCollection } from 'utils/collections';
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
        {searchText.trim().length >= 2 ? (
          <WorkspaceSearchResults searchText={searchText} searchOptions={searchOptions} activeWorkspace={activeWorkspace} />
        ) : (
          sidebarEntries.map((entry) => (
            entry.type === 'loaded' ? (
              <Collection searchText={searchText} collection={entry.collection} key={entry.key} />
            ) : (
              <UnloadedCollection entry={entry} workspacePath={activeWorkspace?.pathname} key={entry.key} />
            )
          ))
        )}
      </div>
    </StyledWrapper>
  );
};

export default Collections;
