import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { IconLoader2 } from '@tabler/icons';
import Collection from './Collection';
import StyledWrapper from './StyledWrapper';
import CreateOrOpenCollection from './CreateOrOpenCollection';
import CollectionSearch from './CollectionSearch/index';
import InlineCollectionCreator from './InlineCollectionCreator';
import { normalizePath } from 'utils/common/path';
import { isScratchCollection } from 'utils/collections';
import { mountCollection, openMultipleCollections } from 'providers/ReduxStore/slices/collections/actions';

const Collections = ({ showSearch, isCreatingCollection, onCreateClick, onDismissCreate, onOpenAdvancedCreate }) => {
  const [searchText, setSearchText] = useState('');
  const [isMountingSearchCollections, setIsMountingSearchCollections] = useState(false);
  const openingSearchCollectionPathsRef = useRef(new Set());
  const mountingSearchCollectionPathsRef = useRef(new Set());
  const { collections } = useSelector((state) => state.collections);
  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);
  const dispatch = useDispatch();

  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);

  const updateSearchMountingState = () => {
    setIsMountingSearchCollections(
      openingSearchCollectionPathsRef.current.size > 0 || mountingSearchCollectionPathsRef.current.size > 0
    );
  };

  const loadedByPath = useMemo(() => {
    const map = new Map();
    for (const c of collections) {
      if (isScratchCollection(c, workspaces)) continue;
      if (c.pathname) map.set(normalizePath(c.pathname), c);
    }
    return map;
  }, [collections, workspaces]);

  useEffect(() => {
    const normalizedSearchText = searchText.trim();
    if (!normalizedSearchText || !activeWorkspace?.collections?.length) {
      setIsMountingSearchCollections(false);
      return;
    }

    activeWorkspace.collections.forEach((wc) => {
      if (!wc.path) return;

      const normalizedPath = normalizePath(wc.path);
      const loaded = loadedByPath.get(normalizedPath);
      if (!loaded) {
        if (openingSearchCollectionPathsRef.current.has(normalizedPath)) {
          return;
        }

        openingSearchCollectionPathsRef.current.add(normalizedPath);
        updateSearchMountingState();
        dispatch(openMultipleCollections([wc.path], { workspacePath: activeWorkspace.pathname }))
          .finally(() => {
            openingSearchCollectionPathsRef.current.delete(normalizedPath);
            updateSearchMountingState();
          });
        return;
      }

      if (loaded.mountStatus !== 'mounted' && loaded.mountStatus !== 'mounting') {
        if (mountingSearchCollectionPathsRef.current.has(normalizedPath)) {
          return;
        }

        mountingSearchCollectionPathsRef.current.add(normalizedPath);
        updateSearchMountingState();
        dispatch(mountCollection({
          collectionUid: loaded.uid,
          collectionPathname: loaded.pathname,
          brunoConfig: loaded.brunoConfig
        })).finally(() => {
          mountingSearchCollectionPathsRef.current.delete(normalizedPath);
          updateSearchMountingState();
        });
      }
    });
  }, [activeWorkspace, dispatch, loadedByPath, searchText]);

  // Build the sidebar list in workspace.yml order while keeping Git scoped to the workspace.
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
    return entries;
  }, [activeWorkspace, loadedByPath]);

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
        <CollectionSearch searchText={searchText} setSearchText={setSearchText} />
      )}

      <div className="collections-list">
        {isCreatingCollection && (
          <InlineCollectionCreator
            onComplete={onDismissCreate}
            onCancel={onDismissCreate}
            onOpenAdvanced={onOpenAdvancedCreate}
          />
        )}
        {sidebarEntries.map((entry) => (
          <Collection searchText={searchText} collection={entry.collection} key={entry.key} />
        ))}
        {isMountingSearchCollections && (
          <div className="flex py-1 collection-name items-center">
            <div className="indent-block" style={{ width: 16, minWidth: 16, height: '100%' }}>
              &nbsp;
            </div>
            <IconLoader2 className="animate-spin mx-1" size={16} strokeWidth={1.5} />
            <div className="ml-1 w-full truncate">Loading collections for search...</div>
          </div>
        )}
        {searchText.trim() && !isMountingSearchCollections && !sidebarEntries.length && (
          <div className="px-4 py-2 text-muted">No matches found.</div>
        )}
      </div>
    </StyledWrapper>
  );
};

export default Collections;
