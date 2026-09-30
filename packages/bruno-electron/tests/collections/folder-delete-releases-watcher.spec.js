// Deleting a folder moves it into the app Trash, and on Windows the collection
// watcher blocks that move: graceful-fs quietly retries it for up to 60s per
// attempt, so the delete sat there until the app exited (reported against
// 4.1.0-vasl.6; reproduced on the installed build, fixed by closing the watcher
// for the move). macOS allows the move either way, so this checks the wiring:
// the delete releases the collection's watcher and brings a new one back.
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
const watcher = require('../../src/app/collection-watcher');
const registerCollectionsIpc = require('../../src/ipc/collection');

jest.setTimeout(60000);
// The watcher re-attached after the delete must not keep jest alive.
afterAll(() => watcher.closeAllWatchers());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

it('closes the collection watcher for a folder delete and re-attaches a new one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-release-'));
  const col = path.join(root, '001 (g_taminir)سازمان تامین اجتماعی');
  const folder = path.join(col, 'استعلام جمع سابقه');
  fs.mkdirSync(path.join(folder, 'Api'), { recursive: true });
  fs.writeFileSync(path.join(col, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  fs.writeFileSync(path.join(folder, 'Api', 'login.bru'), 'meta {\n  name: login\n  type: http\n  seq: 1\n}\n');
  const win = { webContents: { send: () => {} }, isDestroyed: () => false };
  registerCollectionsIpc(win, watcher);

  watcher.addWatcher(win, col, 'col-1', { version: '1', name: 'c' }, false, false, { skipInitialLoad: true });
  for (let i = 0; i < 50 && !watcher.watchers[col]; i++) await sleep(100);
  const before = watcher.watchers[col];
  expect(before).toBeTruthy();
  const closed = jest.spyOn(before, 'close');

  await mockHandlers.get('renderer:delete-collection-item-by-path')({}, { sourcePathname: folder, collectionPathname: col, type: 'folder' });

  expect(closed).toHaveBeenCalled();
  expect(fs.existsSync(folder)).toBe(false);
  expect(watcher.watchers[col]).toBeTruthy();
  expect(watcher.watchers[col]).not.toBe(before);

  watcher.removeWatcher(col, win, 'col-1');
  fs.rmSync(root, { recursive: true, force: true });
});
