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
