import { buildSidebarEntries, getSidebarEntryName } from './sidebarEntries';
import { normalizePath } from 'utils/common/path';

// Persian collection name in both unicode forms. macOS reports NFD from the
// filesystem (watchers/search index) while workspace.yml holds NFC.
const persianName = 'مجموعه‌ی آزمایشی';
const nfcPath = `/Users/dev/collections/${persianName}`.normalize('NFC');
const nfdPath = nfcPath.normalize('NFD');

describe('normalizePath (unicode comparison)', () => {
  it('treats NFC and NFD forms of the same path as equal', () => {
    expect(nfcPath).not.toBe(nfdPath); // sanity: raw strings differ
    expect(normalizePath(nfcPath)).toBe(normalizePath(nfdPath));
  });

  it('still unifies separators and strips trailing slashes', () => {
    expect(normalizePath('C:\\Users\\dev\\api\\')).toBe('C:/Users/dev/api');
  });
});

describe('buildSidebarEntries', () => {
  it('lists a loaded collection whose pathname is NFD while workspace.yml is NFC', () => {
    // Repro of the reported bug: a Persian-named collection opened via a
    // workspace-search result registers with the NFD pathname the search
    // index reported. Clearing the search must not make it vanish.
    const entries = buildSidebarEntries({
      workspaceCollections: [{ name: persianName, path: nfcPath }],
      loadedCollections: [{ uid: 'col-1', name: persianName, pathname: nfdPath }]
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('loaded');
    expect(entries[0].collection.uid).toBe('col-1');
  });

  it('lists a registered-but-unloaded collection as an unloaded placeholder', () => {
    const entries = buildSidebarEntries({
      workspaceCollections: [{ name: 'api', path: '/ws/api' }],
      loadedCollections: []
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('unloaded');
    expect(getSidebarEntryName(entries[0])).toBe('api');
  });

  it('never drops a registered collection when search is empty (mixed loaded/unloaded)', () => {
    const entries = buildSidebarEntries({
      workspaceCollections: [
        { name: 'a', path: '/ws/a' },
        { name: 'b', path: '/ws/b' },
        { name: 'c', path: '/ws/c' }
      ],
      loadedCollections: [{ uid: 'b-uid', name: 'b', pathname: '/ws/b' }]
    });

    expect(entries.map((e) => e.type)).toEqual(['unloaded', 'loaded', 'unloaded']);
    expect(entries.map(getSidebarEntryName)).toEqual(['a', 'b', 'c']);
  });

  it('de-dupes NFC/NFD duplicate workspace entries written by older builds', () => {
    const entries = buildSidebarEntries({
      workspaceCollections: [
        { name: persianName, path: nfcPath },
        { name: persianName, path: nfdPath }
      ],
      loadedCollections: [{ uid: 'col-1', name: persianName, pathname: nfdPath }]
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('loaded');
  });

  it('falls back to the path basename for unloaded entries without a name', () => {
    const entries = buildSidebarEntries({
      workspaceCollections: [{ path: '/ws/deep/nested/api-suite' }],
      loadedCollections: []
    });

    expect(getSidebarEntryName(entries[0])).toBe('api-suite');
  });

  it('sorts alphabetically across loaded and unloaded entries', () => {
    const entries = buildSidebarEntries({
      workspaceCollections: [
        { name: 'zebra', path: '/ws/zebra' },
        { name: 'alpha', path: '/ws/alpha' }
      ],
      loadedCollections: [{ uid: 'z', name: 'zebra', pathname: '/ws/zebra' }],
      collectionSortOrder: 'alphabetical'
    });

    expect(entries.map(getSidebarEntryName)).toEqual(['alpha', 'zebra']);
  });

  it('ignores workspace entries without a path', () => {
    const entries = buildSidebarEntries({
      workspaceCollections: [{ name: 'ghost' }, { name: 'real', path: '/ws/real' }],
      loadedCollections: []
    });

    expect(entries).toHaveLength(1);
    expect(getSidebarEntryName(entries[0])).toBe('real');
  });
});
