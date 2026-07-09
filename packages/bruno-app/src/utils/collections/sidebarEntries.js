import { normalizePath } from 'utils/common/path';

const pathBasename = (p) => {
  const normalized = normalizePath(p);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
};

export const getSidebarEntryName = (entry) => {
  if (entry.type === 'loaded') {
    return entry.collection?.name || '';
  }
  return entry.workspaceCollection?.name || pathBasename(entry.workspaceCollection?.path || '');
};

/**
 * Build the sidebar collection list for the active workspace.
 *
 * Invariant: every collection registered in the workspace is listed when the
 * search box is empty. Collections that are loaded into the store render with
 * their live collection object ({ type: 'loaded' }); collections that are
 * registered but not (yet) loaded render as placeholders
 * ({ type: 'unloaded' }) instead of silently disappearing — a load failure or
 * a path-normalization mismatch must never make a registered collection
 * vanish from the sidebar.
 *
 * Matching between workspace.yml paths and loaded collection pathnames goes
 * through normalizePath, which NFC-normalizes unicode: on macOS the
 * filesystem reports NFD-decomposed names (Persian/accented collection names)
 * while workspace.yml holds NFC, and the two must compare equal.
 *
 * @param {Array} workspaceCollections - activeWorkspace.collections ({ name, path, notFoundLocally })
 * @param {Array} loadedCollections - state.collections.collections (scratch collections already excluded)
 * @param {string} collectionSortOrder - 'default' | 'alphabetical' | 'reverseAlphabetical'
 */
export const buildSidebarEntries = ({ workspaceCollections = [], loadedCollections = [], collectionSortOrder } = {}) => {
  const loadedByPath = new Map();
  for (const collection of loadedCollections) {
    if (collection?.pathname) {
      loadedByPath.set(normalizePath(collection.pathname), collection);
    }
  }

  const entries = [];
  const seenPaths = new Set();
  for (const workspaceCollection of workspaceCollections) {
    if (!workspaceCollection?.path) continue;

    // workspace.yml can carry NFC/NFD duplicates of the same path (written by
    // older builds that compared without unicode normalization); list it once.
    const pathKey = normalizePath(workspaceCollection.path);
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);

    const loaded = loadedByPath.get(pathKey);
    if (loaded) {
      entries.push({ collection: loaded, key: loaded.uid, type: 'loaded' });
    } else {
      entries.push({ workspaceCollection, key: `unloaded:${pathKey}`, type: 'unloaded' });
    }
  }

  if (collectionSortOrder === 'alphabetical' || collectionSortOrder === 'reverseAlphabetical') {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    entries.sort((a, b) => {
      const result = collator.compare(getSidebarEntryName(a), getSidebarEntryName(b));
      return collectionSortOrder === 'reverseAlphabetical' ? -result : result;
    });
  }

  return entries;
};
