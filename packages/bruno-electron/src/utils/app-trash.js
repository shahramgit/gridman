const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const { uuid } = require('./common');

// Gridman-managed Trash (Postman-style): user-deleted requests, folders,
// collections and environment files move HERE — inside the app, not the OS
// trash — so the bottom-bar Trash panel can list them with their original
// location and restore them in one click. Layout:
//   <userData>/trash/<entryId>/meta.json   (what/where-from/when)
//   <userData>/trash/<entryId>/payload/<basename>
// Entries older than PURGE_AFTER_DAYS are purged at app startup.

const PURGE_AFTER_DAYS = 30;

const getTrashRoot = () => {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'trash');
};

const moveToAppTrash = async (source, meta = {}) => {
  const trashRoot = getTrashRoot();
  const entryId = `${Date.now()}-${uuid()}`;
  const entryDir = path.join(trashRoot, entryId);
  const payloadDir = path.join(entryDir, 'payload');
  await fsExtra.ensureDir(payloadDir);

  const basename = path.basename(source);
  // fs-extra move: rename when possible, copy+delete across devices.
  await fsExtra.move(source, path.join(payloadDir, basename));

  const entryMeta = {
    id: entryId,
    displayName: meta.displayName || basename,
    type: meta.type || 'item',
    originalPathname: path.resolve(source),
    collectionPathname: meta.collectionPathname || null,
    deletedAt: new Date().toISOString(),
    basename
  };
  await fsExtra.writeJson(path.join(entryDir, 'meta.json'), entryMeta, { spaces: 2 });
  return entryMeta;
};

// Back up a file's CURRENT content into the trash WITHOUT removing it — used
// by "Revert to Last Commit" so the pre-revert version stays recoverable.
const copyToAppTrash = async (source, meta = {}) => {
  const trashRoot = getTrashRoot();
  const entryId = `${Date.now()}-${uuid()}`;
  const entryDir = path.join(trashRoot, entryId);
  const payloadDir = path.join(entryDir, 'payload');
  await fsExtra.ensureDir(payloadDir);
  const basename = path.basename(source);
  await fsExtra.copy(source, path.join(payloadDir, basename));
  const entryMeta = {
    id: entryId,
    displayName: meta.displayName || basename,
    type: meta.type || 'item',
    originalPathname: path.resolve(source),
    collectionPathname: meta.collectionPathname || null,
    deletedAt: new Date().toISOString(),
    basename
  };
  await fsExtra.writeJson(path.join(entryDir, 'meta.json'), entryMeta, { spaces: 2 });
  return entryMeta;
};

const readEntryMeta = (entryDir) => {
  try {
    return fsExtra.readJsonSync(path.join(entryDir, 'meta.json'));
  } catch (_err) {
    return null;
  }
};

const listAppTrash = async () => {
  const trashRoot = getTrashRoot();
  if (!fs.existsSync(trashRoot)) {
    return [];
  }
  const entries = [];
  for (const name of await fsExtra.readdir(trashRoot)) {
    const meta = readEntryMeta(path.join(trashRoot, name));
    if (meta) {
      entries.push(meta);
    }
  }
  return entries.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
};

const restoreAppTrashItem = async (entryId) => {
  const entryDir = path.join(getTrashRoot(), entryId);
  const meta = readEntryMeta(entryDir);
  if (!meta) {
    throw new Error('Trash entry not found');
  }
  const payloadPath = path.join(entryDir, 'payload', meta.basename);
  if (!fs.existsSync(payloadPath)) {
    throw new Error('Trash entry payload is missing');
  }
  const target = meta.originalPathname;
  if (fs.existsSync(target)) {
    throw new Error(`Cannot restore: "${meta.basename}" already exists at its original location`);
  }
  await fsExtra.ensureDir(path.dirname(target));
  await fsExtra.move(payloadPath, target);
  await fsExtra.remove(entryDir);
  return meta;
};

const deleteAppTrashItem = async (entryId) => {
  await fsExtra.remove(path.join(getTrashRoot(), entryId));
};

const emptyAppTrash = async () => {
  const trashRoot = getTrashRoot();
  if (fs.existsSync(trashRoot)) {
    await fsExtra.emptyDir(trashRoot);
  }
};

const purgeAppTrash = async (days = PURGE_AFTER_DAYS) => {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const entry of await listAppTrash()) {
    const deletedAt = Date.parse(entry.deletedAt);
    if (Number.isFinite(deletedAt) && deletedAt < cutoff) {
      await deleteAppTrashItem(entry.id);
    }
  }
};

module.exports = {
  moveToAppTrash,
  copyToAppTrash,
  listAppTrash,
  restoreAppTrashItem,
  deleteAppTrashItem,
  emptyAppTrash,
  purgeAppTrash
};
