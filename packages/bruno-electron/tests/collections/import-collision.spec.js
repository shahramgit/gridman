// A duplicate import used to silently invent a free name ("My API - 1"), so an
// import meant to update a collection quietly produced a second copy instead.
// Reported from the field against 4.1.0-vasl.4.
const mockHandlers = new Map();
const mockDialog = { showOpenDialog: jest.fn(), showMessageBox: jest.fn() };

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getName: () => 'gridman', getVersion: () => '0.0.0', on: jest.fn(), whenReady: () => Promise.resolve() },
  dialog: mockDialog,
  BrowserWindow: class {},
  ipcMain: {
    handle: jest.fn((channel, handler) => mockHandlers.set(channel, handler)),
    on: jest.fn(),
    emit: jest.fn(),
    removeHandler: jest.fn()
  },
  shell: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false }
}));

jest.mock('electron-store', () => class MemoryStore {
  constructor() { this.data = {}; }
  get(key, d) {
    const v = key.split('.').reduce((a, p) => a?.[p], this.data); return v === undefined ? d : v;
  }

  set() {}
  delete() {}
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const registerCollectionsIpc = require('../../src/ipc/collection');

const win = { webContents: { send: () => {} }, isDestroyed: () => false };
const watched = new Set();
const watcher = {
  addWatcher: (_w, p) => watched.add(p),
  removeWatcher: (p) => watched.delete(p),
  hasWatcher: (p) => watched.has(p),
  getWatcherByItemPath: () => null
};

// One of the reporter's real collection names.
const NAME = '001 (g_taminir)سازمان تامین اجتماعی';

const BUTTONS = { COPY: 0, REPLACE: 1, CANCEL: 2 };

const trashRoot = path.join(os.tmpdir(), 'trash');
const trashedCollections = () => {
  if (!fs.existsSync(trashRoot)) return [];
  return fs
    .readdirSync(trashRoot)
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(trashRoot, id, 'meta.json'), 'utf8'));
      } catch (error) {
        return null;
      }
    })
    .filter((entry) => entry && entry.type === 'collection');
};

let workspace;
let outside;

const makeCollection = (dir, name, marker) => {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'opencollection.yml'), `opencollection: 1.0.0\ninfo:\n  name: "${name}"\n  type: collection\n`);
  fs.writeFileSync(path.join(p, 'marker.txt'), marker);
  return p;
};

const collectionsIn = (ws) => {
  const dir = path.join(ws, 'collections');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

const workspaceEntries = (ws) => {
  const config = yaml.load(fs.readFileSync(path.join(ws, 'workspace.yml'), 'utf8')) || {};
  return (config.collections || []).map((c) => c.name).sort();
};

beforeAll(() => registerCollectionsIpc(win, watcher));

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-out-'));
  fs.mkdirSync(path.join(workspace, 'collections'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'workspace.yml'),
    'opencollection: 1.0.0\ninfo:\n  name: "nixx"\n  type: workspace\ncollections: []\n'
  );
  watched.clear();
  fs.rmSync(trashRoot, { recursive: true, force: true });
  mockDialog.showOpenDialog.mockReset();
  mockDialog.showMessageBox.mockReset();
});

afterEach(() => {
  for (const dir of [workspace, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

const importFolder = (sourcePath) => {
  mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] });
  return mockHandlers.get('renderer:open-collection')({}, { workspaceId: workspace });
};

describe('importing a collection whose name is already taken', () => {
  beforeEach(() => {
    makeCollection(path.join(workspace, 'collections'), NAME, 'existing');
  });

  it('asks instead of renaming behind the user', async () => {
    mockDialog.showMessageBox.mockResolvedValue({ response: BUTTONS.COPY });
    await importFolder(makeCollection(outside, NAME, 'incoming'));

    expect(mockDialog.showMessageBox).toHaveBeenCalledTimes(1);
    const [, opts] = mockDialog.showMessageBox.mock.calls[0];
    expect(opts.buttons).toEqual(['Import as copy', 'Replace', 'Cancel']);
    expect(opts.message).toContain(NAME);
  });

  it('"Import as copy" keeps both', async () => {
    mockDialog.showMessageBox.mockResolvedValue({ response: BUTTONS.COPY });
    await importFolder(makeCollection(outside, NAME, 'incoming'));

    expect(collectionsIn(workspace)).toEqual([NAME, `${NAME} - 1`]);
    expect(fs.readFileSync(path.join(workspace, 'collections', NAME, 'marker.txt'), 'utf8')).toBe('existing');
    expect(fs.readFileSync(path.join(workspace, 'collections', `${NAME} - 1`, 'marker.txt'), 'utf8')).toBe('incoming');
  });

  it('"Replace" puts the new one at the original path and keeps a single entry', async () => {
    mockDialog.showMessageBox.mockResolvedValue({ response: BUTTONS.REPLACE });
    await importFolder(makeCollection(outside, NAME, 'incoming'));

    expect(collectionsIn(workspace)).toEqual([NAME]);
    expect(fs.readFileSync(path.join(workspace, 'collections', NAME, 'marker.txt'), 'utf8')).toBe('incoming');
    expect(workspaceEntries(workspace)).toEqual([NAME]);

    // Replacing must be undoable: the collection it displaced goes to the app
    // Trash panel, not to /dev/null.
    const trashed = trashedCollections().filter((entry) => entry.displayName === NAME);
    expect(trashed).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(trashRoot, trashed[0].id, 'payload', NAME, 'marker.txt'), 'utf8')
    ).toBe('existing');
  });

  it('"Cancel" imports nothing and leaves the existing collection alone', async () => {
    mockDialog.showMessageBox.mockResolvedValue({ response: BUTTONS.CANCEL });
    const result = await importFolder(makeCollection(outside, NAME, 'incoming'));

    expect(result).toEqual([]);
    expect(collectionsIn(workspace)).toEqual([NAME]);
    expect(fs.readFileSync(path.join(workspace, 'collections', NAME, 'marker.txt'), 'utf8')).toBe('existing');
  });

  it('closing the dialog without choosing is treated as cancel', async () => {
    mockDialog.showMessageBox.mockResolvedValue({ response: -1 });
    await importFolder(makeCollection(outside, NAME, 'incoming'));

    expect(collectionsIn(workspace)).toEqual([NAME]);
  });
});

describe('importing a collection whose name is free', () => {
  it('does not ask anything', async () => {
    await importFolder(makeCollection(outside, NAME, 'incoming'));

    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
    expect(collectionsIn(workspace)).toEqual([NAME]);
  });

  it('does not ask for a collection that already lives in the workspace', async () => {
    const inside = makeCollection(path.join(workspace, 'collections'), NAME, 'existing');
    await importFolder(inside);

    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
    expect(collectionsIn(workspace)).toEqual([NAME]);
  });
});

describe('importing from a file asks the same question', () => {
  const importFromFile = (name) =>
    mockHandlers.get('renderer:import-collection')(
      {},
      { uid: 'c1', name, items: [], environments: [], root: {}, brunoConfig: { version: '1', name, type: 'collection' } },
      null,
      { workspaceId: workspace }
    );

  it('asks, and "Import as copy" names the new collection after its folder', async () => {
    makeCollection(path.join(workspace, 'collections'), 'My API', 'existing');
    mockDialog.showMessageBox.mockResolvedValue({ response: BUTTONS.COPY });

    await importFromFile('My API');

    expect(mockDialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(collectionsIn(workspace)).toEqual(['My API', 'My API - 1']);
  });

  it('imports without asking when the name is free', async () => {
    await importFromFile('My API');

    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
    expect(collectionsIn(workspace)).toEqual(['My API']);
  });
});
