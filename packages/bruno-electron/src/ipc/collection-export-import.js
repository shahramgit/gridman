const fs = require('fs');
const path = require('path');
const {
  parseRequest,
  parseFolder,
  stringifyRequest,
  stringifyFolder
} = require('@usebruno/filestore');
const {
  hasBruExtension,
  hasRequestExtension,
  sanitizeName,
  safeWriteFileSync,
  generateUniqueName
} = require('../utils/filesystem');
const { generateUidBasedOnHash } = require('../utils/common');
const { hydrateRequestWithUuid } = require('../utils/collection');

const EXPORT_IGNORED_DIRS = new Set(['node_modules', '.git', 'environments']);
const EXPORT_ROOT_FILE_NAMES = new Set([
  'collection.bru',
  'opencollection.yml',
  'folder.bru',
  'folder.yml'
]);

// Reads a directory subtree off disk into hydrated collection items. The
// renderer's redux store only lazily loads request bodies (warm index), so
// single-file exports must read every request/folder from disk to give the
// converters complete data.
const readCollectionItemsFromDisk = (dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (EXPORT_IGNORED_DIRS.has(entry.name)) continue;

      const folderItem = {
        uid: generateUidBasedOnHash(fullPath),
        name: entry.name,
        type: 'folder',
        filename: entry.name,
        pathname: fullPath,
        items: readCollectionItemsFromDisk(fullPath)
      };

      const folderRoot = readFolderRootFromDisk(fullPath);
      if (folderRoot) {
        folderItem.root = folderRoot;
        if (folderRoot?.meta?.seq != null) folderItem.seq = folderRoot.meta.seq;
      }

      items.push(folderItem);
      continue;
    }

    if (EXPORT_ROOT_FILE_NAMES.has(entry.name.toLowerCase())) continue;
    if (!hasRequestExtension(entry.name)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const format = hasBruExtension(fullPath) ? 'bru' : 'yml';
      const data = parseRequest(content, { format });
      hydrateRequestWithUuid(data, fullPath);
      data.uid = data.uid || generateUidBasedOnHash(fullPath);
      data.filename = entry.name;
      data.pathname = fullPath;
      if (data?.seq == null && data?.meta?.seq != null) data.seq = data.meta.seq;
      items.push(data);
    } catch (err) {
      console.warn('[export] failed to parse request', fullPath, err?.message);
    }
  }

  return items;
};

const readFolderRootFromDisk = (folderPathname) => {
  for (const fmt of ['bru', 'yml']) {
    const folderFile = path.join(folderPathname, `folder.${fmt}`);
    if (!fs.existsSync(folderFile)) continue;
    try {
      return parseFolder(fs.readFileSync(folderFile, 'utf8'), { format: fmt });
    } catch (err) {
      console.warn('[export] failed to parse folder root', folderFile, err?.message);
      return null;
    }
  }
  return null;
};

// Reads a folder subtree off disk into a collection-shaped object so the
// existing single-file converters (brunoToOpenCollection / brunoToPostman)
// accept it as-is.
const readFolderForExport = ({ folderPathname }) => {
  if (!folderPathname || !fs.existsSync(folderPathname)) {
    throw new Error('Folder path does not exist');
  }

  const root = readFolderRootFromDisk(folderPathname) || {};
  const name = root?.meta?.name || path.basename(folderPathname);

  return {
    uid: generateUidBasedOnHash(folderPathname),
    name,
    pathname: folderPathname,
    type: 'collection',
    root,
    environments: [],
    items: readCollectionItemsFromDisk(folderPathname)
  };
};

const IMPORTABLE_REQUEST_TYPES = ['http-request', 'graphql-request', 'grpc-request', 'ws-request'];

const getRequestBaseName = (item) => {
  const filename = String(item?.filename || '').trim();
  if (filename) {
    return path.basename(filename, path.extname(filename));
  }
  return String(item?.name || 'untitled').trim() || 'untitled';
};

// Writes converted (bruno-shaped) collection items into an existing directory
// on disk. Name collisions are resolved by auto-renaming with the standard
// " copy"/" copy n" suffix (generateUniqueName).
const writeItemsIntoFolder = async ({ items = [], targetDirectory, format }) => {
  for (const item of items) {
    if (IMPORTABLE_REQUEST_TYPES.includes(item.type)) {
      const baseName = sanitizeName(getRequestBaseName(item));
      const uniqueBaseName = generateUniqueName(
        baseName,
        (name) => fs.existsSync(path.join(targetDirectory, `${name}.${format}`))
      );
      const content = await stringifyRequest(item, { format });
      safeWriteFileSync(path.join(targetDirectory, `${uniqueBaseName}.${format}`), content);
      continue;
    }

    if (item.type === 'folder') {
      const baseFolderName = sanitizeName(item?.filename || item?.name || 'untitled');
      const uniqueFolderName = generateUniqueName(
        baseFolderName,
        (name) => fs.existsSync(path.join(targetDirectory, name))
      );
      const folderPath = path.join(targetDirectory, uniqueFolderName);
      fs.mkdirSync(folderPath, { recursive: true });

      if (item?.root?.meta?.name) {
        if (item.seq != null) {
          item.root.meta.seq = item.seq;
        }
        const folderContent = await stringifyFolder(item.root, { format });
        safeWriteFileSync(path.join(folderPath, `folder.${format}`), folderContent);
      }

      if (item.items && item.items.length) {
        await writeItemsIntoFolder({ items: item.items, targetDirectory: folderPath, format });
      }
      continue;
    }

    if (item.type === 'js') {
      const filename = sanitizeName(item?.filename || `${item.name}.js`);
      safeWriteFileSync(path.join(targetDirectory, filename), item.fileContent);
    }
  }
};

module.exports = {
  readCollectionItemsFromDisk,
  readFolderForExport,
  writeItemsIntoFolder
};
