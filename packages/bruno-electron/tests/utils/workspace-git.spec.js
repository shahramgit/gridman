const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  initWorkspaceGit,
  getWorkspaceGitRootPath,
  fetchRemotes,
  upsertRemote,
  removeRemote,
  stageChanges,
  commitChanges,
  getGitStatus,
  getCurrentGitBranch,
  abortConflictResolution,
  continueMerge
} = require('../../src/utils/git');

// Git workflow tests against real repositories in temp dirs: init/remote
// management, stage+commit, and merge-conflict continue/abort — the flows
// the workspace Git panel drives. No network access: remotes are plain
// URLs that are never fetched.
describe('workspace git workflows', () => {
  jest.setTimeout(30000);

  let workspacePath;

  const git = (args, cwd = workspacePath) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com'
      }
    });

  const configureIdentity = () => {
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
  };

  const writeWorkspaceYml = () => {
    fs.writeFileSync(
      path.join(workspacePath, 'workspace.yml'),
      ['opencollection: 1.0.0', 'info:', '  name: GitWs', '  type: workspace', 'collections: []', 'specs: []', 'docs: \'\''].join('\n')
    );
  };

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-git-ws-'));
    writeWorkspaceYml();
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  describe('init', () => {
    it('initWorkspaceGit creates a repository at the workspace root', async () => {
      expect(getWorkspaceGitRootPath(workspacePath)).toBeFalsy();
      await initWorkspaceGit({ workspacePath });
      expect(fs.existsSync(path.join(workspacePath, '.git'))).toBe(true);
      expect(path.normalize(getWorkspaceGitRootPath(workspacePath))).toBe(path.normalize(workspacePath));
    });

    it('is idempotent when a repository already exists', async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      git(['add', '.']);
      git(['commit', '-m', 'base']);

      await initWorkspaceGit({ workspacePath });
      // Existing history untouched
      expect(git(['log', '--oneline']).trim().split('\n')).toHaveLength(1);
    });
  });

  describe('remotes: set origin / change origin / remove', () => {
    beforeEach(async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
    });

    it('upsertRemote adds origin, then changes its url in place', async () => {
      const added = await upsertRemote({ gitRootPath: workspacePath, remoteUrl: 'https://example.com/a.git' });
      expect(added).toEqual([
        { name: 'origin', refs: { fetch: 'https://example.com/a.git', push: 'https://example.com/a.git' } }
      ]);

      const changed = await upsertRemote({ gitRootPath: workspacePath, remoteUrl: 'https://example.com/b.git' });
      expect(changed).toEqual([
        { name: 'origin', refs: { fetch: 'https://example.com/b.git', push: 'https://example.com/b.git' } }
      ]);
      // Still exactly one remote
      expect(git(['remote']).trim()).toBe('origin');
    });

    it('removeRemote deletes the remote', async () => {
      await upsertRemote({ gitRootPath: workspacePath, remoteUrl: 'https://example.com/a.git' });
      await removeRemote({ gitRootPath: workspacePath, remoteName: 'origin' });
      const remotes = await fetchRemotes(workspacePath);
      expect(remotes).toEqual([]);
    });
  });

  describe('stage + commit', () => {
    it('stageChanges + commitChanges produce a clean status', async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();

      const filePath = path.join(workspacePath, 'request.bru');
      fs.writeFileSync(filePath, 'meta { name: r1 }\n');

      await stageChanges(workspacePath, [path.join(workspacePath, '.')]);
      await commitChanges(workspacePath, 'first commit');

      const status = await getGitStatus(workspacePath);
      expect(status.files).toEqual([]);
      expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('first commit');
    });
  });

  describe('merge conflict: continue / abort', () => {
    const filePath = () => path.join(workspacePath, 'conflict.txt');

    // main commits base -> branch changes line -> main changes same line ->
    // merging the branch into main conflicts.
    const createConflict = async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(filePath(), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';

      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(filePath(), 'feature change\n');
      git(['add', '.']);
      git(['commit', '-m', 'feature edit']);

      git(['checkout', mainBranch]);
      fs.writeFileSync(filePath(), 'main change\n');
      git(['add', '.']);
      git(['commit', '-m', 'main edit']);

      let mergeFailed = false;
      try {
        git(['merge', 'feature']);
      } catch (_err) {
        mergeFailed = true;
      }
      expect(mergeFailed).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, '.git', 'MERGE_HEAD'))).toBe(true);
    };

    it('abortConflictResolution returns the tree to the pre-merge state', async () => {
      await createConflict();

      await abortConflictResolution(workspacePath);

      expect(fs.existsSync(path.join(workspacePath, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(fs.readFileSync(filePath(), 'utf8')).toBe('main change\n');
      const status = await getGitStatus(workspacePath);
      expect(status.conflicted).toEqual([]);
    });

    it('abortConflictResolution rejects when no merge is in progress', async () => {
      await initWorkspaceGit({ workspacePath });
      await expect(abortConflictResolution(workspacePath)).rejects.toThrow('No merge in progress');
    });

    it('continueMerge writes the resolved content, commits, and clears the conflict', async () => {
      await createConflict();

      await continueMerge(
        workspacePath,
        [{ path: 'conflict.txt', content: 'resolved\n' }],
        'merge feature with manual resolution'
      );

      expect(fs.existsSync(path.join(workspacePath, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(fs.readFileSync(filePath(), 'utf8')).toBe('resolved\n');
      expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('merge feature with manual resolution');
      const status = await getGitStatus(workspacePath);
      expect(status.conflicted).toEqual([]);
      expect(status.files).toEqual([]);
    });
  });
});
