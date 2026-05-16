const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const GRIDMAN_DIR_NAME = 'gridman';
const LEGACY_BRUNO_DIR_NAME = 'bruno';

function getDocumentsDefaultLocation(dirName = GRIDMAN_DIR_NAME) {
  return path.join(app.getPath('documents'), dirName);
}

function isLegacyDefaultLocation(dirPath) {
  if (!dirPath) {
    return false;
  }

  return path.normalize(dirPath) === path.normalize(getDocumentsDefaultLocation(LEGACY_BRUNO_DIR_NAME));
}

/**
 * Returns the default location where new workspaces and collections are stored.
 * Checks ~/Documents/gridman if available, otherwise falls back to the app's data directory.
 */
function resolveDefaultLocation() {
  const defaultPaths = [
    getDocumentsDefaultLocation(),
    app.getPath('userData')
  ];

  for (const dirPath of defaultPaths) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return dirPath;
    } catch (error) {
      console.warn(`Failed to create directory at ${dirPath}:`, error.message);
    }
  }

  throw new Error('Failed to create default location');
}

module.exports = {
  getDocumentsDefaultLocation,
  isLegacyDefaultLocation,
  resolveDefaultLocation
};
