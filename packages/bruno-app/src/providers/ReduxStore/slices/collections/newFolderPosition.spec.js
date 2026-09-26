import { configureStore } from '@reduxjs/toolkit';
import collectionsReducer, {
  collectionIndexStarted,
  collectionIndexBatchReceived,
  collectionIndexReady
} from 'providers/ReduxStore/slices/collections';
import { newFolder } from 'providers/ReduxStore/slices/collections/actions';
import { sortNodes } from 'utils/collections/visibleRows';

// Reported against 4.1.0-vasl.5 with a screenshot of 022(g_taxgovir): a new
// folder landed SECOND from the top, and after the push every teammate saw it
// there. Folder seq is an absolute position among folders that have none, and
// most of this collection's folders have no folder.bru.
const COLLECTION_UID = 'col-022';
const COLLECTION_PATHNAME = '/w/nix/collections/022(g_taxgovir)';
const folder = (uid, name, seq) => ({
  uid, name, type: 'folder', parentUid: null, depth: 0, pathname: `${COLLECTION_PATHNAME}/${name}`, ...(seq ? { seq } : {})
});

const EXISTING = [
  folder('f1', 'استعلام پرداخت قبض تبصره 2 ماده 17', 1),
  folder('f2', 'استعلام جزئیات از سامانه صورت معاملات'),
  folder('f3', 'استعلام قضایی - معاملات بین اشخاص'),
  folder('f4', 'اطلاعات ثبت نام مورد نیاز'),
  folder('f5', 'اعتبارسنجی کد اقتصادی'),
  folder('f6', 'جامع اظهارنامه مالیاتی'),
  folder('f7', 'مجرمین مالیاتی')
];

const makeStore = () => {
  const store = configureStore({
    reducer: { collections: collectionsReducer },
    preloadedState: {
      collections: {
        ...collectionsReducer(undefined, { type: '@@init' }),
        collections: [{ uid: COLLECTION_UID, name: '022(g_taxgovir)', pathname: COLLECTION_PATHNAME, items: [], format: 'bru' }]
      }
    },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });
  store.dispatch(collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's' }));
  store.dispatch(collectionIndexBatchReceived({ collectionUid: COLLECTION_UID, loadSessionId: 's', nodes: EXISTING, totalScanned: EXISTING.length }));
  store.dispatch(collectionIndexReady({ collectionUid: COLLECTION_UID, loadSessionId: 's', totalNodes: EXISTING.length }));
  return store;
};

let written;
beforeEach(() => {
  written = null;
  window.ipcRenderer = {
    invoke: jest.fn(async (channel, payload) => {
      if (channel === 'renderer:new-folder') written = payload;
      return {};
    })
  };
});

it('places a new folder after every existing one, including those without a seq', async () => {
  const store = makeStore();
  const name = 'سامانه مودیان و پایانه های فروشگاهی نسخه بستر آزمون';

  await store.dispatch(newFolder(name, name, COLLECTION_UID, null));

  expect(written).not.toBeNull();
  const created = folder('new', name, written.folderData.meta.seq);
  const order = sortNodes([...EXISTING, created]).map((node) => node.uid);

  expect(order[order.length - 1]).toBe('new');
});
