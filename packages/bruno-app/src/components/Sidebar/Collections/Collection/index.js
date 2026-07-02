import React, { useState, useRef, useEffect } from 'react';
import { getEmptyImage } from 'react-dnd-html5-backend';
import classnames from 'classnames';
import { uuid } from 'utils/common';
import filter from 'lodash/filter';
import { useDrop, useDrag } from 'react-dnd';
import {
  IconChevronRight,
  IconDots,
  IconLoader2,
  IconFilePlus,
  IconFolderPlus,
  IconCopy,
  IconClipboard,
  IconPlayerPlay,
  IconEdit,
  IconShare,
  IconFileImport,
  IconFoldDown,
  IconX,
  IconSettings,
  IconTerminal2,
  IconFolder,
  IconBook
} from '@tabler/icons';
import OpenAPISyncIcon from 'components/Icons/OpenAPISync';
import { toggleCollection, collapseFullCollection, toggleCollectionItem } from 'providers/ReduxStore/slices/collections';
import {
  mountCollection,
  moveCollectionAndPersist,
  handleCollectionItemDrop,
  moveCollectionItemByPath,
  pasteItem,
  showInFolder,
  saveCollectionSecurityConfig,
  renameCollection
} from 'providers/ReduxStore/slices/collections/actions';
import { useDispatch, useSelector } from 'react-redux';
import { addTab, makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import { setFocusedSidebarPath } from 'providers/ReduxStore/slices/app';
import toast from 'react-hot-toast';
import NewRequest from 'components/Sidebar/NewRequest';
import NewFolder from 'components/Sidebar/NewFolder';
import CollectionItem from './CollectionItem';
import IndexedCollectionItems from './IndexedCollectionItems';
import ImportIntoFolder from './ImportIntoFolder';
import SearchHighlight from '../SearchHighlight';
import RemoveCollection from './RemoveCollection';
import { doesCollectionHaveItemsMatchingSearchText } from 'utils/collections/search';
import { isItemAFolder, isItemARequest, areItemsLoading, flattenItems, findParentItemInCollection } from 'utils/collections';
import { isTabForItemActive } from 'src/selectors/tab';

import StyledWrapper from './StyledWrapper';
import CloneCollection from './CloneCollection';
import { scrollToTheActiveTab } from 'utils/tabs';
import ShareCollection from 'components/ShareCollection/index';
import GenerateDocumentation from './GenerateDocumentation';
import { CollectionItemDragPreview } from './CollectionItem/CollectionItemDragPreview/index';
import { sortByNameThenSequence } from 'utils/common/index';
import { getRevealInFolderLabel } from 'utils/common/platform';
import { openDevtoolsAndSwitchToTerminal } from 'utils/terminal';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import StatusBadge from 'ui/StatusBadge';
import { useBetaFeature, BETA_FEATURES } from 'utils/beta-features';
import { useSidebarAccordion } from 'components/Sidebar/SidebarAccordionContext';
import { createEmptyStateMenuItems } from 'utils/collections/emptyStateRequest';
import useKeybinding from 'hooks/useKeybinding';

// Delay before showing empty collection state (ms)
// This prevents flicker from race condition between loading state and item batch updates
const EMPTY_STATE_DELAY_MS = 300;

const Collection = ({ collection, searchText }) => {
  const isOpenAPISyncEnabled = useBetaFeature(BETA_FEATURES.OPENAPI_SYNC);
  const { dropdownContainerRef } = useSidebarAccordion();
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showNewRequestModal, setShowNewRequestModal] = useState(false);
  const [isInlineRenaming, setIsInlineRenaming] = useState(false);
  const [inlineRenameValue, setInlineRenameValue] = useState('');
  const [showCloneCollectionModalOpen, setShowCloneCollectionModalOpen] = useState(false);
  const [showShareCollectionModal, setShowShareCollectionModal] = useState(false);
  const [showImportIntoCollectionModal, setShowImportIntoCollectionModal] = useState(false);
  const [showGenerateDocumentationModal, setShowGenerateDocumentationModal] = useState(false);
  const [showRemoveCollectionModal, setShowRemoveCollectionModal] = useState(false);
  const [dropType, setDropType] = useState(null);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const [showEmptyState, setShowEmptyState] = useState(false);
  const dispatch = useDispatch();
  const isLoading = collection.isLoading;
  const collectionIndex = useSelector((state) => state.collections.collectionIndexes?.[collection.uid]);
  const collectionRef = useRef(null);
  // Only count persisted requests and folders; transients and file items
  // (bruno.json, .js scripts) don't affect empty state
  const itemCount = collection.items?.filter((i) => !i.isTransient && (isItemARequest(i) || isItemAFolder(i))).length || 0;

  const isCollectionFocused = useSelector(isTabForItemActive({ itemUid: collection.uid }));
  const { hasCopiedItems } = useSelector((state) => state.app.clipboard);
  const sidebarReveal = useSelector((state) => state.app.sidebarReveal);

  // Reveal-in-sidebar: expand this collection and (for classic trees) the
  // collapsed ancestor folders of the revealed request. Scrolling is handled
  // by the row components; the indexed renderer expands its own node chain.
  // Re-attempts as the collection hydrates/indexes (deps include the tree
  // and index), so revealing into a just-opened collection works once its
  // data arrives. The reveal is consumed (pending->false) by the row that
  // scrolls, so this stops re-firing afterwards.
  useEffect(() => {
    if (!sidebarReveal?.pending || sidebarReveal.collectionUid !== collection.uid) {
      return;
    }

    // A freshly opened collection needs mounting before its tree exists.
    ensureCollectionIsMounted();

    if (collection.collapsed) {
      dispatch(toggleCollection(collection.uid));
    }

    // The indexed renderer expands its own node chain and consumes the reveal.
    if (collectionIndex) {
      return;
    }

    const normalizeSeparators = (value) => String(value || '').replace(/\\/g, '/');
    const revealedItem = flattenItems(collection.items)
      .find((candidate) => normalizeSeparators(candidate.pathname) === normalizeSeparators(sidebarReveal.pathname));
    if (!revealedItem) {
      return;
    }

    let currentItem = findParentItemInCollection(collection, revealedItem.uid);
    while (currentItem?.type === 'folder') {
      if (currentItem.collapsed) {
        dispatch(toggleCollectionItem({ collectionUid: collection.uid, itemUid: currentItem.uid }));
      }
      currentItem = findParentItemInCollection(collection, currentItem.uid);
    }
  }, [sidebarReveal?.nonce, sidebarReveal?.pending, collection.items, collection.mountStatus, collectionIndex?.totalNodes]);
  const menuDropdownRef = useRef(null);

  // Open the OpenAPI Sync tab
  const openOpenAPISyncTab = () => {
    ensureCollectionIsMounted();
    dispatch(
      addTab({
        uid: uuid(),
        collectionUid: collection.uid,
        type: 'openapi-sync'
      })
    );
  };

  const handleRun = () => {
    dispatch(
      addTab({
        uid: uuid(),
        collectionUid: collection.uid,
        type: 'collection-runner'
      })
    );
  };

  const ensureCollectionIsMounted = () => {
    if (collection.mountStatus === 'mounted' || collection.mountStatus === 'mounting') {
      return;
    }
    dispatch(mountCollection({
      collectionUid: collection.uid,
      collectionPathname: collection.pathname,
      brunoConfig: collection.brunoConfig
    }));
  };

  const hasSearchText = searchText && searchText?.trim()?.length;
  const collectionIsCollapsed = hasSearchText ? false : collection.collapsed;

  const iconClassName = classnames({
    'rotate-90': !collectionIsCollapsed
  });

  const handleClick = (event) => {
    if (event.detail != 1) return;
    // Check if the click came from the chevron icon
    const isChevronClick = event.target.closest('svg')?.classList.contains('chevron-icon');
    setTimeout(scrollToTheActiveTab, 50);

    ensureCollectionIsMounted();

    if (collection.collapsed) {
      dispatch(toggleCollection(collection.uid));
      // Set default jsSandboxMode to 'safe' if not present and save to disk
      if (!collection.securityConfig?.jsSandboxMode) {
        dispatch(saveCollectionSecurityConfig(collection.uid, {
          jsSandboxMode: 'safe'
        }));
      }
    }

    if (!isChevronClick) {
      dispatch(
        addTab({
          uid: collection.uid,
          collectionUid: collection.uid,
          type: 'collection-settings'
        })
      );
    }
  };

  const handleDoubleClick = (_event) => {
    dispatch(makeTabPermanent({ uid: collection.uid }));
  };

  const handleCollectionCollapse = (e) => {
    e.stopPropagation();
    e.preventDefault();
    ensureCollectionIsMounted();
    dispatch(toggleCollection(collection.uid));
  };

  // prevent the parent's double-click handler from firing
  const handleCollectionDoubleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const startInlineRename = () => {
    setInlineRenameValue(collection.name);
    setIsInlineRenaming(true);
  };

  const cancelInlineRename = () => {
    setIsInlineRenaming(false);
    setInlineRenameValue('');
  };

  const commitInlineRename = () => {
    const newName = (inlineRenameValue || '').trim();
    if (!isInlineRenaming) return;
    if (!newName || newName === collection.name) {
      cancelInlineRename();
      return;
    }
    dispatch(renameCollection(newName, collection.uid))
      .then(() => {
        toast.success('Collection renamed!');
      })
      .catch((err) => {
        toast.error(err ? err.message : 'An error occurred while renaming the collection');
      });
    cancelInlineRename();
  };

  const handleRightClick = (event) => {
    event.preventDefault();
    menuDropdownRef.current?.show();
  };

  const handleCollapseFullCollection = () => {
    dispatch(collapseFullCollection({ collectionUid: collection.uid }));
  };

  const viewCollectionSettings = () => {
    dispatch(
      addTab({
        uid: collection.uid,
        collectionUid: collection.uid,
        type: 'collection-settings'
      })
    );
  };

  const handleShowInFolder = () => {
    dispatch(showInFolder(collection.pathname)).catch((error) => {
      console.error('Error opening the folder', error);
      toast.error('Error opening the folder');
    });
  };

  const handlePasteItem = () => {
    dispatch(pasteItem(collection.uid, null))
      .then(() => {
        toast.success('Item pasted successfully');
      })
      .catch((err) => {
        toast.error(err ? err.message : 'An error occurred while pasting the item');
      });
  };

  // Sidebar shortcuts — only active when this collection has keyboard focus
  useKeybinding('cloneItem', () => {
    setShowCloneCollectionModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('renameItem', () => {
    startInlineRename();
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('pasteItem', () => {
    handlePasteItem();
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  const handleFocus = () => {
    setIsKeyboardFocused(true);
    dispatch(setFocusedSidebarPath(collection.pathname));
  };

  const handleBlur = () => {
    setIsKeyboardFocused(false);
    dispatch(setFocusedSidebarPath(null));
  };

  const isCollectionItem = (itemType) => {
    return itemType === 'collection-item';
  };

  const [{ isDragging }, drag, dragPreview] = useDrag({
    type: 'collection',
    item: collection,
    collect: (monitor) => ({
      isDragging: monitor.isDragging()
    }),
    options: {
      dropEffect: 'move'
    }
  });

  const [{ isOver }, drop] = useDrop({
    accept: ['collection', 'collection-item'],
    hover: (_draggedItem, monitor) => {
      const itemType = monitor.getItemType();
      if (isCollectionItem(itemType)) {
        // For collection items, always show full highlight (inside drop)
        setDropType('inside');
      } else {
        // For collections, show line indicator (adjacent drop)
        setDropType('adjacent');
      }
    },
    drop: (draggedItem, monitor) => {
      const itemType = monitor.getItemType();
      if (isCollectionItem(itemType)) {
        const isCrossCollection = draggedItem.sourceCollectionUid && draggedItem.sourceCollectionUid !== collection.uid;
        const isPathOnlyDragItem = Boolean(draggedItem.sourcePathname) && !draggedItem.filename;
        if (isCrossCollection || isPathOnlyDragItem) {
          dispatch(moveCollectionItemByPath({
            sourceCollectionUid: draggedItem.sourceCollectionUid || collection.uid,
            targetCollectionUid: collection.uid,
            sourcePathname: draggedItem.sourcePathname || draggedItem.pathname,
            targetPathname: collection.pathname,
            dropType: 'inside'
          })).catch((error) => {
            toast.error(error?.message || 'Unable to move item');
          });
        } else {
          dispatch(handleCollectionItemDrop({ targetItem: collection, draggedItem, dropType: 'inside', collectionUid: collection.uid }));
        }
      } else {
        dispatch(moveCollectionAndPersist({ draggedItem, targetItem: collection }));
      }
      setDropType(null);
    },
    canDrop: (draggedItem) => {
      return draggedItem.uid !== collection.uid;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver()
    })
  });

  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, []);

  useEffect(() => {
    if (isCollectionFocused && collectionRef.current) {
      try {
        collectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        // ignore scroll errors
      }
    }
  }, [isCollectionFocused]);

  // Debounce showing empty state to prevent flicker
  // Race condition: isLoading can become false before items batch arrives from IPC
  useEffect(() => {
    const isMounted = collection.mountStatus === 'mounted';
    const hasItems = itemCount > 0;

    if (hasItems || isLoading || !isMounted) {
      setShowEmptyState(false);
      return;
    }

    const timer = setTimeout(() => setShowEmptyState(true), EMPTY_STATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [itemCount, isLoading, collection.mountStatus]);

  if (searchText && searchText.length) {
    if (collectionIndex) {
      const normalizedSearchText = searchText.trim().toLowerCase();
      const collectionMatches = collection.name?.toLowerCase?.().includes(normalizedSearchText);
      if (collectionIndex.status === 'indexing' || collectionIndex.status === 'queued') {
        // Keep the collection visible while its metadata index is still building;
        // hiding it early makes unopened large collections look unsearchable.
      } else if (!collectionMatches && !Object.keys(collectionIndex.nodesByUid || {}).length) {
        return null;
      }
    } else if (!doesCollectionHaveItemsMatchingSearchText(collection, searchText)) {
      return null;
    }
  }

  const collectionRowClassName = classnames('flex py-1 collection-name items-center', {
    'item-hovered': isOver && dropType === 'adjacent', // For collection-to-collection moves (show line)
    'drop-target': isOver && dropType === 'inside', // For collection-item drops (highlight full area)
    'collection-focused-in-tab': isCollectionFocused && !isKeyboardFocused,
    'collection-keyboard-focused': isKeyboardFocused
  });

  // we need to sort request items by seq property
  const sortItemsBySequence = (items = []) => {
    return items.sort((a, b) => a.seq - b.seq);
  };

  const requestItems = sortItemsBySequence(filter(collection.items, (i) => isItemARequest(i) && !i.isTransient));
  const folderItems = sortByNameThenSequence(filter(collection.items, (i) => isItemAFolder(i) && !i.isTransient));
  const showEmptyCollectionMessage = showEmptyState && !hasSearchText;

  const emptyStateMenuItems = createEmptyStateMenuItems({ dispatch, collection, itemUid: null });

  const menuItems = [
    {
      id: 'new-request',
      leftSection: IconFilePlus,
      label: 'New Request',
      onClick: () => {
        ensureCollectionIsMounted();
        setShowNewRequestModal(true);
      }
    },
    {
      id: 'new-folder',
      leftSection: IconFolderPlus,
      label: 'New Folder',
      onClick: () => {
        ensureCollectionIsMounted();
        setShowNewFolderModal(true);
      }
    },
    {
      id: 'run',
      leftSection: IconPlayerPlay,
      label: 'Run',
      onClick: () => {
        ensureCollectionIsMounted();
        handleRun();
      }
    },
    {
      id: 'clone',
      leftSection: IconCopy,
      label: 'Clone',
      testId: 'clone-collection',
      onClick: () => {
        setShowCloneCollectionModalOpen(true);
      }
    },
    ...(isOpenAPISyncEnabled ? [{
      id: 'sync-openapi',
      leftSection: OpenAPISyncIcon,
      label: 'OpenAPI',
      rightSection: <StatusBadge status="info" size="xs">Beta</StatusBadge>,
      onClick: openOpenAPISyncTab
    }] : []),
    ...(hasCopiedItems
      ? [
          {
            id: 'paste',
            leftSection: IconClipboard,
            label: 'Paste',
            onClick: handlePasteItem
          }
        ]
      : []),
    {
      id: 'rename',
      leftSection: IconEdit,
      label: 'Rename',
      onClick: () => {
        startInlineRename();
      }
    },
    {
      id: 'share',
      leftSection: IconShare,
      label: 'Share',
      onClick: () => {
        ensureCollectionIsMounted();
        setShowShareCollectionModal(true);
      }
    },
    {
      id: 'import',
      leftSection: IconFileImport,
      label: 'Import',
      onClick: () => {
        ensureCollectionIsMounted();
        setShowImportIntoCollectionModal(true);
      }
    },
    {
      id: 'generate-docs',
      leftSection: IconBook,
      label: 'Generate Docs',
      onClick: () => {
        ensureCollectionIsMounted();
        setShowGenerateDocumentationModal(true);
      }
    },
    {
      id: 'collapse',
      leftSection: IconFoldDown,
      label: 'Collapse',
      onClick: handleCollapseFullCollection
    },
    {
      id: 'show-in-folder',
      leftSection: IconFolder,
      label: getRevealInFolderLabel(),
      onClick: handleShowInFolder
    },
    {
      id: 'divider-1',
      type: 'divider'
    },
    {
      id: 'settings',
      leftSection: IconSettings,
      label: 'Settings',
      onClick: viewCollectionSettings
    },
    {
      id: 'terminal',
      leftSection: IconTerminal2,
      label: 'Open in Terminal',
      onClick: async () => {
        const collectionCwd = collection.pathname;
        await openDevtoolsAndSwitchToTerminal(dispatch, collectionCwd);
      }
    },
    {
      id: 'remove',
      leftSection: IconX,
      label: 'Remove',
      onClick: () => {
        setShowRemoveCollectionModal(true);
      }
    }
  ];

  return (
    <StyledWrapper className="flex flex-col" id={`collection-${collection.name.replace(/\s+/g, '-').toLowerCase()}`}>
      {showNewRequestModal && <NewRequest collectionUid={collection.uid} onClose={() => setShowNewRequestModal(false)} />}
      {showNewFolderModal && <NewFolder collectionUid={collection.uid} onClose={() => setShowNewFolderModal(false)} />}
      {showRemoveCollectionModal && (
        <RemoveCollection collectionUid={collection.uid} onClose={() => setShowRemoveCollectionModal(false)} />
      )}
      {showShareCollectionModal && (
        <ShareCollection collectionUid={collection.uid} onClose={() => setShowShareCollectionModal(false)} />
      )}
      {showImportIntoCollectionModal && (
        <ImportIntoFolder
          collectionUid={collection.uid}
          targetDirectory={collection.pathname}
          targetName={collection.name}
          onClose={() => setShowImportIntoCollectionModal(false)}
        />
      )}
      {showGenerateDocumentationModal && (
        <GenerateDocumentation collectionUid={collection.uid} onClose={() => setShowGenerateDocumentationModal(false)} />
      )}
      {showCloneCollectionModalOpen && (
        <CloneCollection collectionUid={collection.uid} onClose={() => setShowCloneCollectionModalOpen(false)} />
      )}
      <CollectionItemDragPreview />
      <div
        className={collectionRowClassName}
        ref={(node) => {
          collectionRef.current = node;
          drag(drop(node));
        }}
        tabIndex={0}
        onFocus={handleFocus}
        onBlur={handleBlur}
        data-testid="sidebar-collection-row"
      >
        <div
          className="flex flex-grow items-center overflow-hidden"
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleRightClick}
        >
          <ActionIcon style={{ width: 16, minWidth: 16 }}>
            <IconChevronRight
              size={16}
              strokeWidth={2}
              className={`chevron-icon ${iconClassName}`}
              style={{ width: 16, minWidth: 16, color: 'rgb(160 160 160)' }}
              onClick={handleCollectionCollapse}
              onDoubleClick={handleCollectionDoubleClick}
            />
          </ActionIcon>
          <div className="ml-1 w-full" id="sidebar-collection-name" title={collection.name}>
            {isInlineRenaming ? (
              <input
                type="text"
                className="inline-rename-input w-full"
                value={inlineRenameValue}
                autoFocus
                spellCheck="false"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => setInlineRenameValue(e.target.value)}
                onBlur={commitInlineRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitInlineRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelInlineRename();
                  }
                }}
              />
            ) : (
              <SearchHighlight text={collection.name} searchText={searchText} />
            )}
          </div>
          {isLoading ? <IconLoader2 className="animate-spin mx-1" size={18} strokeWidth={1.5} /> : null}
        </div>
        <div>
          <div className="pr-2">
            <MenuDropdown
              ref={menuDropdownRef}
              items={menuItems}
              placement="bottom-start"
              appendTo={dropdownContainerRef?.current || document.body}
              popperOptions={{ strategy: 'fixed' }}
              data-testid="collection-actions"
            >
              <ActionIcon className="collection-actions">
                <IconDots size={18} />
              </ActionIcon>
            </MenuDropdown>
          </div>
        </div>
      </div>
      <div>
        {!collectionIsCollapsed ? (
          <div>
            {collectionIndex ? (
              <IndexedCollectionItems collectionUid={collection.uid} searchText={searchText} />
            ) : (
              <>
                {folderItems?.map?.((i) => {
                  return <CollectionItem key={i.uid} item={i} collectionUid={collection.uid} collectionPathname={collection.pathname} searchText={searchText} />;
                })}
                {requestItems?.map?.((i) => {
                  return <CollectionItem key={i.uid} item={i} collectionUid={collection.uid} collectionPathname={collection.pathname} searchText={searchText} />;
                })}
              </>
            )}
            {showEmptyCollectionMessage ? (
              <div className="empty-collection-message">
                <div className="indent-block" style={{ width: 16, minWidth: 16, height: '100%' }}>
                  &nbsp;
                </div>
                <div style={{ paddingLeft: 8 }}>
                  <MenuDropdown
                    data-testid="add-request-cta"
                    items={emptyStateMenuItems}
                    placement="bottom-start"
                    appendTo={dropdownContainerRef?.current || document.body}
                    popperOptions={{ strategy: 'fixed' }}
                  >
                    <button className="ml-1 add-request-link">+ Add request</button>
                  </MenuDropdown>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </StyledWrapper>
  );
};

export default Collection;
