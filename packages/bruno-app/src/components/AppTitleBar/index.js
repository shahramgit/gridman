import React from 'react';
import {
  IconArrowDown,
  IconArrowUp,
  IconBrandGit,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconGitBranch,
  IconGitCommit,
  IconGitFork,
  IconHome,
  IconPin,
  IconPinned,
  IconPlus,
  IconDownload,
  IconRefresh,
  IconSettings,
  IconMinus,
  IconSquare,
  IconUpload,
  IconX,
  IconCopy
} from '@tabler/icons';
import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';

import { savePreferences, showManageWorkspacePage, toggleSidebarCollapse } from 'providers/ReduxStore/slices/app';
import { closeConsole, openConsole } from 'providers/ReduxStore/slices/logs';
import { createWorkspaceWithUniqueName, openWorkspaceDialog, switchWorkspace } from 'providers/ReduxStore/slices/workspaces/actions';
import { sortWorkspaces, toggleWorkspacePin } from 'utils/workspaces';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import get from 'lodash/get';

import Bruno from 'components/Bruno';
import MenuDropdown from 'ui/MenuDropdown';
import ActionIcon from 'ui/ActionIcon';
import IconSidebarToggle from 'components/Icons/IconSidebarToggle';
import CreateWorkspace from 'components/WorkspaceSidebar/CreateWorkspace';
import ImportWorkspace from 'components/WorkspaceSidebar/ImportWorkspace';
import CloneGitRepository from 'components/Sidebar/CloneGitRespository';

import IconBottombarToggle from 'components/Icons/IconBottombarToggle/index';
import AppMenu from './AppMenu';
import StyledWrapper from './StyledWrapper';
import ResponseLayoutToggle from 'components/ResponsePane/ResponseLayoutToggle';
import { isMacOS, isWindowsOS, isLinuxOS } from 'utils/common/platform';
import classNames from 'classnames';
import { uuid } from 'utils/common';

const getOsClass = () => {
  if (isMacOS()) return 'os-mac';
  if (isWindowsOS()) return 'os-windows';
  if (isLinuxOS()) return 'os-linux';
  return 'os-other';
};

// Helper to get display name for workspace
export const getWorkspaceDisplayName = (name) => {
  if (!name) return 'Untitled Workspace';
  return name;
};

const getWorkspaceGitPayload = (workspace) => ({
  workspacePath: workspace?.pathname,
  collectionPaths: (workspace?.collections || []).map((collection) => collection.path).filter(Boolean)
});

const getRemoteWorkspaceLabel = (workspace) => {
  if (!workspace?.remoteWorkspaceName || workspace.remoteWorkspaceName === workspace.name) {
    return '';
  }

  return `remote: ${workspace.remoteWorkspaceName}`;
};

const getIpcErrorMessage = (error, fallback) => {
  const message = error?.message || String(error || '') || fallback;
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    || fallback;
};

const AppTitleBar = () => {
  const dispatch = useDispatch();
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const osClass = getOsClass();
  const isWindows = osClass === 'os-windows';
  const isLinux = osClass === 'os-linux';
  const showWindowControls = isWindows || isLinux;

  // Listen for fullscreen changes
  useEffect(() => {
    const { ipcRenderer } = window;
    if (!ipcRenderer) return;

    const removeEnterFullScreenListener = ipcRenderer.on('main:enter-full-screen', () => {
      setIsFullScreen(true);
    });

    const removeLeaveFullScreenListener = ipcRenderer.on('main:leave-full-screen', () => {
      setIsFullScreen(false);
    });

    return () => {
      removeEnterFullScreenListener();
      removeLeaveFullScreenListener();
    };
  }, []);

  useEffect(() => {
    if (!showWindowControls) return;
    const { ipcRenderer } = window;
    if (!ipcRenderer) return;

    ipcRenderer.invoke('renderer:window-is-maximized')
      .then((maximized) => {
        setIsMaximized(maximized);
      })
      .catch((error) => {
        console.error('Error getting initial maximized state:', error);
      });

    const removeMaximizedListener = ipcRenderer.on('main:window-maximized', () => {
      setIsMaximized(true);
    });

    const removeUnmaximizedListener = ipcRenderer.on('main:window-unmaximized', () => {
      setIsMaximized(false);
    });

    return () => {
      removeMaximizedListener();
      removeUnmaximizedListener();
    };
  }, [showWindowControls]);

  const handleMinimize = useCallback(() => {
    window.ipcRenderer?.send('renderer:window-minimize');
  }, []);

  const handleMaximize = useCallback(() => {
    window.ipcRenderer?.send('renderer:window-maximize');
    // State will be updated via IPC events from main process (main:window-maximized/main:window-unmaximized)
  }, []);

  const handleClose = useCallback(() => {
    window.ipcRenderer?.send('renderer:window-close');
  }, []);

  // Get workspace info
  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);
  const preferences = useSelector((state) => state.app.preferences);
  const sidebarCollapsed = useSelector((state) => state.app.sidebarCollapsed);
  const isConsoleOpen = useSelector((state) => state.logs.isConsoleOpen);
  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);

  // Sort workspaces according to preferences
  const sortedWorkspaces = useMemo(() => {
    return sortWorkspaces(workspaces, preferences);
  }, [workspaces, preferences]);

  const [createWorkspaceModalOpen, setCreateWorkspaceModalOpen] = useState(false);
  const [importWorkspaceModalOpen, setImportWorkspaceModalOpen] = useState(false);
  const [cloneGitWorkspaceModalOpen, setCloneGitWorkspaceModalOpen] = useState(false);
  const [workspaceGitData, setWorkspaceGitData] = useState(null);
  const [workspaceGitLoading, setWorkspaceGitLoading] = useState(false);
  const [workspaceGitOperation, setWorkspaceGitOperation] = useState(null);
  const showGitWorkspaceFeature = get(preferences, 'features.gitWorkspace', get(preferences, 'features.git', true));

  const WorkspaceName = forwardRef((props, ref) => {
    const remoteWorkspaceLabel = getRemoteWorkspaceLabel(activeWorkspace);
    return (
      <div ref={ref} className="workspace-name-container" {...props}>
        <span data-testid="workspace-name" className={classNames('workspace-name', { 'italic text-muted': !activeWorkspace?.name })}>{getWorkspaceDisplayName(activeWorkspace?.name)}</span>
        {remoteWorkspaceLabel && <span className="workspace-remote-name">({remoteWorkspaceLabel})</span>}
        <IconChevronDown size={14} stroke={1.5} className="chevron-icon" />
      </div>
    );
  });

  const handleHomeClick = () => {
    const scratchCollectionUid = activeWorkspace?.scratchCollectionUid;
    if (scratchCollectionUid) {
      dispatch(focusTab({ uid: `${scratchCollectionUid}-overview` }));
    }
  };

  const refreshWorkspaceGitStatus = useCallback(async ({ silent = false, fetchRemote = false } = {}) => {
    if (!showGitWorkspaceFeature || !activeWorkspace?.pathname) {
      setWorkspaceGitData(null);
      return;
    }

    if (!silent) {
      setWorkspaceGitLoading(true);
    }

    try {
      const result = await window.ipcRenderer.invoke('renderer:get-workspace-git-data', {
        ...getWorkspaceGitPayload(activeWorkspace),
        fetchRemote
      });
      setWorkspaceGitData(result);
      if (fetchRemote && !silent && result?.isGitRepository && result?.remotes?.length) {
        toast.success('Git status refreshed from remote');
      }
    } catch (error) {
      if (!silent) {
        toast.error(error?.message || 'Failed to load workspace Git status');
      }
    } finally {
      if (!silent) {
        setWorkspaceGitLoading(false);
      }
    }
  }, [activeWorkspace?.pathname, showGitWorkspaceFeature]);

  useEffect(() => {
    refreshWorkspaceGitStatus({ silent: true });

    if (!showGitWorkspaceFeature || !activeWorkspace?.pathname) {
      return;
    }

    const intervalId = setInterval(() => {
      refreshWorkspaceGitStatus({ silent: true });
    }, 30000);

    return () => clearInterval(intervalId);
  }, [activeWorkspace?.pathname, refreshWorkspaceGitStatus, showGitWorkspaceFeature]);

  const handleOpenWorkspaceGit = useCallback(() => {
    const scratchCollectionUid = activeWorkspace?.scratchCollectionUid;
    if (!scratchCollectionUid) return;

    const tabUid = `${scratchCollectionUid}-git`;
    dispatch(addTab({
      uid: tabUid,
      collectionUid: scratchCollectionUid,
      type: 'workspaceGit'
    }));
    dispatch(focusTab({ uid: tabUid }));
  }, [activeWorkspace?.scratchCollectionUid, dispatch]);

  const runWorkspaceGitOperation = useCallback(async (label, invokeName, payload = {}) => {
    if (!workspaceGitData?.gitRootPath) {
      handleOpenWorkspaceGit();
      return;
    }

    const currentBranch = workspaceGitData.currentGitBranch || workspaceGitData.defaultGitBranch || workspaceGitData.status?.current || 'main';
    const remote = workspaceGitData.remotes?.find((item) => item.name === 'origin')?.name || workspaceGitData.remotes?.[0]?.name || 'origin';

    setWorkspaceGitOperation(label);
    try {
      const result = await window.ipcRenderer.invoke(invokeName, {
        gitRootPath: workspaceGitData.gitRootPath,
        processUid: uuid(),
        remote,
        remoteBranch: currentBranch,
        strategy: '--no-rebase',
        ...payload
      });
      if (result?.mergeInProgress) {
        toast.error('Merge conflicts need to be resolved in the Git tab');
        handleOpenWorkspaceGit();
      } else {
        toast.success(`${label} completed`);
      }
      await refreshWorkspaceGitStatus({ silent: true });
    } catch (error) {
      toast.error(error?.message || `${label} failed`);
      await refreshWorkspaceGitStatus({ silent: true });
    } finally {
      setWorkspaceGitOperation(null);
    }
  }, [handleOpenWorkspaceGit, refreshWorkspaceGitStatus, workspaceGitData]);

  const initializeWorkspaceGit = useCallback(async () => {
    if (!activeWorkspace?.pathname) return;

    setWorkspaceGitOperation('Initialize Git');
    try {
      const result = await window.ipcRenderer.invoke('renderer:init-workspace-git', {
        ...getWorkspaceGitPayload(activeWorkspace)
      });
      setWorkspaceGitData(result);
      toast.success('Git initialized for this workspace');
      handleOpenWorkspaceGit();
    } catch (error) {
      toast.error(getIpcErrorMessage(error, 'Failed to initialize Git'));
    } finally {
      setWorkspaceGitOperation(null);
    }
  }, [activeWorkspace?.pathname, handleOpenWorkspaceGit]);

  const handleWorkspaceSwitch = (workspaceUid) => {
    dispatch(switchWorkspace(workspaceUid));
    toast.success(`Switched to ${getWorkspaceDisplayName(workspaces.find((w) => w.uid === workspaceUid)?.name)}`);
  };

  const handleOpenWorkspace = async () => {
    try {
      await dispatch(openWorkspaceDialog());
      toast.success('Workspace opened successfully');
    } catch (error) {
      toast.error(error.message || 'Failed to open workspace');
    }
  };

  const handleCreateWorkspace = useCallback(async () => {
    const defaultLocation = get(preferences, 'general.defaultLocation', '');
    if (!defaultLocation) {
      setCreateWorkspaceModalOpen(true);
      return;
    }

    try {
      await dispatch(createWorkspaceWithUniqueName(defaultLocation));
    } catch (error) {
      toast.error(error?.message || 'Failed to create workspace');
    }
  }, [preferences, dispatch]);

  const handleManageWorkspaces = () => {
    dispatch(showManageWorkspacePage());
  };

  const handleImportWorkspace = () => {
    setImportWorkspaceModalOpen(true);
  };

  const handleCloneGitWorkspace = () => {
    setCloneGitWorkspaceModalOpen(true);
  };

  const handlePinWorkspace = useCallback((workspaceUid, e) => {
    e.preventDefault();
    e.stopPropagation();
    const newPreferences = toggleWorkspacePin(workspaceUid, preferences);
    dispatch(savePreferences(newPreferences));
  }, [dispatch, preferences]);

  const handleToggleSidebar = () => {
    dispatch(toggleSidebarCollapse());
  };

  const handleToggleDevtools = () => {
    if (isConsoleOpen) {
      dispatch(closeConsole());
    } else {
      dispatch(openConsole());
    }
  };

  // Build workspace menu items
  const workspaceMenuItems = useMemo(() => {
    const items = sortedWorkspaces.map((workspace) => {
      const isActive = workspace.uid === activeWorkspaceUid;
      const isPinned = preferences?.workspaces?.pinnedWorkspaceUids?.includes(workspace.uid);

      return {
        id: workspace.uid,
        label: getWorkspaceDisplayName(workspace.name),
        onClick: () => handleWorkspaceSwitch(workspace.uid),
        className: `workspace-item ${isActive ? 'active' : ''}`,
        rightSection: (
          <div className="workspace-actions">
            <ActionIcon
              className={`pin-btn ${isPinned ? 'pinned' : ''}`}
              onClick={(e) => handlePinWorkspace(workspace.uid, e)}
              label={isPinned ? 'Unpin workspace' : 'Pin workspace'}
              size="sm"
            >
              {isPinned ? <IconPinned size={14} stroke={1.5} /> : <IconPin size={14} stroke={1.5} />}
            </ActionIcon>
            {isActive && <IconCheck size={16} stroke={1.5} className="check-icon" />}
          </div>
        )
      };
    });

    // Add label and action items
    items.push(
      { type: 'label', label: 'Workspaces' },
      {
        id: 'create-workspace',
        leftSection: IconPlus,
        label: 'Create workspace',
        onClick: handleCreateWorkspace
      },
      {
        id: 'open-workspace',
        leftSection: IconFolder,
        label: 'Open workspace',
        onClick: handleOpenWorkspace
      },
      ...(showGitWorkspaceFeature
        ? [{
            id: 'clone-git-workspace',
            leftSection: IconBrandGit,
            label: 'Clone Git workspace',
            onClick: handleCloneGitWorkspace
          }]
        : []),
      {
        id: 'import-workspace',
        leftSection: IconDownload,
        label: 'Import workspace',
        onClick: handleImportWorkspace
      },
      {
        id: 'manage-workspaces',
        leftSection: IconSettings,
        label: 'Manage workspaces',
        onClick: handleManageWorkspaces
      }
    );

    return items;
  }, [sortedWorkspaces, activeWorkspaceUid, preferences, handlePinWorkspace, handleCreateWorkspace, showGitWorkspaceFeature]);

  const workspaceGitSummary = useMemo(() => {
    const changedFiles = workspaceGitData?.changedFiles || {};
    const changeCount = (changedFiles.staged?.length || 0) + (changedFiles.unstaged?.length || 0) + (changedFiles.conflicted?.length || 0);
    const ahead = workspaceGitData?.aheadBehind?.ahead || workspaceGitData?.status?.ahead || 0;
    const behind = workspaceGitData?.aheadBehind?.behind || workspaceGitData?.status?.behind || 0;
    const hasRemote = Boolean(workspaceGitData?.remotes?.length);
    const hasConflicts = Boolean(workspaceGitData?.mergeInProgress || changedFiles.conflicted?.length);
    const hasCommits = Boolean(workspaceGitData?.hasCommits);

    return {
      changeCount,
      ahead,
      behind,
      hasRemote,
      hasCommits,
      hasConflicts,
      isGitRepository: Boolean(workspaceGitData?.isGitRepository)
    };
  }, [workspaceGitData]);

  const workspaceGitMenuItems = useMemo(() => {
    if (!workspaceGitSummary.isGitRepository) {
      return [
        {
          id: 'init-workspace-git',
          leftSection: IconGitFork,
          label: workspaceGitOperation === 'Initialize Git' ? 'Initializing...' : 'Initialize Git',
          onClick: initializeWorkspaceGit
        },
        {
          id: 'open-workspace-git',
          leftSection: IconBrandGit,
          label: 'Open Git tab',
          onClick: handleOpenWorkspaceGit
        },
        {
          id: 'refresh-workspace-git',
          leftSection: IconRefresh,
          label: 'Refresh status',
          onClick: () => refreshWorkspaceGitStatus({ fetchRemote: true })
        }
      ];
    }

    return [
      {
        id: 'open-workspace-git',
        leftSection: IconBrandGit,
        label: 'View changes in Git tab',
        onClick: handleOpenWorkspaceGit
      },
      {
        id: 'refresh-workspace-git',
        leftSection: IconRefresh,
        label: 'Refresh status',
        onClick: () => refreshWorkspaceGitStatus({ fetchRemote: true })
      },
      { type: 'divider', id: 'workspace-git-actions-divider' },
      {
        id: 'sync-workspace-git',
        leftSection: IconUpload,
        label: !workspaceGitSummary.hasRemote
          ? 'Sync committed (set origin first)'
          : !workspaceGitSummary.hasCommits
              ? 'Sync committed (commit first)'
              : workspaceGitOperation === 'Sync committed'
                ? 'Syncing committed changes...'
                : 'Sync committed',
        disabled: !workspaceGitSummary.hasRemote || !workspaceGitSummary.hasCommits,
        onClick: () => runWorkspaceGitOperation('Sync committed', 'renderer:sync-workspace-git')
      },
      {
        id: 'sync-full-workspace-git',
        leftSection: IconGitCommit,
        label: 'Sync Full (use Git tab)',
        onClick: handleOpenWorkspaceGit
      },
      {
        id: 'pull-workspace-git',
        leftSection: IconArrowDown,
        label: !workspaceGitSummary.hasRemote ? 'Pull (set origin first)' : workspaceGitOperation === 'Pull' ? 'Pulling...' : 'Pull',
        disabled: !workspaceGitSummary.hasRemote,
        onClick: () => runWorkspaceGitOperation('Pull', 'renderer:pull-workspace-git')
      },
      {
        id: 'push-workspace-git',
        leftSection: IconArrowUp,
        label: !workspaceGitSummary.hasRemote
          ? 'Push (set origin first)'
          : !workspaceGitSummary.hasCommits
              ? 'Push (commit first)'
              : workspaceGitOperation === 'Push'
                ? 'Pushing...'
                : 'Push',
        disabled: !workspaceGitSummary.hasRemote || !workspaceGitSummary.hasCommits,
        onClick: () => runWorkspaceGitOperation('Push', 'renderer:push-workspace-git')
      }
    ];
  }, [
    handleOpenWorkspaceGit,
    initializeWorkspaceGit,
    refreshWorkspaceGitStatus,
    runWorkspaceGitOperation,
    workspaceGitOperation,
    workspaceGitSummary.hasCommits,
    workspaceGitSummary.hasRemote,
    workspaceGitSummary.isGitRepository
  ]);

  return (
    <StyledWrapper className={`app-titlebar ${osClass} ${isFullScreen ? 'fullscreen' : ''}`}>
      {createWorkspaceModalOpen && (
        <CreateWorkspace onClose={() => setCreateWorkspaceModalOpen(false)} />
      )}
      {importWorkspaceModalOpen && (
        <ImportWorkspace onClose={() => setImportWorkspaceModalOpen(false)} />
      )}
      {cloneGitWorkspaceModalOpen && (
        <CloneGitRepository
          mode="workspace"
          onClose={() => setCloneGitWorkspaceModalOpen(false)}
          onFinish={() => setCloneGitWorkspaceModalOpen(false)}
        />
      )}

      <div className="titlebar-content">
        <div className="titlebar-left">
          {showWindowControls && <AppMenu />}

          <ActionIcon onClick={handleHomeClick} label="Home" size="lg" className="home-button">
            <IconHome size={16} stroke={1.5} />
          </ActionIcon>

          {/* Workspace Dropdown */}
          <MenuDropdown
            data-testid="workspace-menu"
            items={workspaceMenuItems}
            placement="bottom-start"
            selectedItemId={activeWorkspaceUid}
          >
            <WorkspaceName />
          </MenuDropdown>

          {showGitWorkspaceFeature && activeWorkspace?.pathname && (
            <MenuDropdown
              data-testid="workspace-git-menu"
              items={workspaceGitMenuItems}
              placement="bottom-start"
            >
              <button
                className={classNames('titlebar-git-button', {
                  'is-loading': workspaceGitLoading || Boolean(workspaceGitOperation),
                  'has-unpushed': workspaceGitSummary.ahead > 0,
                  'has-conflicts': workspaceGitSummary.hasConflicts,
                  'not-repo': workspaceGitData && !workspaceGitSummary.isGitRepository
                })}
                title={
                  workspaceGitData && !workspaceGitSummary.isGitRepository
                    ? 'Initialize workspace Git'
                    : `${workspaceGitSummary.changeCount} changes, ${workspaceGitSummary.ahead} ahead, ${workspaceGitSummary.behind} behind`
                }
              >
                <IconBrandGit size={14} stroke={1.5} />
                {workspaceGitSummary.isGitRepository ? (
                  <>
                    <span className="git-branch">
                      <IconGitBranch size={12} stroke={1.5} />
                      {workspaceGitData?.currentGitBranch || 'main'}
                    </span>
                    {workspaceGitSummary.changeCount > 0 && <span className="git-pill">{workspaceGitSummary.changeCount}</span>}
                    {workspaceGitSummary.ahead > 0 && (
                      <span className="git-sync-indicator">
                        <IconArrowUp size={11} stroke={2} />
                        {workspaceGitSummary.ahead}
                      </span>
                    )}
                    {workspaceGitSummary.behind > 0 && (
                      <span className="git-behind-indicator">
                        <IconArrowDown size={11} stroke={2} />
                        {workspaceGitSummary.behind}
                      </span>
                    )}
                  </>
                ) : (
                  <span>Git</span>
                )}
              </button>
            </MenuDropdown>
          )}
        </div>

        {/* Center section: Gridman branding */}
        <div className="titlebar-center">
          <Bruno width={28} variant="wire" />
          <span className="bruno-text">Gridman</span>
        </div>

        {/* Right section: Action buttons */}
        <div className="titlebar-right">
          <div className="titlebar-actions">
            {/* Toggle sidebar */}
            <ActionIcon
              onClick={handleToggleSidebar}
              label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              size="lg"
              data-testid="toggle-sidebar-button"
            >
              <IconSidebarToggle collapsed={sidebarCollapsed} size={16} strokeWidth={1.5} />
            </ActionIcon>

            {/* Toggle devtools */}
            <ActionIcon
              onClick={handleToggleDevtools}
              label={isConsoleOpen ? 'Hide devtools' : 'Show devtools'}
              size="lg"
              data-testid="toggle-devtools-button"
            >
              <IconBottombarToggle collapsed={!isConsoleOpen} size={16} strokeWidth={1.5} />
            </ActionIcon>

            <ResponseLayoutToggle />
          </div>

          {showWindowControls && (
            <div className="window-controls">
              <button
                className="window-control-btn minimize"
                onClick={handleMinimize}
                aria-label="Minimize"
              >
                <IconMinus size={16} stroke={1} />
              </button>
              <button
                className="window-control-btn maximize"
                onClick={handleMaximize}
                aria-label={isMaximized ? 'Restore' : 'Maximize'}
              >
                {isMaximized ? <IconCopy size={14} stroke={1} /> : <IconSquare size={14} stroke={1} />}
              </button>
              <button
                className="window-control-btn close"
                onClick={handleClose}
                aria-label="Close"
              >
                <IconX size={16} stroke={1} />
              </button>
            </div>
          )}
        </div>
      </div>
    </StyledWrapper>
  );
};

export default AppTitleBar;
