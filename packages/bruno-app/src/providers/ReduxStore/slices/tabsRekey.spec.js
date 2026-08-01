import tabsReducer, { addTab } from './tabs';
import { collectionIndexNodeMoved } from './collections';

const COLLECTION_UID = 'col-1';

const addIndexedTab = (state, pathname) => {
  return tabsReducer(
    state,
    addTab({
      uid: `indexed-request:${COLLECTION_UID}:${pathname}`,
      collectionUid: COLLECTION_UID,
      type: 'request',
      itemUid: `item-${pathname}`,
      itemPathname: pathname
    })
  );
};

describe('tabs re-key on collectionIndexNodeMoved', () => {
  it('re-keys the moved tab uid and itemPathname, following the active tab', () => {
    let state = tabsReducer(undefined, { type: '@@INIT' });
    state = addIndexedTab(state, '/ws/collections/api/users/get-user.bru');
    expect(state.activeTabUid).toBe(`indexed-request:${COLLECTION_UID}:/ws/collections/api/users/get-user.bru`);

    state = tabsReducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: '/ws/collections/api/users/get-user.bru',
        targetPathname: '/ws/collections/api/users/fetch-user.bru'
      })
    );

    const tab = state.tabs.find((t) => t.collectionUid === COLLECTION_UID);
    expect(tab.itemPathname).toBe('/ws/collections/api/users/fetch-user.bru');
    expect(tab.uid).toBe(`indexed-request:${COLLECTION_UID}:/ws/collections/api/users/fetch-user.bru`);
    expect(state.activeTabUid).toBe(tab.uid);
  });

  it('re-keys descendant tabs when a folder moves', () => {
    let state = tabsReducer(undefined, { type: '@@INIT' });
    state = addIndexedTab(state, '/ws/collections/api/users/get-user.bru');

    state = tabsReducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: '/ws/collections/api/users',
        targetPathname: '/ws/collections/api/customers'
      })
    );

    const tab = state.tabs.find((t) => t.collectionUid === COLLECTION_UID);
    expect(tab.itemPathname).toBe('/ws/collections/api/customers/get-user.bru');
    expect(tab.uid).toBe(`indexed-request:${COLLECTION_UID}:/ws/collections/api/customers/get-user.bru`);
  });

  it('leaves unrelated tabs and other collections untouched', () => {
    let state = tabsReducer(undefined, { type: '@@INIT' });
    state = addIndexedTab(state, '/ws/collections/api/orders/list.bru');
    const before = state.tabs[0];

    state = tabsReducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: 'other-collection',
        sourcePathname: '/ws/collections/api/orders/list.bru',
        targetPathname: '/ws/collections/api/orders/list-2.bru'
      })
    );

    expect(state.tabs[0].uid).toBe(before.uid);
    expect(state.tabs[0].itemPathname).toBe('/ws/collections/api/orders/list.bru');
  });
});

describe('tabs re-key across Unicode forms', () => {
  // Persian folder names reach the store in whichever form the filesystem
  // reported. Slicing the raw path at sourcePathname.length cut mid-name when
  // the two sides disagreed, so every tab under a moved folder got a corrupt
  // pathname and uid.
  const NFC_FOLDER = 'آرشیو'.normalize('NFC');
  const NFD_FOLDER = 'آرشیو'.normalize('NFD');

  it('re-keys a descendant tab whose path is in a different Unicode form', () => {
    let state = tabsReducer(undefined, { type: '@@INIT' });
    const tabPath = `/ws/collections/${NFD_FOLDER}/req.bru`;
    state = addIndexedTab(state, tabPath);

    state = tabsReducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: `/ws/collections/${NFC_FOLDER}`,
        targetPathname: `/ws/collections/api/${NFC_FOLDER}`
      })
    );

    const tab = state.tabs.find((t) => t.collectionUid === COLLECTION_UID);
    expect(tab.itemPathname).toBe(`/ws/collections/api/${NFC_FOLDER}/req.bru`);
    expect(tab.uid).toBe(`indexed-request:${COLLECTION_UID}:/ws/collections/api/${NFC_FOLDER}/req.bru`);
  });

  it('keeps nested descendants intact', () => {
    let state = tabsReducer(undefined, { type: '@@INIT' });
    state = addIndexedTab(state, `/ws/collections/${NFD_FOLDER}/Api/inner/req.bru`);

    state = tabsReducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: `/ws/collections/${NFC_FOLDER}`,
        targetPathname: `/ws/collections/moved`
      })
    );

    const tab = state.tabs.find((t) => t.collectionUid === COLLECTION_UID);
    expect(tab.itemPathname).toBe('/ws/collections/moved/Api/inner/req.bru');
  });
});
