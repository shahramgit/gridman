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
 * GRIDMAN_DEFAULT_LOCATION overrides both — set by the playwright fixture so
 * e2e runs stay inside their temp userData dir instead of reading/polluting
 * the user's real Documents folder.
 */
function resolveDefaultLocation() {
  const defaultPaths = [
    process.env.GRIDMAN_DEFAULT_LOCATION,
    getDocumentsDefaultLocation(),
    app.getPath('userData')
  ].filter(Boolean);

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
