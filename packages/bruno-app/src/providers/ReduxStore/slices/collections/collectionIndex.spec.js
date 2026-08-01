// Some reducer paths (intermediate folder creation in applyCollectionAddFile)
// call uuid(); jest resolves the hoisted ESM nanoid without customAlphabet,
// so re-map it to the actual module (same pattern as openapi-spec.spec.js).
jest.mock('nanoid', () => ({
  ...jest.requireActual('nanoid')
}));

// moveCollectionItemByPath is the only thing pulled from actions here; stub the
// IPC bridge so the thunk can be driven without a main process.
jest.mock('utils/common/ipc', () => ({
  callIpc: jest.fn()
}));

import reducer, {
  createCollection,
  collectionAddDirectoryEvent,
  collectionAddFileEvent,
  collectionIndexStarted,
  collectionIndexBatchReceived,
  collectionIndexNodeMoved,
  collectionIndexNodeRemoved,
  collectionIndexNodeRenamed,
  collectionIndexNodeAdded,
  collectionIndexNodesResequenced
} from './index';
import { callIpc } from 'utils/common/ipc';
import { moveCollectionItemByPath } from './actions';

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

  it('re-paths a nested sub-folder subtree on a same-collection move', () => {
    // Reducer coverage only — this passes with or without the thunk change in
    // actions.js; it pins down the contract that change now depends on, namely
    // that a targeted move carries a multi-level subtree (paths, parent, depth)
    // and leaves no stale pathname key. The thunk-side regression is covered by
    // the 'moveCollectionItemByPath' describe below.
    const NESTED_NODES = [
      { uid: 'f1', name: 'users', type: 'folder', pathname: '/ws/collections/api/users', parentUid: null, depth: 0, seq: 1 },
      { uid: 'f3', name: 'archived', type: 'folder', pathname: '/ws/collections/api/users/archived', parentUid: 'f1', depth: 1, seq: 1 },
      { uid: 'r3', name: 'old-user', type: 'http', pathname: '/ws/collections/api/users/archived/old-user.bru', parentUid: 'f3', depth: 2, seq: 1 },
      { uid: 'f4', name: 'deep', type: 'folder', pathname: '/ws/collections/api/users/archived/deep', parentUid: 'f3', depth: 2, seq: 2 },
      { uid: 'r4', name: 'legacy', type: 'http', pathname: '/ws/collections/api/users/archived/deep/legacy.bru', parentUid: 'f4', depth: 3, seq: 1 },
      { uid: 'f2', name: 'orders', type: 'folder', pathname: '/ws/collections/api/orders', parentUid: null, depth: 0, seq: 2 },
      { uid: 'f5', name: '2024', type: 'folder', pathname: '/ws/collections/api/orders/2024', parentUid: 'f2', depth: 1, seq: 1 }
    ];
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
    state = reducer(
      state,
      collectionIndexBatchReceived({
        collectionUid: COLLECTION_UID,
        loadSessionId: 's1',
        nodes: NESTED_NODES,
        totalScanned: NESTED_NODES.length
      })
    );

    state = reducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: '/ws/collections/api/users/archived',
        targetPathname: '/ws/collections/api/orders/2024/archived'
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];

    // every descendant re-pathed under the new parent
    expect(index.nodesByUid.f3.pathname).toBe('/ws/collections/api/orders/2024/archived');
    expect(index.nodesByUid.r3.pathname).toBe('/ws/collections/api/orders/2024/archived/old-user.bru');
    expect(index.nodesByUid.f4.pathname).toBe('/ws/collections/api/orders/2024/archived/deep');
    expect(index.nodesByUid.r4.pathname).toBe('/ws/collections/api/orders/2024/archived/deep/legacy.bru');
    expect(index.uidByPathname['/ws/collections/api/orders/2024/archived/deep/legacy.bru']).toBe('r4');

    // no stale key anywhere under the old subtree path
    const staleKeys = Object.keys(index.uidByPathname)
      .filter((pathname) => pathname.startsWith('/ws/collections/api/users/archived'));
    expect(staleKeys).toEqual([]);
    expect(Object.keys(index.nodesByUid)).toHaveLength(NESTED_NODES.length);

    // re-parented, and the descendants follow the new depth
    expect(index.nodesByUid.f3.parentUid).toBe('f5');
    expect(index.childrenByParentUid.f5).toContain('f3');
    expect(index.childrenByParentUid.f1).not.toContain('f3');
    expect(index.nodesByUid.f3.depth).toBe(2);
    expect(index.nodesByUid.r3.depth).toBe(3);
    expect(index.nodesByUid.f4.depth).toBe(3);
    expect(index.nodesByUid.r4.depth).toBe(4);
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

  it('treats NFD (disk) and NFC (renderer) forms of the same pathname as one node', () => {
    // macOS reports NFD from disk; renderer-built paths are NFC. Mixed forms
    // used to leave duplicate sidebar rows after rename/drag (fixed by
    // NFC-normalizing every pathname key/compare).
    const nfdName = 'cafe\u0301'; // 'cafe' + combining acute (NFD)
    const nfcName = 'caf\u00e9'; // precomposed (NFC)
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
    state = reducer(
      state,
      collectionIndexBatchReceived({
        collectionUid: COLLECTION_UID,
        loadSessionId: 's1',
        nodes: [
          { uid: 'p1', name: nfdName, type: 'folder', pathname: `/ws/collections/api/${nfdName}`, parentUid: null, depth: 0 }
        ]
      })
    );

    // A remove issued with the NFC form must find the NFD-keyed node.
    state = reducer(
      state,
      collectionIndexNodeRemoved({ collectionUid: COLLECTION_UID, sourcePathname: `/ws/collections/api/${nfcName}` })
    );
    const index = state.collectionIndexes[COLLECTION_UID];
    expect(index.nodesByUid.p1).toBeUndefined();
    expect(Object.keys(index.uidByPathname)).toHaveLength(0);
  });

  it('a move issued in NFC re-keys an NFD-indexed node without duplicating it', () => {
    const nfd = 'u\u0308ber'; // 'u' + combining diaeresis (NFD)
    const nfc = '\u00fcber'; // precomposed (NFC)
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
    state = reducer(
      state,
      collectionIndexBatchReceived({
        collectionUid: COLLECTION_UID,
        loadSessionId: 's1',
        nodes: [
          { uid: 'q1', name: nfd, type: 'http', pathname: `/ws/collections/api/${nfd}.bru`, parentUid: null, depth: 0 }
        ]
      })
    );

    state = reducer(
      state,
      collectionIndexNodeMoved({
        collectionUid: COLLECTION_UID,
        sourcePathname: `/ws/collections/api/${nfc}.bru`,
        targetPathname: `/ws/collections/api/renamed-${nfc}.bru`
      })
    );
    const index = state.collectionIndexes[COLLECTION_UID];
    expect(Object.keys(index.nodesByUid)).toHaveLength(1);
    expect(index.nodesByUid.q1.pathname).toContain('renamed-');
    // one map key, addressable via either unicode form
    expect(Object.keys(index.uidByPathname)).toHaveLength(1);
  });

  it('re-parents a node the watcher upserted before its index batch arrived', () => {
    // Sidebar unification Phase 2: watcher file events can interleave with
    // (re)index batches. A request hydrated before its parent folder is
    // indexed lands provisionally at the root; the batch must move it under
    // its real parent without duplicating the row.
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, createCollection({
      uid: COLLECTION_UID,
      name: 'api',
      pathname: '/ws/collections/api',
      items: [],
      brunoConfig: { name: 'api' }
    }));
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));

    state = reducer(state, collectionAddFileEvent({
      file: {
        meta: { collectionUid: COLLECTION_UID, pathname: '/ws/collections/api/users/get-user.bru', name: 'get-user.bru' },
        data: {
          uid: 'r1',
          name: 'get-user',
          type: 'http-request',
          seq: 1,
          request: { method: 'GET', url: 'https://api.example.com/users/1' },
          settings: {},
          examples: []
        },
        partial: false,
        loading: false,
        size: 0.01
      }
    }));

    let index = state.collectionIndexes[COLLECTION_UID];
    expect(index.rootChildUids).toContain('r1');

    state = reducer(
      state,
      collectionIndexBatchReceived({ collectionUid: COLLECTION_UID, loadSessionId: 's1', nodes: NODES, totalScanned: NODES.length })
    );
    index = state.collectionIndexes[COLLECTION_UID];

    expect(index.nodesByUid.r1.parentUid).toBe('f1');
    expect(index.rootChildUids).not.toContain('r1');
    expect((index.childrenByParentUid.f1 || []).filter((uid) => uid === 'r1')).toHaveLength(1);
    expect(index.uidByPathname['/ws/collections/api/users/get-user.bru']).toBe('r1');
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

describe('eager hydration (small collections: index built + mounted tree)', () => {
  // Phase 2 flow for small collections: the index is built first, then the
  // watcher's classic initial scan replays fully parsed addDir/addFile events.
  // The reducers must hydrate the tree, upsert loadedRequestsByPath (the
  // request panel's render source), and keep the index consistent — same
  // uids, same parents, no duplicate child links.
  const COLLECTION_PATHNAME = '/ws/collections/api';

  const buildParsedFile = ({ pathname, filename, uid, name, seq }) => ({
    meta: { collectionUid: COLLECTION_UID, pathname, name: filename },
    data: {
      uid,
      name,
      type: 'http-request',
      seq,
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: [],
        params: [],
        body: { mode: 'none' },
        auth: { mode: 'none' },
        vars: { req: [], res: [] },
        assertions: [],
        script: { req: '', res: '' },
        tests: '',
        docs: ''
      },
      settings: {},
      examples: []
    },
    partial: false,
    loading: false,
    size: 0.01
  });

  const buildEagerHydratedState = () => {
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, createCollection({
      uid: COLLECTION_UID,
      name: 'api',
      pathname: COLLECTION_PATHNAME,
      items: [],
      brunoConfig: { name: 'api' }
    }));

    // 1. Index built (main process indexes every collection now).
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
    state = reducer(
      state,
      collectionIndexBatchReceived({ collectionUid: COLLECTION_UID, loadSessionId: 's1', nodes: NODES, totalScanned: NODES.length })
    );

    // 2. Eager hydration: the watcher's initial scan replays the classic
    // mount flow. The shared main-process uid cache keeps dir/file uids
    // identical to the index node uids.
    state = reducer(state, collectionAddDirectoryEvent({
      dir: { meta: { collectionUid: COLLECTION_UID, pathname: '/ws/collections/api/users', name: 'users', seq: 1, uid: 'f1' } }
    }));
    state = reducer(state, collectionAddDirectoryEvent({
      dir: { meta: { collectionUid: COLLECTION_UID, pathname: '/ws/collections/api/orders', name: 'orders', seq: 2, uid: 'f2' } }
    }));
    state = reducer(state, collectionAddFileEvent({
      file: buildParsedFile({
        pathname: '/ws/collections/api/users/get-user.bru',
        filename: 'get-user.bru',
        uid: 'r1',
        name: 'get-user',
        seq: 1
      })
    }));
    state = reducer(state, collectionAddFileEvent({
      file: buildParsedFile({
        pathname: '/ws/collections/api/users/list-users.bru',
        filename: 'list-users.bru',
        uid: 'r2',
        name: 'list-users',
        seq: 2
      })
    }));
    return state;
  };

  it('hydrates the collection tree with the index node uids', () => {
    const state = buildEagerHydratedState();
    const collection = state.collections.find((c) => c.uid === COLLECTION_UID);

    const usersFolder = collection.items.find((item) => item.pathname === '/ws/collections/api/users');
    expect(usersFolder).toBeDefined();
    expect(usersFolder.uid).toBe('f1');
    expect(usersFolder.type).toBe('folder');

    const getUser = usersFolder.items.find((item) => item.pathname === '/ws/collections/api/users/get-user.bru');
    expect(getUser).toBeDefined();
    expect(getUser.uid).toBe('r1');
    expect(getUser.partial).toBe(false);
    expect(getUser.loading).toBe(false);
    expect(getUser.request.method).toBe('GET');
  });

  it('upserts loadedRequestsByPath for every eagerly hydrated request', () => {
    const state = buildEagerHydratedState();
    const loaded = state.loadedRequestsByPath[COLLECTION_UID];

    expect(loaded).toBeDefined();
    const getUser = loaded['/ws/collections/api/users/get-user.bru'];
    const listUsers = loaded['/ws/collections/api/users/list-users.bru'];
    expect(getUser?.uid).toBe('r1');
    expect(getUser?.request?.method).toBe('GET');
    expect(listUsers?.uid).toBe('r2');
  });

  it('keeps the index consistent after hydration (no re-keying, no duplicate child links)', () => {
    const state = buildEagerHydratedState();
    const index = state.collectionIndexes[COLLECTION_UID];

    // Same uids, same parents as the original index batch.
    expect(index.nodesByUid.r1.parentUid).toBe('f1');
    expect(index.nodesByUid.r2.parentUid).toBe('f1');
    expect(index.uidByPathname['/ws/collections/api/users/get-user.bru']).toBe('r1');
    expect(index.uidByPathname['/ws/collections/api/users']).toBe('f1');

    // Hydration refreshed node metadata from the full parse.
    expect(index.nodesByUid.r1.method).toBe('GET');

    // No duplicate child links from the hydration upserts.
    expect((index.childrenByParentUid.f1 || []).filter((uid) => uid === 'r1')).toHaveLength(1);
    expect(index.rootChildUids.filter((uid) => uid === 'f1')).toHaveLength(1);
    expect(index.rootChildUids).not.toContain('r1');
    expect(index.rootChildUids).not.toContain('r2');
  });

  it('does not upsert loadedRequestsByPath for partial (lazy) files', () => {
    let state = buildEagerHydratedState();
    const partialFile = buildParsedFile({
      pathname: '/ws/collections/api/orders/create-order.bru',
      filename: 'create-order.bru',
      uid: 'r3',
      name: 'create-order',
      seq: 1
    });
    partialFile.partial = true;
    state = reducer(state, collectionAddFileEvent({ file: partialFile }));

    expect(state.loadedRequestsByPath[COLLECTION_UID]['/ws/collections/api/orders/create-order.bru']).toBeUndefined();
  });
});

describe('folder is not emptied when a hydration event re-indexes it under a new uid', () => {
  // Real-world repro (Cesar App / "سرویس بیمه"): the indexer links a folder and
  // its children correctly, then eager hydration upserts the same folder from
  // the renderer tree whose item uid differs from the indexer's uid. The old
  // uid-mismatch branch deleted the indexer folder node and STRANDED
  // childrenByParentUid[oldUid], so the folder rendered empty even though its
  // children were on disk. Cloning worked because the clone's fresh path had a
  // single, consistent identity.
  it('migrates the folder children to the new uid instead of stranding them', () => {
    let state = reducer(undefined, { type: '@@INIT' });
    // The renderer tree already holds the folder under a DIFFERENT uid than the
    // indexer will assign (the divergence that triggers the bug).
    state = reducer(state, createCollection({
      uid: COLLECTION_UID,
      name: 'api',
      pathname: '/ws/collections/api',
      items: [
        { uid: 'tree-users', name: 'users', type: 'folder', pathname: '/ws/collections/api/users', seq: 1, items: [] }
      ],
      brunoConfig: { name: 'api' }
    }));
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
    // Indexer builds the folder + its two children, correctly linked.
    state = reducer(state, collectionIndexBatchReceived({
      collectionUid: COLLECTION_UID,
      loadSessionId: 's1',
      nodes: NODES,
      totalScanned: NODES.length
    }));
    expect(state.collectionIndexes[COLLECTION_UID].childrenByParentUid.f1).toEqual(['r1', 'r2']);

    // Eager hydration: a watcher directory event re-indexes the folder from the
    // renderer tree item, whose uid ('tree-users') differs from the indexer's ('f1').
    state = reducer(state, collectionAddDirectoryEvent({
      dir: { meta: { collectionUid: COLLECTION_UID, pathname: '/ws/collections/api/users', name: 'users' } }
    }));

    const index = state.collectionIndexes[COLLECTION_UID];
    // Exactly one folder node survives at that pathname...
    const folderUid = index.uidByPathname['/ws/collections/api/users'];
    expect(folderUid).toBeTruthy();
    // ...and it still owns both children (the folder is NOT empty).
    expect((index.childrenByParentUid[folderUid] || []).slice().sort()).toEqual(['r1', 'r2']);
    expect(index.nodesByUid.r1.parentUid).toBe(folderUid);
    expect(index.nodesByUid.r2.parentUid).toBe(folderUid);
    // No stranded child list under a now-deleted uid.
    for (const [parentUid, children] of Object.entries(index.childrenByParentUid)) {
      if (parentUid !== 'root' && !index.nodesByUid[parentUid]) {
        expect(children).toHaveLength(0);
      }
    }
  });

  it('survives the real eager-hydration ordering (child addFile before its folder)', () => {
    // Production trigger on restart: the indexer links the folder + children,
    // then eager hydration delivers a child's addFile BEFORE the folder event,
    // so applyCollectionAddFile invents the intermediate folder with a random
    // uuid (!= the indexer's uid). The folder event then upserts under that
    // uuid — the exact divergence that used to empty the folder.
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, createCollection({
      uid: COLLECTION_UID,
      name: 'api',
      pathname: '/ws/collections/api',
      items: [],
      brunoConfig: { name: 'api' }
    }));
    state = reducer(state, collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
    state = reducer(state, collectionIndexBatchReceived({
      collectionUid: COLLECTION_UID,
      loadSessionId: 's1',
      nodes: NODES,
      totalScanned: NODES.length
    }));

    // Child request hydrates first — creates the tree folder under a fresh uuid.
    state = reducer(state, collectionAddFileEvent({
      file: {
        meta: { collectionUid: COLLECTION_UID, pathname: '/ws/collections/api/users/get-user.bru', name: 'get-user.bru' },
        data: { uid: 'r1', name: 'get-user', type: 'http-request', seq: 1, request: { method: 'GET', url: 'x' }, settings: {}, examples: [] },
        partial: false,
        loading: false,
        size: 0.01
      }
    }));
    // Then the folder's own directory event upserts it under the tree's uuid.
    state = reducer(state, collectionAddDirectoryEvent({
      dir: { meta: { collectionUid: COLLECTION_UID, pathname: '/ws/collections/api/users', name: 'users' } }
    }));

    const index = state.collectionIndexes[COLLECTION_UID];
    const folderUid = index.uidByPathname['/ws/collections/api/users'];
    expect((index.childrenByParentUid[folderUid] || []).slice().sort()).toEqual(['r1', 'r2']);
    expect(index.nodesByUid.r1.parentUid).toBe(folderUid);
    expect(index.nodesByUid.r2.parentUid).toBe(folderUid);
  });
});

describe('moveCollectionItemByPath (index refresh strategy)', () => {
  const runMove = async ({ moveResult, dropType = 'inside' }) => {
    callIpc.mockResolvedValue(moveResult);
    const dispatched = [];
    // A thunk dispatched here is the full re-index fallback; record it as a
    // function instead of running it (it would fire more IPC).
    const dispatch = jest.fn((action) => {
      dispatched.push(action);
      return typeof action === 'function' ? Promise.resolve() : action;
    });
    const getState = () => ({
      collections: {
        collections: [{ uid: COLLECTION_UID, pathname: '/ws/collections/api', items: [] }],
        collectionIndexes: { [COLLECTION_UID]: { status: 'ready', nodesByUid: {}, uidByPathname: {} } }
      }
    });

    await moveCollectionItemByPath({
      sourceCollectionUid: COLLECTION_UID,
      targetCollectionUid: COLLECTION_UID,
      sourcePathname: '/ws/collections/api/users/archived',
      targetPathname: '/ws/collections/api/orders',
      dropType
    })(dispatch, getState);

    return dispatched;
  };

  it('patches the index in place when a FOLDER is moved within a collection', async () => {
    // Regression: folders used to be excluded from the targeted update and fall
    // back to refreshCollectionIndex, which blanks the collection until the
    // queued single-slot rebuild reaches it — on a large workspace the moved
    // sub-folder only reappeared after an app restart.
    const dispatched = await runMove({
      moveResult: { pathname: '/ws/collections/api/orders/archived', type: 'folder' }
    });

    const moved = dispatched.find((action) => action?.type === collectionIndexNodeMoved.type);
    expect(moved).toBeDefined();
    expect(moved.payload).toMatchObject({
      collectionUid: COLLECTION_UID,
      sourcePathname: '/ws/collections/api/users/archived',
      targetPathname: '/ws/collections/api/orders/archived'
    });
    // no full re-index fallback (the only thunk this path would dispatch)
    expect(dispatched.filter((action) => typeof action === 'function')).toHaveLength(0);
  });

  it('still patches the index in place when a REQUEST is moved within a collection', async () => {
    const dispatched = await runMove({
      moveResult: { pathname: '/ws/collections/api/orders/old-user.bru', type: 'http' }
    });

    expect(dispatched.find((action) => action?.type === collectionIndexNodeMoved.type)).toBeDefined();
    expect(dispatched.filter((action) => typeof action === 'function')).toHaveLength(0);
  });

  it('leaves the index alone for a same-folder reorder (skipped move)', async () => {
    const dispatched = await runMove({
      moveResult: { pathname: '/ws/collections/api/users/archived', type: 'folder', skipped: true }
    });

    expect(dispatched.find((action) => action?.type === collectionIndexNodeMoved.type)).toBeUndefined();
    expect(dispatched.filter((action) => typeof action === 'function')).toHaveLength(0);
  });
});
