const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), on: jest.fn(), getName: () => 'gridman' },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}));
jest.mock('electron-store', () =>
  jest.fn().mockImplementation(() => ({ get: (_k, fallback) => fallback, set: jest.fn() }))
);

const { getWorkspaceMembershipChange } = require('../../src/utils/git');

/**
 * SWITCHING BRANCH CAN EMPTY A WORKSPACE.
 *
 * `workspace.yml` carries the collection list and is tracked, so a checkout rewrites it
 * like any other file. In the reported repository `main` lists 122 collections and
 * `develop` lists none — the sidebar emptied with no warning and no error, reported as
 * "the previous workspace's collections are gone".
 *
 * This is the read-only preflight the UI asks before switching. It must never throw and
 * never block: a ref it cannot compare has to come back `comparable: false`.
 */
describe('getWorkspaceMembershipChange', () => {
  let repo;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const writeWorkspace = (names) => {
    const body = ['opencollection: 1.0.0', 'info:', '  name: "W"', '  type: workspace', '', 'collections:']
      .concat(names.flatMap((n) => [`  - name: "${n}"`, `    path: "collections/${n}"`]))
      .join('\n');
    fs.writeFileSync(path.join(repo, 'workspace.yml'), `${body}\n`);
  };

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-ws-branch-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeWorkspace(['Alpha', 'Beta', 'Gamma']);
    git('add', '-A');
    git('commit', '-qm', 'main workspace');

    git('checkout', '-q', '-b', 'empty');
    writeWorkspace([]);
    git('add', '-A');
    git('commit', '-qm', 'empty workspace');

    git('checkout', '-q', '-b', 'more', 'main');
    writeWorkspace(['Alpha', 'Beta', 'Gamma', 'Delta']);
    git('add', '-A');
    git('commit', '-qm', 'more collections');

    git('checkout', '-q', 'main');
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('reports every collection a branch would drop', async () => {
    const change = await getWorkspaceMembershipChange(repo, 'empty');
    expect(change.comparable).toBe(true);
    expect(change.currentCount).toBe(3);
    expect(change.targetCount).toBe(0);
    // Named, not just counted: the warning lists them so the user recognises what goes.
    expect(change.removed.sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('does not warn when a branch only adds collections', async () => {
    const change = await getWorkspaceMembershipChange(repo, 'more');
    expect(change.removed).toEqual([]);
    expect(change.added).toEqual(['Delta']);
  });

  it('reports nothing to warn about for the branch already checked out', async () => {
    const change = await getWorkspaceMembershipChange(repo, 'main');
    expect(change.removed).toEqual([]);
    expect(change.added).toEqual([]);
  });

  it('never throws on a ref it cannot read, so a checkout is never blocked', async () => {
    const change = await getWorkspaceMembershipChange(repo, 'no-such-branch');
    expect(change.comparable).toBe(false);
    expect(change.removed).toEqual([]);
  });

  it('is comparable:false in a repository with no workspace.yml at all', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-no-ws-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: bare });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: bare });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: bare });
    fs.writeFileSync(path.join(bare, 'README.md'), 'hi');
    execFileSync('git', ['add', '-A'], { cwd: bare });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: bare });

    const change = await getWorkspaceMembershipChange(bare, 'main');
    expect(change.comparable).toBe(false);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
