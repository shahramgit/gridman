const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

jest.mock('electron', () => ({ app: { getPath: () => mockUserDataPath } }));
const mockUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-prune-userdata-'));

const { fetchChanges, fetchRemoteBranches } = require('../../src/utils/git');

// Reported against 4.1.0-vasl.5: the branch picker kept listing every dated
// branch the team had ever cut, long after they were deleted on the server.
// Branch names are the reporter's own.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let root;
let clone;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-prune-'));
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  clone = path.join(root, 'clone');

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, author);
  git(author, 'config', 'user.email', 't@example.com');
  git(author, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(author, 'workspace.yml'), 'x\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'base');
  git(author, 'push', '-q', 'origin', 'main', 'main:develop(1405-06-15)', 'main:developerssss');

  git(root, 'clone', '-q', origin, clone);
  git(author, 'push', '-q', 'origin', '--delete', 'develop(1405-06-15)', 'developerssss');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('stops listing branches that were deleted on the server', async () => {
  expect(await fetchRemoteBranches({ gitRootPath: clone, remote: 'origin' }))
    .toEqual(expect.arrayContaining(['develop(1405-06-15)', 'developerssss']));

  await fetchChanges(clone, 'origin');

  expect(await fetchRemoteBranches({ gitRootPath: clone, remote: 'origin' })).toEqual(['main']);
});

it('prunes on the progress-reporting fetch the Git panel runs too', async () => {
  const win = { webContents: { send: () => {} }, isDestroyed: () => false };
  await fetchChanges(clone, 'origin', { win, processUid: 'fetch-1' });

  expect(await fetchRemoteBranches({ gitRootPath: clone, remote: 'origin' })).toEqual(['main']);
});
