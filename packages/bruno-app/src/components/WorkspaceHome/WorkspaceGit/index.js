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
  IconEdit
} from '@tabler/icons';

import Button from 'ui/Button';
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
  const [editingRemote, setEditingRemote] = useState(false);
  const [reconcilingCollections, setReconcilingCollections] = useState(false);
  const [collectionReconciliation, setCollectionReconciliation] = useState(null);
  const [authDiagnostics, setAuthDiagnostics] = useState(null);
  const [authTestResult, setAuthTestResult] = useState(null);

  const gitRootPath = gitData?.gitRootPath;
  const currentBranch = gitData?.currentGitBranch || gitData?.status?.current || '';
  const remote = gitData?.remotes?.find((item) => item.name === DEFAULT_REMOTE)?.name || gitData?.remotes?.[0]?.name || DEFAULT_REMOTE;
  const remoteUrl = gitData?.remotes?.find((item) => item.name === remote)?.refs?.fetch || '';
  const changedFiles = gitData?.changedFiles || {};
  const staged = changedFiles.staged || [];
  const unstaged = changedFiles.unstaged || [];
  const conflicted = changedFiles.conflicted || [];
  const tooManyFiles = Boolean(changedFiles.tooManyFiles);
  const totalChangedFiles = changedFiles.totalFiles || 0;
  const hasConflicts = gitData?.mergeInProgress || conflicted.length > 0;
  const orphanCollections = collectionReconciliation?.orphanCollections || [];
  const missingCollections = collectionReconciliation?.missingCollections || [];
  const hasCommits = Boolean(gitData?.hasCommits);
  const browserRemoteUrl = getBrowserRemoteUrl(remoteUrl);
  const auth = authDiagnostics || gitData?.auth;
  const authCommands = useMemo(() => getAuthCommands(auth), [auth]);

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

  const runGitOperation = async (label, invokeName, payload = {}) => {
    if (!gitRootPath) return;
    if (['Push', 'Sync committed'].includes(label) && !hasCommits) {
      toast.error('Create the first commit before pushing or syncing');
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
        remoteBranch: currentBranch,
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
        remoteBranch: currentBranch,
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
    if (!nextRemoteUrl) {
      toast.error('Remote URL is required');
      return;
    }

    await runGitOperation('Set remote', 'renderer:set-workspace-git-remote', {
      remoteName: DEFAULT_REMOTE,
      remoteUrl: nextRemoteUrl
    });
    setRemoteUrlInput('');
    setEditingRemote(false);
    setAuthTestResult(null);
    toast.success('Origin changed. Test the connection before syncing.');
  };

  const startEditingRemote = () => {
    setRemoteUrlInput(remoteUrl || '');
    setEditingRemote(true);
    setAuthTestResult(null);
  };

  const cancelEditingRemote = () => {
    setRemoteUrlInput('');
    setEditingRemote(false);
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

  const fileCount = useMemo(() => staged.length + unstaged.length + conflicted.length, [staged.length, unstaged.length, conflicted.length]);

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
          <div className="panel">
            <div className="section-title">Repository</div>
            <div className="meta-grid">
              <span className="meta-label">Branch</span>
              <span className="flex items-center gap-1"><IconGitBranch size={14} />{currentBranch || 'unknown'}</span>
              <span className="meta-label">Remote</span>
              <span className="remote-value">
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
                  <span className="truncate remote-text">not configured</span>
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
            {hasConflicts && (
              <div className="mt-3 text-red-500 flex items-center gap-2">
                <IconGitMerge size={16} /> Merge conflict resolution is required.
              </div>
            )}
          </div>

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
              <p className="text-sm text-muted mb-2">Connect this local workspace repository to GitHub, GitLab, Bitbucket, or any Git remote.</p>
              <div className="remote-form">
                <input
                  className="textbox"
                  value={remoteUrlInput}
                  onChange={(event) => setRemoteUrlInput(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                />
                <Button
                  size="sm"
                  color="primary"
                  icon={<IconCloudUpload size={14} />}
                  disabled={!remoteUrlInput.trim()}
                  loading={operation === 'Set remote'}
                  onClick={setRemote}
                >
                  Set origin
                </Button>
              </div>
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
                    <Button
                      size="sm"
                      color="primary"
                      icon={<IconCloudUpload size={14} />}
                      disabled={!remoteUrlInput.trim() || remoteUrlInput.trim() === remoteUrl}
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

          <div className="panel">
            <div className="section-title">Actions</div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" color="light" icon={<IconRefresh size={14} />} loading={loading} onClick={() => refresh({ fetchRemote: true })}>Refresh</Button>
              <Button size="sm" color="light" icon={<IconDownload size={14} />} loading={operation === 'Fetch'} onClick={() => runGitOperation('Fetch', 'renderer:fetch-workspace-git')}>Fetch</Button>
              <Button size="sm" color="light" icon={<IconArrowDown size={14} />} loading={operation === 'Pull'} onClick={() => runGitOperation('Pull', 'renderer:pull-workspace-git')}>Pull</Button>
              <Button size="sm" color="light" icon={<IconArrowUp size={14} />} disabled={!hasCommits} loading={operation === 'Push'} onClick={() => runGitOperation('Push', 'renderer:push-workspace-git')}>Push</Button>
              <Button size="sm" color="light" icon={<IconUpload size={14} />} disabled={!remoteUrl || !hasCommits} loading={operation === 'Sync committed'} onClick={() => runGitOperation('Sync committed', 'renderer:sync-workspace-git')}>Sync committed</Button>
              <Button size="sm" color="primary" icon={<IconUpload size={14} />} disabled={!remoteUrl || hasConflicts || ((staged.length || unstaged.length) && !commitMessage.trim()) || (!hasCommits && !staged.length && !unstaged.length)} loading={operation === 'Sync Full'} onClick={syncFull}>Sync Full</Button>
            </div>
            <div className="action-help mt-3">
              <div><strong>Refresh</strong> fetches remote metadata, then rereads Git status.</div>
              <div><strong>Fetch</strong> downloads remote metadata without changing files.</div>
              <div><strong>Pull</strong> brings remote commits into this workspace.</div>
              <div><strong>Push</strong> uploads committed local changes.</div>
              <div><strong>Sync committed</strong> fetches, pulls if behind, then pushes committed local changes.</div>
              <div><strong>Sync Full</strong> stages local changes, commits them with the message below, then runs Sync committed.</div>
              <div><strong>Environment files</strong> are ignored by default because they may contain secrets.</div>
            </div>
            {output && <pre className="output-box mt-3">{output}</pre>}
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

        <div className="space-y-4">
          <div className="panel">
            <div className="section-title">Changes</div>
            {tooManyFiles && (
              <div className="workspace-warning mb-3">
                Git has {totalChangedFiles} changed files. Gridman hides the full list for performance, but Pull can still create a safety commit for non-protected files.
              </div>
            )}
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

          <div className="panel">
            <div className="section-title">Diff</div>
            <pre className="diff-box">{selectedFile ? diff : 'Select a file to preview the diff.'}</pre>
          </div>
        </div>
      </div>
    </StyledWrapper>
  );
};

export default WorkspaceGit;
