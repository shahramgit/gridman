import React, { useState, useMemo } from 'react';
import { useSelector } from 'react-redux';
import Collection from './Collection';
import StyledWrapper from './StyledWrapper';
import CreateOrOpenCollection from './CreateOrOpenCollection';
import CollectionSearch from './CollectionSearch/index';
import InlineCollectionCreator from './InlineCollectionCreator';
import { normalizePath } from 'utils/common/path';
import { isScratchCollection } from 'utils/collections';

const Collections = ({ showSearch, isCreatingCollection, onCreateClick, onDismissCreate, onOpenAdvancedCreate }) => {
  const [searchText, setSearchText] = useState('');
  const { collections } = useSelector((state) => state.collections);
  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);

  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid) || workspaces.find((w) => w.type === 'default');

  // Build the sidebar list in workspace.yml order while keeping Git scoped to the workspace.
  const sidebarEntries = useMemo(() => {
    if (!activeWorkspace?.collections?.length) return [];

    const loadedByPath = new Map();
    for (const c of collections) {
      if (isScratchCollection(c, workspaces)) continue;
      if (c.pathname) loadedByPath.set(normalizePath(c.pathname), c);
    }

    const entries = [];
    for (const wc of activeWorkspace.collections) {
      if (!wc.path) continue;
      const loaded = loadedByPath.get(normalizePath(wc.path));
      if (loaded) {
        entries.push({ collection: loaded, key: loaded.uid });
      }
    }
    return entries;
  }, [activeWorkspace, collections, workspaces]);

  if (!sidebarEntries.length) {
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
      </div>
    </StyledWrapper>
  );
};

export default Collections;
