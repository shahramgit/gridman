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

const fs = require('fs');
const os = require('os');
const path = require('path');
const registerCollectionsIpc = require('../../src/ipc/collection');

// Reported against vasl.5 and vasl.6: a folder added to a collection landed at
// the top. The disk decides the number now, whatever the renderer's index said.
let col;
const win = { webContents: { send: () => {} }, isDestroyed: () => false };
const seqOf = (dir) => Number((fs.readFileSync(path.join(dir, 'folder.bru'), 'utf8').match(/^\s*seq:\s*(\d+)/m) || [])[1]);

beforeAll(() => registerCollectionsIpc(win, { addWatcher() {}, removeWatcher() {}, hasWatcher: () => false, getWatcherByItemPath: () => null, watchers: {} }));
beforeEach(() => {
  col = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-new-folder-'));
  fs.writeFileSync(path.join(col, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  for (const [name, seq] of [['a', 1], ['b', 1], ['c', 137]]) {
    fs.mkdirSync(path.join(col, name));
    fs.writeFileSync(path.join(col, name, 'folder.bru'), `meta {\n  name: ${name}\n  seq: ${seq}\n}\n`);
  }
});
afterEach(() => fs.rmSync(col, { recursive: true, force: true }));

it('header New Folder: a low seq from an empty or re-indexing index is overridden', async () => {
  await mockHandlers.get('renderer:new-folder')({}, {
    pathname: path.join(col, 'new one'),
    folderData: { meta: { name: 'new one', seq: 1 }, request: { auth: { mode: 'inherit' } } },
    format: 'bru'
  });
  expect(seqOf(path.join(col, 'new one'))).toBe(138);
});

it('folder-row New Folder: lands after the largest seq, not at sibling-count + 1', async () => {
  const result = await mockHandlers.get('renderer:new-collection-folder-by-path')({}, {
    parentPathname: col, collectionPathname: col, folderName: 'nested new', directoryName: 'nested new'
  });
  expect(result.seq).toBe(138);
  expect(seqOf(path.join(col, 'nested new'))).toBe(138);
});
