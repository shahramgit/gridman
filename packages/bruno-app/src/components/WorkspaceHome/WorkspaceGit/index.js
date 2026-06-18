import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  IconArrowDown,
  IconArrowUp,
  IconGitBranch,
  IconRefresh,
  IconUpload,
  IconDownload,
  IconGitCommit,
  IconGitMerge,
  IconX,
  IconGitFork,
  IconTerminal,
  IconCopy,
  IconCloudUpload,
  IconExternalLink,
  IconKey,
  IconEdit,
  IconPlus,
  IconCircleCheck,
  IconAlertTriangle
} from '@tabler/icons';

import Button from 'ui/Button';
import Modal from 'components/Modal';
import Portal from 'components/Portal';
import StyledWrapper from './StyledWrapper';
import { uuid } from 'utils/common';

const DEFAULT_REMOTE = 'origin';
const DEFAULT_PULL_STRATEGY = '--no-rebase';

const getIpcErrorMessage = (error, fallback) => {
  const message = error?.message || String(error || '') || fallback;
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    || fallback;
};

const getBrowserRemoteUrl = (value = '') => {
  const remoteValue = value.trim();

  if (!remoteValue) {
    return '';
  }

  if (/^https?:\/\//i.test(remoteValue)) {
    return remoteValue.replace(/\.git$/i, '');
  }

  const sshUrlMatch = remoteValue.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (sshUrlMatch) {
    return `https://${sshUrlMatch[1]}/${sshUrlMatch[2].replace(/\.git$/i, '')}`;
  }

  const scpStyleMatch = remoteValue.match(/^(?:[^@]+@)?([^:]+):(.+)$/i);
  if (scpStyleMatch) {
    return `https://${scpStyleMatch[1]}/${scpStyleMatch[2].replace(/\.git$/i, '')}`;
  }

  return '';
};

const getProviderUrls = ({ browserRemoteUrl, sourceBranch, targetBranch }) => {
  if (!browserRemoteUrl || !sourceBranch) {
    return { createMergeRequestUrl: '', mergeRequestsUrl: '' };
  }

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

const getAuthModeLabel = (protocol) => {
  if (protocol === 'https') return 'HTTPS';
  if (protocol === 'ssh') return 'SSH';
  if (protocol === 'file') return 'Local path';
  return 'Not configured';
};

const getAuthSummary = (auth) => {
  if (!auth?.remoteUrl) {
    return 'Set a remote URL first. HTTPS is the easiest option for most users.';
  }

  if (auth.protocol === 'https') {
    return auth.credentialHelper?.configured
      ? 'Gridman will use your system Git credential manager for tokens or app passwords.'
      : 'HTTPS works best with Git Credential Manager so credentials are stored in the OS keychain.';
  }

  if (auth.protocol === 'ssh') {
    return auth.ssh?.hasKeys
      ? 'Gridman will use your existing SSH key through Git and ssh-agent.'
      : 'SSH needs a local key and the public key must be added to your Git provider.';
  }

  return 'Gridman delegates authentication to Git on this machine.';
};

const getAuthCommands = (auth) => {
  if (!auth?.remoteUrl) {
    return ['git remote add origin <url>'];
  }

  if (auth.protocol === 'https') {
    return [
      'git config --global credential.helper manager',
      `git ls-remote ${auth.remoteUrl}`
    ];
  }

  if (auth.protocol === 'ssh') {
    return [
      'ssh-keygen -t ed25519 -C "you@example.com"',
      'ssh-add ~/.ssh/id_ed25519',
      `git ls-remote ${auth.remoteUrl}`
    ];
  }

  return [`git ls-remote ${auth.remoteUrl}`];
};

const getSetupItemStatus = ({ ok, warning = false, admin = false, skipped = false }) => {
  if (skipped) return { label: 'Unknown', className: 'setup-unknown' };
  if (ok) return { label: 'OK', className: 'setup-ok' };
  if (admin) return { label: 'Needs admin', className: 'setup-admin' };
  if (warning) return { label: 'Warning', className: 'setup-warning' };
  return { label: 'Needs setup', className: 'setup-missing' };
};

const getWindowsSetupItems = (setup) => {
  if (!setup) return [];

  const isSsh = setup.protocol === 'ssh';
  const isHttps = setup.protocol === 'https';

  return [
    {
      id: 'git',
      title: 'Git executable',
      fa: 'نصب بودن Git و قابل دسترس بودن آن برای Gridman.',
      status: getSetupItemStatus({ ok: setup.git?.available }),
      detail: setup.git?.message
    },
    {
      id: 'ssh-client',
      title: 'OpenSSH client',
      fa: 'برای ریموت‌های SSH باید کلاینت OpenSSH نصب باشد.',
      status: getSetupItemStatus({ ok: !isSsh || setup.sshClient?.available, skipped: !isSsh }),
      detail: isSsh ? setup.sshClient?.message : 'Only needed for SSH remotes.'
    },
    {
      id: 'ssh-key',
      title: 'SSH key',
      fa: 'کلید عمومی باید در Git provider اضافه شده باشد.',
      status: getSetupItemStatus({ ok: !isSsh || setup.sshKey?.hasKeys, skipped: !isSsh }),
      detail: isSsh ? (setup.sshKey?.hasKeys ? setup.sshKey.keys.map((key) => key.name).join(', ') : 'No common SSH key found.') : 'Only needed for SSH remotes.'
    },
    {
      id: 'known-host',
      title: 'Trusted SSH host',
      fa: 'هاست ریموت باید در known_hosts ثبت شده باشد.',
      status: getSetupItemStatus({ ok: !isSsh || setup.knownHost?.configured, skipped: !isSsh || !setup.remoteInfo?.host }),
      detail: isSsh ? setup.knownHost?.message : 'Only needed for SSH remotes.'
    },
    {
      id: 'identity',
      title: 'Git user name and email',
      fa: 'برای commit باید نام و ایمیل Git تنظیم شده باشد.',
      status: getSetupItemStatus({ ok: setup.gitIdentity?.configured }),
      detail: setup.gitIdentity?.configured ? `${setup.gitIdentity.name} <${setup.gitIdentity.email}>` : setup.gitIdentity?.message
    },
    {
      id: 'git-longpaths',
      title: 'Git long paths',
      fa: 'برای collectionهای عمیق در ویندوز لازم است.',
      status: getSetupItemStatus({ ok: setup.gitLongPaths?.configured }),
      detail: setup.gitLongPaths?.message
    },
    {
      id: 'windows-longpaths',
      title: 'Windows long paths',
      fa: 'این مورد نیاز به دسترسی Administrator دارد.',
      status: getSetupItemStatus({ ok: setup.windowsLongPaths?.enabled, admin: !setup.windowsLongPaths?.enabled }),
      detail: setup.windowsLongPaths?.message
    },
    {
      id: 'https-credentials',
      title: 'HTTPS credentials',
      fa: 'برای HTTPS بهتر است Git Credential Manager فعال باشد.',
      status: getSetupItemStatus({ ok: !isHttps || Boolean(setup.remoteUrl), skipped: !isHttps }),
      detail: isHttps ? 'Gridman uses Git Credential Manager or your system Git credential helper.' : 'Only needed for HTTPS remotes.'
    }
  ];
};

const getGuidedActionIcon = (type) => {
  if (type === 'pull') return <IconArrowDown size={14} />;
  if (type === 'pull-existing') return <IconArrowDown size={14} />;
  if (type === 'push') return <IconArrowUp size={14} />;
  if (type === 'sync' || type === 'sync-full') return <IconUpload size={14} />;
  if (type === 'synced') return <IconRefresh size={14} />;
  if (type === 'save' || type === 'publish-workspace' || type === 'publish-branch') return <IconCloudUpload size={14} />;
  if (type === 'init') return <IconGitBranch size={14} />;
  if (type === 'connect-remote') return <IconCloudUpload size={14} />;
  if (type === 'resolve') return <IconGitMerge size={14} />;
  return <IconRefresh size={14} />;
};

const getWorkspaceGitPayload = (workspace) => ({
  workspacePath: workspace?.pathname,
  collectionPaths: (workspace?.collections || []).map((collection) => collection.path).filter(Boolean)
});

const WorkspaceGit = ({ workspace }) => {
  const [gitData, setGitData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [mergeMessage, setMergeMessage] = useState('Merge remote changes');
  const [selectedFile, setSelectedFile] = useState(null);
  const [diff, setDiff] = useState('');
  const [output, setOutput] = useState('');
  const [remoteUrlInput, setRemoteUrlInput] = useState('');
  const [remoteBranchInput, setRemoteBranchInput] = useState('main');
  const [connectRemoteModalOpen, setConnectRemoteModalOpen] = useState(false);
  const [connectRemoteTestResult, setConnectRemoteTestResult] = useState(null);
  const [preferredRemoteBranch, setPreferredRemoteBranch] = useState('');
  const [editingRemote, setEditingRemote] = useState(false);
  const [reconcilingCollections, setReconcilingCollections] = useState(false);
  const [collectionReconciliation, setCollectionReconciliation] = useState(null);
  const [authDiagnostics, setAuthDiagnostics] = useState(null);
  const [authTestResult, setAuthTestResult] = useState(null);
  const [createBranchName, setCreateBranchName] = useState('');
  const [createBranchBase, setCreateBranchBase] = useState('');
  const [mergeFromBranch, setMergeFromBranch] = useState('');
  const [publishAfterCreate, setPublishAfterCreate] = useState(false);
  const [setupDiagnostics, setSetupDiagnostics] = useState(null);
  const [setupOperation, setSetupOperation] = useState(null);
  const [setupResult, setSetupResult] = useState('');
  const [confirmSetupAction, setConfirmSetupAction] = useState(null);
  const [sshKeyEmail, setSshKeyEmail] = useState('');
  const [gitIdentityName, setGitIdentityName] = useState('');
  const [gitIdentityEmail, setGitIdentityEmail] = useState('');
  const [guidedCommitAction, setGuidedCommitAction] = useState(null);
  const [guidedCommitMessage, setGuidedCommitMessage] = useState('');

  const gitRootPath = gitData?.gitRootPath;
  const currentBranch = gitData?.currentBranch || gitData?.currentGitBranch || gitData?.status?.current || '';
  const trackingBranch = gitData?.trackingBranch || gitData?.status?.tracking || '';
  const hasUpstream = Boolean(gitData?.hasUpstream || trackingBranch);
  const remote = gitData?.remotes?.find((item) => item.name === DEFAULT_REMOTE)?.name || gitData?.remotes?.[0]?.name || DEFAULT_REMOTE;
  const remoteUrl = gitData?.remotes?.find((item) => item.name === remote)?.refs?.fetch || '';
  const remoteDefaultBranch = gitData?.remoteDefaultBranch || gitData?.defaultGitBranch || 'main';
  const localBranches = gitData?.localBranches || gitData?.branches || [];
  const remoteBranches = gitData?.remoteBranches || [];
  const changedFiles = gitData?.changedFiles || {};
  const staged = changedFiles.staged || [];
  const unstaged = changedFiles.unstaged || [];
  const conflicted = changedFiles.conflicted || [];
  const tooManyFiles = Boolean(changedFiles.tooManyFiles);
  const totalChangedFiles = changedFiles.totalFiles || 0;
  const fileCount = useMemo(() => staged.length + unstaged.length + conflicted.length, [staged.length, unstaged.length, conflicted.length]);
  const hasConflicts = gitData?.mergeInProgress || conflicted.length > 0;
  const orphanCollections = collectionReconciliation?.orphanCollections || [];
  const missingCollections = collectionReconciliation?.missingCollections || [];
  const hasCommits = Boolean(gitData?.hasCommits);
  const remoteHasBranches = Boolean(gitData?.remoteHasBranches || gitData?.remoteBranchNames?.length || remoteBranches.length);
  const ahead = Number(gitData?.aheadBehind?.ahead || 0);
  const behind = Number(gitData?.aheadBehind?.behind || 0);
  const hasLocalChanges = Boolean(fileCount > 0 || tooManyFiles);
  const canPublishCurrentBranch = Boolean(hasCommits && (gitData?.canPublishCurrentBranch || (currentBranch && !hasUpstream)));
  const browserRemoteUrl = getBrowserRemoteUrl(remoteUrl);
  const providerUrls = getProviderUrls({
    browserRemoteUrl,
    sourceBranch: currentBranch,
    targetBranch: remoteDefaultBranch
  });
  const preferredBranchBase = useMemo(() => {
    if (remoteDefaultBranch && remoteBranches.includes(remoteDefaultBranch)) {
      return `${remote}/${remoteDefaultBranch}`;
    }
    return currentBranch || remoteDefaultBranch || 'main';
  }, [currentBranch, remote, remoteBranches, remoteDefaultBranch]);
  const guidedRemoteBranch = preferredRemoteBranch || currentBranch || remoteDefaultBranch || 'main';
  const branchBase = createBranchBase || preferredBranchBase;
  const auth = authDiagnostics || gitData?.auth;
  const authCommands = useMemo(() => getAuthCommands(auth), [auth]);
  const windowsSetupItems = useMemo(() => getWindowsSetupItems(setupDiagnostics), [setupDiagnostics]);
  const showWindowsGitSetup = setupDiagnostics?.platform === 'win32';

  const guidedAction = useMemo(() => {
    if (!gitData?.isGitRepository) {
      return {
        type: 'init',
        title: 'Start tracking this workspace',
        description: 'Initialize Git so this workspace can be saved and synced.',
        primaryLabel: 'Initialize Git',
        needsCommitMessage: false
      };
    }

    if (hasConflicts) {
      return {
        type: 'resolve',
        title: 'Resolve merge conflicts',
        description: 'A pull or sync found conflicting changes. Resolve them before continuing.',
        primaryLabel: 'Resolve conflicts',
        needsCommitMessage: false,
        tone: 'warning'
      };
    }

    if (!remoteUrl) {
      return {
        type: 'connect-remote',
        title: 'Connect a Git remote',
        description: 'Paste the repository URL once. After that Gridman can publish or sync this workspace.',
        primaryLabel: 'Connect remote',
        needsCommitMessage: false
      };
    }

    if (!hasCommits && remoteHasBranches) {
      return {
        type: 'pull-existing',
        title: 'Pull existing workspace',
        description: 'This remote already has commits. Pull the existing workspace before publishing local changes.',
        primaryLabel: 'Pull existing workspace',
        needsCommitMessage: false
      };
    }

    if (!hasCommits) {
      return {
        type: 'publish-workspace',
        title: 'Publish this workspace',
        description: 'Gridman will save safe workspace files, create the first commit, and push this branch to the remote.',
        primaryLabel: 'Publish workspace',
        defaultMessage: 'Initial workspace',
        needsCommitMessage: true
      };
    }

    if (hasLocalChanges && behind > 0) {
      return {
        type: 'sync-full',
        title: 'Sync local and remote changes',
        description: 'Gridman will save safe local files, pull remote commits, then push your committed changes.',
        primaryLabel: 'Sync changes',
        defaultMessage: 'Update workspace',
        needsCommitMessage: true
      };
    }

    if (hasLocalChanges) {
      return {
        type: 'save',
        title: 'Save local changes',
        description: 'Gridman will stage safe workspace files and create a Git commit. Environment files are excluded.',
        primaryLabel: 'Save changes',
        defaultMessage: 'Update workspace',
        needsCommitMessage: true
      };
    }

    if (remoteUrl && !hasUpstream) {
      return {
        type: 'publish-branch',
        title: 'Publish this branch',
        description: 'This branch has not been connected to the remote yet.',
        primaryLabel: 'Publish branch',
        needsCommitMessage: false
      };
    }

    if (ahead > 0 && behind > 0) {
      return {
        type: 'sync',
        title: 'Sync local and remote changes',
        description: 'Gridman will pull remote commits, then push your committed local commits.',
        primaryLabel: 'Sync changes',
        needsCommitMessage: false
      };
    }

    if (behind > 0) {
      return {
        type: 'pull',
        title: 'Pull remote updates',
        description: 'The remote has commits this workspace does not have yet.',
        primaryLabel: 'Pull updates',
        needsCommitMessage: false
      };
    }

    if (ahead > 0) {
      return {
        type: 'push',
        title: 'Push committed changes',
        description: 'Your local commits are ready to upload to the remote.',
        primaryLabel: 'Push to remote',
        needsCommitMessage: false
      };
    }

    return {
      type: 'synced',
      title: 'Workspace is synced',
      description: 'There are no local changes and no remote updates detected.',
      primaryLabel: 'Refresh status',
      needsCommitMessage: false
    };
  }, [ahead, behind, gitData?.isGitRepository, hasCommits, hasConflicts, hasLocalChanges, hasUpstream, remoteHasBranches, remoteUrl]);

  const refresh = useCallback(async ({ fetchRemote = false } = {}) => {
    if (!workspace?.pathname) return;
    setLoading(true);
    if (fetchRemote) {
      setOutput('');
    }
    try {
      const result = await window.ipcRenderer.invoke('renderer:get-workspace-git-data', {
        ...getWorkspaceGitPayload(workspace),
        fetchRemote,
        remote
      });
      const reconciliation = await window.ipcRenderer
        .invoke('renderer:get-workspace-collection-reconciliation', workspace.pathname)
        .catch(() => null);
      setGitData(result);
      setCollectionReconciliation(reconciliation);
      setAuthDiagnostics(result?.auth || null);
      if (fetchRemote && result?.isGitRepository && result?.remotes?.length) {
        setOutput('Status refreshed from remote.');
      }
    } catch (error) {
      if (fetchRemote) {
        setOutput(error?.message || String(error));
      }
      toast.error(error?.message || 'Failed to load workspace Git status');
    } finally {
      setLoading(false);
    }
  }, [remote, workspace?.pathname]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshSetupDiagnostics = useCallback(async ({ silent = false } = {}) => {
    if (!gitRootPath) return;
    if (!silent) {
      setSetupOperation('Check Git setup');
    }
    try {
      const result = await window.ipcRenderer.invoke('renderer:get-workspace-git-setup-diagnostics', {
        gitRootPath,
        remote,
        remoteUrl
      });
      setSetupDiagnostics(result);
      setGitIdentityName(result?.gitIdentity?.name || '');
      setGitIdentityEmail(result?.gitIdentity?.email || '');
      setSshKeyEmail(result?.gitIdentity?.email || '');
      if (!silent) {
        toast.success('Git setup checked');
      }
    } catch (error) {
      if (!silent) {
        toast.error(error?.message || 'Failed to check Git setup');
      }
    } finally {
      if (!silent) {
        setSetupOperation(null);
      }
    }
  }, [gitRootPath, remote, remoteUrl]);

  useEffect(() => {
    refreshSetupDiagnostics({ silent: true });
  }, [refreshSetupDiagnostics]);

  const runGitOperation = async (label, invokeName, payload = {}) => {
    if (!gitRootPath) return;
    if (['Push', 'Sync committed'].includes(label) && !hasCommits) {
      toast.error('Create the first commit before pushing or syncing');
      return;
    }
    if (label === 'Publish branch' && !hasCommits) {
      toast.error('Create the first commit before publishing this branch');
      return;
    }
    if (['Pull', 'Push', 'Sync committed'].includes(label) && !hasUpstream && !payload.remoteBranch) {
      toast.error('Publish this branch or set an upstream before syncing');
      return;
    }
    setOperation(label);
    setOutput('');
    try {
      const processUid = uuid();
      const result = await window.ipcRenderer.invoke(invokeName, {
        gitRootPath,
        processUid,
        remote,
        strategy: DEFAULT_PULL_STRATEGY,
        ...payload
      });
      if (result) {
        const safetyCommitNote = result.safetyCommitCreated
          ? ` Local files were first saved in a safety commit: ${result.safetyCommitFiles?.join(', ')}.`
          : '';
        const protectedBackupNote = result.protectedFilesBackedUp
          ? ` Protected local environment files were backed up before pull: ${result.protectedBackupPath}.`
          : '';
        const localBackupNote = result.localFilesBackedUp
          ? ` Local files that could not be safety-committed were backed up before pull: ${result.localBackupPath}.`
          : '';
        if (result.mergeInProgress) {
          setOutput(`${result.message || 'Merge conflicts need to be resolved before sync can continue.'}${safetyCommitNote}${protectedBackupNote}${localBackupNote}`);
        } else if (label.includes('Sync') && typeof result === 'object') {
          setOutput(`${label} completed: fetched${result.pulled ? ', pulled' : ''}${result.pushed ? ', pushed' : ''}.${safetyCommitNote}${protectedBackupNote}${localBackupNote}`);
        } else if (result.safetyCommitCreated) {
          setOutput(`${label} completed.${safetyCommitNote}${protectedBackupNote}${localBackupNote}`);
        } else if (result.protectedFilesBackedUp) {
          setOutput(`${label} completed.${protectedBackupNote}${localBackupNote}`);
        } else if (result.localFilesBackedUp) {
          setOutput(`${label} completed.${localBackupNote}`);
        } else {
          setOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
        }
      }
      if (result?.mergeInProgress) {
        toast.error('Merge conflicts need to be resolved');
      } else {
        toast.success(`${label} completed`);
      }
      await refresh();
    } catch (error) {
      const message = getIpcErrorMessage(error, `${label} failed`);
      setOutput(message);
      toast.error(message);
      await refresh();
    } finally {
      setOperation(null);
    }
  };

  const runGuidedAction = async (action, message = '') => {
    if (!gitRootPath) return;

    setOperation(guidedAction?.primaryLabel || 'Git Assistant');
    setOutput('');
    try {
      const result = await window.ipcRenderer.invoke('renderer:guided-workspace-git-action', {
        gitRootPath,
        processUid: uuid(),
        remote,
        action,
        message,
        remoteBranch: guidedRemoteBranch,
        strategy: DEFAULT_PULL_STRATEGY
      });

      const protectedNote = result?.skippedProtectedFiles?.length
        ? `\n\nLocal environment files were excluded:\n${result.skippedProtectedFiles.join('\n')}`
        : '';
      setOutput(`${result?.message || 'Git action completed.'}${protectedNote}`);
      if (result?.mergeInProgress) {
        toast.error('Merge conflicts need to be resolved');
      } else {
        toast.success(result?.message || 'Git action completed');
      }
      setGuidedCommitAction(null);
      setGuidedCommitMessage('');
      await refresh({ fetchRemote: ['pull', 'pull-existing', 'sync', 'sync-full'].includes(action) });
    } catch (error) {
      const message = getIpcErrorMessage(error, 'Git action failed');
      setOutput(message);
      toast.error(message);
      await refresh();
    } finally {
      setOperation(null);
    }
  };

  const openGuidedCommitModal = (action) => {
    setGuidedCommitAction(action);
    setGuidedCommitMessage(action.defaultMessage || 'Update workspace');
  };

  const handleGuidedPrimaryAction = () => {
    if (!guidedAction) return null;

    if (guidedAction.type === 'init') {
      return initializeGit();
    }

    if (guidedAction.type === 'connect-remote') {
      setRemoteUrlInput(remoteUrl || '');
      setRemoteBranchInput(preferredRemoteBranch || currentBranch || remoteDefaultBranch || 'main');
      setConnectRemoteTestResult(null);
      setConnectRemoteModalOpen(true);
      return null;
    }

    if (guidedAction.type === 'resolve') {
      setOutput('Resolve each conflicted file in the Conflicts section, then continue the merge.');
      return null;
    }

    if (guidedAction.type === 'synced') {
      return refresh({ fetchRemote: true });
    }

    if (guidedAction.needsCommitMessage) {
      openGuidedCommitModal(guidedAction);
      return null;
    }

    return runGuidedAction(guidedAction.type);
  };

  const confirmGuidedCommit = () => {
    const message = guidedCommitMessage.trim();
    if (!message) {
      toast.error('Commit message is required');
      return;
    }
    return runGuidedAction(guidedCommitAction.type, message);
  };

  const syncFull = async () => {
    if (!gitRootPath) return;
    if (hasConflicts) {
      toast.error('Resolve merge conflicts before syncing');
      return;
    }

    const hasLocalChanges = staged.length > 0 || unstaged.length > 0;
    const message = commitMessage.trim();

    if (!hasLocalChanges) {
      return runGitOperation('Sync committed', 'renderer:sync-workspace-git');
    }

    if (!message) {
      toast.error('Commit message is required for Sync Full');
      return;
    }

    setOperation('Sync Full');
    setOutput('');
    try {
      if (unstaged.length) {
        await window.ipcRenderer.invoke('renderer:stage-workspace-git-files', {
          gitRootPath,
          files: unstaged.map((file) => file.path)
        });
      }

      await window.ipcRenderer.invoke('renderer:commit-workspace-git', {
        gitRootPath,
        message
      });

      const result = await window.ipcRenderer.invoke('renderer:sync-workspace-git', {
        gitRootPath,
        processUid: uuid(),
        remote,
        strategy: DEFAULT_PULL_STRATEGY
      });

      setCommitMessage('');
      setOutput(`Sync Full completed: committed, fetched${result?.pulled ? ', pulled' : ''}${result?.pushed ? ', pushed' : ''}.`);
      toast.success('Sync Full completed');
      await refresh();
    } catch (error) {
      const message = getIpcErrorMessage(error, 'Sync Full failed');
      setOutput(message);
      toast.error(message);
      await refresh();
    } finally {
      setOperation(null);
    }
  };

  const initializeGit = async () => {
    if (!workspace?.pathname) return;
    setOperation('Initialize Git');
    setOutput('');
    try {
      const result = await window.ipcRenderer.invoke('renderer:init-workspace-git', {
        ...getWorkspaceGitPayload(workspace)
      });
      setGitData(result);
      toast.success('Git initialized for this workspace');
    } catch (error) {
      const message = getIpcErrorMessage(error, 'Failed to initialize Git');
      setOutput(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const addOrphanCollectionsToWorkspace = async () => {
    if (!workspace?.pathname || orphanCollections.length === 0) return;

    setReconcilingCollections(true);
    setOutput('');
    try {
      const addedCollections = await window.ipcRenderer.invoke(
        'renderer:add-orphan-workspace-collections',
        workspace.pathname,
        orphanCollections
      );

      setOutput([
        'Added collection folders back to workspace.yml:',
        ...addedCollections.map((collection) => collection.relativePath || collection.path)
      ].join('\n'));
      toast.success('Collection folders added to workspace');
      await refresh();
    } catch (error) {
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Failed to add collection folders');
    } finally {
      setReconcilingCollections(false);
    }
  };

  const deleteOrphanCollectionsFromDisk = async () => {
    if (!workspace?.pathname || orphanCollections.length === 0) return;

    setReconcilingCollections(true);
    setOutput('');
    try {
      const deletedCollections = await window.ipcRenderer.invoke(
        'renderer:delete-orphan-workspace-collections',
        workspace.pathname,
        orphanCollections
      );

      setOutput([
        'Deleted collection folders from disk:',
        ...deletedCollections.map((collection) => collection.relativePath || collection.path)
      ].join('\n'));
      toast.success('Collection folders deleted from disk');
      await refresh();
    } catch (error) {
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Failed to delete collection folders');
    } finally {
      setReconcilingCollections(false);
    }
  };

  const removeMissingCollectionsFromWorkspace = async () => {
    if (!workspace?.pathname || missingCollections.length === 0) return;

    setReconcilingCollections(true);
    setOutput('');
    try {
      const removedCollections = await window.ipcRenderer.invoke(
        'renderer:remove-missing-workspace-collections',
        workspace.pathname,
        missingCollections
      );

      setOutput([
        'Removed missing collection entries from workspace.yml:',
        ...removedCollections.map((collection) => collection.path || collection.name)
      ].join('\n'));
      toast.success('Missing collection entries removed');
      await refresh();
    } catch (error) {
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Failed to remove missing collection entries');
    } finally {
      setReconcilingCollections(false);
    }
  };

  const setRemote = async () => {
    const nextRemoteUrl = remoteUrlInput.trim();
    const nextBranch = remoteBranchInput.trim() || 'main';
    if (!nextRemoteUrl) {
      toast.error('Remote URL is required');
      return;
    }

    setOperation('Set remote');
    setOutput('');
    try {
      await window.ipcRenderer.invoke('renderer:set-workspace-git-remote', {
        gitRootPath,
        remoteName: DEFAULT_REMOTE,
        remoteUrl: nextRemoteUrl,
        branchName: nextBranch
      });
      setPreferredRemoteBranch(nextBranch);
      setRemoteUrlInput('');
      setRemoteBranchInput('main');
      setEditingRemote(false);
      setConnectRemoteModalOpen(false);
      setConnectRemoteTestResult(null);
      setAuthTestResult(null);
      toast.success(`Origin connected for branch ${nextBranch}.`);
      await refresh({ fetchRemote: true });
    } catch (error) {
      const message = getIpcErrorMessage(error, 'Set remote failed');
      setOutput(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const startEditingRemote = () => {
    setRemoteUrlInput(remoteUrl || '');
    setRemoteBranchInput(preferredRemoteBranch || currentBranch || remoteDefaultBranch || 'main');
    setEditingRemote(true);
    setAuthTestResult(null);
  };

  const cancelEditingRemote = () => {
    setRemoteUrlInput('');
    setRemoteBranchInput('main');
    setEditingRemote(false);
  };

  const testRemoteConnectionInput = async () => {
    const nextRemoteUrl = remoteUrlInput.trim();
    if (!gitRootPath || !nextRemoteUrl) {
      toast.error('Remote URL is required');
      return;
    }

    setOperation('Test connection');
    setConnectRemoteTestResult(null);
    try {
      const result = await window.ipcRenderer.invoke('renderer:test-workspace-git-auth', {
        gitRootPath,
        remote,
        remoteUrl: nextRemoteUrl
      });
      setConnectRemoteTestResult(result);
      if (result.ok) {
        toast.success('Git connection succeeded');
      } else {
        toast.error(result.message || 'Git connection failed');
      }
    } catch (error) {
      const result = { ok: false, message: getIpcErrorMessage(error, 'Git connection failed') };
      setConnectRemoteTestResult(result);
      toast.error(result.message);
    } finally {
      setOperation(null);
    }
  };

  const refreshAuthDiagnostics = async () => {
    if (!gitRootPath) return;
    setOperation('Check authentication');
    setAuthTestResult(null);
    try {
      const result = await window.ipcRenderer.invoke('renderer:get-workspace-git-auth-diagnostics', {
        gitRootPath,
        remote,
        remoteUrl
      });
      setAuthDiagnostics(result);
      toast.success('Authentication settings refreshed');
    } catch (error) {
      toast.error(error?.message || 'Failed to check authentication settings');
    } finally {
      setOperation(null);
    }
  };

  const testAuthentication = async () => {
    if (!gitRootPath) return;
    setOperation('Test connection');
    setAuthTestResult(null);
    try {
      const result = await window.ipcRenderer.invoke('renderer:test-workspace-git-auth', {
        gitRootPath,
        remote,
        remoteUrl
      });
      setAuthDiagnostics(result);
      setAuthTestResult(result);
      if (result.ok) {
        toast.success('Git connection succeeded');
      } else {
        toast.error(result.message || 'Git connection failed');
      }
    } catch (error) {
      const result = { ok: false, message: error?.message || String(error) };
      setAuthTestResult(result);
      toast.error(result.message);
    } finally {
      setOperation(null);
    }
  };

  const runSetupAction = async (label, invokeName, payload = {}) => {
    setSetupOperation(label);
    setSetupResult('');
    try {
      const result = await window.ipcRenderer.invoke(invokeName, payload);
      setSetupResult(result?.message || JSON.stringify(result, null, 2));
      if (result?.publicKey) {
        setSetupResult(`${result.message}\n\nPublic key:\n${result.publicKey}`);
      }
      toast.success(`${label} completed`);
      await refreshSetupDiagnostics({ silent: true });
      return result;
    } catch (error) {
      const message = getIpcErrorMessage(error, `${label} failed`);
      setSetupResult(message);
      toast.error(message);
      return null;
    } finally {
      setSetupOperation(null);
      setConfirmSetupAction(null);
    }
  };

  const confirmCreateSshKey = () => {
    setConfirmSetupAction({
      type: 'create-ssh-key',
      title: 'Create SSH key',
      confirmText: 'Create key',
      body: 'Gridman will create ~/.ssh/id_ed25519 only if it does not already exist. It will not upload the key to your Git provider.',
      bodyFa: 'Gridman فقط اگر کلید وجود نداشته باشد آن را می‌سازد و آن را جایی آپلود نمی‌کند.'
    });
  };

  const confirmSetGitIdentity = () => {
    setConfirmSetupAction({
      type: 'set-git-identity',
      title: 'Save Git identity',
      confirmText: 'Save identity',
      body: 'Gridman will write git config --global user.name and user.email for this Windows user.',
      bodyFa: 'Gridman نام و ایمیل Git را به صورت global برای همین کاربر ذخیره می‌کند.'
    });
  };

  const confirmEnableGitLongPaths = () => {
    setConfirmSetupAction({
      type: 'enable-git-longpaths',
      title: 'Enable Git long paths',
      confirmText: 'Enable',
      body: 'Gridman will run git config --global core.longpaths true. This does not require administrator access.',
      bodyFa: 'این تنظیم فقط برای Git کاربر فعلی اعمال می‌شود و نیاز به Administrator ندارد.'
    });
  };

  const confirmAddKnownHost = async () => {
    const host = setupDiagnostics?.remoteInfo?.host;
    const port = setupDiagnostics?.remoteInfo?.port || '22';
    if (!host) {
      toast.error('SSH host could not be detected from the remote URL');
      return;
    }

    setSetupOperation('Scan SSH host');
    setSetupResult('');
    try {
      const scan = await window.ipcRenderer.invoke('renderer:scan-git-known-host', { host, port });
      setConfirmSetupAction({
        type: 'add-known-host',
        title: 'Trust SSH host',
        confirmText: 'Add host',
        body: `Gridman will append this SSH host key to ~/.ssh/known_hosts for ${host}:${port}.`,
        bodyFa: 'قبل از اضافه کردن کلید هاست، مقدار پیدا شده را بررسی کنید.',
        payload: scan
      });
    } catch (error) {
      const message = getIpcErrorMessage(error, 'Failed to scan SSH host');
      setSetupResult(message);
      toast.error(message);
    } finally {
      setSetupOperation(null);
    }
  };

  const confirmSetupModalAction = async () => {
    if (!confirmSetupAction) return;

    if (confirmSetupAction.type === 'create-ssh-key') {
      await runSetupAction('Create SSH key', 'renderer:create-git-ssh-key', { email: sshKeyEmail });
      return;
    }

    if (confirmSetupAction.type === 'set-git-identity') {
      await runSetupAction('Save Git identity', 'renderer:set-git-identity', {
        gitRootPath,
        name: gitIdentityName,
        email: gitIdentityEmail
      });
      return;
    }

    if (confirmSetupAction.type === 'enable-git-longpaths') {
      await runSetupAction('Enable Git long paths', 'renderer:enable-git-global-longpaths', { gitRootPath });
      return;
    }

    if (confirmSetupAction.type === 'add-known-host') {
      await runSetupAction('Add known host', 'renderer:add-git-known-host', confirmSetupAction.payload);
    }
  };

  const testSetupConnection = async () => {
    if (!gitRootPath) return;
    await runSetupAction('Test Git connection', 'renderer:test-git-ssh-connection', {
      gitRootPath,
      remote,
      remoteUrl
    });
  };

  const copyCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Command copied');
    } catch (error) {
      toast.error('Failed to copy command');
    }
  };

  const openRemoteUrl = () => {
    if (!browserRemoteUrl) {
      return;
    }

    window?.ipcRenderer?.openExternal(browserRemoteUrl);
  };

  const openCreateMergeRequest = () => {
    if (!providerUrls.createMergeRequestUrl) {
      copyCommand(`git push -u ${remote} ${currentBranch || '<branch>'}`);
      setOutput('Could not detect a provider merge request URL. Publish the branch, then create a merge request in your Git provider.');
      return;
    }
    window?.ipcRenderer?.openExternal(providerUrls.createMergeRequestUrl);
  };

  const openMergeRequests = () => {
    if (!providerUrls.mergeRequestsUrl) {
      setOutput('Could not detect a provider merge request URL for this remote.');
      return;
    }
    window?.ipcRenderer?.openExternal(providerUrls.mergeRequestsUrl);
  };

  const checkoutBranch = (branchName) => {
    if (!branchName || branchName === currentBranch) return null;
    return runGitOperation('Checkout branch', 'renderer:checkout-workspace-git-branch', { branchName });
  };

  const checkoutRemoteBranch = (branchName) => {
    if (!branchName) return null;
    return runGitOperation('Checkout remote branch', 'renderer:checkout-workspace-git-remote-branch', { branchName });
  };

  const mergeBranch = async (branchName) => {
    if (!branchName || branchName === currentBranch) return null;
    await runGitOperation('Merge branch', 'renderer:merge-workspace-git-branch', { branchName });
    setMergeFromBranch('');
  };

  const handleRepositoryBranchChange = (value) => {
    if (!value || value === currentBranch) return null;

    if (value.startsWith(`${remote}/`)) {
      return checkoutRemoteBranch(value.slice(remote.length + 1));
    }

    return checkoutBranch(value);
  };

  const publishBranch = () => {
    if (!currentBranch) {
      toast.error('Current branch could not be detected');
      return null;
    }
    return runGitOperation('Publish branch', 'renderer:publish-workspace-git-branch', { branchName: currentBranch });
  };

  const createBranch = async () => {
    const branchName = createBranchName.trim();
    if (!branchName) {
      toast.error('Branch name is required');
      return;
    }

    await runGitOperation('Create branch', 'renderer:create-workspace-git-branch', {
      branchName,
      startPoint: branchBase
    });
    setCreateBranchName('');
    setCreateBranchBase('');

    if (publishAfterCreate) {
      await runGitOperation('Publish branch', 'renderer:publish-workspace-git-branch', { branchName });
    }
  };

  const selectFile = async (file, stagedDiff = false) => {
    setSelectedFile({ ...file, stagedDiff });
    setDiff('Loading diff...');
    try {
      const result = await window.ipcRenderer.invoke('renderer:get-workspace-git-diff', {
        gitRootPath,
        filePath: file.path,
        staged: stagedDiff
      });
      setDiff(result || 'No diff available.');
    } catch (error) {
      setDiff(error?.message || 'Failed to load diff.');
    }
  };

  const stageFiles = (files) => runGitOperation('Stage', 'renderer:stage-workspace-git-files', { files: files.map((file) => file.path) });
  const unstageFiles = (files) => runGitOperation('Unstage', 'renderer:unstage-workspace-git-files', { files: files.map((file) => file.path) });

  const resolveConflict = (file, side) => {
    const label = side === 'ours' ? 'Accept local' : 'Accept remote';
    return runGitOperation(label, 'renderer:resolve-workspace-git-conflict-file', {
      filePath: file.path,
      side
    });
  };

  const commit = async () => {
    const message = commitMessage.trim();
    if (!message) {
      toast.error('Commit message is required');
      return;
    }

    if (!staged.length && !unstaged.length) {
      toast.error('No changes to commit');
      return;
    }

    setOperation('Commit');
    setOutput('');
    try {
      if (!staged.length && unstaged.length) {
        await window.ipcRenderer.invoke('renderer:stage-workspace-git-files', {
          gitRootPath,
          files: unstaged.map((file) => file.path)
        });
      }

      const result = await window.ipcRenderer.invoke('renderer:commit-workspace-git', {
        gitRootPath,
        message
      });
      if (result) {
        setOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      }
      setCommitMessage('');
      toast.success('Commit completed');
      await refresh();
    } catch (error) {
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Commit failed');
      await refresh();
    } finally {
      setOperation(null);
    }
  };

  const abortMerge = () => runGitOperation('Abort merge', 'renderer:abort-workspace-git-merge');

  const continueMerge = () => {
    if (!gitData?.mergeInProgress) {
      toast.error('No merge in progress');
      return;
    }
    return runGitOperation('Continue merge', 'renderer:continue-resolved-workspace-git-merge', {
      conflictedFilePaths: conflicted.map((file) => file.path),
      commitMessage: mergeMessage
    });
  };

  if (!workspace?.pathname) {
    return <div className="p-4">Workspace path not found.</div>;
  }

  if (loading && !gitData) {
    return <div className="p-4">Loading Git status...</div>;
  }

  if (gitData && !gitData.isGitRepository) {
    const initCommands = [
      'git init',
      'git branch -M main',
      'git remote add origin <url>',
      'git add . && git commit -m "Initial Gridman workspace"'
    ];

    return (
      <StyledWrapper>
        <div className="empty-state-grid">
          <div className="panel empty-state-panel">
            <div className="status-icon">
              <IconGitFork size={28} strokeWidth={1.5} />
            </div>
            <h3>Start tracking this workspace</h3>
            <p className="text-muted">
              Initialize Git in this workspace folder. Gridman will create the usual safe defaults, including a `.gitignore`
              for secrets, Gridman environment files, dependencies, and OS files.
            </p>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button
                size="sm"
                color="primary"
                icon={<IconGitFork size={14} />}
                loading={operation === 'Initialize Git'}
                onClick={initializeGit}
              >
                Initialize Git
              </Button>
              <Button
                size="sm"
                color="light"
                icon={<IconRefresh size={14} />}
                loading={loading}
                onClick={() => refresh()}
              >
                Refresh
              </Button>
            </div>
            {(orphanCollections.length > 0 || missingCollections.length > 0) && (
              <div className="workspace-warning mt-4">
                <div className="font-semibold">Workspace collections need repair</div>
                <p className="text-muted mt-1">
                  Some collection folders and `workspace.yml` entries are out of sync.
                </p>
                {orphanCollections.length > 0 && (
                  <>
                    <div className="outside-list mt-2">
                      {orphanCollections.map((collection) => (
                        <div key={collection.path} className="outside-row">{collection.relativePath || collection.path}</div>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      color="primary"
                      className="mt-3"
                      loading={reconcilingCollections}
                      onClick={addOrphanCollectionsToWorkspace}
                    >
                      Add folders to workspace
                    </Button>
                    <Button
                      size="sm"
                      color="danger"
                      className="mt-3 ml-2"
                      loading={reconcilingCollections}
                      onClick={deleteOrphanCollectionsFromDisk}
                    >
                      Delete folders from disk
                    </Button>
                  </>
                )}
                {missingCollections.length > 0 && (
                  <Button
                    size="sm"
                    color="light"
                    className="mt-3 ml-2"
                    loading={reconcilingCollections}
                    onClick={removeMissingCollectionsFromWorkspace}
                  >
                    Remove missing entries
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="section-title">Manual setup</div>
            <p className="text-muted mb-3">Run these in the workspace folder if you prefer Terminal.</p>
            <div className="commands-list">
              {initCommands.map((command) => (
                <div className="command-row" key={command}>
                  <div>
                    <code>{command}</code>
                  </div>
                  <button className="copy-command" onClick={() => copyCommand(command)} title="Copy command">
                    <IconCopy size={14} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
            <div className="terminal-hint mt-3">
              <IconTerminal size={15} strokeWidth={1.5} />
              <span>{workspace.pathname}</span>
            </div>
          </div>
        </div>
      </StyledWrapper>
    );
  }

  return (
    <StyledWrapper>
      <div className="git-layout">
        <div className="space-y-4">
          <div className={`panel git-assistant-panel ${guidedAction?.tone === 'warning' ? 'warning-panel' : ''}`}>
            <div className="assistant-header">
              <div>
                <div className="section-title">Git Assistant</div>
                <div className="assistant-title">{guidedAction?.title}</div>
                <p className="assistant-description">{guidedAction?.description}</p>
              </div>
              <Button
                size="sm"
                color={guidedAction?.type === 'synced' ? 'light' : 'primary'}
                icon={getGuidedActionIcon(guidedAction?.type)}
                loading={operation === guidedAction?.primaryLabel}
                disabled={!guidedAction}
                onClick={handleGuidedPrimaryAction}
              >
                {guidedAction?.primaryLabel || 'Refresh'}
              </Button>
            </div>
            <div className="assistant-facts">
              <span>{currentBranch || 'unknown branch'}</span>
              <span>{remoteUrl ? 'remote connected' : 'no remote'}</span>
              <span>{hasUpstream ? `tracks ${trackingBranch}` : 'not published'}</span>
              <span>{hasLocalChanges ? `${tooManyFiles ? totalChangedFiles : fileCount} changed files` : 'no local changes'}</span>
            </div>
            {(hasLocalChanges || tooManyFiles) && (
              <div className="assistant-note">
                Local environment files are not included in Git.
              </div>
            )}
            {output && <pre className="output-box assistant-output mt-3">{output}</pre>}
          </div>

          <div className="panel">
            <div className="section-title">Repository</div>
            <div className="meta-grid">
              <span className="meta-label">Branch</span>
              <span className="repository-branch-select">
                <IconGitBranch size={14} />
                <select
                  className="textbox"
                  value={currentBranch || ''}
                  disabled={!localBranches.length && !remoteBranches.length}
                  onChange={(event) => handleRepositoryBranchChange(event.target.value)}
                >
                  {currentBranch && !localBranches.includes(currentBranch) && (
                    <option value={currentBranch}>{currentBranch}</option>
                  )}
                  {localBranches.length > 0 && (
                    <optgroup label="Local branches">
                      {localBranches.map((branch) => (
                        <option key={branch} value={branch}>{branch}</option>
                      ))}
                    </optgroup>
                  )}
                  {remoteBranches.length > 0 && (
                    <optgroup label="Remote branches">
                      {remoteBranches.map((branch) => (
                        <option key={`${remote}/${branch}`} value={`${remote}/${branch}`}>{remote}/{branch}</option>
                      ))}
                    </optgroup>
                  )}
                  {!currentBranch && !localBranches.length && !remoteBranches.length && (
                    <option value="">unknown</option>
                  )}
                </select>
              </span>
              <span className="meta-label">Upstream</span>
              <span>{hasUpstream ? `${currentBranch} -> ${trackingBranch}` : `${currentBranch || 'branch'} (not published)`}</span>
              <span className="meta-label">Default</span>
              <span>{remoteDefaultBranch || 'main'}</span>
              <span className="meta-label">Remote</span>
              <span className={`remote-value ${!remoteUrl ? 'remote-value-empty' : ''}`}>
                {remoteUrl ? (
                  <>
                    {browserRemoteUrl ? (
                      <button className="remote-link truncate" title={remoteUrl} onClick={openRemoteUrl}>
                        {remoteUrl}
                      </button>
                    ) : (
                      <span className="truncate remote-text" title={remoteUrl}>{remoteUrl}</span>
                    )}
                    <button className="copy-command" onClick={() => copyCommand(remoteUrl)} title="Copy remote URL">
                      <IconCopy size={14} strokeWidth={1.5} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="truncate remote-text">not configured</span>
                    <Button
                      size="sm"
                      color="primary"
                      icon={<IconCloudUpload size={14} />}
                      onClick={() => {
                        setRemoteUrlInput('');
                        setRemoteBranchInput(currentBranch || remoteDefaultBranch || 'main');
                        setConnectRemoteTestResult(null);
                        setConnectRemoteModalOpen(true);
                      }}
                    >
                      Connect remote
                    </Button>
                  </>
                )}
              </span>
              <span className="meta-label">Sync</span>
              <span><IconArrowUp size={13} className="inline" /> {gitData?.aheadBehind?.ahead || 0} <IconArrowDown size={13} className="inline ml-2" /> {gitData?.aheadBehind?.behind || 0}</span>
              <span className="meta-label">Changes</span>
              <span>{fileCount}</span>
              <span className="meta-label">Commits</span>
              <span>{hasCommits ? 'ready' : 'none yet'}</span>
            </div>
            {!hasCommits && (
              <div className="mt-3 text-sm text-muted">
                Make the first commit before using Push or Sync committed.
              </div>
            )}
            {hasCommits && remoteUrl && !hasUpstream && (
              <div className="mt-3 workspace-warning">
                This branch is not published yet. Publish it before pull, push, or sync.
              </div>
            )}
            {hasConflicts && (
              <div className="mt-3 text-red-500 flex items-center gap-2">
                <IconGitMerge size={16} /> Merge conflict resolution is required.
              </div>
            )}
          </div>

          <details className="advanced-details changes-details" open={hasConflicts}>
            <summary>Changed files and diff</summary>
            <div className="changes-diff-content">
              <div className="panel changes-panel">
                <div className="section-title">Changes</div>
                {tooManyFiles && (
                  <div className="workspace-warning mb-3">
                    Git has {totalChangedFiles} changed files. Gridman hides the full list for performance, but Pull can still create a safety commit for non-protected files.
                  </div>
                )}
                <div className="changes-scroll">
                  {conflicted.length > 0 && (
                    <>
                      <div className="font-semibold mb-1">Conflicts</div>
                      {conflicted.map((file) => (
                        <div key={`conflict-${file.path}`} className={`file-row ${selectedFile?.path === file.path ? 'active' : ''}`} onClick={() => selectFile(file)}>
                          <span className="file-status">{file.status || `${file.fileIndex || ''}${file.working_dir || ''}`}</span>
                          <span className="truncate">{file.path}</span>
                          <div className="file-actions">
                            <Button
                              size="sm"
                              color="light"
                              onClick={(event) => {
                                event.stopPropagation(); resolveConflict(file, 'ours');
                              }}
                            >Accept local
                            </Button>
                            <Button
                              size="sm"
                              color="light"
                              onClick={(event) => {
                                event.stopPropagation(); resolveConflict(file, 'theirs');
                              }}
                            >Accept remote
                            </Button>
                            <Button
                              size="sm"
                              color="light"
                              onClick={(event) => {
                                event.stopPropagation(); stageFiles([file]);
                              }}
                            >Mark resolved
                            </Button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  <div className="font-semibold mt-3 mb-1">Staged</div>
                  {staged.length === 0 && <div className="text-muted text-sm">No staged changes.</div>}
                  {staged.map((file) => (
                    <div key={`staged-${file.path}`} className={`file-row ${selectedFile?.path === file.path && selectedFile?.stagedDiff ? 'active' : ''}`} onClick={() => selectFile(file, true)}>
                      <span className="file-status">{file.fileIndex}</span>
                      <span className="truncate">{file.path}</span>
                      <Button
                        size="sm"
                        color="light"
                        onClick={(event) => {
                          event.stopPropagation(); unstageFiles([file]);
                        }}
                      >Unstage
                      </Button>
                    </div>
                  ))}

                  <div className="font-semibold mt-3 mb-1">Unstaged</div>
                  {unstaged.length === 0 && <div className="text-muted text-sm">No unstaged changes.</div>}
                  {unstaged.map((file) => (
                    <div key={`unstaged-${file.path}`} className={`file-row ${selectedFile?.path === file.path && !selectedFile?.stagedDiff ? 'active' : ''}`} onClick={() => selectFile(file)}>
                      <span className="file-status">{file.working_dir || file.fileIndex}</span>
                      <span className="truncate">{file.path}</span>
                      <Button
                        size="sm"
                        color="light"
                        onClick={(event) => {
                          event.stopPropagation(); stageFiles([file]);
                        }}
                      >Stage
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel diff-panel">
                <div className="section-title">Diff</div>
                <pre className="diff-box">{selectedFile ? diff : 'Select a file to preview the diff.'}</pre>
              </div>
            </div>
          </details>

          <details className="advanced-details" open={editingRemote || hasConflicts}>
            <summary>Advanced Git</summary>
            <div className="advanced-content">
              {remoteUrl && (
                <div className="panel">
                  <div className="section-title">Branches</div>
                  <div className="branch-controls">
                    <select
                      className="textbox"
                      value={currentBranch}
                      onChange={(event) => checkoutBranch(event.target.value)}
                      disabled={operation === 'Checkout branch'}
                    >
                      {localBranches.map((branch) => (
                        <option key={branch} value={branch}>{branch}</option>
                      ))}
                    </select>
                    <Button size="sm" color="light" icon={<IconRefresh size={14} />} loading={operation === 'Fetch'} onClick={() => runGitOperation('Fetch', 'renderer:fetch-workspace-git')}>
                      Fetch
                    </Button>
                    {canPublishCurrentBranch && (
                      <Button size="sm" color="primary" icon={<IconCloudUpload size={14} />} loading={operation === 'Publish branch'} onClick={publishBranch}>
                        Publish branch
                      </Button>
                    )}
                  </div>

                  {remoteBranches.length > 0 && (
                    <div className="mt-3">
                      <div className="text-sm text-muted mb-1">Checkout remote branch</div>
                      <div className="branch-controls">
                        <select
                          className="textbox"
                          defaultValue=""
                          onChange={(event) => {
                            checkoutRemoteBranch(event.target.value);
                            event.target.value = '';
                          }}
                        >
                          <option value="" disabled>Select remote branch...</option>
                          {remoteBranches.map((branch) => (
                            <option key={branch} value={branch}>{remote}/{branch}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="mt-3">
                    <div className="text-sm text-muted mb-1">Create branch</div>
                    <div className="branch-create-form">
                      <input
                        className="textbox"
                        value={createBranchName}
                        onChange={(event) => setCreateBranchName(event.target.value)}
                        placeholder="feature/workspace-sync"
                      />
                      <input
                        className="textbox"
                        value={branchBase}
                        onChange={(event) => setCreateBranchBase(event.target.value)}
                        placeholder="Base branch"
                      />
                      <Button size="sm" color="primary" icon={<IconPlus size={14} />} disabled={!createBranchName.trim()} loading={operation === 'Create branch'} onClick={createBranch}>
                        Create
                      </Button>
                    </div>
                    <label className="branch-checkbox mt-2">
                      <input
                        type="checkbox"
                        checked={publishAfterCreate}
                        onChange={(event) => setPublishAfterCreate(event.target.checked)}
                      />
                      <span>Publish to {remote} after create</span>
                    </label>
                  </div>

                  <div className="mt-3">
                    <div className="text-sm text-muted mb-1">Merge into {currentBranch || 'current branch'}</div>
                    <div className="branch-controls">
                      <select
                        className="textbox"
                        value={mergeFromBranch}
                        onChange={(event) => setMergeFromBranch(event.target.value)}
                        disabled={operation === 'Merge branch'}
                      >
                        <option value="" disabled>Select branch to merge from...</option>
                        {localBranches
                          .filter((branch) => branch !== currentBranch)
                          .map((branch) => (
                            <option key={branch} value={branch}>{branch}</option>
                          ))}
                      </select>
                      <Button
                        size="sm"
                        color="primary"
                        disabled={!mergeFromBranch || mergeFromBranch === currentBranch}
                        loading={operation === 'Merge branch'}
                        onClick={() => mergeBranch(mergeFromBranch)}
                      >
                        Merge
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button size="sm" color="light" icon={<IconExternalLink size={14} />} disabled={!browserRemoteUrl} onClick={openCreateMergeRequest}>
                      Create merge request
                    </Button>
                    <Button size="sm" color="light" icon={<IconExternalLink size={14} />} disabled={!browserRemoteUrl} onClick={openMergeRequests}>
                      Open merge requests
                    </Button>
                  </div>
                </div>
              )}

              {(orphanCollections.length > 0 || missingCollections.length > 0) && (
                <div className="panel warning-panel">
                  <div className="section-title">Workspace Collections</div>
                  <p className="text-sm text-muted">
                    Git merge can leave collection folders and `workspace.yml` out of sync. Repair the workspace index before committing.
                  </p>

                  {orphanCollections.length > 0 && (
                    <div className="mt-3">
                      <div className="font-semibold">Folders not listed in workspace.yml</div>
                      <div className="outside-list mt-2">
                        {orphanCollections.map((collection) => (
                          <div key={collection.path} className="outside-row">{collection.relativePath || collection.path}</div>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        color="primary"
                        className="mt-3"
                        loading={reconcilingCollections}
                        onClick={addOrphanCollectionsToWorkspace}
                      >
                        Add folders to workspace
                      </Button>
                      <Button
                        size="sm"
                        color="danger"
                        className="mt-3 ml-2"
                        loading={reconcilingCollections}
                        onClick={deleteOrphanCollectionsFromDisk}
                      >
                        Delete folders from disk
                      </Button>
                    </div>
                  )}

                  {missingCollections.length > 0 && (
                    <div className="mt-3">
                      <div className="font-semibold">Entries with missing folders</div>
                      <div className="outside-list mt-2">
                        {missingCollections.map((collection) => (
                          <div key={`${collection.name}-${collection.path}`} className="outside-row">
                            {collection.name}: {collection.relativePath || collection.path}
                          </div>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        color="light"
                        className="mt-3"
                        loading={reconcilingCollections}
                        onClick={removeMissingCollectionsFromWorkspace}
                      >
                        Remove missing entries
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {!remoteUrl && (
                <div className="panel">
                  <div className="section-title">Remote</div>
                  <p className="text-sm text-muted mb-2">
                    Connect this workspace to a Git remote. Gridman will ask for the repository URL and branch in one step.
                  </p>
                  <Button
                    size="sm"
                    color="primary"
                    icon={<IconCloudUpload size={14} />}
                    onClick={() => {
                      setRemoteUrlInput('');
                      setRemoteBranchInput(currentBranch || remoteDefaultBranch || 'main');
                      setConnectRemoteTestResult(null);
                      setConnectRemoteModalOpen(true);
                    }}
                  >
                    Connect remote
                  </Button>
                  <div className="commands-list mt-3">
                    {['git remote add origin <url>', `git push -u origin ${currentBranch || 'main'}`].map((command) => (
                      <div className="command-row" key={command}>
                        <div>
                          <code>{command}</code>
                        </div>
                        <button className="copy-command" onClick={() => copyCommand(command)} title="Copy command">
                          <IconCopy size={14} strokeWidth={1.5} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {remoteUrl && (
                <div className="panel">
                  <div className="section-title">Origin</div>
                  {!editingRemote ? (
                    <>
                      <p className="text-sm text-muted mb-2">
                        Change origin when this workspace should sync with a different Git repository.
                      </p>
                      <Button
                        size="sm"
                        color="light"
                        icon={<IconEdit size={14} />}
                        onClick={startEditingRemote}
                      >
                        Change origin
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted mb-2">
                        Changing origin only changes where this workspace syncs. It does not move files or rewrite local commits.
                        Pulling from an unrelated remote may fail.
                      </p>
                      <div className="remote-form">
                        <input
                          className="textbox"
                          value={remoteUrlInput}
                          onChange={(event) => setRemoteUrlInput(event.target.value)}
                          placeholder="https://github.com/org/repo.git"
                        />
                        <input
                          className="textbox"
                          value={remoteBranchInput}
                          onChange={(event) => setRemoteBranchInput(event.target.value)}
                          placeholder="main"
                        />
                        <Button
                          size="sm"
                          color="primary"
                          icon={<IconCloudUpload size={14} />}
                          disabled={!remoteUrlInput.trim() || (remoteUrlInput.trim() === remoteUrl && (remoteBranchInput.trim() || 'main') === (currentBranch || remoteDefaultBranch || 'main'))}
                          loading={operation === 'Set remote'}
                          onClick={setRemote}
                        >
                          Save origin
                        </Button>
                      </div>
                      <div className="flex gap-2 mt-2">
                        <Button size="sm" color="light" onClick={cancelEditingRemote}>Cancel</Button>
                        <Button size="sm" color="light" icon={<IconCopy size={14} />} onClick={() => copyCommand(`git remote set-url origin ${remoteUrlInput || '<url>'}`)}>
                          Copy command
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="panel">
                <div className="section-title">Authentication</div>
                <div className="auth-summary">
                  <div className="auth-chip">
                    <IconKey size={14} strokeWidth={1.5} />
                    <span>{getAuthModeLabel(auth?.protocol)}</span>
                  </div>
                  <div className="auth-provider">{auth?.provider?.name || 'No provider detected'}</div>
                </div>
                <p className="text-sm text-muted mt-2">{getAuthSummary(auth)}</p>

                {auth?.protocol === 'https' && (
                  <div className="auth-detail mt-3">
                    <span className="meta-label">Credential helper</span>
                    <span>{auth.credentialHelper?.configured ? `${auth.credentialHelper.value} (${auth.credentialHelper.scope})` : 'not configured'}</span>
                  </div>
                )}

                {auth?.protocol === 'ssh' && (
                  <div className="auth-detail mt-3">
                    <span className="meta-label">SSH keys</span>
                    <span>{auth.ssh?.hasKeys ? auth.ssh.keys.map((key) => key.name).join(', ') : 'no common SSH key found'}</span>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 mt-3">
                  <Button size="sm" color="light" icon={<IconRefresh size={14} />} loading={operation === 'Check authentication'} onClick={refreshAuthDiagnostics}>Check setup</Button>
                  <Button size="sm" color="primary" icon={<IconKey size={14} />} disabled={!remoteUrl} loading={operation === 'Test connection'} onClick={testAuthentication}>Test connection</Button>
                  {auth?.helpLinks?.https && (
                    <Button size="sm" color="light" icon={<IconExternalLink size={14} />} onClick={() => window?.ipcRenderer?.openExternal(auth.protocol === 'ssh' ? auth.helpLinks.ssh : auth.helpLinks.https)}>
                      Open setup guide
                    </Button>
                  )}
                </div>

                {authTestResult && (
                  <pre className={`output-box mt-3 ${authTestResult.ok ? 'success-output' : 'error-output'}`}>
                    {authTestResult.message}
                  </pre>
                )}

                <div className="commands-list mt-3">
                  {authCommands.map((command) => (
                    <div className="command-row" key={command}>
                      <div>
                        <code>{command}</code>
                      </div>
                      <button className="copy-command" onClick={() => copyCommand(command)} title="Copy command">
                        <IconCopy size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {showWindowsGitSetup && (
                <details className="nested-advanced-details" open={windowsSetupItems.some((item) => !['setup-ok', 'setup-unknown'].includes(item.status.className))}>
                  <summary>Windows Git Setup</summary>
                  <div className="panel">
                    <div className="section-title">Windows Git Setup</div>
                    <p className="text-sm text-muted mb-3">
                      Diagnose and fix common Windows Git setup issues. Safe user-level fixes require confirmation; administrator commands are copy-only.
                      <br />
                      راهنمای تنظیم Git در ویندوز؛ موارد حساس فقط با تایید شما انجام می‌شوند.
                    </p>

                    <div className="setup-checklist">
                      {windowsSetupItems.map((item) => (
                        <div className="setup-row" key={item.id}>
                          <div className="setup-status-icon">
                            {item.status.className === 'setup-ok' ? <IconCircleCheck size={17} /> : <IconAlertTriangle size={17} />}
                          </div>
                          <div className="setup-row-body">
                            <div className="setup-row-title">{item.title}</div>
                            <div className="setup-row-fa">{item.fa}</div>
                            {item.detail && <div className="setup-row-detail">{item.detail}</div>}
                          </div>
                          <span className={`setup-badge ${item.status.className}`}>{item.status.label}</span>
                        </div>
                      ))}
                    </div>

                    <div className="setup-actions mt-3">
                      <Button size="sm" color="light" icon={<IconRefresh size={14} />} loading={setupOperation === 'Check Git setup'} onClick={() => refreshSetupDiagnostics()}>
                        Re-check
                      </Button>
                      <Button size="sm" color="primary" icon={<IconKey size={14} />} disabled={!remoteUrl} loading={setupOperation === 'Test Git connection'} onClick={testSetupConnection}>
                        Test connection
                      </Button>
                    </div>

                    {setupDiagnostics?.protocol === 'ssh' && (
                      <div className="setup-form mt-3">
                        <label className="setup-input-label">
                          SSH key email/comment
                          <input
                            className="textbox"
                            value={sshKeyEmail}
                            onChange={(event) => setSshKeyEmail(event.target.value)}
                            placeholder="you@example.com"
                          />
                        </label>
                        <div className="setup-actions">
                          <Button size="sm" color="light" icon={<IconKey size={14} />} disabled={setupDiagnostics?.sshKey?.hasKeys} loading={setupOperation === 'Create SSH key'} onClick={confirmCreateSshKey}>
                            Create SSH key
                          </Button>
                          <Button size="sm" color="light" icon={<IconCopy size={14} />} disabled={!setupDiagnostics?.sshKey?.publicKey} onClick={() => copyCommand(setupDiagnostics?.sshKey?.publicKey)}>
                            Copy public key
                          </Button>
                          <Button size="sm" color="light" icon={<IconKey size={14} />} disabled={!setupDiagnostics?.remoteInfo?.host || setupDiagnostics?.knownHost?.configured} loading={setupOperation === 'Scan SSH host' || setupOperation === 'Add known host'} onClick={confirmAddKnownHost}>
                            Trust SSH host
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="setup-form mt-3">
                      <div className="setup-two-columns">
                        <label className="setup-input-label">
                          Git user name
                          <input
                            className="textbox"
                            value={gitIdentityName}
                            onChange={(event) => setGitIdentityName(event.target.value)}
                            placeholder="Example User"
                          />
                        </label>
                        <label className="setup-input-label">
                          Git email
                          <input
                            className="textbox"
                            value={gitIdentityEmail}
                            onChange={(event) => setGitIdentityEmail(event.target.value)}
                            placeholder="example@email.com"
                          />
                        </label>
                      </div>
                      <div className="setup-actions mt-2">
                        <Button size="sm" color="light" icon={<IconEdit size={14} />} disabled={!gitIdentityName.trim() || !gitIdentityEmail.trim()} loading={setupOperation === 'Save Git identity'} onClick={confirmSetGitIdentity}>
                          Save Git identity
                        </Button>
                        <Button size="sm" color="light" icon={<IconTerminal size={14} />} disabled={setupDiagnostics?.gitLongPaths?.configured} loading={setupOperation === 'Enable Git long paths'} onClick={confirmEnableGitLongPaths}>
                          Enable Git long paths
                        </Button>
                      </div>
                    </div>

                    {setupDiagnostics?.adminCommands?.length > 0 && (
                      <div className="mt-3">
                        <div className="text-sm text-muted mb-2">
                          Administrator-only fixes. Gridman will not run these commands for you.
                          <br />
                          این دستورها باید در PowerShell با دسترسی Administrator اجرا شوند.
                        </div>
                        <div className="commands-list">
                          {setupDiagnostics.adminCommands.map((command) => (
                            <div className="command-row" key={command}>
                              <div><code>{command}</code></div>
                              <button className="copy-command" onClick={() => copyCommand(command)} title="Copy command">
                                <IconCopy size={14} strokeWidth={1.5} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {setupDiagnostics?.protocol === 'https' && (
                      <div className="workspace-warning mt-3">
                        HTTPS remotes use Git Credential Manager or your configured Git credential helper.
                        <br />
                        برای HTTPS بهتر است Credential Manager فعال باشد و token/app password استفاده شود.
                      </div>
                    )}

                    {setupResult && <pre className="output-box mt-3">{setupResult}</pre>}
                  </div>
                </details>
              )}

              <div className="panel">
                <div className="section-title">Actions</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" color="light" icon={<IconRefresh size={14} />} loading={loading} onClick={() => refresh({ fetchRemote: true })}>Refresh</Button>
                  <Button size="sm" color="light" icon={<IconDownload size={14} />} loading={operation === 'Fetch'} onClick={() => runGitOperation('Fetch', 'renderer:fetch-workspace-git')}>Fetch</Button>
                  <Button size="sm" color="light" icon={<IconArrowDown size={14} />} disabled={!hasUpstream} loading={operation === 'Pull'} onClick={() => runGitOperation('Pull', 'renderer:pull-workspace-git')}>Pull</Button>
                  <Button size="sm" color="light" icon={<IconArrowUp size={14} />} disabled={!hasCommits || (!hasUpstream && !remoteUrl)} loading={operation === 'Push' || operation === 'Publish branch'} onClick={() => hasUpstream ? runGitOperation('Push', 'renderer:push-workspace-git') : publishBranch()}>{hasUpstream ? 'Push' : 'Publish branch'}</Button>
                  <Button size="sm" color="light" icon={<IconUpload size={14} />} disabled={!remoteUrl || !hasCommits || !hasUpstream} loading={operation === 'Sync committed'} onClick={() => runGitOperation('Sync committed', 'renderer:sync-workspace-git')}>Sync committed</Button>
                  <Button size="sm" color="primary" icon={<IconUpload size={14} />} disabled={!remoteUrl || !hasUpstream || hasConflicts || ((staged.length || unstaged.length) && !commitMessage.trim()) || (!hasCommits && !staged.length && !unstaged.length)} loading={operation === 'Sync Full'} onClick={syncFull}>Sync Full</Button>
                </div>
                <div className="action-help mt-3">
                  <div><strong>Refresh</strong> fetches remote metadata, then rereads Git status.</div>
                  <div><strong>Fetch</strong> downloads remote metadata without changing files.</div>
                  <div><strong>Pull</strong> brings remote commits into this workspace.</div>
                  <div><strong>Push</strong> uploads committed local changes.</div>
                  <div><strong>Publish branch</strong> runs `git push -u {remote} {currentBranch || '<branch>'}` for a branch without upstream.</div>
                  <div><strong>Sync committed</strong> fetches, pulls if behind, then pushes committed local changes.</div>
                  <div><strong>Sync Full</strong> stages local changes, commits them with the message below, then runs Sync committed.</div>
                  <div><strong>Environment files</strong> are ignored by default because they may contain secrets.</div>
                </div>
              </div>

              <div className="panel">
                <div className="section-title">Commit</div>
                <textarea
                  className="textbox w-full h-24"
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="Commit message"
                />
                <div className="flex gap-2 mt-2">
                  <Button size="sm" color="light" disabled={!unstaged.length} onClick={() => stageFiles(unstaged)}>Stage all</Button>
                  <Button size="sm" color="light" disabled={!staged.length} onClick={() => unstageFiles(staged)}>Unstage all</Button>
                  <Button size="sm" color="primary" icon={<IconGitCommit size={14} />} disabled={(!staged.length && !unstaged.length) || !commitMessage.trim()} loading={operation === 'Commit'} onClick={commit}>
                    {staged.length ? 'Commit staged' : 'Stage all and commit'}
                  </Button>
                </div>
                <div className="text-muted text-sm mt-2">
                  Commit saves a Git snapshot. If nothing is staged, Gridman stages all unstaged files before committing.
                </div>
              </div>
            </div>
          </details>
          {hasConflicts && (
            <div className="panel">
              <div className="section-title">Conflicts</div>
              <p className="text-sm text-muted">Choose local or remote for each conflicted file, or edit the files manually, then continue the merge.</p>
              <textarea
                className="textbox w-full h-16 mt-2"
                value={mergeMessage}
                onChange={(event) => setMergeMessage(event.target.value)}
              />
              <div className="flex gap-2 mt-2">
                <Button size="sm" color="primary" icon={<IconGitMerge size={14} />} loading={operation === 'Continue merge'} onClick={continueMerge}>Continue merge</Button>
                <Button size="sm" color="light" icon={<IconX size={14} />} loading={operation === 'Abort merge'} onClick={abortMerge}>Abort merge</Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {connectRemoteModalOpen && (
        <Portal>
          <Modal
            size="md"
            title="Connect Git remote"
            confirmText="Connect remote"
            handleConfirm={setRemote}
            handleCancel={() => {
              setConnectRemoteModalOpen(false);
              setRemoteUrlInput('');
              setRemoteBranchInput('main');
              setConnectRemoteTestResult(null);
            }}
          >
            <div style={{ display: 'grid', gap: 16 }}>
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                Paste the Git repository URL and choose the branch this workspace should use.
              </p>
              <label style={{ display: 'grid', gap: 8, fontSize: 13, fontWeight: 600 }}>
                <span>Origin URL</span>
                <input
                  className="textbox"
                  value={remoteUrlInput}
                  onChange={(event) => {
                    setRemoteUrlInput(event.target.value);
                    setConnectRemoteTestResult(null);
                  }}
                  placeholder="https://github.com/org/repo.git"
                  autoFocus
                />
              </label>
              <label style={{ display: 'grid', gap: 8, fontSize: 13, fontWeight: 600 }}>
                <span>Branch</span>
                <input
                  className="textbox"
                  value={remoteBranchInput}
                  onChange={(event) => setRemoteBranchInput(event.target.value)}
                  placeholder="main"
                />
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button
                  size="sm"
                  color="light"
                  icon={<IconRefresh size={14} />}
                  disabled={!remoteUrlInput.trim()}
                  loading={operation === 'Test connection'}
                  onClick={testRemoteConnectionInput}
                >
                  Test connection
                </Button>
                {connectRemoteTestResult && (
                  <span
                    style={{
                      fontSize: 12,
                      color: connectRemoteTestResult.ok ? '#188038' : '#d93025'
                    }}
                  >
                    {connectRemoteTestResult.ok ? 'Connection succeeded' : connectRemoteTestResult.message || 'Connection failed'}
                  </span>
                )}
              </div>
              <div style={{ padding: '9px 10px', border: '1px solid #e5e5e5', borderRadius: 4, fontSize: 12, lineHeight: 1.45, color: '#777' }}>
                If the remote already has files, Gridman will offer to pull the existing workspace after connecting.
              </div>
            </div>
          </Modal>
        </Portal>
      )}
      {guidedCommitAction && (
        <Portal>
          <Modal
            size="md"
            title={guidedCommitAction.title}
            confirmText={guidedCommitAction.primaryLabel}
            handleConfirm={confirmGuidedCommit}
            handleCancel={() => {
              setGuidedCommitAction(null);
              setGuidedCommitMessage('');
            }}
          >
            <div style={{ display: 'grid', gap: 16 }}>
              <p style={{ margin: 0, lineHeight: 1.5 }}>{guidedCommitAction.description}</p>
              <label style={{ display: 'grid', gap: 8, fontSize: 13, fontWeight: 600 }}>
                <span>Commit message</span>
                <textarea
                  className="textbox"
                  style={{ width: '100%', minHeight: 104, resize: 'vertical', fontSize: 14 }}
                  value={guidedCommitMessage}
                  onChange={(event) => setGuidedCommitMessage(event.target.value)}
                  autoFocus
                />
              </label>
              <div style={{ padding: '9px 10px', border: '1px solid #e5e5e5', borderRadius: 4, fontSize: 12, lineHeight: 1.45, color: '#777' }}>
                Environment files are excluded from Git because they may contain secrets.
              </div>
            </div>
          </Modal>
        </Portal>
      )}
      {confirmSetupAction && (
        <Portal>
          <Modal
            size="md"
            title={confirmSetupAction.title}
            confirmText={confirmSetupAction.confirmText}
            handleConfirm={confirmSetupModalAction}
            handleCancel={() => setConfirmSetupAction(null)}
          >
            <div className="space-y-3">
              <p>{confirmSetupAction.body}</p>
              <p className="text-muted">{confirmSetupAction.bodyFa}</p>
              {confirmSetupAction.type === 'add-known-host' && (
                <pre className="output-box">{confirmSetupAction.payload?.hostKey}</pre>
              )}
            </div>
          </Modal>
        </Portal>
      )}
    </StyledWrapper>
  );
};

export default WorkspaceGit;
