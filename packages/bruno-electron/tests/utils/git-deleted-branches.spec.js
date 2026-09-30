const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

jest.mock('electron', () => ({ app: { getPath: () => mockUserDataPath } }));
const mockUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-deleted-branches-'));

const { getWorkspaceGitData, pushGitChanges } = require('../../src/utils/git');

// Reported against 4.1.0-vasl.5 and again against .6: the Branch picker listed
// local copies of every dated branch the team had ever cut and deleted. Names
// are the reporters' own.
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const win = { webContents: { send: () => {} }, isDestroyed: () => false };

let root;
let server;
let clone;
const commitFile = (cwd, name) => {
  fs.writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', name);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-gone-'));
  server = path.join(root, 'server.git');
  clone = path.join(root, 'ws');
  git(root, 'init', '-q', '--bare', '-b', 'main', server);
  git(root, 'clone', '-q', server, clone);
  commitFile(clone, 'workspace.yml');
  git(clone, 'push', '-q', 'origin', 'main', 'main:develop(1405-06-29)', 'main:develop(1405-06-25)', 'main:Develop(1405-06-30)');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'branch', '-q', '--track', 'develop(1405-06-29)', 'origin/develop(1405-06-29)');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const data = (extra = {}) => getWorkspaceGitData({ workspacePath: clone, fetchRemote: false, ...extra });
const detail = (d, name) => d.localBranchDetails.find((row) => row.name === name);

it('hides nothing and marks nothing while the server still has the branches', async () => {
  const d = await data();
  expect(detail(d, 'develop(1405-06-29)')).toMatchObject({ deletedOnServer: false });
});

it('marks a branch deleted on the server as safe to hide when all its commits are on the server', async () => {
  git(server, 'branch', '-q', '-D', 'develop(1405-06-29)');
  const d = await data(); // no fetch: the server's live list is enough
  expect(detail(d, 'develop(1405-06-29)')).toMatchObject({ deletedOnServer: true, unpushedCount: 0 });
  expect(d.remoteBranches).not.toContain('develop(1405-06-29)');
});

it('never proves a branch safe when it holds a commit no server branch has', async () => {
  git(clone, 'checkout', '-q', 'develop(1405-06-29)');
  commitFile(clone, 'local-work');
  git(clone, 'checkout', '-q', 'main');
  git(server, 'branch', '-q', '-D', 'develop(1405-06-29)');
  const d = await data();
  expect(detail(d, 'develop(1405-06-29)')).toMatchObject({ deletedOnServer: true, unpushedCount: null });
});

it('does not count a stale copy of a branch the server has since reset', async () => {
  // The server's develop(1405-06-25) is reset back behind a commit that only it
  // had; our remote-tracking ref still points at that commit.
  const author = path.join(root, 'author');
  git(root, 'clone', '-q', server, author);
  git(author, 'checkout', '-q', 'develop(1405-06-25)');
  commitFile(author, 'later');
  git(author, 'push', '-q', 'origin', 'develop(1405-06-25)');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'branch', '-q', 'feature-x', 'origin/develop(1405-06-25)'); // local work sitting on that commit
  git(clone, 'branch', '-q', '--set-upstream-to=origin/develop(1405-06-29)', 'feature-x');
  git(author, 'push', '-q', '--force', 'origin', 'main:develop(1405-06-25)');
  git(server, 'branch', '-q', '-D', 'develop(1405-06-29)');
  const d = await data();
  expect(detail(d, 'feature-x')).toMatchObject({ deletedOnServer: true, unpushedCount: null });
});

it('treats a checked-out branch the server deleted as unpublished, so Publish is offered', async () => {
  git(clone, 'checkout', '-q', 'develop(1405-06-29)');
  git(server, 'branch', '-q', '-D', 'develop(1405-06-29)');
  const d = await data();
  expect(d.currentUpstreamDeleted).toBe(true);
  expect(d.hasUpstream).toBe(false);
  expect(d.canPublishCurrentBranch).toBe(true);
});

it('refuses to push to it (that silently re-created the branch for everyone)', async () => {
  git(clone, 'checkout', '-q', 'develop(1405-06-29)');
  commitFile(clone, 'more');
  git(server, 'branch', '-q', '-D', 'develop(1405-06-29)');
  await expect(pushGitChanges(win, { gitRootPath: clone, processUid: 'p1' })).rejects.toThrow(/deleted on the server/);
  expect(git(server, 'branch', '--format=%(refname:short)')).not.toMatch(/1405-06-29/);
});

it('still pushes a branch the server has', async () => {
  git(clone, 'checkout', '-q', 'develop(1405-06-29)');
  commitFile(clone, 'ok');
  await pushGitChanges(win, { gitRootPath: clone, processUid: 'p2' });
  expect(git(server, 'log', '-1', '--format=%s', 'develop(1405-06-29)').trim()).toBe('ok');
});

it('skips the per-branch work for callers that do not show branches', async () => {
  git(server, 'branch', '-q', '-D', 'develop(1405-06-29)');
  const d = await data({ includeBranchDetails: false });
  expect(d.localBranchDetails).toEqual([]);
  expect(d.remoteBranches).not.toContain('develop(1405-06-29)');
});
