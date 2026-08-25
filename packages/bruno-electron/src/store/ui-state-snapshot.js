const Store = require('electron-store');

const MAX_PERSISTED_EXPANDED_FOLDERS = 500;

class UiStateSnapshotStore {
  constructor() {
    this.store = new Store({
      name: 'ui-state-snapshot',
      clearInvalidConfig: true
    });
  }

  getCollections() {
    return this.store.get('collections') || [];
  }

  saveCollections(collections) {
    this.store.set('collections', collections);
  }

  getCollectionByPathname({ pathname }) {
    let collections = this.getCollections();

    let collection = collections.find((c) => c?.pathname === pathname);
    if (!collection) {
      collection = { pathname };
      collections.push(collection);
      this.saveCollections(collections);
    }

    return collection;
  }

  setCollectionByPathname({ collection }) {
    let collections = this.getCollections();

    collections = collections.filter((c) => c?.pathname !== collection.pathname);
    collections.push({ ...collection });
    this.saveCollections(collections);

    return collection;
  }

  updateCollectionEnvironment({ collectionPath, environmentName }) {
    const collection = this.getCollectionByPathname({ pathname: collectionPath });
    collection.selectedEnvironment = environmentName;
    this.setCollectionByPathname({ collection });
  }

  /**
   * Which folders the user had open, as collection-relative posix paths.
   *
   * Paths and not uids: `getRequestUid` hands out a fresh uuid per pathname
   * per process (see cache/requestUids.js — it is a Map, not a hash), so a uid
   * written today means nothing tomorrow.
   *
   * The cap is not defensive dressing. This file is rewritten on every toggle,
   * and the workspace this ships for has 4,789 directories in one collection;
   * an "expand all" on that would put a quarter of a megabyte of paths in a
   * settings file that is read synchronously at startup.
   */
  updateCollectionExpandedFolders({ collectionPath, expandedFolders }) {
    const collection = this.getCollectionByPathname({ pathname: collectionPath });
    collection.expandedFolders = (Array.isArray(expandedFolders) ? expandedFolders : [])
      .filter((entry) => typeof entry === 'string' && entry)
      .slice(0, MAX_PERSISTED_EXPANDED_FOLDERS);
    this.setCollectionByPathname({ collection });
  }

  update({ type, data }) {
    switch (type) {
      case 'COLLECTION_ENVIRONMENT': {
        const { collectionPath, environmentName } = data;
        this.updateCollectionEnvironment({ collectionPath, environmentName });
        break;
      }
      case 'COLLECTION_EXPANDED_FOLDERS': {
        const { collectionPath, expandedFolders } = data;
        this.updateCollectionExpandedFolders({ collectionPath, expandedFolders });
        break;
      }
      default:
        break;
    }
  }
}

module.exports = UiStateSnapshotStore;
