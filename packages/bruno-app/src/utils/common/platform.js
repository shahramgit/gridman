import trim from 'lodash/trim';
import platform from 'platform';
import path from './path';

export const isElectron = () => {
  if (!window) {
    return false;
  }

  return window.ipcRenderer ? true : false;
};

export const resolveRequestFilename = (name, extension = 'bru') => {
  return `${trim(name)}.${extension}`;
};

/**
 * The folder segments between a collection root and a path inside it.
 *
 * A path that is NOT inside the root has no segments — returning them anyway is how a
 * transient request (whose file lives in a temp directory outside the collection) put
 * phantom '..' folders into the sidebar tree. usebruno/bruno#8977.
 *
 * Two ways a path can be outside: `path.relative` walks up ('..'), or the target is on a
 * different root entirely, where relative() returns an absolute path — which happens on
 * Windows across drive letters, and our users are Windows-only.
 */
export const getSubdirectoriesFromRoot = (rootPath, pathname) => {
  const relativePath = path.relative(rootPath, pathname);
  if (!relativePath || path.isAbsolute(relativePath)) {
    return [];
  }
  const segments = relativePath.split(path.sep);
  return segments[0] === '..' ? [] : segments;
};

export const isWindowsOS = () => {
  const os = platform.os;
  const osFamily = os.family.toLowerCase();

  return osFamily.includes('windows');
};

export const isMacOS = () => {
  const os = platform.os;
  const osFamily = os.family.toLowerCase();

  return osFamily.includes('os x');
};

export const isLinuxOS = () => {
  const os = platform.os;
  const osFamily = os.family.toLowerCase();

  return osFamily.includes('linux') || osFamily.includes('ubuntu') || osFamily.includes('debian') || osFamily.includes('fedora') || osFamily.includes('centos') || osFamily.includes('arch');
};

export const getRevealInFolderLabel = () => {
  if (isMacOS()) return 'Reveal in Finder';
  if (isWindowsOS()) return 'Reveal in File Explorer';
  return 'Reveal in File Manager';
};

export const getAppInstallDate = () => {
  let dateString = localStorage.getItem('bruno.installedOn');

  if (!dateString) {
    dateString = new Date().toISOString();
    localStorage.setItem('bruno.installedOn', dateString);
  }

  const date = new Date(dateString);
  return date;
};
