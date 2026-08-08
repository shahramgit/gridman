const path = require('path');
const fs = require('fs-extra');
const fsPromises = require('fs/promises');
const { dialog } = require('electron');
const isValidPathname = require('is-valid-path');
const os = require('os');

const DEFAULT_GITIGNORE = [
  '# Secrets — real values in plaintext, never committed.',
  '.env*',
  '',
  '# NOTE: environment files are intentionally NOT ignored. A secret variable is',
  '# stored in them as a NAME only; its value lives in an encrypted store outside',
  '# the repository. Sharing them is what lets a teammate clone and run. If your',
  '# internal URLs are themselves sensitive, add "**/environments/" below and turn',
  '# on Preferences > Git > exclude environments.',
  '',
  '# Dependencies',
  'node_modules',
  '',
  '# OS files',
  '.DS_Store',
  'Thumbs.db'
].join('\n');

// Windows refuses fs operations on paths longer than MAX_PATH (260) unless they
// use the extended-length "\\?\" prefix. Deeply nested collections with long
// (e.g. non-ASCII) folder names exceed this and fail with ENOENT. Prefix the
// resolved path for the fs call only; never expose the prefixed form to the
// renderer/UI.
const winLongPath = (p) => {
  if (process.platform !== 'win32' || !p) {
    return p;
  }
  const resolved = path.resolve(p);
  if (resolved.startsWith('\\\\?\\')) {
    return resolved;
  }
  if (resolved.startsWith('\\\\')) {
    // UNC path: \\server\share -> \\?\UNC\server\share
    return `\\\\?\\UNC\\${resolved.slice(2)}`;
  }
  return `\\\\?\\${resolved}`;
};

const exists = async (p) => {
  try {
    await fsPromises.access(p);
    return true;
  } catch (_) {
    return false;
  }
};

const isSymbolicLink = (filepath) => {
  try {
    return fs.existsSync(filepath) && fs.lstatSync(filepath).isSymbolicLink();
  } catch (_) {
    return false;
  }
};

const isFile = (filepath) => {
  try {
    return fs.existsSync(filepath) && fs.lstatSync(filepath).isFile();
  } catch (_) {
    return false;
  }
};

const isDirectory = (dirPath) => {
  try {
    return fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory();
  } catch (_) {
    return false;
  }
};

const isValidCollectionDirectory = (dirPath) => {
  if (!isDirectory(dirPath)) {
    return false;
  }
  const brunoJsonPath = path.join(dirPath, 'bruno.json');
  const opencollectionYmlPath = path.join(dirPath, 'opencollection.yml');
  return fs.existsSync(brunoJsonPath) || fs.existsSync(opencollectionYmlPath);
};

const hasSubDirectories = (dir) => {
  const files = fs.readdirSync(dir);
  return files.some((file) => fs.statSync(path.join(dir, file)).isDirectory());
};

const normalizeAndResolvePath = (pathname) => {
  if (isWSLPath(pathname)) {
    return normalizeWSLPath(pathname);
  }

  if (isSymbolicLink(pathname)) {
    const absPath = path.dirname(pathname);
    const targetPath = path.resolve(absPath, fs.readlinkSync(pathname));
    if (isFile(targetPath) || isDirectory(targetPath)) {
      return path.resolve(targetPath);
    }
    console.error(`Cannot resolve link target "${pathname}" (${targetPath}).`);
    return '';
  }
  return path.resolve(pathname);
};

function isWSLPath(pathname) {
  // Check if the path starts with the WSL prefix
  // eg. "\\wsl.localhost\Ubuntu\home\user\bruno\collection\scripting\api\req\getHeaders.bru"
  return pathname.startsWith('\\\\') || pathname.startsWith('//') || pathname.startsWith('/wsl.localhost/') || pathname.startsWith('\\wsl.localhost');
}

function normalizeWSLPath(pathname) {
  // Replace the WSL path prefix and convert forward slashes to backslashes
  // This is done to achieve WSL paths (linux style) to Windows UNC equivalent (Universal Naming Conversion)
  return pathname.replace(/^\/wsl.localhost/, '\\\\wsl.localhost').replace(/\//g, '\\');
}

const writeFile = async (pathname, content, isBinary = false) => {
  try {
    await safeWriteFile(pathname, content, {
      encoding: !isBinary ? 'utf-8' : null
    });
  } catch (err) {
    console.error(`Error writing file at ${pathname}:`, err);
    return Promise.reject(err);
  }
};

const hasJsonExtension = (filename) => {
  if (!filename || typeof filename !== 'string') return false;
  return ['json'].some((ext) => filename.toLowerCase().endsWith(`.${ext}`));
};

const hasBruExtension = (filename) => {
  if (!filename || typeof filename !== 'string') return false;
  return ['bru'].some((ext) => filename.toLowerCase().endsWith(`.${ext}`));
};

const hasRequestExtension = (filename, format = null) => {
  if (!filename || typeof filename !== 'string') return false;

  if (format) {
    const ext = format === 'yml' ? 'yml' : 'bru';
    return filename.toLowerCase().endsWith(`.${ext}`);
  }

  return ['bru', 'yml'].some((ext) => filename.toLowerCase().endsWith(`.${ext}`));
};

const createDirectory = async (dir) => {
  if (!dir) {
    throw new Error(`directory: path is null`);
  }

  if (fs.existsSync(dir)) {
    throw new Error(`directory: ${dir} already exists`);
  }

  return fs.mkdirSync(dir);
};

const browseDirectory = async (win) => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory']
  });

  if (!filePaths || !filePaths[0]) {
    return false;
  }

  const resolvedPath = path.resolve(filePaths[0]);
  return isDirectory(resolvedPath) ? resolvedPath : false;
};

const browseFiles = async (win, filters = [], properties = []) => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', ...properties],
    filters
  });

  if (!filePaths) {
    return [];
  }

  return filePaths.map((filePath) => path.resolve(filePath)).filter((filePath) => isFile(filePath));
};

const chooseFileToSave = async (win, preferredFileName = '') => {
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: preferredFileName
  });

  return filePath;
};

const searchForFiles = (dir, extension) => {
  let results = [];
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results = results.concat(searchForFiles(filePath, extension));
    } else if (path.extname(file) === extension) {
      results.push(filePath);
    }
  }
  return results;
};

// Search for request files based on collection filetype by reading config
const searchForRequestFiles = (dir, collectionPath = null) => {
  const format = getCollectionFormat(collectionPath || dir);
  if (format === 'yml') {
    return searchForFiles(dir, '.yml');
  } else if (format === 'bru') {
    return searchForFiles(dir, '.bru');
  } else {
    throw new Error(`Invalid format: ${format}`);
  }
};

const sanitizeName = (name) => {
  const invalidCharacters = /[<>:"/\\|?*\x00-\x1F]/g;
  name = name
    .replace(invalidCharacters, '-') // replace invalid characters with hyphens
    .replace(/^[\s\-]+/, '') // remove leading spaces and hyphens
    .replace(/[.\s]+$/, ''); // remove trailing dots and spaces
  return name;
};

const isWindowsOS = () => {
  return os.platform() === 'win32';
};

/**
 * Generate a unique name by adding a "copy" suffix if needed
 *
 * @param {string} baseName - The base name
 * @param {Function} checkExists - Function that takes a name and returns true if it exists
 * @returns {string} - A unique name
 */
const generateUniqueName = (baseName, checkExists) => {
  if (!checkExists(baseName)) {
    return baseName;
  }

  let counter = 1;
  let uniqueName = `${baseName} copy`;

  while (checkExists(uniqueName)) {
    counter++;
    uniqueName = `${baseName} copy ${counter}`;
  }
  return uniqueName;
};

const getCollectionFormat = (collectionPath) => {
  const ocYmlPath = path.join(collectionPath, 'opencollection.yml');
  if (fs.existsSync(ocYmlPath)) {
    return 'yml';
  }

  const brunoJsonPath = path.join(collectionPath, 'bruno.json');
  if (fs.existsSync(brunoJsonPath)) {
    return 'bru';
  }

  throw new Error(`No collection configuration found at: ${collectionPath}`);
};

const validateName = (name) => {
  const invalidCharacters = /[<>:"/\\|?*\x00-\x1F]/g; // keeping this for informational purpose
  const reservedDeviceNames = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;
  const firstCharacter = /^[^\s\-<>:"/\\|?*\x00-\x1F]/; // no space, hyphen and `invalidCharacters`
  const middleCharacters = /^[^<>:"/\\|?*\x00-\x1F]*$/; // no `invalidCharacters`
  const lastCharacter = /[^.\s<>:"/\\|?*\x00-\x1F]$/; // no dot, space and `invalidCharacters`
  if (name.length > 255) return false; // max name length

  if (reservedDeviceNames.test(name)) return false; // windows reserved names

  return (
    firstCharacter.test(name)
    && middleCharacters.test(name)
    && lastCharacter.test(name)
  );
};

const safeToRename = (oldPath, newPath) => {
  try {
    // If the new path doesn't exist, it's safe to rename
    if (!fs.existsSync(winLongPath(newPath))) {
      return true;
    }

    const oldStat = fs.statSync(winLongPath(oldPath));
    const newStat = fs.statSync(winLongPath(newPath));

    if (isWindowsOS()) {
      // Windows-specific comparison:
      // Check if both files have the same birth time, size (Since, Win FAT-32 doesn't use inodes)

      return oldStat.birthtimeMs === newStat.birthtimeMs && oldStat.size === newStat.size;
    }
    // Unix/Linux/MacOS: Check inode to see if they are the same file
    return oldStat.ino === newStat.ino;
  } catch (error) {
    console.error(`Error checking file rename safety for ${oldPath} and ${newPath}:`, error);
    return false;
  }
};

// A workspace scan walks every file of every collection at startup (~11.7k on
// the largest customer workspace). The walk stays parallel, but the number of
// in-flight fs calls is capped so it cannot starve the event loop or exhaust
// file handles while the app is still opening.
const COLLECTION_STATS_CONCURRENCY = 24;

const createConcurrencyLimiter = (limit) => {
  let active = 0;
  // A queue with one entry per directory entry: Array#shift is O(n), so
  // draining a directory with thousands of files would cost O(n^2). Walk an
  // index instead and only reset the array once it has been drained.
  const waiting = [];
  let next = 0;

  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    // The slot is handed over by release(), which keeps counting it as active
    // while the waiter wakes up — a caller arriving in between must queue
    // behind us rather than jump the cap.
    return new Promise((resolve) => waiting.push(resolve));
  };

  const release = () => {
    if (next >= waiting.length) {
      active -= 1;
      return;
    }
    const resume = waiting[next];
    waiting[next] = null;
    next += 1;
    if (next === waiting.length) {
      waiting.length = 0;
      next = 0;
    }
    resume();
  };

  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};

// The stats decide eager vs lazy (indexed) collection load and land in
// brunoConfig.size/filesCount, so they must count exactly what the app treats
// as a request — the collection format's own request files, minus the
// collection/folder root files and the environments directory the watcher
// routes elsewhere. Counting every *.yml made an OpenAPI spec or a
// docker-compose.yml kept next to a collection count as requests, and a single
// 6 MB one flipped a small collection onto the lazy path.
const COLLECTION_ROOT_FILENAMES = ['collection.bru', 'opencollection.yml'];
const FOLDER_ROOT_FILENAMES = ['folder.bru', 'folder.yml'];

const getCollectionStats = async (directoryPath) => {
  let size = 0;
  let filesCount = 0;
  let maxFileSize = 0;
  const limit = createConcurrencyLimiter(COLLECTION_STATS_CONCURRENCY);

  // A directory that is not (yet) a collection has no format; count both
  // request formats there rather than throwing at callers that only want a
  // rough size.
  let format = null;
  try {
    format = getCollectionFormat(directoryPath);
  } catch (_err) {
    format = null;
  }

  // Count the collection's own request format, not just .bru: a yml collection
  // used to report zero files/zero bytes, so it never qualified for the indexed
  // (lazy) load and was always scanned eagerly on startup.
  const isRequestFile = (name, isCollectionRoot) => {
    if (!hasRequestExtension(name, format)) {
      return false;
    }
    if (FOLDER_ROOT_FILENAMES.includes(name)) {
      return false;
    }
    return !(isCollectionRoot && COLLECTION_ROOT_FILENAMES.includes(name));
  };

  async function calculateStats(directory, isCollectionRoot) {
    const entries = await limit(() => fsPromises.readdir(winLongPath(directory), { withFileTypes: true }));

    const tasks = entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (['node_modules', '.git'].includes(entry.name)) {
          return;
        }

        // Environment files are not requests — the watcher routes them to
        // addEnvironmentFile before its request check ever runs.
        if (isCollectionRoot && entry.name === 'environments') {
          return;
        }

        return calculateStats(fullPath, false);
      }

      if (isRequestFile(entry.name, isCollectionRoot)) {
        const stats = await limit(() => fsPromises.stat(winLongPath(fullPath)));
        size += stats?.size;
        if (maxFileSize < stats?.size) {
          maxFileSize = stats?.size;
        }
        filesCount += 1;
      }
    });

    await Promise.all(tasks);
  }

  await calculateStats(directoryPath, true);

  size = sizeInMB(size);
  maxFileSize = sizeInMB(maxFileSize);

  return { size, filesCount, maxFileSize };
};

const sizeInMB = (size) => {
  return size / (1024 * 1024);
};

const getSafePathToWrite = (filePath) => {
  const MAX_FILENAME_LENGTH = 255; // Common limit on most filesystems
  let dir = path.dirname(filePath);
  let ext = path.extname(filePath);
  let base = path.basename(filePath, ext);
  if (base.length + ext.length > MAX_FILENAME_LENGTH) {
    base = sanitizeName(base);
    base = base.slice(0, MAX_FILENAME_LENGTH - ext.length);
  }
  let safePath = path.join(dir, base + ext);
  return safePath;
};

async function safeWriteFile(filePath, data, options) {
  const safePath = getSafePathToWrite(filePath);

  try {
    const fsExtra = require('fs-extra');
    fsExtra.outputFileSync(winLongPath(safePath), data, options);
  } catch (err) {
    console.error(`Error writing file at ${safePath}:`, err);
    return Promise.reject(err);
  }
}

function safeWriteFileSync(filePath, data) {
  const safePath = getSafePathToWrite(filePath);
  fs.writeFileSync(winLongPath(safePath), data);
}

// Windows refuses a rename with EPERM/EBUSY/EACCES while ANY handle inside the
// subtree is open without FILE_SHARE_DELETE — antivirus, a sync client, an
// Explorer window or a terminal sitting in the folder hold it just as often as
// the app does. Customer symptom: renaming a folder in a Persian collection
// failed with EPERM and "only worked after closing Gridman". Those holds clear
// within a second, so retry before paying for a recursive copy of the tree.
const TRANSIENT_LOCK_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const MOVE_RETRY_DELAYS_IN_MS = [50, 100, 200, 400, 800];
const REMOVE_RETRY_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

const isTransientLockError = (error) => TRANSIENT_LOCK_CODES.includes(error?.code);

// fs-extra refuses a non-overwriting move onto an existing destination with a
// bare `new Error('dest already exists.')` — no `code` to match on.
const isDestExistsError = (error) => !error?.code && error?.message === 'dest already exists.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every error out of movePathWithRetry carries this, because callers delete
// things based on it (moveToAppTrash removes the trash entry it just created).
// `true` is only ever set where the source was PROVEN intact — an unflagged
// error must read as "cannot prove", never as "safe to clean up".
const withSourceIntact = (error, sourceIntact) => {
  error.sourceIntact = sourceIntact;
  return error;
};

const lockedPathError = (pathname, error) => {
  const lockedError = new Error(
    `Could not move "${path.basename(pathname)}" — it is open in another program `
    + '(antivirus, file sync, Explorer or a terminal) or is not writable. '
    + 'Close it and try again.'
  );
  lockedError.code = error?.code;
  return withSourceIntact(lockedError, true);
};

const targetExistsError = (sourcePathname, targetPathname) => {
  const existsError = new Error(
    `Could not move "${path.basename(sourcePathname)}" — "${path.basename(targetPathname)}" already exists.`
  );
  existsError.code = 'EEXIST';
  return withSourceIntact(existsError, true);
};

const partiallyMovedError = (sourcePathname, targetPathname, error) => {
  const partialError = new Error(
    `"${path.basename(sourcePathname)}" was copied to "${targetPathname}", but the original could not be removed `
    + '(it is open in another program) and is now incomplete. The copy has been kept — do not delete it.'
  );
  partialError.code = error?.code;
  // Tells callers the copy at the target is the only COMPLETE copy left, so it
  // must survive their cleanup (see moveToAppTrash).
  return withSourceIntact(partialError, false);
};

// Does `original` still hold every entry of `copy`? fsPromises.rm unlinks
// depth-first and can reject with descendants ALREADY gone, so this is what
// tells a removal that failed outright (original untouched, the copy is
// redundant) from one that failed half way (the copy is now the only complete
// copy of the user's requests).
const holdsEveryEntryOf = async (original, copy) => {
  try {
    if (!(await exists(original))) {
      return false;
    }
    const copyStats = await fsPromises.lstat(copy);
    if (!copyStats.isDirectory()) {
      return true;
    }
    const entries = await fsPromises.readdir(copy, { withFileTypes: true });
    for (const entry of entries) {
      if (!(await holdsEveryEntryOf(path.join(original, entry.name), path.join(copy, entry.name)))) {
        return false;
      }
    }
    return true;
  } catch (_err) {
    // Cannot prove the original survived — assume it did not and keep the copy.
    return false;
  }
};

// Moves a file/directory, absorbing the transient locks described above: retry
// with backoff, then copy + remove as a last resort.
//
// The contract callers depend on (see app-trash.js):
//   resolves                     -> everything is at the target, nothing is left at the source
//   rejects                      -> the source is untouched and no leftover of OURS is at the target
//   rejects with sourceIntact:false -> the copy at the target is the only complete copy
//                                   left; it must be kept, the source is now incomplete.
const movePathWithRetry = async (sourcePathname, targetPathname) => {
  // Extended-length paths so long/non-ASCII nested paths (past MAX_PATH) don't
  // fail with ENOENT.
  const source = winLongPath(sourcePathname);
  const target = winLongPath(targetPathname);

  // Whatever sits at the target before the first attempt belongs to the user
  // and is never ours to delete; anything appearing there afterwards is a
  // leftover of one of our own failed attempts. (A case-only rename does not
  // land here: fs-extra renames it natively without the exists check.)
  const targetExistedBefore = fs.existsSync(target);

  // Discards a leftover of one of OUR failed attempts, and answers whether the
  // source is safe to keep working with. It refuses to delete anything it
  // cannot prove is redundant: across devices fs-extra's move is
  // copy-then-remove, so a failed attempt can leave the target holding the ONLY
  // complete copy while the source is half eaten. Deleting that copy — and then
  // retrying against the truncated source — destroys the user's requests.
  const discardOurLeftoverAtTarget = async () => {
    if (targetExistedBefore) {
      // Whatever sits there belongs to the user; never ours to delete.
      return true;
    }
    if (!(await exists(target))) {
      return true;
    }
    if (!(await holdsEveryEntryOf(source, target))) {
      return false;
    }
    await fsPromises.rm(target, REMOVE_RETRY_OPTIONS).catch(() => {});
    return true;
  };

  for (let attempt = 0; attempt <= MOVE_RETRY_DELAYS_IN_MS.length; attempt++) {
    try {
      await fs.move(source, target, { overwrite: false });
      return;
    } catch (error) {
      if (isDestExistsError(error) && targetExistedBefore) {
        throw targetExistsError(sourcePathname, targetPathname);
      }
      // Across devices — userData and the collections sit on different drives
      // on most Windows machines, so EVERY trash move is cross-device —
      // fs-extra's move is copy-then-remove. When the remove is the part the
      // lock breaks, the copy stays behind and every later attempt dies on the
      // code-less 'dest already exists.' instead of retrying. Clear our own
      // leftover so the retries (and the copy fallback below) start clean.
      if (!(await discardOurLeftoverAtTarget())) {
        throw partiallyMovedError(sourcePathname, targetPathname, error);
      }
      if (!isTransientLockError(error) && !isDestExistsError(error)) {
        throw withSourceIntact(error, true);
      }
      if (attempt < MOVE_RETRY_DELAYS_IN_MS.length) {
        await sleep(MOVE_RETRY_DELAYS_IN_MS[attempt]);
      }
    }
  }

  try {
    await fs.copy(source, target, { overwrite: false, errorOnExist: true });
  } catch (error) {
    // fsExtra.copy is not transactional: without this the half-written target
    // stays on disk next to the source, which for a rename is the folder
    // showing up twice in the sidebar after a restart. (copy never touches the
    // source, so the discard below can always prove it intact.)
    if (!(await discardOurLeftoverAtTarget())) {
      throw partiallyMovedError(sourcePathname, targetPathname, error);
    }
    throw isTransientLockError(error)
      ? lockedPathError(sourcePathname, error)
      : withSourceIntact(error, true);
  }

  try {
    await fsPromises.rm(source, REMOVE_RETRY_OPTIONS);
  } catch (error) {
    if (await discardOurLeftoverAtTarget()) {
      // Nothing was lost, so drop the copy: both on disk shows the item twice.
      throw lockedPathError(sourcePathname, error);
    }
    // The removal already ate part of the source — rolling the copy back here
    // would destroy the user's only complete copy of those requests.
    throw partiallyMovedError(sourcePathname, targetPathname, error);
  }
};

// Recursively copies a source <file/directory> to a destination <directory>.
const copyPath = async (source, destination) => {
  let targetPath = `${destination}/${path.basename(source)}`;

  const targetPathExists = await fsPromises.access(targetPath).then(() => true).catch(() => false);
  if (targetPathExists) {
    throw new Error(`Cannot copy, ${path.basename(source)} already exists in ${path.basename(destination)}`);
  }

  const copy = async (source, destination) => {
    const stat = await fsPromises.lstat(winLongPath(source));
    if (stat.isDirectory()) {
      await fsPromises.mkdir(winLongPath(destination), { recursive: true });
      const entries = await fsPromises.readdir(winLongPath(source));
      for (const entry of entries) {
        const srcPath = path.join(source, entry);
        const destPath = path.join(destination, entry);
        await copy(srcPath, destPath);
      }
    } else {
      await fsPromises.copyFile(winLongPath(source), winLongPath(destination));
    }
  };

  await copy(source, targetPath);
};

// Recursively removes a source <file/directory>.
const removePath = async (source) => {
  const stat = await fsPromises.lstat(winLongPath(source));
  if (stat.isDirectory()) {
    const entries = await fsPromises.readdir(winLongPath(source));
    for (const entry of entries) {
      const entryPath = path.join(source, entry);
      await removePath(entryPath);
    }
    await fsPromises.rmdir(winLongPath(source));
  } else {
    await fsPromises.unlink(winLongPath(source));
  }
};

// Recursively gets paths. Returns plain (non-prefixed) paths for callers/UI;
// only the fs calls use the Windows long-path prefix.
const getPaths = async (source) => {
  let paths = [];
  const _getPaths = async (source) => {
    const stat = await fsPromises.lstat(winLongPath(source));
    paths.push(source);
    if (stat.isDirectory()) {
      const entries = await fsPromises.readdir(winLongPath(source));
      for (const entry of entries) {
        const entryPath = path.join(source, entry);
        await _getPaths(entryPath);
      }
    }
  };
  await _getPaths(source);
  return paths;
};

/**
 * Checks if a file is larger than a given threshold.
 * @param {string} filePath - The path to the file.
 * @param {number} threshold - The threshold in bytes. Default is 10MB.
 * @returns {boolean} True if the file is larger than the threshold, false otherwise.
 */
const isLargeFile = (filePath, threshold = 10 * 1024 * 1024) => {
  if (!isFile(filePath)) {
    throw new Error(`File ${filePath} is not a file`);
  }

  const size = fs.statSync(filePath).size;

  return size > threshold;
};

const isDotEnvFile = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const basename = path.basename(pathname);

  return path.normalize(dirname) === path.normalize(collectionPath) && basename === '.env';
};

const isValidDotEnvFilename = (filename) => {
  if (!filename || typeof filename !== 'string') return false;
  const basename = path.basename(filename);
  if (basename !== filename) return false;
  return basename === '.env' || (basename.startsWith('.env.') && /^\.env\.[a-zA-Z0-9._-]+$/.test(basename));
};

const COLLECTION_ROOT_FILES = new Set(['opencollection.yml', 'bruno.json', 'collection.bru']);
const LOCAL_ONLY_COLLECTION_RESIDUE = new Set(['environments', '.gitignore', '.DS_Store', 'Thumbs.db']);

const isReusableDeletedCollectionDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return false;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  if (!entries.length) {
    return true;
  }

  return entries.every((entry) => {
    if (COLLECTION_ROOT_FILES.has(entry.name)) {
      return false;
    }

    if (entry.name === 'environments' && entry.isDirectory()) {
      return true;
    }

    if (entry.isFile() && (LOCAL_ONLY_COLLECTION_RESIDUE.has(entry.name) || isValidDotEnvFilename(entry.name))) {
      return true;
    }

    return false;
  });
};

const isBrunoConfigFile = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const basename = path.basename(pathname);

  return path.normalize(dirname) === path.normalize(collectionPath) && basename === 'bruno.json';
};

const isBruEnvironmentConfig = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const envDirectory = path.join(collectionPath, 'environments');
  const basename = path.basename(pathname);

  return path.normalize(dirname) === path.normalize(envDirectory) && hasBruExtension(basename);
};

const isCollectionRootBruFile = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const basename = path.basename(pathname);

  return path.normalize(dirname) === path.normalize(collectionPath) && basename === 'collection.bru';
};

const scanForBrunoFiles = async (dir) => {
  const brunoFolders = [];

  const scanDir = (currentDir) => {
    const files = fs.readdirSync(currentDir);

    if (files && files.length) {
      files.forEach((file) => {
        const fullPath = path.join(currentDir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (['node_modules', '.git'].includes(file)) {
            return;
          }
          scanDir(fullPath);
        } else if (file === 'bruno.json') {
          brunoFolders.push(currentDir);
        }
      });
    }
  };

  scanDir(dir);
  return brunoFolders;
};

const posixifyPath = (p) => (p ? p.replace(/\\/g, '/') : p);

module.exports = {
  DEFAULT_GITIGNORE,
  posixifyPath,
  isValidPathname,
  exists,
  isSymbolicLink,
  isFile,
  isDirectory,
  isValidCollectionDirectory,
  normalizeAndResolvePath,
  isWSLPath,
  normalizeWSLPath,
  writeFile,
  hasJsonExtension,
  hasBruExtension,
  hasRequestExtension,
  createDirectory,
  browseDirectory,
  browseFiles,
  chooseFileToSave,
  searchForFiles,
  searchForRequestFiles,
  sanitizeName,
  isWindowsOS,
  safeToRename,
  validateName,
  hasSubDirectories,
  getCollectionStats,
  sizeInMB,
  safeWriteFile,
  safeWriteFileSync,
  movePathWithRetry,
  copyPath,
  removePath,
  getPaths,
  winLongPath,
  isLargeFile,
  generateUniqueName,
  getCollectionFormat,
  isDotEnvFile,
  isValidDotEnvFilename,
  isReusableDeletedCollectionDirectory,
  isBrunoConfigFile,
  isBruEnvironmentConfig,
  isCollectionRootBruFile,
  scanForBrunoFiles
};
