import React, { useState, useRef, useEffect } from 'react';
import { getEmptyImage } from 'react-dnd-html5-backend';
import range from 'lodash/range';
import filter from 'lodash/filter';
import classnames from 'classnames';
import { useDrag, useDrop } from 'react-dnd';
import {
  IconChevronRight,
  IconDots,
  IconFilePlus,
  IconFolderPlus,
  IconPlayerPlay,
  IconEdit,
  IconCopy,
  IconClipboard,
  IconCode,
  IconFolder,
  IconTrash,
  IconSettings,
  IconInfoCircle,
  IconTerminal2,
  IconFileExport,
  IconFileImport
} from '@tabler/icons';
import { useSelector, useDispatch } from 'react-redux';
import { addTab, focusTab, makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import {
  handleCollectionItemDrop,
  moveCollectionItemByPath,
  sendRequest,
  showInFolder,
  pasteItem,
  saveRequest
} from 'providers/ReduxStore/slices/collections/actions';
import { toggleCollectionItem, addResponseExample } from 'providers/ReduxStore/slices/collections';
import { insertTaskIntoQueue } from 'providers/ReduxStore/slices/app';
import { uuid } from 'utils/common';
import { clearSidebarReveal, copyRequest, setFocusedSidebarPath } from 'providers/ReduxStore/slices/app';
import NewRequest from 'components/Sidebar/NewRequest';
import NewFolder from 'components/Sidebar/NewFolder';
import SearchHighlight from '../../SearchHighlight';
import RenameCollectionItem from './RenameCollectionItem';
import CloneCollectionItem from './CloneCollectionItem';
import DeleteCollectionItem from './DeleteCollectionItem';
import RunCollectionItem from './RunCollectionItem';
import GenerateCodeItem from './GenerateCodeItem';
import ExportFolder from './ExportFolder';
import ImportIntoFolder from '../ImportIntoFolder';
import { isItemARequest, isItemAFolder } from 'utils/tabs';
import { doesRequestMatchSearchText, doesFolderHaveItemsMatchSearchText } from 'utils/collections/search';
import { getDefaultRequestPaneTab } from 'utils/collections';
import toast from 'react-hot-toast';
import StyledWrapper from './StyledWrapper';
import NetworkError from 'components/ResponsePane/NetworkError/index';
import CollectionItemInfo from './CollectionItemInfo/index';
import CollectionItemIcon from './CollectionItemIcon';
import ExampleItem from './ExampleItem';
import ExampleIcon from 'components/Icons/ExampleIcon';
import { scrollToTheActiveTab } from 'utils/tabs';
import { isTabForItemActive as isTabForItemActiveSelector, isTabForItemPresent as isTabForItemPresentSelector } from 'src/selectors/tab';
import { isEqual } from 'lodash';
import { createEmptyStateMenuItems } from 'utils/collections/emptyStateRequest';
import { calculateDraggedItemNewPathname, getInitialExampleName, findParentItemInCollection, findItemInCollection, flattenItems } from 'utils/collections/index';
import { excludeDescendantItems } from 'utils/collections/multiSelect';
import { sortByNameThenSequence } from 'utils/common/index';
import { getRevealInFolderLabel } from 'utils/common/platform';
import { openDevtoolsAndSwitchToTerminal } from 'utils/terminal';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import { useSidebarAccordion } from 'components/Sidebar/SidebarAccordionContext';
import useKeybinding from 'hooks/useKeybinding';

const CollectionItem = ({ item, collectionUid, collectionPathname, searchText, multiSelect }) => {
  const { dropdownContainerRef } = useSidebarAccordion();
  const _isTabForItemActiveSelector = isTabForItemActiveSelector({ itemUid: item.uid });
  const isTabForItemActive = useSelector(_isTabForItemActiveSelector, isEqual);

  const _isTabForItemPresentSelector = isTabForItemPresentSelector({ itemUid: item.uid });
  const isTabForItemPresent = useSelector(_isTabForItemPresentSelector, isEqual);

  const isSidebarDragging = useSelector((state) => state.app.isDragging);
  const collection = useSelector((state) => state.collections.collections?.find((c) => c.uid === collectionUid));
  const { hasCopiedItems } = useSelector((state) => state.app.clipboard);
  const dispatch = useDispatch();

  // We use a single ref for drag and drop.
  const ref = useRef(null);
  const menuDropdownRef = useRef(null);

  const [renameItemModalOpen, setRenameItemModalOpen] = useState(false);
  const [cloneItemModalOpen, setCloneItemModalOpen] = useState(false);
  const [deleteItemModalOpen, setDeleteItemModalOpen] = useState(false);
  const [generateCodeItemModalOpen, setGenerateCodeItemModalOpen] = useState(false);
  const [newRequestModalOpen, setNewRequestModalOpen] = useState(false);
  const [newFolderModalOpen, setNewFolderModalOpen] = useState(false);
  const [runCollectionModalOpen, setRunCollectionModalOpen] = useState(false);
  const [itemInfoModalOpen, setItemInfoModalOpen] = useState(false);
  const [exportFolderModalOpen, setExportFolderModalOpen] = useState(false);
  const [importIntoFolderModalOpen, setImportIntoFolderModalOpen] = useState(false);
  const [examplesExpanded, setExamplesExpanded] = useState(false);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const hasSearchText = searchText && searchText?.trim()?.length;
  const itemIsCollapsed = hasSearchText ? false : item.collapsed;
  const isFolder = isItemAFolder(item);

  // Check if request has examples (only for HTTP requests)
  const hasExamples = isItemARequest(item) && item.type === 'http-request' && item.examples && item.examples.length > 0;

  // Sidebar shortcuts — only active when this sidebar item has keyboard focus
  useKeybinding('cloneItem', () => {
    setCloneItemModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('copyItem', () => {
    handleCopyItem();
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('pasteItem', () => {
    handlePasteItem();
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('renameItem', () => {
    setRenameItemModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  useKeybinding('deleteItem', () => {
    setDeleteItemModalOpen(true);
    return false;
  }, { enabled: isKeyboardFocused, deps: [isKeyboardFocused] });

  const [dropType, setDropType] = useState(null); // 'adjacent' or 'inside'

  const [{ isDragging }, drag, dragPreview] = useDrag({
    type: 'collection-item',
    item: () => {
      const basePayload = {
        ...item,
        sourceCollectionUid: collectionUid,
        sourcePathname: item.pathname,
        sourceCollectionPathname: collectionPathname
      };

      // Group drag: when the dragged row is part of a multi-selection, carry
      // one entry per selected item (same shape as the single payload).
      const selectedUids = multiSelect?.selectedItemUids;
      if (!selectedUids || selectedUids.size <= 1 || !selectedUids.has(item.uid)) {
        return basePayload;
      }

      const visibleOrderByUid = new Map(flattenItems(collection?.items || []).map((flatItem, index) => [flatItem.uid, index]));
      const selectedItems = [...selectedUids]
        .map((uid) => findItemInCollection(collection, uid))
        .filter(Boolean)
        .sort((a, b) => (visibleOrderByUid.get(a.uid) ?? 0) - (visibleOrderByUid.get(b.uid) ?? 0));
      // Skip selected items living inside another selected folder — moving
      // the folder moves them.
      const draggableItems = excludeDescendantItems(selectedItems).map((selectedItem) => ({
        ...selectedItem,
        sourceCollectionUid: collectionUid,
        sourcePathname: selectedItem.pathname,
        sourceCollectionPathname: collectionPathname
      }));

      if (draggableItems.length <= 1) {
        return draggableItems[0] || basePayload;
      }

      return { ...basePayload, isMultiSelect: true, items: draggableItems };
    },
    collect: (monitor) => ({
      isDragging: monitor.isDragging()
    }),
    options: {
      dropEffect: 'move'
    }
  });

  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, []);

  // Auto-scroll to show this item when its tab becomes active
  useEffect(() => {
    if (isTabForItemActive && ref.current) {
      try {
        ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        // ignore scroll errors (some environments may not support smooth scrolling)
      }
    }
  }, [isTabForItemActive]);

  // Reveal-in-sidebar: scroll to this row and flash it when it is the target.
  // This effect runs on mount too, so a row that renders only after its
  // collection hydrates still consumes a still-pending reveal. It then clears
  // the reveal so it does not re-fire on unrelated re-renders.
  const sidebarReveal = useSelector((state) => state.app.sidebarReveal);
  const [revealFlash, setRevealFlash] = useState(false);
  useEffect(() => {
    if (!sidebarReveal?.pending || sidebarReveal.collectionUid !== collectionUid || !ref.current) {
      return;
    }
    const normalizeSeparators = (value) => String(value || '').replace(/\\/g, '/');
    if (normalizeSeparators(sidebarReveal.pathname) !== normalizeSeparators(item.pathname)) {
      return;
    }
    try {
      // 'nearest' is a no-op when the row is already visible — clicking a
      // request (which also fires a reveal via tab activation) must not
      // yank the row the user is looking at to the center.
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      // ignore scroll errors
    }
    setRevealFlash(true);
    dispatch(clearSidebarReveal());
  }, [sidebarReveal?.nonce, sidebarReveal?.pending]);

  // Auto-clear the flash on its own timer so flipping the reveal's pending
  // flag (above) cannot cancel it.
  useEffect(() => {
    if (!revealFlash) {
      return undefined;
    }
    const timer = setTimeout(() => setRevealFlash(false), 1800);
    return () => clearTimeout(timer);
  }, [revealFlash]);

  const determineDropType = (monitor) => {
    const hoverBoundingRect = ref.current?.getBoundingClientRect();
    const clientOffset = monitor.getClientOffset();
    if (!hoverBoundingRect || !clientOffset) return null;

    const clientY = clientOffset.y - hoverBoundingRect.top;
    const folderUpperThreshold = hoverBoundingRect.height * 0.35;
    const fileUpperThreshold = hoverBoundingRect.height * 0.5;

    if (isItemAFolder(item)) {
      return clientY < folderUpperThreshold ? 'adjacent' : 'inside';
    } else {
      return clientY < fileUpperThreshold ? 'adjacent' : null;
    }
  };

  const canItemBeDropped = ({ draggedItem, targetItem, dropType }) => {
    const { uid: targetItemUid, pathname: targetItemPathname } = targetItem;
    const { uid: draggedItemUid, pathname: draggedItemPathname, sourceCollectionUid } = draggedItem;
    const sourcePathname = draggedItem.sourcePathname || draggedItemPathname;

    if (draggedItemUid === targetItemUid) return false;

    // For cross-collection moves, we allow the drop
    if (sourceCollectionUid !== collectionUid) {
      return true;
    }

    if (draggedItem.sourcePathname) {
      const normalizedTarget = String(targetItemPathname || '').replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedSource = String(sourcePathname || '').replace(/\\/g, '/').replace(/\/+$/, '');
      return normalizedTarget !== normalizedSource && !normalizedTarget.startsWith(`${normalizedSource}/`);
    }

    const newPathname = calculateDraggedItemNewPathname({ draggedItem, targetItem, dropType, collectionPathname });
    if (!newPathname) return false;

    if (targetItemPathname?.startsWith(draggedItemPathname)) return false;

    return true;
  };

  // A multi-select drag carries one entry per selected item; a plain drag is
  // treated as a single-entry group so both flow through the same logic.
  const getDraggedItems = (draggedPayload) => (
    draggedPayload?.isMultiSelect && Array.isArray(draggedPayload.items) ? draggedPayload.items : [draggedPayload]
  );

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: 'collection-item',
    hover: (draggedPayload, monitor) => {
      const { uid: targetItemUid } = item;

      if (draggedPayload.uid === targetItemUid) return;

      const dropType = determineDropType(monitor);

      const allDroppable = getDraggedItems(draggedPayload).every((draggedItem) => (
        draggedItem.uid !== targetItemUid && canItemBeDropped({ draggedItem, targetItem: item, dropType })
      ));

      setDropType(allDroppable ? dropType : null);
    },
    drop: async (draggedPayload, monitor) => {
      const { uid: targetItemUid } = item;

      if (draggedPayload.uid === targetItemUid) return;

      const dropType = determineDropType(monitor);
      if (!dropType) return;

      const draggedItems = getDraggedItems(draggedPayload);

      // No partial group moves: every selected item must be droppable here.
      if (draggedItems.length > 1) {
        const allDroppable = draggedItems.every((draggedItem) => (
          draggedItem.uid !== targetItemUid && canItemBeDropped({ draggedItem, targetItem: item, dropType })
        ));
        if (!allDroppable) {
          toast.error('Cannot move the selected items here');
          setDropType(null);
          return;
        }
      }

      try {
        for (const draggedItem of draggedItems) {
          // Cross-collection moves and drags originating from the indexed
          // sidebar (no hydrated item fields) go through the path-based move,
          // which handles format conversion in the main process. Same-collection
          // classic drags keep handleCollectionItemDrop for seq reordering.
          const isCrossCollection = draggedItem.sourceCollectionUid && draggedItem.sourceCollectionUid !== collectionUid;
          const isPathOnlyDragItem = Boolean(draggedItem.sourcePathname) && !draggedItem.filename;
          if (isCrossCollection || isPathOnlyDragItem) {
            await dispatch(moveCollectionItemByPath({
              sourceCollectionUid: draggedItem.sourceCollectionUid || collectionUid,
              targetCollectionUid: collectionUid,
              sourcePathname: draggedItem.sourcePathname || draggedItem.pathname,
              targetPathname: item.pathname,
              dropType
            }));
          } else {
            await dispatch(handleCollectionItemDrop({ targetItem: item, draggedItem, dropType, collectionUid }));
          }
        }

        if (draggedItems.length > 1) {
          multiSelect?.clearItemSelection?.();
          toast.success(`Moved ${draggedItems.length} items`);
        }
      } catch (error) {
        toast.error(error?.message || 'Unable to move item');
      }
      setDropType(null);
    },
    canDrop: (draggedPayload) => !getDraggedItems(draggedPayload).some((draggedItem) => draggedItem.uid === item.uid),
    collect: (monitor) => ({
      isOver: monitor.isOver()
    })
  });

  const iconClassName = classnames({
    'rotate-90': !itemIsCollapsed
  });

  const examplesIconClassName = classnames({
    'rotate-90': examplesExpanded
  });

  const isMultiSelected = Boolean(multiSelect?.selectedItemUids?.has(item.uid));

  const itemRowClassName = classnames('flex collection-item-name relative items-center', {
    'item-focused-in-tab': isTabForItemActive,
    'item-multi-selected': isMultiSelected,
    'item-hovered': isOver && canDrop,
    'drop-target': isOver && dropType === 'inside',
    'drop-target-above': isOver && dropType === 'adjacent',
    'item-keyboard-focused': isKeyboardFocused,
    'reveal-flash': revealFlash
  });

  const handleRun = async () => {
    dispatch(sendRequest(item, collectionUid)).catch((err) =>
      toast.custom((t) => <NetworkError onClose={() => toast.dismiss(t.id)} />, {
        duration: 5000
      })
    );
  };

  const handleClick = (event) => {
    if (event && event.detail != 1) return;

    // Multi-select: ctrl/cmd-click toggles, shift-click selects the visible
    // range from the last selected item. Neither opens the request.
    if (event && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      multiSelect?.toggleItemSelection?.(item.uid);
      return;
    }
    if (event && event.shiftKey) {
      event.preventDefault();
      multiSelect?.selectItemRange?.(item.uid);
      return;
    }
    // Plain click: collapse the selection to just this item, then perform the
    // normal open/toggle behavior.
    multiSelect?.selectSingleItem?.(item.uid);

    // scroll to the active tab
    setTimeout(scrollToTheActiveTab, 50);
    const isRequest = isItemARequest(item);
    if (isRequest) {
      if (isTabForItemPresent) {
        dispatch(
          focusTab({
            uid: item.uid
          })
        );
        return;
      }
      dispatch(
        addTab({
          uid: item.uid,
          collectionUid: collectionUid,
          requestPaneTab: getDefaultRequestPaneTab(item),
          type: 'request'
        })
      );
    } else {
      // Folder click opens its settings tab as a preview (Postman-style folder
      // tab); double-click on the row makes it permanent via handleDoubleClick.
      dispatch(
        addTab({
          uid: item.uid,
          collectionUid: collectionUid,
          type: 'folder-settings',
          itemPathname: item.pathname,
          preview: true
        })
      );
      if (item.collapsed) {
        dispatch(
          toggleCollectionItem({
            itemUid: item.uid,
            collectionUid: collectionUid
          })
        );
      }
    }
  };

  const handleFolderCollapse = (e) => {
    e.stopPropagation();
    e.preventDefault();
    dispatch(
      toggleCollectionItem({
        itemUid: item.uid,
        collectionUid: collectionUid
      })
    );
  };

  // prevent the parent's double-click handler from firing
  const handleFolderDoubleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleExamplesCollapse = (e) => {
    e.stopPropagation();
    e.preventDefault();
    setExamplesExpanded(!examplesExpanded);
  };

  // prevent the parent's double-click handler from firing
  const handleExamplesDoubleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };

  // Handle right-click context menu
  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    menuDropdownRef.current?.show();
  };

  let indents = range(item.depth);

  // Build menu items for MenuDropdown
  const buildMenuItems = () => {
    const items = [];

    if (isFolder) {
      items.push(
        {
          id: 'new-request',
          leftSection: IconFilePlus,
          label: 'New Request',
          onClick: () => setNewRequestModalOpen(true)
        },
        {
          id: 'new-folder',
          leftSection: IconFolderPlus,
          label: 'New Folder',
          onClick: () => setNewFolderModalOpen(true)
        },
        {
          id: 'run',
          leftSection: IconPlayerPlay,
          label: 'Run',
          onClick: () => setRunCollectionModalOpen(true)
        }
      );
    }

    items.push(
      {
        id: 'clone',
        leftSection: IconCopy,
        label: 'Clone',
        onClick: () => setCloneItemModalOpen(true)
      },
      {
        id: 'copy',
        leftSection: IconCopy,
        label: 'Copy',
        onClick: handleCopyItem
      }
    );

    if (isFolder && hasCopiedItems) {
      items.push({
        id: 'paste',
        leftSection: IconClipboard,
        label: 'Paste',
        onClick: handlePasteItem
      });
    }

    items.push(
      {
        id: 'rename',
        leftSection: IconEdit,
        label: 'Rename',
        onClick: () => setRenameItemModalOpen(true)
      }
    );

    if (isFolder) {
      items.push(
        {
          id: 'import',
          leftSection: IconFileImport,
          label: 'Import',
          onClick: () => setImportIntoFolderModalOpen(true)
        },
        {
          id: 'export',
          leftSection: IconFileExport,
          label: 'Export',
          onClick: () => setExportFolderModalOpen(true)
        }
      );
    }

    if (!isFolder && isItemARequest(item) && !(item.type === 'http-request' || item.type === 'graphql-request')) {
      items.push({
        id: 'run',
        leftSection: IconPlayerPlay,
        label: 'Run',
        onClick: () => {
          handleRun();
        }
      });
    }

    if (!isFolder && (item.type === 'http-request' || item.type === 'graphql-request')) {
      items.push({
        id: 'generate-code',
        leftSection: IconCode,
        label: 'Generate Code',
        onClick: handleGenerateCode
      });
    }

    if (!isFolder && isItemARequest(item) && item.type === 'http-request') {
      items.push({
        id: 'create-example',
        leftSection: ExampleIcon,
        label: 'Create Example',
        // Create immediately (Postman-style, no modal); default name is the
        // request name with a unique suffix, renameable from the example tab.
        onClick: () => handleCreateExample(getInitialExampleName(item))
      });
    }

    items.push(
      {
        id: 'show-in-folder',
        leftSection: IconFolder,
        label: getRevealInFolderLabel(),
        onClick: handleShowInFolder
      }
    );

    items.push({ id: 'separator-1', type: 'divider' });

    items.push({
      id: 'info',
      leftSection: IconInfoCircle,
      label: 'Info',
      onClick: () => setItemInfoModalOpen(true)
    });

    if (isFolder) {
      items.push(
        {
          id: 'settings',
          leftSection: IconSettings,
          label: 'Settings',
          onClick: viewFolderSettings
        },
        {
          id: 'open-terminal',
          leftSection: IconTerminal2,
          label: 'Open in Terminal',
          onClick: async () => {
            const folderCwd = item.pathname || collectionPathname;
            await openDevtoolsAndSwitchToTerminal(dispatch, folderCwd);
          }
        }
      );
    }

    items.push({
      id: 'delete',
      leftSection: IconTrash,
      label: 'Delete',
      className: 'delete-item',
      onClick: () => setDeleteItemModalOpen(true)
    });

    return items;
  };

  const className = classnames('flex flex-col w-full', {
    'is-sidebar-dragging': isSidebarDragging
  });

  if (searchText && searchText.length) {
    if (isItemARequest(item)) {
      if (!doesRequestMatchSearchText(item, searchText)) {
        return null;
      }
    } else {
      if (!doesFolderHaveItemsMatchSearchText(item, searchText)) {
        return null;
      }
    }
  }

  const handleDoubleClick = (event) => {
    dispatch(makeTabPermanent({ uid: item.uid }));
  };

  // Sort items by their "seq" property.
  const sortItemsBySequence = (items = []) => {
    return items.sort((a, b) => a.seq - b.seq);
  };

  const handleShowInFolder = () => {
    dispatch(showInFolder(item.pathname)).catch((error) => {
      console.error('Error opening the folder', error);
      toast.error('Error opening the folder');
    });
  };

  const handleCreateExample = async (name, description = '') => {
    // Create example with default values
    const exampleData = {
      name: name,
      description: description,
      status: 200,
      statusText: 'OK',
      headers: [],
      body: {
        type: 'text',
        content: ''
      }
    };

    // Calculate the index where the example will be saved
    const existingExamples = item.draft?.examples || item.examples || [];
    const exampleIndex = existingExamples.length;
    const exampleUid = uuid();

    dispatch(addResponseExample({
      itemUid: item.uid,
      collectionUid: collectionUid,
      example: {
        ...exampleData,
        uid: exampleUid
      }
    }));

    // Save the request
    await dispatch(saveRequest(item.uid, collectionUid, true));

    // Task middleware will track this and open the example in a new tab once the file is reloaded
    dispatch(insertTaskIntoQueue({
      uid: exampleUid,
      type: 'OPEN_EXAMPLE',
      collectionUid: collectionUid,
      itemUid: item.uid,
      exampleIndex: exampleIndex
    }));

    toast.success(`Example "${name}" created successfully`);
  };

  const folderItems = sortByNameThenSequence(filter(item.items, (i) => isItemAFolder(i) && !i.isTransient));
  const requestItems = sortItemsBySequence(filter(item.items, (i) => isItemARequest(i) && !i.isTransient));
  const showEmptyFolderMessage = isFolder && !hasSearchText && !folderItems?.length && !requestItems?.length;

  const emptyFolderMenuItems = createEmptyStateMenuItems({ dispatch, collection, itemUid: item.uid });

  const handleGenerateCode = () => {
    if (
      (item?.request?.url !== '')
      || (item?.draft?.request?.url !== undefined && item?.draft?.request?.url !== '')
    ) {
      setGenerateCodeItemModalOpen(true);
    } else {
      toast.error('URL is required');
    }
  };

  const viewFolderSettings = () => {
    if (isItemAFolder(item)) {
      if (isTabForItemPresent) {
        dispatch(focusTab({ uid: item.uid }));
      } else {
        dispatch(
          addTab({
            uid: item.uid,
            collectionUid,
            type: 'folder-settings',
            itemPathname: item.pathname
          })
        );
      }
      // Explicit Settings intent: keep the tab around (not a preview tab)
      dispatch(makeTabPermanent({ uid: item.uid }));
    }
  };

  const handleCopyItem = () => {
    dispatch(copyRequest(item));
    const itemType = isFolder ? 'Folder' : 'Request';
    toast.success(`${itemType} copied`);
  };

  const handlePasteItem = () => {
    // Determine target folder: if item is a folder, paste into it; otherwise paste into parent folder
    let targetFolderUid = item.uid;
    if (!isFolder) {
      const parentFolder = findParentItemInCollection(collection, item.uid);
      targetFolderUid = parentFolder ? parentFolder.uid : null;
    }

    dispatch(pasteItem(collectionUid, targetFolderUid))
      .then(() => {
        toast.success('Item pasted successfully');
      })
      .catch((err) => {
        toast.error(err ? err.message : 'An error occurred while pasting the item');
      });
  };

  const handleFocus = () => {
    setIsKeyboardFocused(true);
    // For folders, set the folder path; for requests, set empty string (no terminal)
    dispatch(setFocusedSidebarPath(isFolder ? item.pathname : ''));
  };

  const handleBlur = () => {
    setIsKeyboardFocused(false);
    dispatch(setFocusedSidebarPath(null));
  };

  return (
    <StyledWrapper className={className}>
      {renameItemModalOpen && (
        <RenameCollectionItem item={item} collectionUid={collectionUid} onClose={() => setRenameItemModalOpen(false)} />
      )}
      {cloneItemModalOpen && (
        <CloneCollectionItem item={item} collectionUid={collectionUid} onClose={() => setCloneItemModalOpen(false)} />
      )}
      {deleteItemModalOpen && (
        <DeleteCollectionItem item={item} collectionUid={collectionUid} onClose={() => setDeleteItemModalOpen(false)} />
      )}
      {newRequestModalOpen && (
        <NewRequest item={item} collectionUid={collectionUid} onClose={() => setNewRequestModalOpen(false)} />
      )}
      {newFolderModalOpen && (
        <NewFolder item={item} collectionUid={collectionUid} onClose={() => setNewFolderModalOpen(false)} />
      )}
      {runCollectionModalOpen && (
        <RunCollectionItem collectionUid={collectionUid} item={item} onClose={() => setRunCollectionModalOpen(false)} />
      )}
      {generateCodeItemModalOpen && (
        <GenerateCodeItem collectionUid={collectionUid} item={item} onClose={() => setGenerateCodeItemModalOpen(false)} />
      )}
      {itemInfoModalOpen && (
        <CollectionItemInfo item={item} onClose={() => setItemInfoModalOpen(false)} />
      )}
      {exportFolderModalOpen && (
        <ExportFolder
          folderName={item.name}
          folderPathname={item.pathname}
          collectionPathname={collectionPathname}
          onClose={() => setExportFolderModalOpen(false)}
        />
      )}
      {importIntoFolderModalOpen && (
        <ImportIntoFolder
          collectionUid={collectionUid}
          targetDirectory={item.pathname}
          targetName={item.name}
          onClose={() => setImportIntoFolderModalOpen(false)}
        />
      )}
      <div
        className={itemRowClassName}
        ref={(node) => {
          ref.current = node;
          drag(drop(node));
        }}
        tabIndex={0}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onContextMenu={handleContextMenu}
        data-testid="sidebar-collection-item-row"
      >
        <div className="flex items-center h-full w-full">
          {indents && indents.length
            ? indents.map((i) => (
                <div
                  onClick={handleClick}
                  onDoubleClick={handleDoubleClick}
                  className="indent-block"
                  key={i}
                  style={{ width: 16, minWidth: 16, height: '100%' }}
                >
                &nbsp;{/* Indent */}
                </div>
              ))
            : null}
          <div
            className="flex flex-grow items-center h-full overflow-hidden"
            style={{ paddingLeft: 8 }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
          >

            {isFolder ? (
              <ActionIcon style={{ width: 16, minWidth: 16 }}>
                <IconChevronRight
                  size={16}
                  strokeWidth={2}
                  className={iconClassName}
                  style={{ color: 'rgb(160 160 160)' }}
                  onClick={handleFolderCollapse}
                  onDoubleClick={handleFolderDoubleClick}
                  data-testid="folder-chevron"
                />
              </ActionIcon>
            ) : hasExamples ? (
              <ActionIcon style={{ width: 16, minWidth: 16 }}>
                <IconChevronRight
                  size={16}
                  strokeWidth={2}
                  className={examplesIconClassName}
                  style={{ color: 'rgb(160 160 160)' }}
                  onClick={handleExamplesCollapse}
                  onDoubleClick={handleExamplesDoubleClick}
                  data-testid="request-item-chevron"
                />
              </ActionIcon>
            ) : (
              // Reserve the chevron slot so requests without examples keep the
              // same icon/name alignment as folders and requests that have one.
              <div style={{ width: 16, minWidth: 16 }} />
            )}

            <div className="ml-1 flex w-full h-full items-center overflow-hidden">
              <CollectionItemIcon item={item} />
              <span className="item-name" title={item.name}>
                <SearchHighlight text={item.name} searchText={searchText} />
              </span>
            </div>
          </div>
          <div className="pr-2">
            <MenuDropdown
              ref={menuDropdownRef}
              items={buildMenuItems()}
              placement="bottom-start"
              data-testid="collection-item-menu"
              popperOptions={{ strategy: 'fixed' }}
              appendTo={dropdownContainerRef?.current || document.body}
            >
              <ActionIcon className="menu-icon">
                <IconDots size={18} className="collection-item-menu-icon" />
              </ActionIcon>
            </MenuDropdown>
          </div>
        </div>
      </div>
      {!itemIsCollapsed ? (
        <div>
          {folderItems && folderItems.length
            ? folderItems.map((i) => {
                return <CollectionItem key={i.uid} item={i} collectionUid={collectionUid} collectionPathname={collectionPathname} searchText={searchText} multiSelect={multiSelect} />;
              })
            : null}
          {requestItems && requestItems.length
            ? requestItems.map((i) => {
                return <CollectionItem key={i.uid} item={i} collectionUid={collectionUid} collectionPathname={collectionPathname} searchText={searchText} multiSelect={multiSelect} />;
              })
            : null}
          {showEmptyFolderMessage ? (
            <div className="empty-folder-message">
              {range(item.depth + 1).map((i) => (
                <div className="indent-block" key={i} style={{ width: 16, minWidth: 16, height: '100%' }}>
                  &nbsp;
                </div>
              ))}
              <div style={{ paddingLeft: 8 }}>
                <MenuDropdown
                  data-testid="add-request-cta-folder"
                  items={emptyFolderMenuItems}
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

      {/* Show examples when expanded (only for HTTP requests) */}
      {isItemARequest(item) && item.type === 'http-request' && examplesExpanded && hasExamples && (
        <div>
          {(item.examples || []).map((example, index) => {
            return (
              <ExampleItem
                key={example.uid || index}
                example={example}
                item={item}
                index={index}
                collection={collection}
              />
            );
          })}
        </div>
      )}
    </StyledWrapper>
  );
};

export default React.memo(CollectionItem);
