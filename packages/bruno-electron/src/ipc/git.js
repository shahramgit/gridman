const { ipcMain } = require('electron');
const path = require('path');
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
  abortConflictResolution,
  continueMerge,
  continueResolvedMerge,
  getStagedFileDiff,
  getUnstagedFileDiff,
  upsertRemote
} = require('../utils/git');
const { createDirectory, removeDirectory } = require('../utils/filesystem');

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
    return initWorkspaceGit({ workspacePath, collectionPaths, preferCollectionParent });
  });

  ipcMain.handle('renderer:set-workspace-git-remote', async (event, { gitRootPath, remoteName = 'origin', remoteUrl }) => {
    return upsertRemote({ gitRootPath, remoteName, remoteUrl });
  });

  ipcMain.handle('renderer:stage-workspace-git-files', async (event, { gitRootPath, files }) => {
    const fullPaths = files.map((file) => path.join(gitRootPath, file));
    return stageChanges(gitRootPath, fullPaths);
  });

  ipcMain.handle('renderer:unstage-workspace-git-files', async (event, { gitRootPath, files }) => {
    const fullPaths = files.map((file) => path.join(gitRootPath, file));
    return unstageChanges(gitRootPath, fullPaths);
  });

  ipcMain.handle('renderer:commit-workspace-git', async (event, { gitRootPath, message }) => {
    return commitChanges(gitRootPath, message);
  });

  ipcMain.handle('renderer:fetch-workspace-git', async (event, { gitRootPath, remote = 'origin' }) => {
    return fetchChanges(gitRootPath, remote);
  });

  ipcMain.handle('renderer:pull-workspace-git', async (event, { gitRootPath, processUid, remote = 'origin', remoteBranch, strategy = '--no-rebase' }) => {
    return pullGitChanges(mainWindow, { gitRootPath, processUid, remote, remoteBranch, strategy });
  });

  ipcMain.handle('renderer:push-workspace-git', async (event, { gitRootPath, processUid, remote = 'origin', remoteBranch }) => {
    return pushGitChanges(mainWindow, { gitRootPath, processUid, remote, remoteBranch });
  });

  ipcMain.handle('renderer:sync-workspace-git', async (event, { gitRootPath, processUid, remote = 'origin', remoteBranch, strategy = '--no-rebase' }) => {
    return syncGitChanges(mainWindow, { gitRootPath, processUid, remote, remoteBranch, strategy });
  });

  ipcMain.handle('renderer:abort-workspace-git-merge', async (event, { gitRootPath }) => {
    return abortConflictResolution(gitRootPath);
  });

  ipcMain.handle('renderer:continue-workspace-git-merge', async (event, { gitRootPath, conflictedFiles, commitMessage }) => {
    return continueMerge(gitRootPath, conflictedFiles, commitMessage);
  });

  ipcMain.handle('renderer:continue-resolved-workspace-git-merge', async (event, { gitRootPath, conflictedFilePaths, commitMessage }) => {
    return continueResolvedMerge(gitRootPath, conflictedFilePaths, commitMessage);
  });

  ipcMain.handle('renderer:get-workspace-git-diff', async (event, { gitRootPath, filePath, staged }) => {
    const fullPath = path.join(gitRootPath, filePath);
    return staged ? getStagedFileDiff(gitRootPath, fullPath) : getUnstagedFileDiff(gitRootPath, fullPath);
  });
};

module.exports = registerGitIpc;
