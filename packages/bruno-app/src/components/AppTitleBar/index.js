import React from 'react';
import {
  IconArrowDown,
  IconArrowUp,
  IconBrandGit,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconGitBranch,
  IconGitFork,
  IconHome,
  IconPin,
  IconPinned,
  IconPlus,
  IconDownload,
  IconUpload,
  IconFileExport,
  IconRefresh,
  IconSettings,
  IconMinus,
  IconSquare,
  IconX,
  IconCopy,
  IconExternalLink
} from '@tabler/icons';
import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';

import { savePreferences, showManageWorkspacePage, toggleSidebarCollapse } from 'providers/ReduxStore/slices/app';
import { closeConsole, openConsole } from 'providers/ReduxStore/slices/logs';
import { createWorkspaceWithUniqueName, openWorkspaceDialog, switchWorkspace } from 'providers/ReduxStore/slices/workspaces/actions';
import ExportWorkspaceModal from 'components/ExportWorkspaceModal';
import { sortWorkspaces, toggleWorkspacePin } from 'utils/workspaces';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import get from 'lodash/get';

import Bruno from 'components/Bruno';
import MenuDropdown from 'ui/MenuDropdown';
import ActionIcon from 'ui/ActionIcon';
import IconSidebarToggle from 'components/Icons/IconSidebarToggle';
import CreateWorkspace from 'components/WorkspaceSidebar/CreateWorkspace';
import ImportWorkspace from 'components/WorkspaceSidebar/ImportWorkspace';
import ExportApiCatalog from 'components/WorkspaceSidebar/ExportApiCatalog';
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

const getBrowserRemoteUrl = (value = '') => {
  const remoteValue = value.trim();
  if (!remoteValue) return '';
  if (/^https?:\/\//i.test(remoteValue)) return remoteValue.replace(/\.git$/i, '');

  const sshUrlMatch = remoteValue.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (sshUrlMatch) return `https://${sshUrlMatch[1]}/${sshUrlMatch[2].replace(/\.git$/i, '')}`;

  const scpStyleMatch = remoteValue.match(/^(?:[^@]+@)?([^:]+):(.+)$/i);
  if (scpStyleMatch) return `https://${scpStyleMatch[1]}/${scpStyleMatch[2].replace(/\.git$/i, '')}`;

  return '';
};

const getProviderUrls = ({ browserRemoteUrl, sourceBranch, targetBranch }) => {
  if (!browserRemoteUrl || !sourceBranch) return { createMergeRequestUrl: '', mergeRequestsUrl: '' };

  const encodedSource = encodeURIComponent(sourceBranch);
  const encodedTarget = encodeURIComponent(targetBranch || 'main');
  if (/github\.com/i.test(browserRemoteUrl)) {
    return {
      createMergeRequestUrl: `${browserRemoteUrl}/compare/${encodedTarget}...${encodedSource}?expand=1`,
      mergeRequestsUrl: `${browserRemoteUrl}/pulls`
    };
  }

  return {
    createMergeRequestUrl: `${browserRemoteUrl}/-/merge_requests/new?merge_request[source_branch]=${encodedSource}&merge_request[target_branch]=${encodedTarget}`,
    mergeRequestsUrl: `${browserRemoteUrl}/-/merge_requests`
  };
};

const getTitlebarGuidedGitAction = ({ summary, operation }) => {
  if (!summary.isGitRepository) {
    return {
      type: 'init',
      label: operation === 'Initialize Git' ? 'Initializing Git...' : 'Initialize Git',
      icon: IconGitFork,
      disabled: operation === 'Initialize Git'
    };
  }

  if (summary.hasConflicts) {
    return {
      type: 'resolve',
      label: 'Resolve conflicts in Git tab',
      icon: IconGitBranch
    };
  }

  if (!summary.hasRemote) {
    return {
      type: 'connect-remote',
      label: 'Connect remote in Git tab',
      icon: IconBrandGit
    };
  }

  if (!summary.hasCommits && summary.remoteHasBranches) {
    return {
      type: 'pull-existing',
      label: operation === 'Pull existing workspace' ? 'Pulling existing workspace...' : 'Pull existing workspace',
      icon: IconDownload,
      disabled: operation === 'Pull existing workspace'
    };
  }

  if (!summary.hasCommits) {
    return {
      type: 'publish-workspace',
      label: 'Publish workspace in Git tab',
      icon: IconBrandGit
    };
  }

  if (summary.changeCount > 0) {
    return {
      type: 'save',
      label: 'Save changes in Git tab',
      icon: IconGitBranch
    };
  }

  if (!summary.hasUpstream) {
    return {
      type: 'publish-branch',
      label: operation === 'Publish branch' ? 'Publishing branch...' : 'Publish branch',
      icon: IconBrandGit,
      disabled: operation === 'Publish branch'
    };
  }

  if (summary.ahead > 0 && summary.behind > 0) {
    return {
      type: 'sync',
      label: operation === 'Sync changes' ? 'Syncing changes...' : 'Sync changes',
      icon: IconRefresh,
      disabled: operation === 'Sync changes'
    };
  }

  if (summary.behind > 0) {
    return {
      type: 'pull',
      label: operation === 'Pull updates' ? 'Pulling updates...' : 'Pull updates',
      icon: IconDownload,
      disabled: operation === 'Pull updates'
    };
  }

  if (summary.ahead > 0) {
    return {
      type: 'push',
      label: operation === 'Push to remote' ? 'Pushing to remote...' : 'Push to remote',
      icon: IconBrandGit,
      disabled: operation === 'Push to remote'
    };
  }

  return {
    type: 'synced',
    label: 'Workspace is synced',
    icon: IconCheck,
    disabled: true
  };
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

    ipcRenderer.invoke('renderer:window-is-fullscreen')
      .then((fullscreen) => {
        setIsFullScreen(fullscreen);
      })
      .catch((error) => {
        console.error('Error getting initial fullscreen state:', error);
      });

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
  const [exportApiCatalogModalOpen, setExportApiCatalogModalOpen] = useState(false);
  const [workspaceGitData, setWorkspaceGitData] = useState(null);
  const [exportWorkspaceModalOpen, setExportWorkspaceModalOpen] = useState(false);
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

  const runGuidedWorkspaceGitAction = useCallback(async (action, label) => {
    if (!workspaceGitData?.gitRootPath) {
      handleOpenWorkspaceGit();
      return;
    }

    const remote = workspaceGitData.remotes?.find((item) => item.name === 'origin')?.name || workspaceGitData.remotes?.[0]?.name || 'origin';

    setWorkspaceGitOperation(label);
    try {
      const result = await window.ipcRenderer.invoke('renderer:guided-workspace-git-action', {
        gitRootPath: workspaceGitData.gitRootPath,
        processUid: uuid(),
        remote,
        action,
        remoteBranch: workspaceGitData.remoteDefaultBranch || workspaceGitData.defaultGitBranch || 'main',
        strategy: '--no-rebase'
      });

      if (result?.mergeInProgress) {
        toast.error('Merge conflicts need to be resolved in the Git tab');
        handleOpenWorkspaceGit();
      } else {
        toast.success(result?.message || `${label} completed`);
      }
      await refreshWorkspaceGitStatus({ silent: true, fetchRemote: ['pull', 'pull-existing', 'sync'].includes(action) });
    } catch (error) {
      toast.error(getIpcErrorMessage(error, `${label} failed`));
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
      const result = await dispatch(openWorkspaceDialog());
      if (result) {
        toast.success('Workspace opened successfully');
      }
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

  const handleExportWorkspace = () => {
    if (!activeWorkspaceUid) {
      toast.error('No active workspace to export');
      return;
    }
    setExportWorkspaceModalOpen(true);
  };

  const handleExportApiCatalog = () => {
    if (!activeWorkspaceUid) {
      toast.error('No active workspace to export');
      return;
    }
    setExportApiCatalogModalOpen(true);
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
        id: 'export-workspace',
        leftSection: IconUpload,
        label: 'Export workspace',
        onClick: handleExportWorkspace
      },
      {
        id: 'export-api-catalog',
        leftSection: IconFileExport,
        label: 'Export API catalog',
        onClick: handleExportApiCatalog
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
    // The conflicted LIST is capped for big workspaces; conflictedCount carries
    // the real number, so the badge must prefer it or it under-reports exactly
    // when there is most to report.
    const conflictedCount = changedFiles.conflictedCount ?? (changedFiles.conflicted?.length || 0);
    const changeCount = (changedFiles.staged?.length || 0) + (changedFiles.unstaged?.length || 0) + conflictedCount;
    const ahead = workspaceGitData?.aheadBehind?.ahead || workspaceGitData?.status?.ahead || 0;
    const behind = workspaceGitData?.aheadBehind?.behind || workspaceGitData?.status?.behind || 0;
    const hasRemote = Boolean(workspaceGitData?.remotes?.length);
    const hasConflicts = Boolean(workspaceGitData?.mergeInProgress || conflictedCount);
    const hasCommits = Boolean(workspaceGitData?.hasCommits);
    const hasUpstream = Boolean(workspaceGitData?.hasUpstream || workspaceGitData?.trackingBranch || workspaceGitData?.status?.tracking);
    const remoteHasBranches = Boolean(workspaceGitData?.remoteHasBranches || workspaceGitData?.remoteBranchNames?.length || workspaceGitData?.remoteBranches?.length);
    const currentBranch = workspaceGitData?.currentBranch || workspaceGitData?.currentGitBranch || workspaceGitData?.status?.current || '';
    const remoteUrl = workspaceGitData?.remotes?.find((item) => item.name === 'origin')?.refs?.fetch || workspaceGitData?.remotes?.[0]?.refs?.fetch || '';
    const browserRemoteUrl = getBrowserRemoteUrl(remoteUrl);
    const providerUrls = getProviderUrls({
      browserRemoteUrl,
      sourceBranch: currentBranch,
      targetBranch: workspaceGitData?.remoteDefaultBranch || workspaceGitData?.defaultGitBranch || 'main'
    });

    return {
      changeCount,
      ahead,
      behind,
      hasRemote,
      hasCommits,
      hasUpstream,
      hasConflicts,
      remoteHasBranches,
      currentBranch,
      trackingBranch: workspaceGitData?.trackingBranch || workspaceGitData?.status?.tracking || '',
      providerUrls,
      isGitRepository: Boolean(workspaceGitData?.isGitRepository)
    };
  }, [workspaceGitData]);

  const workspaceGitMenuItems = useMemo(() => {
    const primaryAction = getTitlebarGuidedGitAction({
      summary: workspaceGitSummary,
      operation: workspaceGitOperation
    });
    const runPrimaryAction = () => {
      if (primaryAction.type === 'init') {
        return initializeWorkspaceGit();
      }

      if (['connect-remote', 'publish-workspace', 'save', 'resolve'].includes(primaryAction.type)) {
        return handleOpenWorkspaceGit();
      }

      if (primaryAction.type === 'synced') {
        return null;
      }

      return runGuidedWorkspaceGitAction(primaryAction.type, primaryAction.label);
    };

    const items = [
      {
        type: 'label',
        label: workspaceGitSummary.isGitRepository && workspaceGitSummary.hasUpstream
          ? `${workspaceGitSummary.currentBranch} -> ${workspaceGitSummary.trackingBranch}`
          : workspaceGitSummary.isGitRepository
            ? `${workspaceGitSummary.currentBranch || 'Branch'} (not published)`
            : 'Git is not initialized'
      },
      {
        id: 'workspace-git-primary-action',
        leftSection: primaryAction.icon,
        label: primaryAction.label,
        disabled: primaryAction.disabled,
        onClick: runPrimaryAction
      },
      { type: 'divider', id: 'workspace-git-primary-divider' },
      {
        id: 'open-workspace-git',
        leftSection: IconBrandGit,
        label: 'View Git tab',
        onClick: handleOpenWorkspaceGit
      },
      {
        id: 'refresh-workspace-git',
        leftSection: IconRefresh,
        label: 'Refresh status',
        onClick: () => refreshWorkspaceGitStatus({ fetchRemote: true })
      },
      { type: 'divider', id: 'workspace-git-mr-divider' },
      {
        id: 'create-merge-request',
        leftSection: IconExternalLink,
        label: 'Create merge request',
        disabled: !workspaceGitSummary.providerUrls.createMergeRequestUrl,
        onClick: () => window?.ipcRenderer?.openExternal(workspaceGitSummary.providerUrls.createMergeRequestUrl)
      },
      {
        id: 'open-merge-requests',
        leftSection: IconExternalLink,
        label: 'Open merge requests',
        disabled: !workspaceGitSummary.providerUrls.mergeRequestsUrl,
        onClick: () => window?.ipcRenderer?.openExternal(workspaceGitSummary.providerUrls.mergeRequestsUrl)
      }
    ];

    if (!workspaceGitSummary.providerUrls.createMergeRequestUrl && !workspaceGitSummary.providerUrls.mergeRequestsUrl) {
      return items.filter((item) => !['workspace-git-mr-divider', 'create-merge-request', 'open-merge-requests'].includes(item.id));
    }

    return items;
  }, [
    handleOpenWorkspaceGit,
    initializeWorkspaceGit,
    refreshWorkspaceGitStatus,
    runGuidedWorkspaceGitAction,
    workspaceGitOperation,
    workspaceGitSummary.hasCommits,
    workspaceGitSummary.remoteHasBranches,
    workspaceGitSummary.hasRemote,
    workspaceGitSummary.hasUpstream,
    workspaceGitSummary.hasConflicts,
    workspaceGitSummary.changeCount,
    workspaceGitSummary.ahead,
    workspaceGitSummary.behind,
    workspaceGitSummary.isGitRepository,
    workspaceGitSummary.currentBranch,
    workspaceGitSummary.trackingBranch,
    workspaceGitSummary.providerUrls.createMergeRequestUrl,
    workspaceGitSummary.providerUrls.mergeRequestsUrl
  ]);

  return (
    <StyledWrapper className={`app-titlebar ${osClass} ${isFullScreen ? 'fullscreen' : ''}`}>
      {createWorkspaceModalOpen && (
        <CreateWorkspace onClose={() => setCreateWorkspaceModalOpen(false)} />
      )}
      {importWorkspaceModalOpen && (
        <ImportWorkspace onClose={() => setImportWorkspaceModalOpen(false)} />
      )}
      {exportApiCatalogModalOpen && (
        <ExportApiCatalog
          workspaceUid={activeWorkspaceUid}
          onClose={() => setExportApiCatalogModalOpen(false)}
        />
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
                      {workspaceGitData?.currentBranch || workspaceGitData?.currentGitBranch || workspaceGitData?.remoteDefaultBranch || 'main'}
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
      {exportWorkspaceModalOpen && (
        <ExportWorkspaceModal
          workspaceUid={activeWorkspaceUid}
          onClose={() => setExportWorkspaceModalOpen(false)}
        />
      )}
    </StyledWrapper>
  );
};

export default AppTitleBar;
