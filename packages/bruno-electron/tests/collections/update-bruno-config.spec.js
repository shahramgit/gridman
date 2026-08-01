// `renderer:update-bruno-config` lives inside the collection IPC module, so the
// suite registers the real handlers against a stub ipcMain and invokes the one it
// cares about. Everything below is the minimum needed to load that module outside
// electron.
const registeredHandlers = {};

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'gridman', getVersion: () => '0.0.0', isPackaged: false },
  dialog: {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel, handler) => {
      registeredHandlers[channel] = handler;
    },
    on: () => {},
    emit: () => {}
  }
}));

jest.mock('electron-store', () => {
  return class MemoryStore {
    constructor() {
      this.data = {};
    }

    get(key, defaultValue) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], this.data);
      return value === undefined ? defaultValue : value;
    }

    set(key, value) {
      const parts = key.split('.');
      let node = this.data;
      for (const part of parts.slice(0, -1)) {
        node[part] = node[part] || {};
        node = node[part];
      }
      node[parts.at(-1)] = value;
    }

    delete(key) {
      delete this.data[key];
    }
  };
});

// src/utils/constants.js is ESM and jest here runs without a transform.
jest.mock('../../src/utils/constants', () => ({
  REQUEST_TYPES: ['http-request', 'graphql-request', 'grpc-request', 'ws-request']
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stringifyCollection, parseCollection } = require('@usebruno/filestore');

const registerCollectionsIpc = require('../../src/ipc/collection');

const mainWindowStub = { webContents: { send: () => {} } };
const watcherStub = { addWatcher: () => {}, removeWatcher: () => {}, hasWatcher: () => false };

registerCollectionsIpc(mainWindowStub, watcherStub);

const updateBrunoConfig = registeredHandlers['renderer:update-bruno-config'];

const BRUNO_CONFIG = {
  opencollection: '1.0.0',
  name: 'Test Collection',
  type: 'collection',
  ignore: ['node_modules', '.git']
};

const COLLECTION_ROOT = {
  meta: null,
  request: {
    headers: [{ name: 'x-api-key', value: 'do-not-lose-me', enabled: true }],
    auth: null,
    script: { req: 'console.log("pre-request");', res: null },
    vars: { req: [], res: [] },
    tests: null
  },
  docs: 'Collection docs that must survive a config-only save.'
};

describe('renderer:update-bruno-config — yml collection root recovery', () => {
  let collectionPath;
  let ocYmlPath;

  const readRoot = () => parseCollection(fs.readFileSync(ocYmlPath, 'utf8'), { format: 'yml' });

  beforeEach(() => {
    collectionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-update-config-'));
    ocYmlPath = path.join(collectionPath, 'opencollection.yml');
    fs.writeFileSync(ocYmlPath, stringifyCollection(COLLECTION_ROOT, BRUNO_CONFIG, { format: 'yml' }), 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(collectionPath, { recursive: true, force: true });
    } catch (err) {}
  });

  it('exposes the handler', () => {
    expect(typeof updateBrunoConfig).toBe('function');
  });

  it('the fixture round-trips, so the assertions below mean something', () => {
    const { collectionRoot } = readRoot();
    expect(collectionRoot.docs).toBe(COLLECTION_ROOT.docs);
    expect(collectionRoot.request.headers).toHaveLength(1);
  });

  // opencollection.yml holds config AND root in one file. The renderer hands us
  // `collection.root`, which stays empty until the root is hydrated — and GRIDMAN
  // hydrates lazily, so a config-only save on a collection whose settings were
  // never opened used to write an empty root over the real one.
  // upstream bruno #8424 (acc74745d)
  it('keeps the on-disk root when the caller passes no root', async () => {
    await updateBrunoConfig(null, { ...BRUNO_CONFIG, ignore: ['node_modules', '.git', 'dist'] }, collectionPath, undefined);

    const { collectionRoot, brunoConfig } = readRoot();
    expect(collectionRoot.docs).toBe(COLLECTION_ROOT.docs);
    expect(collectionRoot.request.headers[0].name).toBe('x-api-key');
    expect(collectionRoot.request.headers[0].value).toBe('do-not-lose-me');
    expect(collectionRoot.request.script.req).toContain('pre-request');
    expect(brunoConfig.ignore).toEqual(['node_modules', '.git', 'dist']);
  });

  it('keeps the on-disk root when the caller passes an empty root object', async () => {
    await updateBrunoConfig(null, { ...BRUNO_CONFIG, ignore: ['dist'] }, collectionPath, {});

    const { collectionRoot, brunoConfig } = readRoot();
    expect(collectionRoot.docs).toBe(COLLECTION_ROOT.docs);
    expect(collectionRoot.request.headers[0].value).toBe('do-not-lose-me');
    expect(brunoConfig.ignore).toEqual(['dist']);
  });

  it('still writes the root the caller supplied when there is one', async () => {
    const editedRoot = {
      ...COLLECTION_ROOT,
      docs: 'Edited docs',
      request: {
        ...COLLECTION_ROOT.request,
        headers: [{ name: 'x-api-key', value: 'edited', enabled: true }]
      }
    };

    await updateBrunoConfig(null, BRUNO_CONFIG, collectionPath, editedRoot);

    const { collectionRoot } = readRoot();
    expect(collectionRoot.docs).toBe('Edited docs');
    expect(collectionRoot.request.headers[0].value).toBe('edited');
  });
});
