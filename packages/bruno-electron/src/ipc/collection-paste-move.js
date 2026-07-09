const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const {
  parseRequest,
  stringifyRequest,
  parseFolder,
  stringifyFolder
} = require('@usebruno/filestore');
const { writeFile, isDirectory, generateUniqueName } = require('../utils/filesystem');

const REQUEST_FILE_EXTENSION_BY_FORMAT = {
  bru: '.bru',
  yml: '.yml'
};

// Resolve a collision-free target pathname inside targetDirname. When the
// desired basename already exists, generate a unique one ("name copy",
// "name copy 2", ...) while preserving the file extension for requests.
// Returns the suffix that was appended so callers can mirror it onto the
// item's display name.
const resolveUniqueTargetPathname = ({ targetDirname, basename, isFolder }) => {
  const ext = isFolder ? '' : path.extname(basename);
  const stem = ext ? path.basename(basename, ext) : basename;
  const desiredPathname = path.join(targetDirname, basename);

  if (!fs.existsSync(desiredPathname)) {
    return { pathname: desiredPathname, basename, renamed: false, suffix: '' };
  }

  const uniqueStem = generateUniqueName(stem, (name) => fs.existsSync(path.join(targetDirname, `${name}${ext}`)));
  return {
    pathname: path.join(targetDirname, `${uniqueStem}${ext}`),
    basename: `${uniqueStem}${ext}`,
    renamed: true,
    suffix: uniqueStem.slice(stem.length)
  };
};

// After an auto-renamed move/copy, append the same suffix to the item's
// display name (the sidebar renders meta name, not the filename) so the user
// doesn't see two identical entries. Best-effort: the file operation already
// succeeded, so failures here must not fail the whole action. Returns the new
// display name (or null when nothing was rewritten).
const applyDisplayNameSuffix = async ({ pathname, kind, suffix, format }) => {
  if (!suffix) {
    return null;
  }

  try {
    if (kind === 'folder') {
      const folderFilePath = path.join(pathname, `folder.${format}`);
      if (!fs.existsSync(folderFilePath)) {
        // No folder meta: the folder displays its directory name, which is
        // already unique.
        return null;
      }
      const content = await fs.promises.readFile(folderFilePath, 'utf8');
      const jsonData = await parseFolder(content, { format });
      if (!jsonData?.meta?.name) {
        return null;
      }
      jsonData.meta.name = `${jsonData.meta.name}${suffix}`;
      await writeFile(folderFilePath, await stringifyFolder(jsonData, { format }));
      return jsonData.meta.name;
    }

    const content = await fs.promises.readFile(pathname, 'utf8');
    const jsonData = parseRequest(content, { format });
    if (!jsonData?.name) {
      return null;
    }
    jsonData.name = `${jsonData.name}${suffix}`;
    await writeFile(pathname, stringifyRequest(jsonData, { format }));
    return jsonData.name;
  } catch (error) {
    console.warn('Failed to update display name after auto-rename', pathname, error);
    return null;
  }
};

// Recursively copy a folder while converting request/folder files between
// collection formats. Returns [sourcePath, targetPath] pairs so move callers
// can remap request uids (copy callers ignore them).
const convertFolderBetweenFormats = async ({ sourcePathname, targetPathname, sourceFormat, targetFormat }) => {
  const sourceExt = REQUEST_FILE_EXTENSION_BY_FORMAT[sourceFormat] || '.bru';
  const targetExt = REQUEST_FILE_EXTENSION_BY_FORMAT[targetFormat] || '.bru';
  const movedPairs = [];

  const walk = async (sourceDir, targetDir) => {
    await fsExtra.ensureDir(targetDir);
    const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourceEntryPath = path.join(sourceDir, entry.name);

      if (entry.isDirectory()) {
        await walk(sourceEntryPath, path.join(targetDir, entry.name));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const isFolderMeta = entry.name === `folder${sourceExt}`;
      const isRequestFile = !isFolderMeta && entry.name.endsWith(sourceExt);

      if (isFolderMeta) {
        const content = await fs.promises.readFile(sourceEntryPath, 'utf8');
        const parsed = await parseFolder(content, { format: sourceFormat });
        const stringified = await stringifyFolder(parsed, { format: targetFormat });
        await writeFile(path.join(targetDir, `folder${targetExt}`), stringified);
        continue;
      }

      if (isRequestFile) {
        const content = await fs.promises.readFile(sourceEntryPath, 'utf8');
        const parsed = await parseRequest(content, { format: sourceFormat });
        const targetEntryPath = path.join(targetDir, `${path.basename(entry.name, sourceExt)}${targetExt}`);
        const stringified = await stringifyRequest(parsed, { format: targetFormat });
        await writeFile(targetEntryPath, stringified);
        movedPairs.push([sourceEntryPath, targetEntryPath]);
        continue;
      }

      await fsExtra.copy(sourceEntryPath, path.join(targetDir, entry.name));
    }
  };

  await walk(sourcePathname, targetPathname);
  return movedPairs;
};

const readFolderDisplayName = async (folderPathname, format) => {
  try {
    const folderFilePath = path.join(folderPathname, `folder.${format}`);
    if (fs.existsSync(folderFilePath)) {
      const content = await fs.promises.readFile(folderFilePath, 'utf8');
      const jsonData = await parseFolder(content, { format });
      if (jsonData?.meta?.name) {
        return jsonData.meta.name;
      }
    }
  } catch (error) {
    // fall through to the directory name
  }
  return path.basename(folderPathname);
};

// Disk-level folder paste. Copies the folder subtree from the source
// collection into targetDirname (possibly in another collection / another
// format), auto-renaming on filename collisions. Working from disk means
// index-only (non-hydrated) children paste correctly — the renderer's
// hydrated tree is never consulted.
const pasteFolderByPath = async ({ sourcePathname, targetDirname, sourceFormat, targetFormat }) => {
  if (!isDirectory(sourcePathname)) {
    throw new Error(`path: ${sourcePathname} is not a folder`);
  }

  const { pathname: targetPathname, renamed, suffix } = resolveUniqueTargetPathname({
    targetDirname,
    basename: path.basename(sourcePathname),
    isFolder: true
  });

  if (sourceFormat !== targetFormat) {
    await convertFolderBetweenFormats({ sourcePathname, targetPathname, sourceFormat, targetFormat });
  } else {
    await fsExtra.copy(sourcePathname, targetPathname, { overwrite: false, errorOnExist: true });
  }

  if (renamed) {
    await applyDisplayNameSuffix({ pathname: targetPathname, kind: 'folder', suffix, format: targetFormat });
  }

  return {
    pathname: targetPathname,
    name: await readFolderDisplayName(targetPathname, targetFormat),
    type: 'folder'
  };
};

// Disk-level request paste (see pasteFolderByPath).
const pasteRequestByPath = async ({ sourcePathname, targetDirname, sourceFormat, targetFormat }) => {
  if (!fs.existsSync(sourcePathname)) {
    throw new Error(`path: ${sourcePathname} does not exist`);
  }

  const content = await fs.promises.readFile(sourcePathname, 'utf8');
  const jsonData = parseRequest(content, { format: sourceFormat });

  const targetExt = REQUEST_FILE_EXTENSION_BY_FORMAT[targetFormat] || '.bru';
  const stem = path.basename(sourcePathname, path.extname(sourcePathname));
  const { pathname: targetPathname, renamed, suffix } = resolveUniqueTargetPathname({
    targetDirname,
    basename: `${stem}${targetExt}`,
    isFolder: false
  });

  if (renamed && jsonData?.name) {
    jsonData.name = `${jsonData.name}${suffix}`;
  }

  await writeFile(targetPathname, stringifyRequest(jsonData, { format: targetFormat }));

  return {
    pathname: targetPathname,
    name: jsonData?.name || path.basename(targetPathname, targetExt),
    type: jsonData?.type || 'http-request'
  };
};

module.exports = {
  resolveUniqueTargetPathname,
  applyDisplayNameSuffix,
  convertFolderBetweenFormats,
  pasteFolderByPath,
  pasteRequestByPath
};
