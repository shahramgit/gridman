import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { getEmptyImage } from 'react-dnd-html5-backend';
import classnames from 'classnames';
import { uuid } from 'utils/common';
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
  IconBook,
  IconSortAZ,
  IconSortZA,
  IconClock
} from '@tabler/icons';
import OpenAPISyncIcon from 'components/Icons/OpenAPISync';
import { toggleCollection, collapseFullCollection } from 'providers/ReduxStore/slices/collections';
import {
  mountCollection,
  moveCollectionAndPersist,
  handleCollectionItemDrop,
  moveCollectionItemByPath,
  pasteItem,
  showInFolder,
  saveCollectionSecurityConfig,
  renameCollection,
  refreshCollectionIndex
} from 'providers/ReduxStore/slices/collections/actions';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { addTab, makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import { setFocusedSidebarPath } from 'providers/ReduxStore/slices/app';
import toast from 'react-hot-toast';
import NewRequest from 'components/Sidebar/NewRequest';
import NewFolder from 'components/Sidebar/NewFolder';
import IndexedCollectionItems, { sortIndexedChildren } from './IndexedCollectionItems';
import ImportIntoFolder from './ImportIntoFolder';
import SearchHighlight from '../SearchHighlight';
import RemoveCollection from './RemoveCollection';
import { isItemAFolder, isItemARequest } from 'utils/collections';
import { getRangeUids } from 'utils/collections/multiSelect';
import { isTabForItemActive } from 'src/selectors/tab';

import StyledWrapper from './StyledWrapper';
import CloneCollection from './CloneCollection';
import { scrollToTheActiveTab } from 'utils/tabs';
import ShareCollection from 'components/ShareCollection/index';
import GenerateDocumentation from './GenerateDocumentation';
import { CollectionItemDragPreview } from './CollectionItem/CollectionItemDragPreview/index';
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

// Search-triggered index requests, deduped at module level: Collection
// components unmount/remount as the filtered list changes per keystroke, so
// a per-instance ref would re-request (and restart) an in-flight index build
// on every keystroke — stretching a ~2s serialized build into a long storm
// of restarted builds whose batches jank scrolling.
const searchIndexRequestedUids = new Set();

const Collection = ({ collection, searchText, searchMatches = null, filterRowAllowance = null }) => {
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
  const store = useStore();
  const isLoading = collection.isLoading;
  const collectionIndex = useSelector((state) => state.collections.collectionIndexes?.[collection.uid]);
  // The indexed renderer is the only renderer (unification Phase 3a). When
  // indexing failed, a retry row renders instead — a collection must never
  // silently render empty.
  const indexFailed = collectionIndex?.status === 'failed';
  const collectionRef = useRef(null);
  // Only count persisted requests and folders; transients and file items
  // (bruno.json, .js scripts) don't affect empty state
  const itemCount = collection.items?.filter((i) => !i.isTransient && (isItemARequest(i) || isItemAFolder(i))).length || 0;

  const isCollectionFocused = useSelector(isTabForItemActive({ itemUid: collection.uid }));
  const { hasCopiedItems } = useSelector((state) => state.app.clipboard);
  const sidebarReveal = useSelector((state) => state.app.sidebarReveal);

  // Multi-select (Postman-style): selection lives here — the common ancestor
  // of both sidebar renderers — because the indexed renderer is virtualized
  // and its rows unmount while scrolled out of view.
  const [selectedItemUids, setSelectedItemUids] = useState(() => new Set());
  // Anchor for shift-click ranges. A ref (not state) so the selection
  // callbacks stay referentially stable for the memoized row components;
  // nothing renders from the anchor itself.
  const lastSelectedUidRef = useRef(null);
  // The visible rows change wholesale on search/collection changes; a stale
  // selection would silently target hidden items, so reset it.
  useEffect(() => {
    setSelectedItemUids(new Set());
    lastSelectedUidRef.current = null;
  }, [searchText, collection.uid]);

  const clearItemSelection = useCallback(() => {
    setSelectedItemUids((current) => (current.size ? new Set() : current));
    lastSelectedUidRef.current = null;
  }, []);

  // ESC clears the multi-selection (bound only while a selection exists)
  useEffect(() => {
    if (!selectedItemUids.size) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        clearItemSelection();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedItemUids.size, clearItemSelection]);

  const toggleItemSelection = useCallback((uid) => {
    setSelectedItemUids((current) => {
      const next = new Set(current);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
    lastSelectedUidRef.current = uid;
  }, []);

  const selectSingleItem = useCallback((uid) => {
    setSelectedItemUids((current) => (current.size === 1 && current.has(uid) ? current : new Set([uid])));
    lastSelectedUidRef.current = uid;
  }, []);

  // Shift-click: select the visible range between the anchor and the target.
  // The indexed renderer passes its visibleUids (from useVisibleRows);
  // getRangeUids falls back to just the target when an endpoint is hidden.
  const selectItemRange = useCallback((targetUid, visibleUids) => {
    const anchorUid = lastSelectedUidRef.current;
    if (!anchorUid) {
      setSelectedItemUids(new Set([targetUid]));
      lastSelectedUidRef.current = targetUid;
      return;
    }

    setSelectedItemUids(new Set(getRangeUids(visibleUids || [], anchorUid, targetUid)));
  }, []);

  const multiSelect = useMemo(() => ({
    selectedItemUids,
    toggleItemSelection,
    selectItemRange,
    selectSingleItem,
    clearItemSelection
  }), [selectedItemUids, toggleItemSelection, selectItemRange, selectSingleItem, clearItemSelection]);

  // Reveal-in-sidebar: mount and expand this collection; the indexed renderer
  // expands the revealed node's ancestor chain and consumes the reveal
  // (pending->false) once it scrolls the row into view. Re-attempts as the
  // collection mounts/indexes so revealing into a just-opened collection
  // works once its data arrives.
  useEffect(() => {
    if (!sidebarReveal?.pending || sidebarReveal.collectionUid !== collection.uid) {
      return;
    }

    // A freshly opened collection needs mounting before its tree exists.
    ensureCollectionIsMounted();

    if (collection.collapsed) {
      dispatch(toggleCollection(collection.uid));
    }
  }, [sidebarReveal?.nonce, sidebarReveal?.pending, collection.mountStatus, collectionIndex?.totalNodes]);
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

  // Content-search hits target this collection but its index has no data yet
  // (missing entirely, or still queued behind the startup warm-up builds).
  // Request a PRIORITY, INDEX-ONLY build so the filtered rows can render —
  // NOT a full mount: mounting eagerly hydrates small collections (parses
  // every file), and a common search term matching dozens of collections at
  // once turned that into a hydration storm that froze the app. The index
  // scan is metadata only, serialized by the main process, and the priority
  // flag jumps the warm-up queue. Requested once per collection; clicking a
  // row still mounts/hydrates on demand.
  const indexHasNoDataYet = !collectionIndex
    || (collectionIndex.status === 'indexing' && !collectionIndex.totalNodes && !collectionIndex.totalScanned);
  useEffect(() => {
    if (searchMatches && indexHasNoDataYet && !searchIndexRequestedUids.has(collection.uid)) {
      searchIndexRequestedUids.add(collection.uid);
      dispatch(refreshCollectionIndex({ collectionUid: collection.uid, priority: true })).catch(() => {
        searchIndexRequestedUids.delete(collection.uid);
      });
    }
  }, [Boolean(searchMatches), indexHasNoDataYet, collection.uid]);

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

  // Sort the collection's root-level children through the same resequence
  // path folders use (index parent key 'root' = the collection root).
  const handleSortCollectionChildren = (mode = 'name-asc') => {
    ensureCollectionIsMounted();
    return sortIndexedChildren({ store, dispatch, collectionUid: collection.uid, parentKey: 'root', mode });
  };

  // Retry row action when indexing failed — re-runs the main-process index.
  const handleRetryIndex = () => {
    ensureCollectionIsMounted();
    dispatch(refreshCollectionIndex({ collectionUid: collection.uid, priority: true })).catch((err) => {
      toast.error(err?.message || 'Unable to re-index the collection');
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
    drop: (draggedPayload, monitor) => {
      const itemType = monitor.getItemType();
      if (isCollectionItem(itemType)) {
        // A multi-select drag carries one entry per selected item; a plain
        // drag is handled as a single-entry group so both share one path.
        const draggedItems = draggedPayload.isMultiSelect && Array.isArray(draggedPayload.items)
          ? draggedPayload.items
          : [draggedPayload];

        const moveSequentially = async () => {
          for (const draggedItem of draggedItems) {
            const isCrossCollection = draggedItem.sourceCollectionUid && draggedItem.sourceCollectionUid !== collection.uid;
            const isPathOnlyDragItem = Boolean(draggedItem.sourcePathname) && !draggedItem.filename;
            if (isCrossCollection || isPathOnlyDragItem) {
              await dispatch(moveCollectionItemByPath({
                sourceCollectionUid: draggedItem.sourceCollectionUid || collection.uid,
                targetCollectionUid: collection.uid,
                sourcePathname: draggedItem.sourcePathname || draggedItem.pathname,
                targetPathname: collection.pathname,
                dropType: 'inside'
              }));
            } else {
              await dispatch(handleCollectionItemDrop({ targetItem: collection, draggedItem, dropType: 'inside', collectionUid: collection.uid }));
            }
          }
        };

        moveSequentially()
          .then(() => {
            if (draggedItems.length > 1) {
              clearItemSelection();
              toast.success(`Moved ${draggedItems.length} items`);
            }
          })
          .catch((error) => {
            toast.error(error?.message || 'Unable to move item');
          });
      } else {
        dispatch(moveCollectionAndPersist({ draggedItem: draggedPayload, targetItem: collection }));
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

  if (searchText && searchText.length && !searchMatches) {
    // Renderer-side name filter (short queries; content searches pass
    // searchMatches and are already filtered by the parent). The index is
    // authoritative for visibility; collections with a missing/failed/
    // still-building index stay visible so search never silently hides one.
    if (collectionIndex && collectionIndex.status !== 'failed') {
      const normalizedSearchText = searchText.trim().toLowerCase();
      const collectionMatches = collection.name?.toLowerCase?.().includes(normalizedSearchText);
      if (collectionIndex.status === 'indexing' || collectionIndex.status === 'queued') {
        // Keep the collection visible while its metadata index is still building;
        // hiding it early makes unopened large collections look unsearchable.
      } else if (!collectionMatches && !Object.keys(collectionIndex.nodesByUid || {}).length) {
        return null;
      }
    }
  }

  const collectionRowClassName = classnames('flex py-1 collection-name items-center', {
    'item-hovered': isOver && dropType === 'adjacent', // For collection-to-collection moves (show line)
    'drop-target': isOver && dropType === 'inside', // For collection-item drops (highlight full area)
    'collection-focused-in-tab': isCollectionFocused && !isKeyboardFocused,
    'collection-keyboard-focused': isKeyboardFocused
  });

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
      id: 'sort',
      leftSection: IconSortAZ,
      label: 'Sort',
      submenu: [
        { id: 'sort-az', leftSection: IconSortAZ, label: 'Name (A→Z)', onClick: () => handleSortCollectionChildren('name-asc') },
        { id: 'sort-za', leftSection: IconSortZA, label: 'Name (Z→A)', onClick: () => handleSortCollectionChildren('name-desc') },
        { id: 'sort-created', leftSection: IconClock, label: 'Created (oldest first)', onClick: () => handleSortCollectionChildren('created-asc') }
      ]
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
            {indexFailed ? (
              <div className="text-xs text-muted ml-8 py-1">
                Failed to load collection items.
                <button className="ml-1 add-request-link" onClick={handleRetryIndex}>
                  Retry
                </button>
              </div>
            ) : collectionIndex ? (
              <IndexedCollectionItems
                collectionUid={collection.uid}
                searchText={searchText}
                searchMatches={searchMatches}
                filterRowAllowance={filterRowAllowance}
                multiSelect={multiSelect}
              />
            ) : (
              <div className="text-xs text-muted ml-8 py-1">Loading collection...</div>
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
