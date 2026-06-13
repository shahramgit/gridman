import React, { useState, useMemo } from 'react';
import { useSelector } from 'react-redux';
import Collection from './Collection';
import StyledWrapper from './StyledWrapper';
import CreateOrOpenCollection from './CreateOrOpenCollection';
import CollectionSearch from './CollectionSearch/index';
import InlineCollectionCreator from './InlineCollectionCreator';
import WorkspaceSearchResults from './WorkspaceSearchResults';
import { normalizePath } from 'utils/common/path';
import { isScratchCollection } from 'utils/collections';

const SEARCH_OPTIONS_STORAGE_KEY = 'gridman.sidebar-search-options';

const DEFAULT_SEARCH_OPTIONS = {
  matchCase: false,
  scopes: {
    collections: true,
    names: true,
    url: true,
    headers: true,
    body: true,
    examples: false
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

  const loadedByPath = useMemo(() => {
    const map = new Map();
    for (const c of collections) {
      if (isScratchCollection(c, workspaces)) continue;
      if (c.pathname) map.set(normalizePath(c.pathname), c);
    }
    return map;
  }, [collections, workspaces]);

  // Build the sidebar list in workspace.yml order by default while keeping Git scoped to the workspace.
  const sidebarEntries = useMemo(() => {
    if (!activeWorkspace?.collections?.length) return [];

    const entries = [];
    for (const wc of activeWorkspace.collections) {
      if (!wc.path) continue;
      const loaded = loadedByPath.get(normalizePath(wc.path));
      if (loaded) {
        entries.push({ collection: loaded, key: loaded.uid, type: 'loaded' });
      }
    }

    if (collectionSortOrder === 'alphabetical' || collectionSortOrder === 'reverseAlphabetical') {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      entries.sort((a, b) => {
        const result = collator.compare(a.collection?.name || '', b.collection?.name || '');
        return collectionSortOrder === 'reverseAlphabetical' ? -result : result;
      });
    }

    return entries;
  }, [activeWorkspace, collectionSortOrder, loadedByPath]);

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
            <Collection searchText={searchText} collection={entry.collection} key={entry.key} />
          ))
        )}
      </div>
    </StyledWrapper>
  );
};

export default Collections;
