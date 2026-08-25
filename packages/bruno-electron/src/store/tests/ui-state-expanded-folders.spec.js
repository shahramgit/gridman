/**
 * THE SIDEBAR HAS TO REOPEN WHERE THE USER LEFT IT.
 *
 * Restart collapsed everything. On the workspace this ships for that is 124
 * collections and 4,789 directories, re-navigated by hand every morning.
 *
 * Two properties matter on the storage side and both are tested here: entries
 * survive a round trip keyed by collection, and the list cannot grow without
 * bound — this file is rewritten on every toggle and read synchronously at
 * startup, and one "expand all" on the big collection would otherwise put a
 * quarter of a megabyte of paths in it.
 */

const mockBackingStore = new Map();
jest.mock('electron-store', () => {
  return class FakeStore {
    get(key) { return mockBackingStore.get(key); }
    set(key, value) { mockBackingStore.set(key, JSON.parse(JSON.stringify(value))); }
  };
});

const UiStateSnapshotStore = require('../ui-state-snapshot');

beforeEach(() => mockBackingStore.clear());

const COLL = '/w/collections/alpha';
const OTHER = '/w/collections/beta';

describe('persisted expanded folders', () => {
  it('round-trips the folders it was given', () => {
    const s = new UiStateSnapshotStore();
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: ['auth', 'auth/tokens'] } });

    expect(s.getCollectionByPathname({ pathname: COLL }).expandedFolders).toEqual(['auth', 'auth/tokens']);
  });

  it('keeps collections apart', () => {
    const s = new UiStateSnapshotStore();
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: ['auth'] } });
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: OTHER, expandedFolders: ['billing'] } });

    expect(s.getCollectionByPathname({ pathname: COLL }).expandedFolders).toEqual(['auth']);
    expect(s.getCollectionByPathname({ pathname: OTHER }).expandedFolders).toEqual(['billing']);
  });

  it('does not disturb the selected environment stored alongside it', () => {
    const s = new UiStateSnapshotStore();
    s.update({ type: 'COLLECTION_ENVIRONMENT', data: { collectionPath: COLL, environmentName: 'staging' } });
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: ['auth'] } });

    const saved = s.getCollectionByPathname({ pathname: COLL });
    expect(saved.selectedEnvironment).toBe('staging');
    expect(saved.expandedFolders).toEqual(['auth']);
  });

  it('caps the list instead of writing a directory tree into a settings file', () => {
    const s = new UiStateSnapshotStore();
    const many = Array.from({ length: 5000 }, (_, i) => `folder-${i}`);
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: many } });

    expect(s.getCollectionByPathname({ pathname: COLL }).expandedFolders).toHaveLength(500);
  });

  it('collapsing everything clears the list rather than leaving it stale', () => {
    const s = new UiStateSnapshotStore();
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: ['auth'] } });
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: [] } });

    expect(s.getCollectionByPathname({ pathname: COLL }).expandedFolders).toEqual([]);
  });

  it('ignores junk entries rather than persisting them', () => {
    const s = new UiStateSnapshotStore();
    s.update({ type: 'COLLECTION_EXPANDED_FOLDERS', data: { collectionPath: COLL, expandedFolders: ['auth', '', null, 42, undefined] } });

    expect(s.getCollectionByPathname({ pathname: COLL }).expandedFolders).toEqual(['auth']);
  });
});
