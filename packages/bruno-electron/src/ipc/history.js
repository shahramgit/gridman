const { ipcMain } = require('electron');
const { appendHistoryEntry, loadHistory, removeHistoryEntry, clearHistory } = require('../utils/request-history');

// Request-send History persistence (sidebar History section).
const registerHistoryIpc = () => {
  ipcMain.handle('renderer:append-request-history', async (event, { entry }) => {
    appendHistoryEntry(entry);
  });

  ipcMain.handle('renderer:load-request-history', async (event, { workspaceUid }) => {
    return loadHistory(workspaceUid);
  });

  ipcMain.handle('renderer:remove-request-history-entry', async (event, { workspaceUid, id }) => {
    removeHistoryEntry(workspaceUid, id);
  });

  ipcMain.handle('renderer:clear-request-history', async (event, { workspaceUid }) => {
    clearHistory(workspaceUid);
  });
};

module.exports = registerHistoryIpc;
