// The filesystem util pulls in electron's dialog; the search index never
// touches it, so a stub is enough.
jest.mock('electron', () => ({ dialog: {} }));

// ONE fake worker module for the whole file, switched by mockFoldWorkerBehavior
// below. Re-mocking per suite does not work: jest caches the mocked module
// instance, so the second suite silently keeps running the first suite's fake.
let mockFoldWorkerBehavior = null;
jest.mock('node:worker_threads', () => {
  const EventEmitter = require('events');
  return {
    Worker: class FakeFoldWorker extends EventEmitter {
      constructor() {
        super();
        mockFoldWorkerBehavior?.onSpawn?.();
      }

      unref() {}

      terminate() {
        return Promise.resolve();
      }

      postMessage(message) {
        mockFoldWorkerBehavior?.onPostMessage?.(this, message);
      }
    }
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getCollectionSearchIndex,
  invalidateWorkspaceSearchForPath,
  evictWorkspaceSearchForPath,
  workspaceSearchIndex,
  workspaceSearchFileCache
} = require('../../src/ipc/workspace-search-index');
const { matchSearchFields, SEARCH_INDEX_MAX_FIELD_CHARS } = require('../../src/utils/workspace-search-match');
const { utils } = require('@usebruno/common');

const BRU_REQUEST = (name, url) => `meta {
  name: ${name}
  type: http
  seq: 1
}

get {
  url: ${url}
  body: none
  auth: none
}
`;

describe('workspace-search-index', () => {
  let workspacePath;
  let collectionPath;

  const writeRequest = (relative, name, url) => {
    const pathname = path.join(collectionPath, relative);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, BRU_REQUEST(name, url));
    return pathname;
  };

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-search-'));
    collectionPath = path.join(workspacePath, 'collections', 'api');
    fs.mkdirSync(collectionPath, { recursive: true });
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'api', type: 'collection' }));
    writeRequest('users/get-user.bru', 'Get User', 'https://api.example.com/users/1');
    writeRequest('users/list-users.bru', 'List Users', 'https://api.example.com/users');
    workspaceSearchIndex.clear();
    workspaceSearchFileCache.clear();
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('builds the index on first call and reuses it while fresh', async () => {
    const first = await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(first.entries.size).toBe(2);
    expect(first.builtAt).toBeGreaterThan(0);

    const second = await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(second).toBe(first); // fresh index returned as-is, no rebuild
  });

  it('serves stale entries immediately after invalidation and rebuilds in the background', async () => {
    const first = await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(first.entries.size).toBe(2);

    const added = writeRequest('users/new-request.bru', 'New Request', 'https://api.example.com/new');
    invalidateWorkspaceSearchForPath(added);

    // The very next call must NOT wait for the rebuild: it serves the stale
    // 2-entry index while the 3-entry rebuild runs in the background.
    const stale = await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(stale.entries.size).toBe(2);
    expect(stale.building).toBeTruthy();

    await stale.building;
    const rebuilt = await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(rebuilt.entries.size).toBe(3);
    expect(rebuilt.builtAt).toBeGreaterThan(0);
  });

  it('awaits the first build when no previous entries exist', async () => {
    const index = await getCollectionSearchIndex(workspacePath, collectionPath);
    // must be the built result, not a placeholder still building
    expect(index.building).toBeNull();
    expect(index.entries.size).toBe(2);
  });

  it('keeps the result stale when an invalidation races the build', async () => {
    await getCollectionSearchIndex(workspacePath, collectionPath);
    const added = writeRequest('users/racer.bru', 'Racer', 'https://api.example.com/racer');
    invalidateWorkspaceSearchForPath(added);

    // Trigger the rebuild (serves stale, builds in background).
    const stale = await getCollectionSearchIndex(workspacePath, collectionPath);
    // A second invalidation lands while the rebuild is in flight.
    invalidateWorkspaceSearchForPath(added);
    const rebuilt = await stale.building;

    // The build raced an invalidation -> its result must be marked stale so
    // the next search rebuilds again instead of trusting it for a full TTL.
    expect(rebuilt.builtAt).toBe(0);
  });

  it('re-reads a changed file on rebuild (mtime/size cache miss)', async () => {
    const first = await getCollectionSearchIndex(workspacePath, collectionPath);
    const target = path.join(collectionPath, 'users', 'get-user.bru');
    expect(first.entries.get(target).result.name).toBe('Get User');

    fs.writeFileSync(target, BRU_REQUEST('Renamed User', 'https://api.example.com/users/1'));
    // ensure a different mtime even on coarse filesystems
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(target, future, future);
    invalidateWorkspaceSearchForPath(target);

    const stale = await getCollectionSearchIndex(workspacePath, collectionPath);
    const rebuilt = await (stale.building || stale);
    expect(rebuilt.entries.get(target).result.name).toBe('Renamed User');
  });

  it('does not index environments or dotfiles', async () => {
    const envDir = path.join(collectionPath, 'environments');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, 'prod.bru'), 'vars {\n  secret: hunter2\n}\n');

    const index = await getCollectionSearchIndex(workspacePath, collectionPath);
    const indexedPaths = [...index.entries.keys()];
    expect(indexedPaths.some((p) => p.includes('environments'))).toBe(false);
  });

  it('invalidates when a parent directory (git root) is invalidated', async () => {
    const built = await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(built.builtAt).toBeGreaterThan(0);

    // A git pull invalidates by workspace root — a parent of the collection.
    invalidateWorkspaceSearchForPath(workspacePath);
    expect(workspaceSearchIndex.get(collectionPath).builtAt).toBe(0);
  });

  it('evicts the index and file cache for a removed collection', async () => {
    await getCollectionSearchIndex(workspacePath, collectionPath);
    expect(workspaceSearchIndex.has(collectionPath)).toBe(true);
    expect(workspaceSearchFileCache.size).toBeGreaterThan(0);

    evictWorkspaceSearchForPath(collectionPath);
    expect(workspaceSearchIndex.has(collectionPath)).toBe(false);
    expect([...workspaceSearchFileCache.keys()].some((p) => p.startsWith(collectionPath))).toBe(false);
  });

  it('prunes deleted files from the cache on rebuild', async () => {
    await getCollectionSearchIndex(workspacePath, collectionPath);
    const target = path.join(collectionPath, 'users', 'get-user.bru');
    expect(workspaceSearchFileCache.has(target)).toBe(true);

    fs.rmSync(target);
    invalidateWorkspaceSearchForPath(target);
    const stale = await getCollectionSearchIndex(workspacePath, collectionPath);
    const rebuilt = await (stale.building || stale);
    expect(rebuilt.entries.has(target)).toBe(false);
    expect(workspaceSearchFileCache.has(target)).toBe(false);
  });

  it('indexes an oversized request by name and url and marks it truncated', async () => {
    // The customer symptom: one ~5 MB folder in a collection. The body is
    // indexed up to the cap; the identity fields must still match in full.
    const pathname = path.join(collectionPath, 'huge.bru');
    fs.writeFileSync(pathname, `meta {
  name: Huge Response
  type: http
  seq: 1
}

get {
  url: https://api.example.com/huge
}

body:json {
  ${'x'.repeat(SEARCH_INDEX_MAX_FIELD_CHARS + 1024)} needleafterthecap
}
`);

    const index = await getCollectionSearchIndex(workspacePath, collectionPath);
    const entry = index.entries.get(pathname);
    expect(entry.result.name).toBe('Huge Response');
    expect(entry.result.url).toBe('https://api.example.com/huge');
    expect(entry.truncated).toBe(true);
    expect(entry.raw.body.length).toBe(SEARCH_INDEX_MAX_FIELD_CHARS);
    expect(entry.folded.body.length).toBeLessThanOrEqual(SEARCH_INDEX_MAX_FIELD_CHARS);

    const scopes = { collections: true, names: true, url: true, headers: true, body: true, examples: true };
    const query = (text) => ({
      scopes,
      matchCase: false,
      foldedQueryCi: utils.foldSearchText(text),
      foldedQueryCs: utils.foldSearchText(text, { caseSensitive: true })
    });
    expect(matchSearchFields(entry, query('Huge Response'))).toEqual({ field: 'name' });
    expect(matchSearchFields(entry, query('api.example.com/huge'))).toEqual({ field: 'url' });
    // past the cap, so the entry says it is truncated rather than pretending
    expect(matchSearchFields(entry, query('needleafterthecap'))).toBeNull();

    // the untouched requests are unaffected
    expect(index.entries.get(path.join(collectionPath, 'users', 'get-user.bru')).truncated).toBe(false);
  });

  it('recovers after a failed call instead of staying wedged', async () => {
    const missing = path.join(workspacePath, 'collections', 'gone');
    // Missing collection config -> getCollectionFormat throws before any
    // placeholder is stored; the failure must not wedge later calls.
    await expect(getCollectionSearchIndex(workspacePath, missing)).rejects.toThrow();

    fs.mkdirSync(missing, { recursive: true });
    fs.writeFileSync(path.join(missing, 'bruno.json'), JSON.stringify({ version: '1', name: 'gone', type: 'collection' }));
    const index = await getCollectionSearchIndex(workspacePath, missing);
    expect(index.entries.size).toBe(0);
    expect(index.building).toBeNull();
  });
});

// A fold worker that dies instead of replying. Its slot has to leave the
// round-robin and be respawned: while it stayed in, every later chunk was
// posted into a closed port, so the build promise never settled and the
// collection was stuck "building" for the rest of the session.
describe('workspace-search-index with dying fold workers', () => {
  const FILE_COUNT = 24;
  let workspacePath;
  let collectionPath;
  let spawned;
  let searchIndex;

  // Every file is bigger than the chunk byte bound, so a build dispatches many
  // chunks and far outlives the pool's initial workers.
  const writeBigCollection = (target, label) => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'bruno.json'), JSON.stringify({ version: '1', name: label, type: 'collection' }));
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(target, `big-${i}.bru`),
        `${BRU_REQUEST(`Big ${i}`, `https://api.example.com/big/${i}`)}\nbody:json {\n  ${'x'.repeat(300 * 1024)} needle${i}\n}\n`
      );
    }
  };

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-search-worker-'));
    collectionPath = path.join(workspacePath, 'collections', 'api');
    writeBigCollection(collectionPath, 'api');

    spawned = 0;
    // Dies instead of replying, every time.
    mockFoldWorkerBehavior = {
      onSpawn: () => {
        spawned += 1;
      },
      onPostMessage: (worker) => setImmediate(() => worker.emit('exit', 1))
    };
    process.env.GRIDMAN_SEARCH_FOLD_POOL = '1';
    // isolateModules, not resetModules: the module registers itself as the
    // global search invalidator on load, and a second copy in the shared
    // registry would leave that pointing at caches nothing else can see.
    jest.isolateModules(() => {
      searchIndex = require('../../src/ipc/workspace-search-index');
    });
  });

  afterEach(() => {
    delete process.env.GRIDMAN_SEARCH_FOLD_POOL;
    mockFoldWorkerBehavior = null;
    searchIndex = null;
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('settles the build and indexes everything when every fold worker dies', async () => {
    const index = await searchIndex.getCollectionSearchIndex(workspacePath, collectionPath);

    expect(index.building).toBeNull();
    expect(index.entries.size).toBe(FILE_COUNT);
    // every file was folded (inline, since no worker ever replied) and stayed
    // searchable by name AND by body content
    for (let i = 0; i < FILE_COUNT; i++) {
      const entry = index.entries.get(path.join(collectionPath, `big-${i}.bru`));
      expect(entry.result.name).toBe(`Big ${i}`);
      expect(entry.folded.body).toContain(`needle${i}`);
    }
  });

  it('stops respawning fold workers once they keep dying', async () => {
    await searchIndex.getCollectionSearchIndex(workspacePath, collectionPath);
    const afterFirstCollection = spawned;
    expect(afterFirstCollection).toBeGreaterThan(0);

    // Without a circuit breaker, worker death that is deterministic (a sandbox
    // that forbids threads, a corrupt worker script) spawns a fresh thread for
    // every chunk of every collection for the rest of the session — each dying
    // at once, on top of the inline fold that has to run anyway.
    const second = path.join(workspacePath, 'collections', 'api2');
    writeBigCollection(second, 'api2');
    const index = await searchIndex.getCollectionSearchIndex(workspacePath, second);

    expect(spawned).toBe(afterFirstCollection);
    expect(index.entries.size).toBe(FILE_COUNT); // still fully indexed, inline
  });
});

// The reader pool is 32 wide. Without a gate BEFORE the dispatch, every reader
// gets one chunk out before it waits, so a whole collection's text can sit in
// the workers' queues at once — on top of the copy each reader still holds.
describe('workspace-search-index fold chunk backpressure', () => {
  const FILE_COUNT = 24;
  let workspacePath;
  let collectionPath;
  let inFlightChunks;
  let peakInFlightChunks;
  let searchIndex;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-search-backpressure-'));
    collectionPath = path.join(workspacePath, 'collections', 'api');
    fs.mkdirSync(collectionPath, { recursive: true });
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'api', type: 'collection' }));
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(collectionPath, `big-${i}.bru`),
        `${BRU_REQUEST(`Big ${i}`, `https://api.example.com/big/${i}`)}\nbody:json {\n  ${'x'.repeat(300 * 1024)}\n}\n`
      );
    }

    inFlightChunks = 0;
    peakInFlightChunks = 0;
    // Replies, but takes its time, so chunks actually queue up.
    mockFoldWorkerBehavior = {
      onPostMessage: (worker, { id }) => {
        inFlightChunks += 1;
        peakInFlightChunks = Math.max(peakInFlightChunks, inFlightChunks);
        setTimeout(() => {
          inFlightChunks -= 1;
          worker.emit('message', { id, results: null }); // no fields -> folded inline
        }, 5);
      }
    };
    process.env.GRIDMAN_SEARCH_FOLD_POOL = '1';
    jest.isolateModules(() => {
      searchIndex = require('../../src/ipc/workspace-search-index');
    });
  });

  afterEach(() => {
    delete process.env.GRIDMAN_SEARCH_FOLD_POOL;
    mockFoldWorkerBehavior = null;
    searchIndex = null;
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('keeps queued fold chunks under the limit instead of the reader count', async () => {
    const index = await searchIndex.getCollectionSearchIndex(workspacePath, collectionPath);

    expect(index.entries.size).toBe(FILE_COUNT);
    expect(peakInFlightChunks).toBeGreaterThan(0);
    expect(peakInFlightChunks).toBeLessThanOrEqual(searchIndex.MAX_INFLIGHT_FOLD_CHUNKS);
  });
});
