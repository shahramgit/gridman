const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A WORKSPACE IS NOT GONE JUST BECAUSE ITS CONFIG IS.
 *
 * `workspace.yml` is git-tracked. Checking out a branch that does not carry it
 * leaves a perfectly good workspace directory with no config in it — and the
 * startup scan treated that as invalid and deleted the workspace from the
 * recent list PERMANENTLY. Reported against the GSB workspace: switch branch,
 * restart, and the workspace is gone from the app while the folder is still
 * right there. Switching back did not bring it back, because the entry had
 * already been dropped.
 *
 * The store is the user's own list of workspaces. Forgetting an entry is
 * destructive and irreversible from inside the app, so the only thing that
 * earns it is the directory itself being gone.
 */

const mockStore = new Map();
jest.mock('electron-store', () => {
  return class FakeStore {
    get(key, fallback) { return mockStore.has(key) ? mockStore.get(key) : fallback; }
    set(key, value) { mockStore.set(key, JSON.parse(JSON.stringify(value))); }
  };
});

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn)
  },
  dialog: {},
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' }
}));
jest.mock('electron-is-dev', () => false);

const registerWorkspaceIpc = require('../src/ipc/workspace');

const KEY = 'workspaces.lastOpenedWorkspaces';
let root;

const listWorkspaces = () => mockHandlers.get('renderer:get-last-opened-workspaces')();
const remembered = () => mockStore.get(KEY) || [];

beforeAll(() => {
  registerWorkspaceIpc({ webContents: { send: () => {} } }, null);
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-ws-'));
  fs.writeFileSync(path.join(root, 'workspace.yml'), 'info:\n  name: GSB\n  type: workspace\n');
  mockStore.clear();
  mockStore.set(KEY, [root]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the remembered workspace list', () => {
  it('lists a workspace whose config is present', async () => {
    expect(await listWorkspaces()).toEqual([root]);
  });

  it('keeps remembering a workspace whose config a branch switch removed', async () => {
    fs.rmSync(path.join(root, 'workspace.yml'));

    // Not listed as openable right now — there is no config to open.
    expect(await listWorkspaces()).toEqual([]);
    // But still the user's workspace.
    expect(remembered()).toEqual([root]);
  });

  it('brings it back when the branch is switched back', async () => {
    fs.rmSync(path.join(root, 'workspace.yml'));
    await listWorkspaces();

    fs.writeFileSync(path.join(root, 'workspace.yml'), 'info:\n  name: GSB\n  type: workspace\n');
    expect(await listWorkspaces()).toEqual([root]);
  });

  it('survives repeated startups while the config is missing', async () => {
    fs.rmSync(path.join(root, 'workspace.yml'));

    // The old code removed on the first scan; this guards against a slow
    // version that drops it on the second or third.
    await listWorkspaces();
    await listWorkspaces();
    await listWorkspaces();

    expect(remembered()).toEqual([root]);
  });

  it('forgets a workspace whose directory is actually gone', async () => {
    fs.rmSync(root, { recursive: true, force: true });

    expect(await listWorkspaces()).toEqual([]);
    expect(remembered()).toEqual([]);
  });

  it('does not forget the other workspaces when one directory is gone', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-ws-b-'));
    fs.writeFileSync(path.join(other, 'workspace.yml'), 'info:\n  name: Other\n  type: workspace\n');
    const missing = path.join(os.tmpdir(), 'gridman-ws-never-existed');
    mockStore.set(KEY, [root, missing, other]);

    await listWorkspaces();

    expect(remembered()).toEqual([root, other]);
    fs.rmSync(other, { recursive: true, force: true });
  });
});
