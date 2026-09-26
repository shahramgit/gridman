// Field report against 4.1.0-vasl.5: "delete a request in a folder and nothing
// happens; after restarting the app it is gone". The delete itself worked. On a
// large workspace the watcher's initial scan parses every file at background
// priority, so a request can be READ, then deleted, then have its add emitted:
// the unlink (no parse) reached the renderer first, removed the row, and the
// late add put it back. These drive the real watcher and the real delete IPC,
// holding one file's parse open the way the worker queue does.
const mockHandlers = new Map();
jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getName: () => 'gridman', getVersion: () => '0.0.0', on: jest.fn(), whenReady: () => Promise.resolve() },
  dialog: {},
  BrowserWindow: class {},
  ipcMain: { handle: jest.fn((c, h) => mockHandlers.set(c, h)), on: jest.fn(), emit: jest.fn(), removeHandler: jest.fn() },
  shell: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false }
}));
jest.mock('electron-store', () => class MemoryStore {
  get(_key, defaultValue) {
    return defaultValue;
  }

  set() {}
  delete() {}
});

const mockHeld = { release: null, file: 'inner.bru' };
jest.mock('@usebruno/filestore', () => {
  const actual = jest.requireActual('@usebruno/filestore');
  return {
    ...actual,
    parseRequestViaWorker: async (content, options) => {
      if (options?.filename && options.filename.endsWith(mockHeld.file)) {
        await new Promise((resolve) => {
          mockHeld.release = resolve;
        });
      }
      return actual.parseRequest(content, { format: options?.format });
    }
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const CollectionWatcher = require('../../src/app/collection-watcher');
const registerCollectionsIpc = require('../../src/ipc/collection');

jest.setTimeout(60000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, ms = 10000) => {
  for (let waited = 0; waited < ms && !predicate(); waited += 50) await sleep(50);
  return predicate();
};
const REQUEST = (name) => `meta {\n  name: ${name}\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://x.invalid\n  body: none\n  auth: none\n}\n`;

let root;
let collection;
let target;
let sent;
let win;
let watcher;

beforeAll(() => {
  sent = [];
  win = { webContents: { send: (channel, type, payload) => sent.push([channel, type, payload?.meta?.pathname]) }, isDestroyed: () => false };
  watcher = typeof CollectionWatcher === 'function' ? new CollectionWatcher() : CollectionWatcher;
  registerCollectionsIpc(win, watcher);
});

beforeEach(async () => {
  mockHeld.release = null;
  sent.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-scan-delete-'));
  // One of the reporter's real collection names.
  collection = path.join(root, '001 (g_taminir)سازمان تامین اجتماعی');
  fs.mkdirSync(path.join(collection, 'Api'), { recursive: true });
  fs.writeFileSync(path.join(collection, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  fs.writeFileSync(path.join(collection, 'Api', 'inner.bru'), REQUEST('inner'));
  fs.writeFileSync(path.join(collection, 'Api', 'sibling.bru'), REQUEST('sibling'));
  target = path.join(collection, 'Api', 'inner.bru');

  // An eager collection: initial scan on, parses on the worker lane.
  watcher.addWatcher(win, collection, 'col-1', { version: '1', name: 'c' }, false, true);
  expect(await until(() => mockHeld.release)).toBeTruthy(); // read, and now mid-parse
});

afterEach(() => {
  mockHeld.release?.();
  watcher.removeWatcher(collection, win, 'col-1');
  fs.rmSync(root, { recursive: true, force: true });
});

const treeEventsFor = (pathname) =>
  sent.filter(([channel, , p]) => channel === 'main:collection-tree-updated' && p === pathname).map(([, type]) => type);

const deleteByPath = (sourcePathname, type) =>
  mockHandlers.get('renderer:delete-collection-item-by-path')({}, { sourcePathname, collectionPathname: collection, type });

it('does not bring back a request deleted while its add was being parsed', async () => {
  await deleteByPath(target, 'http-request');
  expect(await until(() => treeEventsFor(target).includes('unlink'))).toBe(true);

  mockHeld.release();
  await sleep(1000);

  expect(fs.existsSync(target)).toBe(false);
  expect(treeEventsFor(target)).toEqual(['unlink']);
});

it('does not bring back a request whose FOLDER was deleted while it was being parsed', async () => {
  const folder = path.dirname(target);
  await deleteByPath(folder, 'folder');
  expect(await until(() => sent.some(([, type, p]) => type === 'unlinkDir' && p === folder))).toBe(true);

  mockHeld.release();
  await sleep(1000);

  expect(treeEventsFor(target)).not.toContain('addFile');
});

it('still announces a path that was removed and then re-created (a Trash restore)', async () => {
  const content = fs.readFileSync(target, 'utf8');
  await deleteByPath(target, 'http-request');
  expect(await until(() => treeEventsFor(target).includes('unlink'))).toBe(true);

  fs.writeFileSync(target, content);
  mockHeld.release();
  await sleep(1500);

  const events = treeEventsFor(target);
  expect(events[events.length - 1]).toBe('addFile');
});
