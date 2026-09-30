import { configureStore } from '@reduxjs/toolkit';
import collectionsReducer, {
  collectionIndexStarted,
  collectionIndexBatchReceived,
  collectionIndexReady,
  collectionChangeFileEvent
} from 'providers/ReduxStore/slices/collections';
import { moveCollectionItemByPath } from 'providers/ReduxStore/slices/collections/actions';
import { sortNodes } from 'utils/collections/visibleRows';

// The sidebar sorts from the INDEX. A folder whose number changed on disk kept
// its old place in the sidebar until the next re-index: its folder file's
// add/change events updated only the loaded tree, and a move never carried the
// new number back. Reported (as "the folder is at the top") against vasl.5/.6.
const mockCallIpc = jest.fn();
jest.mock('utils/common/ipc', () => ({ ...jest.requireActual('utils/common/ipc'), callIpc: (...a) => mockCallIpc(...a) }));

const UID = 'col-022';
const ROOT = '/w/nix/collections/022(g_taxgovir)';
const folder = (uid, name, seq) => ({ uid, name, type: 'folder', parentUid: null, depth: 0, pathname: `${ROOT}/${name}`, seq });
const NODES = [folder('a', 'first', 1), folder('b', 'second', 2), folder('c', 'moved-in', 1)];

const makeStore = () => {
  const store = configureStore({
    reducer: { collections: collectionsReducer },
    preloadedState: { collections: { ...collectionsReducer(undefined, { type: '@@init' }), collections: [{ uid: UID, name: '022', pathname: ROOT, items: [], format: 'bru' }] } },
    middleware: (d) => d({ serializableCheck: false, immutableCheck: false })
  });
  store.dispatch(collectionIndexStarted({ collectionUid: UID, loadSessionId: 's' }));
  store.dispatch(collectionIndexBatchReceived({ collectionUid: UID, loadSessionId: 's', nodes: NODES, totalScanned: 3 }));
  store.dispatch(collectionIndexReady({ collectionUid: UID, loadSessionId: 's', totalNodes: 3 }));
  return store;
};
const order = (store) => {
  const index = store.getState().collections.collectionIndexes[UID];
  return sortNodes((index.childrenByParentUid.root || []).map((uid) => index.nodesByUid[uid])).map((n) => n.name);
};

it('a folder file\'s new seq reaches the sidebar without a re-index', () => {
  const store = makeStore();
  expect(order(store)[0]).toBe('first'); // 'moved-in' ties at seq 1 today

  store.dispatch(collectionChangeFileEvent({
    file: { meta: { collectionUid: UID, pathname: `${ROOT}/moved-in/folder.bru`, folderRoot: true }, data: { meta: { name: 'moved-in', seq: 3 } } }
  }));

  expect(order(store).at(-1)).toBe('moved-in');
});

it('a moved folder\'s new seq from the main process is applied to the mover\'s sidebar', async () => {
  const store = makeStore();
  mockCallIpc.mockResolvedValue({ pathname: `${ROOT}/moved-in`, type: 'folder', seq: 3 });

  await store.dispatch(moveCollectionItemByPath({
    sourceCollectionUid: UID,
    targetCollectionUid: UID,
    sourcePathname: `${ROOT}/elsewhere/moved-in`,
    targetPathname: `${ROOT}`,
    dropType: 'inside'
  }));

  const index = store.getState().collections.collectionIndexes[UID];
  const node = Object.values(index.nodesByUid).find((n) => n.pathname === `${ROOT}/moved-in`);
  expect(node.seq).toBe(3);
});
