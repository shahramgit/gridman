import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import find from 'lodash/find';
import filter from 'lodash/filter';
import classnames from 'classnames';
import { IconChevronRight, IconChevronLeft } from '@tabler/icons';
import { useSelector, useDispatch } from 'react-redux';
import { focusTab, reorderTabs } from 'providers/ReduxStore/slices/tabs';
import { getWorkspaceTabs } from 'providers/ReduxStore/slices/workspaces/getTabToFocusForCurrentWorkspace';
import NewRequest from 'components/Sidebar/NewRequest';
import CollectionHeader from './CollectionHeader';
import RequestTab from './RequestTab';
import StyledWrapper from './StyledWrapper';
import DraggableTab from './DraggableTab';
import CreateTransientRequest from 'components/CreateTransientRequest';
import ActionIcon from 'ui/ActionIcon/index';

// The workspace's own pages. They sat in the scrolling strip with the request
// tabs, so with many requests open they scrolled out of reach and users paged
// back through every tab to get to them (reported against 4.1.0-vasl.5). They
// now stay put at the start of the strip.
const PINNED_WORKSPACE_TAB_TYPES = new Set(['workspaceOverview', 'workspaceEnvironments', 'workspaceGit']);

const RequestTabs = () => {
  const dispatch = useDispatch();
  const tabsRef = useRef();
  const scrollContainerRef = useRef();
  const collectionTabsRef = useRef();
  const pinnedTabsRef = useRef();
  const [pinnedTabsWidth, setPinnedTabsWidth] = useState(0);
  const [newRequestModalOpen, setNewRequestModalOpen] = useState(false);
  const [tabOverflowStates, setTabOverflowStates] = useState({});
  const [showChevrons, setShowChevrons] = useState(false);
  const tabs = useSelector((state) => state.tabs.tabs);
  const activeTabUid = useSelector((state) => state.tabs.activeTabUid);
  const collections = useSelector((state) => state.collections.collections);
  const leftSidebarWidth = useSelector((state) => state.app.leftSidebarWidth);
  const sidebarCollapsed = useSelector((state) => state.app.sidebarCollapsed);
  const screenWidth = useSelector((state) => state.app.screenWidth);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);

  const createSetHasOverflow = useCallback((tabUid) => {
    return (hasOverflow) => {
      setTabOverflowStates((prev) => {
        if (prev[tabUid] === hasOverflow) {
          return prev;
        }
        return {
          ...prev,
          [tabUid]: hasOverflow
        };
      });
    };
  }, []);

  const activeTab = find(tabs, (t) => t.uid === activeTabUid);
  const activeCollection = find(collections, (c) => c?.uid === activeTab?.collectionUid);
  const activeWorkspace = find(workspaces, (w) => w.uid === activeWorkspaceUid);
  // Postman-style tab strip: every open tab of the current workspace stays
  // visible, whatever collection it belongs to. Only workspace switches change
  // the visible set.
  const collectionRequestTabs = useMemo(
    () => getWorkspaceTabs(tabs, collections, activeWorkspace),
    [tabs, collections, activeWorkspace]
  );
  const pinnedTabs = useMemo(
    () => collectionRequestTabs.filter((tab) => PINNED_WORKSPACE_TAB_TYPES.has(tab.type)),
    [collectionRequestTabs]
  );
  const scrollingTabs = useMemo(
    () => collectionRequestTabs.filter((tab) => !PINNED_WORKSPACE_TAB_TYPES.has(tab.type)),
    [collectionRequestTabs]
  );

  // The scroller's width budget has to leave room for the pinned group.
  useEffect(() => {
    const node = pinnedTabsRef.current;
    if (!node) {
      setPinnedTabsWidth(0);
      return undefined;
    }
    const measure = () => setPinnedTabsWidth(node.offsetWidth || 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [pinnedTabs.length]);

  // Show a collection hint on tabs only when tabs from several collections
  // are open at once.
  const showCollectionHint = useMemo(() => {
    const uids = new Set(collectionRequestTabs.map((t) => t.collectionUid).filter(Boolean));
    return uids.size > 1;
  }, [collectionRequestTabs]);

  const isScratchCollection = useMemo(() => {
    return activeCollection ? workspaces.some((w) => w.scratchCollectionUid === activeCollection.uid) : false;
  }, [workspaces, activeCollection]);

  useEffect(() => {
    if (!activeTabUid || !activeTab) return;

    const checkOverflow = () => {
      if (tabsRef.current && scrollContainerRef.current) {
        const hasOverflow = tabsRef.current.scrollWidth > scrollContainerRef.current.clientWidth + 1;
        setShowChevrons(hasOverflow);
      }
    };

    checkOverflow();
    const resizeObserver = new ResizeObserver(checkOverflow);
    if (scrollContainerRef.current) {
      resizeObserver.observe(scrollContainerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, [activeTabUid, activeTab, scrollingTabs.length, pinnedTabsWidth, screenWidth, leftSidebarWidth, sidebarCollapsed]);

  const getTabClassname = (tab, index) => {
    return classnames('request-tab select-none', {
      'active': tab.uid === activeTabUid,
      'last-tab': tabs && tabs.length && index === tabs.length - 1,
      'has-overflow': tabOverflowStates[tab.uid]
    });
  };

  const handleClick = (tab) => {
    dispatch(
      focusTab({
        uid: tab.uid
      })
    );
  };

  if (!activeTabUid) {
    return null;
  }

  const effectiveSidebarWidth = sidebarCollapsed ? 0 : leftSidebarWidth;
  const maxTablistWidth = screenWidth - effectiveSidebarWidth - 150 - pinnedTabsWidth;

  // Each tab renders against ITS collection — the strip holds tabs from
  // several collections at once.
  const collectionForTab = (tab) => (tab.collectionUid === activeCollection?.uid
    ? activeCollection
    : find(collections, (c) => c?.uid === tab.collectionUid));

  const leftSlide = () => {
    scrollContainerRef.current?.scrollBy({
      left: -120,
      behavior: 'smooth'
    });
  };

  const rightSlide = () => {
    scrollContainerRef.current?.scrollBy({
      left: 120,
      behavior: 'smooth'
    });
  };

  // Todo: Must support ephemeral requests
  return (
    <StyledWrapper>
      {newRequestModalOpen && (
        <NewRequest collectionUid={activeCollection?.uid} onClose={() => setNewRequestModalOpen(false)} />
      )}
      {collectionRequestTabs && collectionRequestTabs.length ? (
        <>
          {activeCollection && (
            <CollectionHeader
              collection={activeCollection}
              isScratchCollection={isScratchCollection}
            />
          )}
          <div className="flex items-center gap-2 pl-2" ref={collectionTabsRef}>
            {pinnedTabs.length > 0 && (
              <ul role="tablist" aria-label="Workspace" className="pinned-tabs" ref={pinnedTabsRef} data-testid="pinned-workspace-tabs">
                {pinnedTabs.map((tab, index) => (
                  <li
                    key={tab.uid}
                    role="tab"
                    className={getTabClassname(tab, index)}
                    onClick={() => handleClick(tab)}
                  >
                    {/* Their own list: close-others/left/right on a pinned tab
                        stays among the pinned ones, and the same actions on a
                        request tab no longer sweep the workspace pages away. */}
                    <RequestTab
                      collectionRequestTabs={pinnedTabs}
                      tabIndex={index}
                      tab={tab}
                      collection={collectionForTab(tab)}
                      showCollectionHint={showCollectionHint}
                      folderUid={tab.folderUid}
                      hasOverflow={tabOverflowStates[tab.uid]}
                      setHasOverflow={createSetHasOverflow(tab.uid)}
                      dropdownContainerRef={collectionTabsRef}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className={classnames('scroll-chevrons', { hidden: !showChevrons })}>
              <ActionIcon size="lg" onClick={leftSlide} aria-label="Left Chevron" style={{ marginBottom: '3px' }}>
                <IconChevronLeft size={18} strokeWidth={1.5} />
              </ActionIcon>
            </div>
            {/* Moved to post mvp */}
            {/* <li className="select-none new-tab mr-1" onClick={createNewTab}>
              <div className="flex items-center home-icon-container">
                <IconHome2 size={18} strokeWidth={1.5}/>
              </div>
            </li> */}
            <div className="tabs-scroll-container" style={{ maxWidth: maxTablistWidth }} ref={scrollContainerRef}>
              <ul role="tablist" ref={tabsRef}>
                {scrollingTabs.length
                  ? scrollingTabs.map((tab, index) => {
                      const tabCollection = collectionForTab(tab);
                      return (
                        <DraggableTab
                          key={tab.uid}
                          id={tab.uid}
                          index={index}
                          onMoveTab={(source, target) => {
                            dispatch(reorderTabs({
                              sourceUid: source,
                              targetUid: target
                            }));
                          }}
                          className={getTabClassname(tab, index)}
                          onClick={() => handleClick(tab)}
                        >
                          <RequestTab
                            collectionRequestTabs={scrollingTabs}
                            tabIndex={index}
                            key={tab.uid}
                            tab={tab}
                            collection={tabCollection}
                            showCollectionHint={showCollectionHint}
                            folderUid={tab.folderUid}
                            hasOverflow={tabOverflowStates[tab.uid]}
                            setHasOverflow={createSetHasOverflow(tab.uid)}
                            dropdownContainerRef={collectionTabsRef}
                          />
                        </DraggableTab>
                      );
                    })
                  : null}
              </ul>
            </div>

            {activeCollection && (
              <CreateTransientRequest collectionUid={activeCollection.uid} />
            )}

            <div className={classnames('scroll-chevrons', { hidden: !showChevrons })}>
              <ActionIcon size="lg" onClick={rightSlide} aria-label="Right Chevron" style={{ marginBottom: '3px' }}>
                <IconChevronRight size={18} strokeWidth={1.5} />
              </ActionIcon>
            </div>
            {/* Moved to post mvp */}
            {/* <li className="select-none new-tab choose-request">
                <div className="flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </div>
              </li> */}
          </div>
        </>
      ) : null}
    </StyledWrapper>
  );
};

export default RequestTabs;
