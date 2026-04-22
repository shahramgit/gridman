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
  IconCloudUpload
} from '@tabler/icons';

import Button from 'ui/Button';
import StyledWrapper from './StyledWrapper';
import { uuid } from 'utils/common';

const DEFAULT_REMOTE = 'origin';
const DEFAULT_PULL_STRATEGY = '--no-rebase';

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
  const [repairingCollections, setRepairingCollections] = useState(false);

  const gitRootPath = gitData?.gitRootPath;
  const currentBranch = gitData?.currentGitBranch || gitData?.status?.current || '';
  const remote = gitData?.remotes?.find((item) => item.name === DEFAULT_REMOTE)?.name || gitData?.remotes?.[0]?.name || DEFAULT_REMOTE;
  const remoteUrl = gitData?.remotes?.find((item) => item.name === remote)?.refs?.fetch || '';
  const changedFiles = gitData?.changedFiles || {};
  const staged = changedFiles.staged || [];
  const unstaged = changedFiles.unstaged || [];
  const conflicted = changedFiles.conflicted || [];
  const hasConflicts = gitData?.mergeInProgress || conflicted.length > 0;
  const outsideCollections = gitData?.outsideCollections || [];
  const hasCommits = Boolean(gitData?.hasCommits);

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
      setGitData(result);
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
        if (label.includes('Sync') && typeof result === 'object') {
          setOutput(`${label} completed: fetched${result.pulled ? ', pulled' : ''}${result.pushed ? ', pushed' : ''}.`);
        } else {
          setOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
        }
      }
      toast.success(`${label} completed`);
      await refresh();
    } catch (error) {
      setOutput(error?.message || String(error));
      toast.error(error?.message || `${label} failed`);
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
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Sync Full failed');
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
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Failed to initialize Git');
    } finally {
      setOperation(null);
    }
  };

  const moveCollectionsInsideWorkspace = async () => {
    if (!workspace?.pathname || outsideCollections.length === 0) return;

    setRepairingCollections(true);
    setOutput('');
    try {
      const movedCollections = await window.ipcRenderer.invoke('renderer:move-workspace-collections-inside', {
        workspacePath: workspace.pathname,
        collectionPaths: outsideCollections.map((collection) => collection.path)
      });

      setOutput([
        'Moved collections into the workspace:',
        ...movedCollections.map((collection) => `${collection.from} -> ${collection.to}`)
      ].join('\n'));
      toast.success('Collections moved into workspace');
      await refresh();
    } catch (error) {
      setOutput(error?.message || String(error));
      toast.error(error?.message || 'Failed to move collections');
    } finally {
      setRepairingCollections(false);
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
  };

  const copyCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Command copied');
    } catch (error) {
      toast.error('Failed to copy command');
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
    if (!conflicted.length) {
      toast.error('No conflicted files found');
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
      'git add . && git commit -m "Initial Bruno workspace"'
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
              Initialize Git in this workspace folder. Bruno will create the usual safe defaults, including a `.gitignore`
              for secrets, dependencies, and OS files.
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
            {outsideCollections.length > 0 && (
              <div className="workspace-warning mt-4">
                <div className="font-semibold">Collections outside this workspace</div>
                <p className="text-muted mt-1">
                  Git can only track files under one workspace folder. Move these collections into this workspace before syncing.
                </p>
                <div className="outside-list mt-2">
                  {outsideCollections.map((collection) => (
                    <div key={collection.path} className="outside-row">{collection.path}</div>
                  ))}
                </div>
                <Button
                  size="sm"
                  color="primary"
                  className="mt-3"
                  loading={repairingCollections}
                  onClick={moveCollectionsInsideWorkspace}
                >
                  Move inside workspace
                </Button>
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
              <span className="truncate" title={remoteUrl}>{remoteUrl || 'not configured'}</span>
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

          {outsideCollections.length > 0 && (
            <div className="panel warning-panel">
              <div className="section-title">Workspace Layout</div>
              <p className="text-sm text-muted">
                These collections are outside the workspace folder, so they cannot be included in this workspace Git repository.
              </p>
              <div className="outside-list mt-2">
                {outsideCollections.map((collection) => (
                  <div key={collection.path} className="outside-row">{collection.path}</div>
                ))}
              </div>
              <Button
                size="sm"
                color="primary"
                className="mt-3"
                loading={repairingCollections}
                onClick={moveCollectionsInsideWorkspace}
              >
                Move inside workspace
              </Button>
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
              Commit saves a Git snapshot. If nothing is staged, Bruno stages all unstaged files before committing.
            </div>
          </div>

          {hasConflicts && (
            <div className="panel">
              <div className="section-title">Conflicts</div>
              <p className="text-sm text-muted">Resolve conflict markers in the files, then continue the merge.</p>
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
            {conflicted.length > 0 && (
              <>
                <div className="font-semibold mb-1">Conflicts</div>
                {conflicted.map((file) => (
                  <div key={`conflict-${file.path}`} className={`file-row ${selectedFile?.path === file.path ? 'active' : ''}`} onClick={() => selectFile(file)}>
                    <span className="file-status">UU</span>
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
