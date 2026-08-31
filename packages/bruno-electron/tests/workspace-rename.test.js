const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * RENAMING A WORKSPACE HAS TO STICK.
 *
 * Rename writes `info.name` into workspace.yml. Every place that built the
 * config for the renderer then overrode it with `path.basename(workspacePath)`
 * — so the renderer's optimistic update was undone a beat later by the
 * watcher's own broadcast, and the name snapped back to the folder. Reported
 * as "rename workspace does not work".
 *
 * The two agree for every workspace made through the app
 * (createWorkspaceConfig names it after its folder), so preferring the carried
 * name changes nothing until someone actually renames one.
 */

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn),
    // renderer-ready hands off to the next stage through the event bus.
    emit: () => {}
  },
  dialog: {},
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' }
}));
jest.mock('electron-is-dev', () => false);
const mockStore = new Map();
jest.mock('electron-store', () => class FakeStore {
  get(key, fallback) { return mockStore.has(key) ? mockStore.get(key) : fallback; }
  set(key, value) { mockStore.set(key, JSON.parse(JSON.stringify(value))); }
});

const registerWorkspaceIpc = require('../src/ipc/workspace');
const { readWorkspaceConfig } = require('../src/utils/workspace-config');

let root;
const sent = [];

const writeConfig = (name) =>
  fs.writeFileSync(
    path.join(root, 'workspace.yml'),
    `opencollection: 1.0.0\ninfo:\n  name: "${name}"\n  type: workspace\ncollections: []\n`
  );

beforeAll(() => {
  registerWorkspaceIpc(
    { webContents: { send: (...args) => sent.push(args) }, isDestroyed: () => false },
    { addWatcher: () => {}, removeWatcher: () => {} }
  );
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-rename-'));
  writeConfig(path.basename(root));
  sent.length = 0;
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const rename = (newName) => mockHandlers.get('renderer:rename-workspace')(null, root, newName);

// What the app is actually told at startup. This is the broadcast that used to
// overwrite the rename.
const broadcastNameOnStartup = async () => {
  mockStore.set('workspaces.lastOpenedWorkspaces', [root]);
  sent.length = 0;
  await mockHandlers.get('main:renderer-ready')({
    webContents: { send: (...args) => sent.push(args) },
    isDestroyed: () => false
  });
  const opened = sent.find(([channel]) => channel === 'main:workspace-opened');
  return opened?.[3]?.name;
};

describe('renaming a workspace', () => {
  it('writes the new name into workspace.yml', async () => {
    await rename('Payments Team');
    expect(readWorkspaceConfig(root).info.name).toBe('Payments Team');
  });

  it('tells the app the new name at startup, not the folder name', async () => {
    await rename('Payments Team');

    // The bug: this came back as the directory's basename, so the rename was
    // overwritten the moment the workspace was re-opened or the watcher fired.
    expect(await broadcastNameOnStartup()).toBe('Payments Team');
  });

  it('survives a second rename', async () => {
    await rename('First');
    await rename('Second');
    expect(readWorkspaceConfig(root).info.name).toBe('Second');
  });

  it('keeps the collections when renaming', async () => {
    fs.writeFileSync(
      path.join(root, 'workspace.yml'),
      'opencollection: 1.0.0\ninfo:\n  name: "Before"\n  type: workspace\ncollections:\n  - name: A\n    path: ./A\n'
    );
    await rename('After');

    const config = readWorkspaceConfig(root);
    expect(config.info.name).toBe('After');
    expect(config.collections).toHaveLength(1);
  });
});
