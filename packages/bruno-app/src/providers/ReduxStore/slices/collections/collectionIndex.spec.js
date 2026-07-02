import reducer, {
  collectionIndexStarted,
  collectionIndexBatchReceived,
  collectionIndexNodeMoved,
  collectionIndexNodeRemoved,
  collectionIndexNodeRenamed,
  collectionIndexNodeAdded,
  collectionIndexNodesResequenced
} from './index';

const COLLECTION_UID = 'col-1';

const NODES = [
  { uid: 'f1', name: 'users', type: 'folder', pathname: '/ws/collections/api/users', parentUid: null, depth: 0, seq: 1 },
  { uid: 'r1', name: 'get-user', type: 'http', pathname: '/ws/collections/api/users/get-user.bru', parentUid: 'f1', depth: 1, seq: 1 },
  { uid: 'r2', name: 'list-users', type: 'http', pathname: '/ws/collections/api/users/list-users.bru', parentUid: 'f1', depth: 1, seq: 2 },
  { uid: 'f2', name: 'orders', type: 'folder', pathname: '/ws/collections/api/orders', parentUid: null, depth: 0, seq: 2 }
];

const buildIndexedState = () => {
  let state = reducer(undefined, { type: '@@INIT' });
  state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
  state = reducer(
    state,
    collectionIndexBatchReceived({ collectionUid: COLLECTION_UID, loadSessionId: 's1', nodes: NODES, totalScanned: NODES.length })
  );
  return state;
};

describe('collection index reducers (uidByPathname invariants)', () => {
  it('maintains uidByPathname for every indexed node', () => {
    const state = buildIndexedState();
    const index = state.collectionIndexes[COLLECTION_UID];

    expect(Object.keys(index.nodesByUid)).toHaveLength(4);
    for (const node of NODES) {
      expect(index.uidByPathname[node.pathname]).toBe(node.uid);
    }
  });

  it('re-keys the moved node and its descendants on move', () => {
    let state = buildIndexedState();
    state = reducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: '/ws/collections/api/users',
        targetPathname: '/ws/collections/api/orders/users'
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];

    // old keys gone
    expect(index.uidByPathname['/ws/collections/api/users']).toBeUndefined();
    expect(index.uidByPathname['/ws/collections/api/users/get-user.bru']).toBeUndefined();
    // new keys present, nodes updated
    expect(index.uidByPathname['/ws/collections/api/orders/users']).toBe('f1');
    expect(index.uidByPathname['/ws/collections/api/orders/users/get-user.bru']).toBe('r1');
    expect(index.nodesByUid.r1.pathname).toBe('/ws/collections/api/orders/users/get-user.bru');
    // parent re-wired
    expect(index.nodesByUid.f1.parentUid).toBe('f2');
    expect(index.childrenByParentUid.f2).toContain('f1');
    expect(index.rootChildUids).not.toContain('f1');
  });

  it('removes a subtree and its map keys on remove', () => {
    let state = buildIndexedState();
    state = reducer(
      state,
      collectionIndexNodeRemoved({ collectionUid: COLLECTION_UID, sourcePathname: '/ws/collections/api/users' })
    );
    const index = state.collectionIndexes[COLLECTION_UID];

    expect(index.nodesByUid.f1).toBeUndefined();
    expect(index.nodesByUid.r1).toBeUndefined();
    expect(index.nodesByUid.r2).toBeUndefined();
    expect(index.nodesByUid.f2).toBeDefined();
    expect(index.uidByPathname['/ws/collections/api/users']).toBeUndefined();
    expect(index.uidByPathname['/ws/collections/api/users/get-user.bru']).toBeUndefined();
    expect(index.uidByPathname['/ws/collections/api/orders']).toBe('f2');
    expect(index.totalNodes).toBe(1);
  });

  it('updates node seq in place on resequence', () => {
    let state = buildIndexedState();
    state = reducer(
      state,
      collectionIndexNodesResequenced({
        collectionUid: COLLECTION_UID,
        itemsToResequence: [
          { pathname: '/ws/collections/api/users/get-user.bru', seq: 5 },
          { pathname: '/ws/collections/api/users/list-users.bru', seq: 6 }
        ]
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];

    expect(index.nodesByUid.r1.seq).toBe(5);
    expect(index.nodesByUid.r2.seq).toBe(6);
    // map unchanged by resequence
    expect(index.uidByPathname['/ws/collections/api/users/get-user.bru']).toBe('r1');
  });

  it('renames a node in place without touching the map', () => {
    let state = buildIndexedState();
    state = reducer(
      state,
      collectionIndexNodeRenamed({
        collectionUid: COLLECTION_UID,
        pathname: '/ws/collections/api/users/get-user.bru',
        name: 'Get User v2'
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];
    expect(index.nodesByUid.r1.name).toBe('Get User v2');
    expect(index.uidByPathname['/ws/collections/api/users/get-user.bru']).toBe('r1');
  });

  it('adds a single node under its parent', () => {
    let state = buildIndexedState();
    state = reducer(
      state,
      collectionIndexNodeAdded({
        collectionUid: COLLECTION_UID,
        pathname: '/ws/collections/api/users/archived',
        name: 'archived',
        type: 'folder',
        uid: 'new-folder-uid'
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];
    const uid = index.uidByPathname['/ws/collections/api/users/archived'];
    expect(uid).toBe('new-folder-uid');
    expect(index.nodesByUid[uid].parentUid).toBe('f1');
    expect(index.nodesByUid[uid].depth).toBe(1);
    expect(index.childrenByParentUid.f1).toContain(uid);
    expect(index.totalNodes).toBe(5);

    // idempotent when the watcher already reported it
    const before = index.totalNodes;
    state = reducer(
      state,
      collectionIndexNodeAdded({
        collectionUid: COLLECTION_UID,
        pathname: '/ws/collections/api/users/archived',
        name: 'archived',
        type: 'folder',
        uid: 'another-uid'
      })
    );
    expect(state.collectionIndexes[COLLECTION_UID].totalNodes).toBe(before);
  });

  it('ignores batches from a stale load session', () => {
    let state = buildIndexedState();
    state = reducer(
      state,
      collectionIndexBatchReceived({
        collectionUid: COLLECTION_UID,
        loadSessionId: 'other-session',
        nodes: [{ uid: 'x1', name: 'stale', type: 'http', pathname: '/ws/collections/api/stale.bru', parentUid: null, depth: 0 }]
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];
    expect(index.nodesByUid.x1).toBeUndefined();
    expect(index.uidByPathname['/ws/collections/api/stale.bru']).toBeUndefined();
  });
});
