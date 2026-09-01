const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  readWorkspaceConfig,
  resolveGitConflictMarkers,
  hasGitConflictMarkers
} = require('../src/utils/workspace-config');
const { createSafetyCommitForFiles } = require('../src/utils/git');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const workspaceYml = (collections) =>
  [
    'opencollection: 1.0.0',
    'info:',
    '  name: "GSB"',
    '  type: workspace',
    '',
    'collections:',
    ...collections.flatMap((name) => [`  - name: "${name}"`, `    path: "collections/${name}"`]),
    ''
  ].join('\n');

// A real repo with a real merge conflict in workspace.yml, produced the way the
// users produced it: two branches that each add a collection.
const makeConflictedRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-conflict-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');

  fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['shared']));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');

  git(root, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['shared', 'arezooteat']));
  git(root, 'commit', '-qam', 'theirs');

  git(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'workspace.yml'), workspaceYml(['shared', 'amiiiin']));
  git(root, 'commit', '-qam', 'ours');

  try {
    git(root, 'merge', 'other');
  } catch (error) {
    // expected: conflict
  }

  for (const name of ['shared', 'amiiiin', 'arezooteat']) {
    fs.mkdirSync(path.join(root, 'collections', name), { recursive: true });
  }

  return root;
};

describe('conflicted workspace.yml', () => {
  let root;

  beforeEach(() => {
    root = makeConflictedRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('really is conflicted (guards the fixture)', () => {
    const content = fs.readFileSync(path.join(root, 'workspace.yml'), 'utf8');
    expect(hasGitConflictMarkers(content)).toBe(true);
    expect(git(root, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('workspace.yml');
  });

  it('opens the workspace instead of making it vanish, keeping both sides', () => {
    const config = readWorkspaceConfig(root);

    expect(config.name).toBe('GSB');
    expect(config.hasGitConflicts).toBe(true);
    expect(config.collections.map((c) => c.name).sort()).toEqual(['amiiiin', 'arezooteat', 'shared']);
  });

  it('refuses to commit the conflicted file instead of baking markers into history', async () => {
    await expect(createSafetyCommitForFiles(root, ['workspace.yml'])).rejects.toThrow(/conflict markers/i);

    expect(git(root, 'log', '--oneline').split('\n').filter(Boolean)).toHaveLength(2);
    expect(git(root, 'show', 'HEAD:workspace.yml')).not.toContain('<<<<<<<');
  });

  it('still refuses once the markers are staged, which git counts as resolved', async () => {
    git(root, 'add', 'workspace.yml');
    expect(git(root, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('');

    await expect(createSafetyCommitForFiles(root, ['workspace.yml'])).rejects.toThrow(/conflict markers/i);
  });

  // GSB's real state: three people had already committed a marker-laden
  // workspace.yml, so Git reports a clean tree and the resolver has no conflict
  // to work with. The message has to say the file itself needs editing.
  it('names committed markers as committed, not as a live conflict', async () => {
    git(root, 'add', 'workspace.yml');
    git(root, 'commit', '-qm', 'oops, committed the markers');
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
    expect(git(root, 'show', 'HEAD:workspace.yml')).toContain('<<<<<<<');

    fs.writeFileSync(path.join(root, 'note.txt'), 'later edit\n');
    await expect(createSafetyCommitForFiles(root, ['workspace.yml', 'note.txt']))
      .rejects.toThrow(/committed to this branch/i);
  });

  it('still opens a workspace whose markers are committed', () => {
    git(root, 'add', 'workspace.yml');
    git(root, 'commit', '-qm', 'oops, committed the markers');

    const config = readWorkspaceConfig(root);
    expect(config.hasGitConflicts).toBe(true);
    expect(config.collections.map((c) => c.name).sort()).toEqual(['amiiiin', 'arezooteat', 'shared']);
  });

  it('commits normally when nothing is conflicted', async () => {
    git(root, 'checkout', '-q', '--theirs', 'workspace.yml');
    git(root, 'add', 'workspace.yml');
    git(root, 'commit', '-qm', 'resolved');
    fs.writeFileSync(path.join(root, 'note.txt'), 'local edit\n');

    const result = await createSafetyCommitForFiles(root, ['note.txt']);
    expect(result.committed).toBe(true);
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('Save local workspace files before pull');
  });
});

describe('resolveGitConflictMarkers', () => {
  it('keeps both sides for a list conflict', () => {
    const text = ['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> abc123', 'b'].join('\n');
    expect(resolveGitConflictMarkers(text, 'union').split('\n')).toEqual(['a', 'ours', 'theirs', 'b']);
    expect(resolveGitConflictMarkers(text, 'ours').split('\n')).toEqual(['a', 'ours', 'b']);
  });

  it('drops the merge base of a diff3-style conflict', () => {
    const text = [
      '<<<<<<< HEAD', 'ours', '||||||| base', 'original', '=======', 'theirs', '>>>>>>> abc123'
    ].join('\n');
    expect(resolveGitConflictMarkers(text, 'union').split('\n')).toEqual(['ours', 'theirs']);
  });

  it('keeps the tail of a truncated conflict rather than dropping it', () => {
    const text = ['head', '<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n');
    expect(resolveGitConflictMarkers(text, 'union').split('\n')).toEqual(['head', 'ours', 'theirs']);
  });

  it('leaves content without markers byte-identical', () => {
    const text = 'one\ntwo\nthree\n';
    expect(resolveGitConflictMarkers(text, 'union')).toBe(text);
  });
});

// The path the real repos actually went down: a pull whose safety commit ran
// over a workspace.yml that an earlier pull had left conflicted. Four commits
// named "Save local workspace files before pull" in one team's history each
// carry `<<<<<<<` inside workspace.yml, and each was cleaned up by hand on the
// Git host days later.
describe('pull over a conflicted workspace.yml', () => {
  const { pullGitChanges } = require('../src/utils/git');
  const win = { webContents: { send: () => {} }, isDestroyed: () => false };
  let origin;
  let clone;

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-origin-'));
    git(origin, 'init', '-q', '--bare', '-b', 'main');

    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-clone-'));
    git(clone, 'clone', '-q', origin, '.');
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'Test');

    fs.writeFileSync(path.join(clone, 'workspace.yml'), workspaceYml(['shared']));
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'base');
    git(clone, 'push', '-q', 'origin', 'main');
  });

  afterEach(() => {
    for (const dir of [origin, clone]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses instead of committing the markers, and leaves history clean', async () => {
    // Leave workspace.yml conflicted, exactly as an earlier failed merge would.
    fs.writeFileSync(
      path.join(clone, 'workspace.yml'),
      workspaceYml(['shared']).replace(
        'collections:',
        'collections:\n<<<<<<< HEAD\n  - name: "amiiiin"\n    path: "collections/amiiiin"\n=======\n  - name: "arezooteat"\n    path: "collections/arezooteat"\n>>>>>>> abc123'
      )
    );

    const before = git(clone, 'rev-parse', 'HEAD').trim();

    await expect(pullGitChanges(win, { gitRootPath: clone, processUid: 'test', strategy: '--no-rebase' }))
      .rejects.toThrow(/conflict markers/i);

    expect(git(clone, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(clone, 'log', '--format=%s').split('\n').filter(Boolean)).toEqual(['base']);
    expect(git(clone, 'show', 'HEAD:workspace.yml')).not.toContain('<<<<<<<');
  });

  it('pulls normally when workspace.yml is clean', async () => {
    fs.writeFileSync(path.join(clone, 'workspace.yml'), workspaceYml(['shared', 'local-only']));

    await expect(pullGitChanges(win, { gitRootPath: clone, processUid: 'test', strategy: '--no-rebase' })).resolves.toBeDefined();

    expect(git(clone, 'show', 'HEAD:workspace.yml')).toContain('local-only');
  });
});
