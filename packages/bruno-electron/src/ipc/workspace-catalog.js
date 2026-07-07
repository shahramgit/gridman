const fs = require('fs');
const { ipcMain, dialog } = require('electron');
const { readWorkspaceConfig, getWorkspaceCollections } = require('../utils/workspace-config');
const { sanitizeName } = require('../utils/filesystem');
const { readCollectionItemsFromDisk } = require('./collection-export-import');
const { generateApiCatalog } = require('../utils/api-catalog');

const CATALOG_FORMATS = new Set(['md', 'html']);

// Builds the catalog document for a workspace. SECURITY: environment files
// are never read (readCollectionItemsFromDisk skips the environments dir) and
// the generator never renders auth credentials or request bodies — see
// utils/api-catalog.js for the full exclusion list.
const buildWorkspaceCatalog = ({ workspacePath, format }) => {
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    throw new Error('Workspace path does not exist');
  }
  if (!CATALOG_FORMATS.has(format)) {
    throw new Error(`Unsupported catalog format: ${format}`);
  }

  const config = readWorkspaceConfig(workspacePath);
  const workspaceName = config.name || 'Untitled Workspace';

  const collections = getWorkspaceCollections(workspacePath)
    .filter((collection) => !collection.notFoundLocally)
    .map((collection) => ({
      name: collection.name,
      items: readCollectionItemsFromDisk(collection.path)
    }));

  return {
    workspaceName,
    content: generateApiCatalog({ workspaceName, collections, format })
  };
};

const registerWorkspaceCatalogIpc = (mainWindow) => {
  ipcMain.handle('renderer:export-workspace-catalog', async (event, { workspacePath, format = 'md' } = {}) => {
    const { workspaceName, content } = buildWorkspaceCatalog({ workspacePath, format });

    const defaultFileName = `${sanitizeName(workspaceName)}-api-catalog.${format}`;
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export API Catalog',
      defaultPath: defaultFileName,
      filters: [
        format === 'html'
          ? { name: 'HTML Files', extensions: ['html'] }
          : { name: 'Markdown Files', extensions: ['md'] }
      ]
    });

    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    fs.writeFileSync(filePath, content, 'utf8');

    return { success: true, filePath };
  });
};

module.exports = registerWorkspaceCatalogIpc;
module.exports.buildWorkspaceCatalog = buildWorkspaceCatalog;
