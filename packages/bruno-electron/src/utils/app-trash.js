const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const { uuid } = require('./common');
const { movePathWithRetry } = require('./filesystem');

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
  const entryMeta = {
    id: entryId,
    displayName: meta.displayName || basename,
    type: meta.type || 'item',
    originalPathname: path.resolve(source),
    collectionPathname: meta.collectionPathname || null,
    deletedAt: new Date().toISOString(),
    basename
  };

  // Rename when possible, copy+delete across devices (userData usually lives
  // on another drive than the collection). Deleting hits the same Windows
  // locks and MAX_PATH limits as renaming, so it goes through the shared retry
  // helper.
  try {
    await movePathWithRetry(source, path.join(payloadDir, basename));
  } catch (error) {
    if (error?.sourceIntact === true) {
      // The source was PROVEN untouched, so nothing of the user's is in here.
      // Without meta.json this entry is invisible to both the Trash panel and
      // the purge, so drop it instead of leaking a directory into userData on
      // every failed delete.
      await fsExtra.remove(entryDir).catch(() => {});
    } else {
      // The move may have taken the only complete copy into the payload — and
      // anything we cannot PROVE intact counts as that — so the entry has to
      // stay, with its meta.json, or listAppTrash skips it, purgeAppTrash never
      // sees it and the user's requests sit unreachable in userData forever.
      await fsExtra.writeJson(path.join(entryDir, 'meta.json'), entryMeta, { spaces: 2 }).catch(() => {});
    }
    throw error;
  }

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
  try {
    await movePathWithRetry(payloadPath, target);
  } catch (error) {
    // `sourceIntact: false` means the complete copy already landed back at the
    // original location and only the payload could not be fully removed — that
    // IS the restore the user asked for, so finish it rather than report a
    // failure they cannot act on and leave a half-emptied entry behind.
    if (error?.sourceIntact !== false) {
      throw error;
    }
  }
  // Best-effort: the lock that stopped the payload being removed is usually
  // still in force, and failing here would report a restore that actually
  // succeeded — leaving an entry pointing at a path that now exists, which
  // every retry then refuses with "already exists at its original location".
  await fsExtra.remove(entryDir).catch(() => {});
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
