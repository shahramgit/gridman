const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A WORKSPACE WHOSE CONFIG CANNOT BE READ MUST NOT VANISH IN SILENCE.
 *
 * Reported after the branch-switch fix: the workspace survives a restart now,
 * "but if we add a folder to it, it disappears after restart".
 *
 * The startup scan reads every remembered workspace and skips any whose
 * workspace.yml fails to parse or validate — logging to the console and
 * telling the renderer nothing. Adding a collection rewrites workspace.yml, and
 * a merge or a branch switch across that write leaves conflict markers in a
 * git-TRACKED file. From the app it looks identical to the workspace being
 * gone.
 *
 * The entry is kept (that was the earlier fix). What was missing is any way for
 * the user to learn why it did not open.
 */

const mockStore = new Map();
jest.mock('electron-store', () => class FakeStore {
  get(key, fallback) { return mockStore.has(key) ? mockStore.get(key) : fallback; }
  set(key, value) { mockStore.set(key, JSON.parse(JSON.stringify(value))); }
});

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn),
    emit: () => {}
  },
  dialog: {},
  app: { getPath: () => require('os').tmpdir(), getVersion: () => '0.0.0' }
}));
jest.mock('electron-is-dev', () => false);

const registerWorkspaceIpc = require('../src/ipc/workspace');

const KEY = 'workspaces.lastOpenedWorkspaces';
let root;
let sent;

const VALID = 'opencollection: 1.0.0\ninfo:\n  name: GSB\n  type: workspace\ncollections: []\n';
const CONFLICTED = [
  'opencollection: 1.0.0',
  'info:',
  '  name: GSB',
  '  type: workspace',
  'collections:',
  '<<<<<<< HEAD',
  '  - name: \'A\'',
  '    path: \'collections/a\'',
  '=======',
  '  - name: \'B\'',
  '    path: \'collections/b\'',
  '>>>>>>> feature',
  ''
].join('\n');

beforeAll(() => {
  registerWorkspaceIpc({ webContents: { send: () => {} }, isDestroyed: () => false },
    { addWatcher: () => {}, removeWatcher: () => {} });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-broken-ws-'));
  mockStore.clear();
  mockStore.set(KEY, [root]);
  sent = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const startup = async () => {
  sent = [];
  await mockHandlers.get('main:renderer-ready')({
    webContents: { send: (...args) => sent.push(args) },
    isDestroyed: () => false
  });
  return sent.map(([channel]) => channel);
};

describe('a workspace whose config cannot be read', () => {
  it('opens normally when the config is fine', async () => {
    fs.writeFileSync(path.join(root, 'workspace.yml'), VALID);
    expect(await startup()).toContain('main:workspace-opened');
  });

  it('stays in the remembered list when the config has conflict markers', async () => {
    fs.writeFileSync(path.join(root, 'workspace.yml'), CONFLICTED);
    await startup();
    expect(mockStore.get(KEY)).toEqual([root]);
  });

  it('tells the renderer it could not be opened, rather than saying nothing', async () => {
    fs.writeFileSync(path.join(root, 'workspace.yml'), CONFLICTED);
    const channels = await startup();

    // The bug: the workspace was skipped with a console.error and the renderer
    // heard nothing at all, so it looked exactly like the workspace was gone.
    expect(channels).toContain('main:workspace-open-failed');
    expect(channels).not.toContain('main:workspace-opened');
  });

  it('names the workspace and the reason', async () => {
    fs.writeFileSync(path.join(root, 'workspace.yml'), CONFLICTED);
    await startup();

    const failure = sent.find(([channel]) => channel === 'main:workspace-open-failed');
    expect(failure[1]).toBe(root);
    expect(String(failure[3]?.reason || '')).toMatch(/conflict/i);
  });

  it('reports a malformed config too, not just a conflicted one', async () => {
    fs.writeFileSync(path.join(root, 'workspace.yml'), 'info:\n  type: workspace\n');
    const channels = await startup();
    expect(channels).toContain('main:workspace-open-failed');
  });

  it('says nothing about a workspace whose directory is genuinely gone', async () => {
    // Nothing to report and nothing to fix — it is forgotten, and since the
    // user is then left with no workspaces at all, a fresh one is created.
    // That is the case the initial-workspace path is FOR; the bug was doing it
    // on top of a workspace that merely failed to open.
    fs.rmSync(root, { recursive: true, force: true });
    const channels = await startup();

    expect(channels).not.toContain('main:workspace-open-failed');
    expect(mockStore.get(KEY)).not.toContain(root);
    expect(channels).toContain('main:workspace-opened');
  });
});
