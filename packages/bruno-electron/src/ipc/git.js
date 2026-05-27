const { ipcMain } = require('electron');
const path = require('path');
const {
  readWorkspaceConfig,
  resolveAndFilterWorkspaceCollections,
  getWorkspaceUid
} = require('../utils/workspace-config');
const {
  cloneGitRepository,
  getWorkspaceGitData,
  initWorkspaceGit,
  stageChanges,
  unstageChanges,
  commitChanges,
  fetchChanges,
  pullGitChanges,
  pushGitChanges,
  syncGitChanges,
  checkoutGitBranch,
  checkoutRemoteGitBranch,
  publishGitBranch,
  setGitBranchUpstream,
  abortConflictResolution,
  continueMerge,
  continueResolvedMerge,
  resolveConflictFile,
  getStagedFileDiff,
  getUnstagedFileDiff,
  upsertRemote,
  getGitAuthDiagnostics,
  testGitAuthentication,
  getWorkspaceGitSetupDiagnostics,
  createGitSshKey,
  scanGitKnownHost,
  addGitKnownHost,
  setGitIdentity,
  enableGitGlobalLongPaths,
  testGitSshConnection
} = require('../utils/git');
const { createDirectory, removeDirectory } = require('../utils/filesystem');

const activeWorkspaceGitOperations = new Set();

const withWorkspaceGitOperationLock = async (gitRootPath, operationName, operation) => {
  const lockKey = path.resolve(gitRootPath);

  if (activeWorkspaceGitOperations.has(lockKey)) {
    throw new Error(`Another Git operation is already running for this workspace. Wait for it to finish before running ${operationName}.`);
  }

  activeWorkspaceGitOperations.add(lockKey);
  try {
    return await operation();
  } finally {
    activeWorkspaceGitOperations.delete(lockKey);
  }
};

const notifyWorkspaceConfigUpdated = (mainWindow, workspacePath) => {
  try {
    const workspaceConfig = readWorkspaceConfig(workspacePath);
    const workspaceUid = getWorkspaceUid(workspacePath);
    mainWindow.webContents.send('main:workspace-config-updated', workspacePath, workspaceUid, {
      ...workspaceConfig,
      name: path.basename(workspacePath),
      remoteWorkspaceName: workspaceConfig.name,
      collections: resolveAndFilterWorkspaceCollections(workspacePath, workspaceConfig.collections)
    });
  } catch (_) {
  }
};

const registerGitIpc = (mainWindow) => {
  ipcMain.handle('renderer:clone-git-repository', async (event, { url, path, processUid }) => {
    let directoryCreated = false;
    try {
      await createDirectory(path);
      directoryCreated = true;
      await cloneGitRepository(mainWindow, { url, path, processUid });
      return 'Repository cloned successfully';
    } catch (error) {
      if (directoryCreated) {
        await removeDirectory(path);
      }
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:get-workspace-git-data', async (event, { workspacePath, collectionPaths = [], preferCollectionParent = false, fetchRemote = false, remote = 'origin' }) => {
    return getWorkspaceGitData({ workspacePath, collectionPaths, preferCollectionParent, fetchRemote, remote });
  });

  ipcMain.handle('renderer:init-workspace-git', async (event, { workspacePath, collectionPaths = [], preferCollectionParent = false }) => {
    return withWorkspaceGitOperationLock(workspacePath, 'Git init', () => initWorkspaceGit({ workspacePath, collectionPaths, preferCollectionParent }));
  });

  ipcMain.handle('renderer:set-workspace-git-remote', async (event, { gitRootPath, remoteName = 'origin', remoteUrl }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'set origin', () => upsertRemote({ gitRootPath, remoteName, remoteUrl }));
  });

  ipcMain.handle('renderer:get-workspace-git-auth-diagnostics', async (event, { gitRootPath, remote = 'origin', remoteUrl = '' }) => {
    return getGitAuthDiagnostics({ gitRootPath, remote, remoteUrl });
  });

  ipcMain.handle('renderer:test-workspace-git-auth', async (event, { gitRootPath, remote = 'origin', remoteUrl = '' }) => {
    return testGitAuthentication({ gitRootPath, remote, remoteUrl });
  });

  ipcMain.handle('renderer:get-workspace-git-setup-diagnostics', async (event, { gitRootPath, remote = 'origin', remoteUrl = '' }) => {
    return getWorkspaceGitSetupDiagnostics({ gitRootPath, remote, remoteUrl });
  });

  ipcMain.handle('renderer:create-git-ssh-key', async (event, { email = '' }) => {
    return createGitSshKey({ email });
  });

  ipcMain.handle('renderer:scan-git-known-host', async (event, { host, port }) => {
    return scanGitKnownHost({ host, port });
  });

  ipcMain.handle('renderer:add-git-known-host', async (event, { host, port, hostKey }) => {
    return addGitKnownHost({ host, port, hostKey });
  });

  ipcMain.handle('renderer:set-git-identity', async (event, { gitRootPath, name, email }) => {
    return setGitIdentity({ gitRootPath, name, email });
  });

  ipcMain.handle('renderer:enable-git-global-longpaths', async (event, { gitRootPath }) => {
    return enableGitGlobalLongPaths({ gitRootPath });
  });

  ipcMain.handle('renderer:test-git-ssh-connection', async (event, { gitRootPath, remote = 'origin', remoteUrl = '' }) => {
    return testGitSshConnection({ gitRootPath, remote, remoteUrl });
  });

  ipcMain.handle('renderer:stage-workspace-git-files', async (event, { gitRootPath, files }) => {
    const fullPaths = files.map((file) => path.join(gitRootPath, file));
    return withWorkspaceGitOperationLock(gitRootPath, 'stage', () => stageChanges(gitRootPath, fullPaths));
  });

  ipcMain.handle('renderer:unstage-workspace-git-files', async (event, { gitRootPath, files }) => {
    const fullPaths = files.map((file) => path.join(gitRootPath, file));
    return withWorkspaceGitOperationLock(gitRootPath, 'unstage', () => unstageChanges(gitRootPath, fullPaths));
  });

  ipcMain.handle('renderer:commit-workspace-git', async (event, { gitRootPath, message }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'commit', () => commitChanges(gitRootPath, message));
  });

  ipcMain.handle('renderer:fetch-workspace-git', async (event, { gitRootPath, remote = 'origin' }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'fetch', () => fetchChanges(gitRootPath, remote));
  });

  ipcMain.handle('renderer:pull-workspace-git', async (event, { gitRootPath, processUid, remote = 'origin', remoteBranch, strategy = '--no-rebase' }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'pull', () => pullGitChanges(mainWindow, { gitRootPath, processUid, remote, remoteBranch, strategy }));
  });

  ipcMain.handle('renderer:push-workspace-git', async (event, { gitRootPath, processUid, remote = 'origin', remoteBranch }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'push', () => pushGitChanges(mainWindow, { gitRootPath, processUid, remote, remoteBranch }));
  });

  ipcMain.handle('renderer:sync-workspace-git', async (event, { gitRootPath, processUid, remote = 'origin', remoteBranch, strategy = '--no-rebase' }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'sync', () => syncGitChanges(mainWindow, { gitRootPath, processUid, remote, remoteBranch, strategy }));
  });

  ipcMain.handle('renderer:checkout-workspace-git-branch', async (event, { gitRootPath, processUid, branchName }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'checkout branch', () => checkoutGitBranch(mainWindow, { gitRootPath, processUid, branchName }));
  });

  ipcMain.handle('renderer:create-workspace-git-branch', async (event, { gitRootPath, processUid, branchName, startPoint = '' }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'create branch', () => checkoutGitBranch(mainWindow, {
      gitRootPath,
      processUid,
      branchName,
      shouldCreate: true,
      startPoint
    }));
  });

  ipcMain.handle('renderer:checkout-workspace-git-remote-branch', async (event, { gitRootPath, processUid, remote = 'origin', branchName }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'checkout remote branch', () => checkoutRemoteGitBranch(mainWindow, {
      gitRootPath,
      processUid,
      remoteName: remote,
      branchName
    }));
  });

  ipcMain.handle('renderer:publish-workspace-git-branch', async (event, { gitRootPath, processUid, remote = 'origin', branchName }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'publish branch', () => publishGitBranch(mainWindow, { gitRootPath, processUid, remote, branchName }));
  });

  ipcMain.handle('renderer:set-workspace-git-upstream', async (event, { gitRootPath, remote = 'origin', branchName, remoteBranch }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'set upstream', () => setGitBranchUpstream({ gitRootPath, remote, branchName, remoteBranch }));
  });

  ipcMain.handle('renderer:abort-workspace-git-merge', async (event, { gitRootPath }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'abort merge', () => abortConflictResolution(gitRootPath));
  });

  ipcMain.handle('renderer:continue-workspace-git-merge', async (event, { gitRootPath, conflictedFiles, commitMessage }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'continue merge', async () => {
      const result = await continueMerge(gitRootPath, conflictedFiles, commitMessage);
      notifyWorkspaceConfigUpdated(mainWindow, gitRootPath);
      return result;
    });
  });

  ipcMain.handle('renderer:continue-resolved-workspace-git-merge', async (event, { gitRootPath, conflictedFilePaths, commitMessage }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'continue merge', async () => {
      const result = await continueResolvedMerge(gitRootPath, conflictedFilePaths, commitMessage);
      notifyWorkspaceConfigUpdated(mainWindow, gitRootPath);
      return result;
    });
  });

  ipcMain.handle('renderer:resolve-workspace-git-conflict-file', async (event, { gitRootPath, filePath, side }) => {
    return withWorkspaceGitOperationLock(gitRootPath, 'resolve conflict', () => resolveConflictFile(gitRootPath, filePath, side));
  });

  ipcMain.handle('renderer:get-workspace-git-diff', async (event, { gitRootPath, filePath, staged }) => {
    const fullPath = path.join(gitRootPath, filePath);
    return staged ? getStagedFileDiff(gitRootPath, fullPath) : getUnstagedFileDiff(gitRootPath, fullPath);
  });
};

module.exports = registerGitIpc;
