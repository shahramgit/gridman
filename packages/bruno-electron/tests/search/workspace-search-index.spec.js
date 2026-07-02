// The filesystem util pulls in electron's dialog; the search index never
// touches it, so a stub is enough.
jest.mock('electron', () => ({ dialog: {} }));

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
