const fs = require('fs');
const path = require('path');

// WHERE A NEW OR INCOMING FOLDER GOES: after every sibling, whatever numbers
// those siblings already carry.
//
// Folders sort with sortByNameThenSequence, where seq is an ABSOLUTE position,
// and a folder written with a low seq sorts near the top — committed that way,
// so every teammate sees it there too. Each folder writer used to pick its own
// number: the header "New Folder" asked the renderer's index (empty while a
// collection re-indexes after a pull), the folder-row "New Folder" used
// sibling-count + 1 (which ignores numbers above the count), and import wrote
// the SOURCE file's numbering (1, 2, ...), putting an imported folder at the
// top. Reported against 4.1.0-vasl.5 and again against 4.1.0-vasl.6. Every
// writer now asks the disk, which is right whatever state the index is in.
//
// Only the first 4KB of each sibling is read: `seq` sits in the meta/info
// block at the top of every request and folder file.
const HEAD_BYTES = 4096;
const SEQ_LINE = /^\s*seq:\s*['"]?(\d+)['"]?\s*$/m;
const NOT_REQUESTS = new Set(['folder', 'collection', 'opencollection']);

const readSeqFromHead = (filePath) => {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const match = buffer.subarray(0, bytesRead).toString('utf8').match(SEQ_LINE);
    return match ? Number(match[1]) : 0;
  } catch (_error) {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_error) {
        // nothing to do about a handle that will not close
      }
    }
  }
};

const isRequestFileName = (name, format) => {
  const ext = path.extname(name);
  return ext === `.${format}` && !NOT_REQUESTS.has(path.basename(name, ext));
};

// max(number of siblings, largest sibling seq) + 1. `exclude` names entries
// that must not count — the item being placed, when it is already on disk.
const nextAppendSeq = (parentDir, format, { exclude = [] } = {}) => {
  let count = 0;
  let maxSeq = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch (_error) {
    return 1;
  }

  for (const entry of entries) {
    const { name } = entry;
    if (name.startsWith('.') || name === 'node_modules' || exclude.includes(name)) {
      continue;
    }
    const fullPath = path.join(parentDir, name);
    if (entry.isDirectory()) {
      count += 1;
      maxSeq = Math.max(maxSeq, readSeqFromHead(path.join(fullPath, `folder.${format}`)));
    } else if (isRequestFileName(name, format)) {
      count += 1;
      maxSeq = Math.max(maxSeq, readSeqFromHead(fullPath));
    }
  }

  return Math.max(count, maxSeq) + 1;
};

// Rewrite ONE folder's seq in place — a folder pasted or dropped into a new
// parent otherwise keeps the number it had in its old one (seq 1 there means
// the top here). Only this folder's file is touched: resequencing the siblings
// would drop a new folder file into every one of them.
const setFolderSeq = async (folderPath, format, seq) => {
  const { parseFolder, stringifyFolder } = require('@usebruno/filestore');
  const folderFile = path.join(folderPath, `folder.${format}`);
  let data = null;
  if (fs.existsSync(folderFile)) {
    try {
      data = await parseFolder(fs.readFileSync(folderFile, 'utf8'), { format });
    } catch (_error) {
      return false; // never overwrite a folder file we could not read
    }
  }
  // An empty or nameless folder file parses to an object without a name, and
  // writing that back would name the folder "undefined".
  const next = data && typeof data === 'object' ? data : {};
  if (!next.request) {
    next.request = { auth: { mode: 'inherit' } };
  }
  next.meta = { ...(next.meta || {}), name: next.meta?.name || path.basename(folderPath), seq };
  fs.writeFileSync(folderFile, await stringifyFolder(next, { format }));
  return true;
};

module.exports = { nextAppendSeq, readSeqFromHead, setFolderSeq };
