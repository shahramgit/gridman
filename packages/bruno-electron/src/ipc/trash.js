const { ipcMain } = require('electron');
const {
  listAppTrash,
  restoreAppTrashItem,
  deleteAppTrashItem,
  emptyAppTrash
} = require('../utils/app-trash');

// Gridman Trash (bottom-bar panel): list / restore / delete-forever / empty.
// Deletions land here via moveToAppTrash in the delete handlers.
const registerTrashIpc = () => {
  ipcMain.handle('renderer:list-app-trash', async () => {
    return listAppTrash();
  });

  ipcMain.handle('renderer:restore-app-trash-item', async (event, { entryId }) => {
    return restoreAppTrashItem(entryId);
  });

  ipcMain.handle('renderer:delete-app-trash-item', async (event, { entryId }) => {
    return deleteAppTrashItem(entryId);
  });

  ipcMain.handle('renderer:empty-app-trash', async () => {
    return emptyAppTrash();
  });
};

module.exports = registerTrashIpc;
