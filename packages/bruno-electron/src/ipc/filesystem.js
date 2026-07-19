const { ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  browseDirectory,
  browseFiles,
  normalizeAndResolvePath,
  isFile,
  isDirectory
} = require('../utils/filesystem');
const { findUniqueFolderName } = require('../utils/collection-import');

const registerFilesystemIpc = (mainWindow) => {
  ipcMain.handle('renderer:browse-directory', async (event, pathname, request) => {
    try {
      return await browseDirectory(mainWindow);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:browse-files', async (_, filters, properties) => {
    try {
      return await browseFiles(mainWindow, filters, properties);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:browse-pac-file', async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'PAC Files', extensions: ['pac', 'js'] }]
    });
    if (!filePaths || filePaths.length === 0) return null;
    return pathToFileURL(filePaths[0]).href;
  });

  ipcMain.handle('renderer:exists-sync', async (_, filePath) => {
    try {
      const normalizedPath = normalizeAndResolvePath(filePath);
      return isFile(normalizedPath);
    } catch (error) {
      return false;
    }
  });

  ipcMain.handle('renderer:resolve-path', async (_, relativePath, basePath) => {
    try {
      const resolvedPath = path.resolve(basePath, relativePath);
      return normalizeAndResolvePath(resolvedPath);
    } catch (error) {
      return relativePath;
    }
  });

  ipcMain.handle('renderer:is-directory', async (_, pathname) => {
    return isDirectory(pathname);
  });

  ipcMain.handle('renderer:find-unique-folder-name', async (_, baseName, location) => {
    try {
      return await findUniqueFolderName(baseName, location);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('open-file', async () => {
    return null;
  });

  ipcMain.handle('renderer:log-renderer-error', async (_, payload) => {
    console.error('Renderer error boundary:', payload);
    // Persist the crash so packaged-app users can attach it to a report —
    // console.error alone is lost outside dev. Returns the file path so the
    // error page can tell the user where it was saved.
    try {
      const { app } = require('electron');
      const path = require('path');
      const fs = require('fs');
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'renderer-errors.log');
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${JSON.stringify(payload)}\n`);
      return { logFile };
    } catch (err) {
      return null;
    }
  });
};

module.exports = registerFilesystemIpc;
