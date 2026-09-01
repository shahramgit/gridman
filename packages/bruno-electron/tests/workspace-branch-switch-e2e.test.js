const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * THE BRANCH SWITCH, WITH A REAL GIT REPOSITORY.
 *
 * The earlier tests for this simulated the states by writing files. This one
 * uses git: a real repository, real branches, real checkouts — because the
 * reported sequence is "add a folder, switch branch, restart" and what git
 * actually leaves in the working tree is the whole question.
 *
 * `workspace.yml` is TRACKED, so it is rewritten by every checkout. Three
 * outcomes matter and all three are exercised here: the file is absent on the
 * other branch, the file differs on the other branch, and a merge left conflict
 * markers in it.
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

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const workspaceYml = (collections) => [
  'opencollection: 1.0.0',
  'info:',
  '  name: GSB',
  '  type: workspace',
  'collections:',
  ...collections.flatMap((c) => [`  - name: '${c}'`, `    path: 'collections/${c}'`]),
  'specs:',
  'docs: \'\'',
  ''
].join('\n');

const makeCollection = (name) => {
  const dir = path.join(root, 'collections', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify({ version: '1', name, type: 'collection' }));
};

beforeAll(() => {
  registerWorkspaceIpc({ webContents: { send: () => {} }, isDestroyed: () => false },
    { addWatcher: () => {}, removeWatcher: () => {} });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-branch-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  makeCollection('Alpha');
  fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha']));
  git('add', '-A');
  git('commit', '-m', 'main: one collection');

  mockStore.clear();
  mockStore.set(KEY, [root]);
  sent = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// The real startup path, which is what "restart the app" means.
const restart = async () => {
  sent = [];
  await mockHandlers.get('main:renderer-ready')({
    webContents: { send: (...args) => sent.push(args) },
    isDestroyed: () => false
  });
  return {
    channels: sent.map(([channel]) => channel),
    openedPaths: sent.filter(([c]) => c === 'main:workspace-opened').map(([, p]) => p),
    remembered: mockStore.get(KEY) || [],
    sent
  };
};

describe('switching branches under a workspace', () => {
  it('opens the workspace on the branch that has its config', async () => {
    const r = await restart();
    expect(r.openedPaths).toContain(root);
  });

  it('keeps the workspace when the other branch does not carry workspace.yml', async () => {
    git('checkout', '-b', 'no-workspace');
    git('rm', '--cached', 'workspace.yml');
    fs.rmSync(path.join(root, 'workspace.yml'));
    git('commit', '-m', 'branch without a workspace file');

    const r = await restart();
    // Not openable right now — there is genuinely no config to open.
    expect(r.openedPaths).not.toContain(root);
    // But still the user's workspace, and the directory is right there.
    expect(r.remembered).toContain(root);
  });

  it('brings it back on switching to the branch that has it', async () => {
    git('checkout', '-b', 'no-workspace');
    git('rm', '--cached', 'workspace.yml');
    fs.rmSync(path.join(root, 'workspace.yml'));
    git('commit', '-m', 'branch without a workspace file');
    await restart();

    git('checkout', 'main');
    const r = await restart();
    expect(r.openedPaths).toContain(root);
  });

  it('follows the collection list across a branch that has a different one', async () => {
    // The reported "my collections disappeared": they are listed in a tracked
    // file, so the other branch legitimately has a different set.
    git('checkout', '-b', 'more');
    makeCollection('Beta');
    fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha', 'Beta']));
    git('add', '-A');
    git('commit', '-m', 'two collections');

    const r = await restart();
    expect(r.openedPaths).toContain(root);
    const config = sent.find(([c]) => c === 'main:workspace-opened')[3];
    expect(config.collections.map((c) => c.name).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('opens, and reports, a workspace.yml left with conflict markers', async () => {
    // Add a collection on a branch, add a different one on main, merge.
    git('checkout', '-b', 'adds-beta');
    makeCollection('Beta');
    fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha', 'Beta']));
    git('add', '-A');
    git('commit', '-m', 'adds beta');

    git('checkout', 'main');
    makeCollection('Gamma');
    fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha', 'Gamma']));
    git('add', '-A');
    git('commit', '-m', 'adds gamma');

    try {
      git('merge', 'adds-beta');
    } catch (_conflictIsThePoint) { /* the merge is expected to conflict */ }

    expect(fs.readFileSync(path.join(root, 'workspace.yml'), 'utf8')).toContain('<<<<<<<');

    const r = await restart();
    // This is the sequence the user described. It used to skip the workspace
    // with a console line and then open a brand new empty one instead. The
    // workspace now opens, reads through the markers, and reports the conflict
    // — all three collections are on disk and the user needs to reach them.
    expect(r.channels).toContain('main:workspace-opened');
    expect(r.channels).toContain('main:workspace-config-conflicted');
    expect(r.remembered).toContain(root);
    expect(r.openedPaths).toContain(root);

    const opened = r.sent.find(([channel]) => channel === 'main:workspace-opened');
    expect((opened[3]?.collections || []).map((collection) => collection.name).sort())
      .toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('recovers once the conflict is resolved', async () => {
    git('checkout', '-b', 'adds-beta');
    makeCollection('Beta');
    fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha', 'Beta']));
    git('add', '-A');
    git('commit', '-m', 'adds beta');
    git('checkout', 'main');
    makeCollection('Gamma');
    fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha', 'Gamma']));
    git('add', '-A');
    git('commit', '-m', 'adds gamma');
    try { git('merge', 'adds-beta'); } catch (_e) { /* expected */ }
    await restart();

    // Resolve it the way a user would, and reopen.
    fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['Alpha', 'Beta', 'Gamma']));
    const r = await restart();

    expect(r.openedPaths).toContain(root);
    const config = sent.find(([c]) => c === 'main:workspace-opened')[3];
    expect(config.collections.map((c) => c.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
