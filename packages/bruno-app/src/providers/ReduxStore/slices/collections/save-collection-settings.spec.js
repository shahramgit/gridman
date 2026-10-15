jest.mock('nanoid', () => ({ customAlphabet: () => () => 'mock-uid' }));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() }
}));

import { configureStore } from '@reduxjs/toolkit';
import collectionsReducer, {
  updateCollectionRequestScript,
  updateCollectionProxy
} from './index';
import { saveCollectionRoot, saveCollectionSettings, saveMultipleCollections, updateBrunoConfig } from './actions';

const SCRIPT = 'bru.setVar("saved", true);';
const PROXY = { enabled: true, hostname: 'proxy.local', port: 8080 };

const makeCollection = (uid = 'one') => ({
  uid,
  name: uid,
  pathname: `/tmp/${uid}`,
  format: 'yml',
  root: {
    request: {
      headers: [], auth: { mode: 'none' }, script: { req: '', res: '' },
      vars: { req: [], res: [] }, tests: ''
    }
  },
  brunoConfig: { name: uid, version: '1', proxy: { enabled: false } },
  items: [],
  environments: []
});

const createStore = (collections = [makeCollection()]) => configureStore({
  reducer: { collections: collectionsReducer },
  preloadedState: { collections: { collections } },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware({ immutableCheck: false, serializableCheck: false })
});

let disks;
let releaseRootWrite;
let rejectPath;

beforeEach(() => {
  disks = {};
  releaseRootWrite = null;
  rejectPath = null;
  window.ipcRenderer = {
    invoke: jest.fn(async (channel, ...args) => {
      if (channel === 'renderer:save-collection-root') {
        const [pathname, root, config] = args;
        if (releaseRootWrite) await releaseRootWrite;
        if (pathname === rejectPath) throw new Error('disk full');
        // Both real IPCs rewrite the entire opencollection.yml, not just one part.
        disks[pathname] = { root, config };
      } else if (channel === 'renderer:update-bruno-config') {
        const [config, pathname, root] = args;
        disks[pathname] = { root, config };
      }
    })
  };
});

const editBoth = (store, collectionUid = 'one') => {
  store.dispatch(updateCollectionRequestScript({ collectionUid, script: SCRIPT }));
  store.dispatch(updateCollectionProxy({ collectionUid, proxy: PROXY }));
};

it.each(['settings', 'root', 'bulk'])('saves both draft sections through the %s entry point', async (entryPoint) => {
  const store = createStore();
  editBoth(store);
  const save = entryPoint === 'root' ? saveCollectionRoot('one')
    : entryPoint === 'bulk' ? saveMultipleCollections([{ collectionUid: 'one' }])
      : saveCollectionSettings('one');
  await store.dispatch(save);
  expect(disks['/tmp/one'].root.request.script.req).toBe(SCRIPT);
  expect(disks['/tmp/one'].config.proxy).toEqual(PROXY);
  expect(store.getState().collections.collections[0].draft).toBeNull();
});

it('does not start a conflicting config write or finish bulk saving while a root write is pending', async () => {
  let release;
  releaseRootWrite = new Promise((resolve) => { release = resolve; });
  const store = createStore();
  editBoth(store);
  let finished = false;
  const pending = store.dispatch(saveMultipleCollections([{ collectionUid: 'one' }])).then(() => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(window.ipcRenderer.invoke.mock.calls.map(([channel]) => channel)).toEqual(['renderer:save-collection-root']);
  release();
  await pending;
  expect(disks['/tmp/one'].root.request.script.req).toBe(SCRIPT);
  expect(disks['/tmp/one'].config.proxy).toEqual(PROXY);
});

it('writes each collection to its own path and skips stale collection ids', async () => {
  const store = createStore([makeCollection('one'), makeCollection('two')]);
  editBoth(store, 'one');
  store.dispatch(updateCollectionProxy({ collectionUid: 'two', proxy: PROXY }));
  await store.dispatch(saveMultipleCollections([{ collectionUid: 'one' }, { collectionUid: 'missing' }, { collectionUid: 'two' }]));
  expect(disks['/tmp/one'].root.request.script.req).toBe(SCRIPT);
  expect(disks['/tmp/two'].root.request.script.req).toBe('');
  expect(disks['/tmp/two'].config.proxy).toEqual(PROXY);
});

it('rejects a failed bulk save and preserves the unsaved draft', async () => {
  const store = createStore();
  editBoth(store);
  rejectPath = '/tmp/one';
  await expect(store.dispatch(saveMultipleCollections([{ collectionUid: 'one' }]))).rejects.toThrow('disk full');
  expect(store.getState().collections.collections[0].draft.root.request.script.req).toBe(SCRIPT);
  expect(disks['/tmp/one']).toBeUndefined();
});

it('keeps a newer edit dirty when an earlier save finishes', async () => {
  let release;
  releaseRootWrite = new Promise((resolve) => { release = resolve; });
  const store = createStore();
  editBoth(store);
  const pending = store.dispatch(saveCollectionSettings('one'));
  store.dispatch(updateCollectionRequestScript({ collectionUid: 'one', script: 'newer unsaved edit' }));
  release();
  await pending;
  const collection = store.getState().collections.collections[0];
  expect(disks['/tmp/one'].root.request.script.req).toBe(SCRIPT);
  expect(collection.root.request.script.req).toBe(SCRIPT);
  expect(collection.draft.root.request.script.req).toBe('newer unsaved edit');
});

it('does not replace a lazy collection root with an empty manufactured root', async () => {
  const collection = makeCollection();
  collection.root = {};
  const store = createStore([collection]);
  store.dispatch(updateCollectionProxy({ collectionUid: 'one', proxy: PROXY }));
  await store.dispatch(saveCollectionSettings('one'));
  expect(window.ipcRenderer.invoke.mock.calls.map(([channel]) => channel)).toEqual(['renderer:update-bruno-config']);
  // Empty root reaches the main process unchanged, allowing its disk fallback.
  expect(window.ipcRenderer.invoke.mock.calls[0][3]).toEqual({});
});

it('serializes overlapping saves of one collection and leaves the newest snapshot on disk', async () => {
  let release;
  releaseRootWrite = new Promise((resolve) => { release = resolve; });
  const store = createStore();
  editBoth(store);
  const first = store.dispatch(saveCollectionSettings('one'));
  store.dispatch(updateCollectionRequestScript({ collectionUid: 'one', script: 'newest saved edit' }));
  const second = store.dispatch(saveCollectionSettings('one'));
  expect(window.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(disks['/tmp/one'].root.request.script.req).toBe('newest saved edit');
  expect(store.getState().collections.collections[0].draft).toBeNull();
});

it('queues config-only proto updates without overwriting saved settings or clearing newer drafts', async () => {
  let release;
  releaseRootWrite = new Promise((resolve) => { release = resolve; });
  const store = createStore();
  const config = { ...store.getState().collections.collections[0].brunoConfig, protobuf: { protoFiles: [{ path: 'api.proto' }] } };
  editBoth(store);
  const settingsSave = store.dispatch(saveCollectionSettings('one'));
  store.dispatch(updateCollectionRequestScript({ collectionUid: 'one', script: 'still unsaved' }));
  const protoSave = store.dispatch(updateBrunoConfig(config, 'one'));
  expect(window.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([settingsSave, protoSave]);
  expect(disks['/tmp/one'].root.request.script.req).toBe(SCRIPT);
  expect(disks['/tmp/one'].config.proxy).toEqual(PROXY);
  expect(disks['/tmp/one'].config.protobuf).toEqual(config.protobuf);
  expect(store.getState().collections.collections[0].draft.root.request.script.req).toBe('still unsaved');
});
