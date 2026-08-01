const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

// git.js reaches the app Trash (through app-trash) for other flows, and its
// root comes from electron's userData path.
jest.mock('electron', () => ({ app: { getPath: () => mockUserDataPath } }));
const mockUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-git-userdata-'));

const {
  initWorkspaceGit,
  getWorkspaceGitRootPath,
  fetchRemotes,
  upsertRemote,
  removeRemote,
  stageChanges,
  unstageChanges,
  commitChanges,
  getGitStatus,
  getCurrentGitBranch,
  getWorkspaceFileGitStatus,
  restoreWorkspaceFileFromIndex,
  getRepositoryState,
  abortConflictResolution,
  continueMerge,
  continueResolvedMerge,
  resolveConflictFile,
  discardWorkspaceChanges,
  restoreWorkspaceDiscard,
  discardLocalCommits,
  listStashes
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

  // What is in the INDEX. `git reset`/`git add` never touch the working tree,
  // so a stray pathspec match only shows up here — asserting file contents
  // alone cannot tell a scoped index write from an unscoped one. -z so a
  // Persian or bracketed path comes back as raw bytes rather than git's escaped
  // "\xxx" form.
  const stagedPaths = () =>
    git(['diff', '--cached', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean)
      .sort();

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

  afterAll(() => {
    fs.rmSync(mockUserDataPath, { recursive: true, force: true });
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

    it('abortConflictResolution rejects when nothing is in progress', async () => {
      await initWorkspaceGit({ workspacePath });
      await expect(abortConflictResolution(workspacePath)).rejects.toThrow('There is nothing to abort');
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
  // Modify/delete conflicts: one side deleted the file while the other
  // changed it. Only ONE conflict stage exists, so `git checkout
  // --ours|--theirs` fails with "path '<file>' does not have their/our
  // version" (reported by a user whose folder.bru was deleted/renamed on one
  // side and edited on the other). Choosing the deleting side must accept the
  // deletion instead of erroring.
  describe('resolveConflictFile with modify/delete conflicts', () => {
    // Persian path on purpose: this is what the real workspaces look like.
    const relPath = 'collections/002/انتشار ازدواج و طلاق/folder.bru';
    const absPath = () => path.join(workspacePath, relPath);

    const commitBase = () => {
      git(['init']);
      configureIdentity();
      fs.mkdirSync(path.dirname(absPath()), { recursive: true });
      fs.writeFileSync(absPath(), 'meta {\n  name: base\n}\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
    };

    it('accepts the deletion when THEIRS deleted the file (modified by us)', async () => {
      commitBase();
      git(['checkout', '-b', 'feature']);
      git(['rm', '-q', '--', relPath]);
      git(['commit', '-m', 'delete on feature']);
      git(['checkout', '-']);
      fs.writeFileSync(absPath(), 'meta {\n  name: edited-locally\n}\n');
      git(['commit', '-am', 'edit on main']);
      expect(() => git(['merge', 'feature'])).toThrow();

      await expect(resolveConflictFile(workspacePath, relPath, 'theirs')).resolves.toMatchObject({ deleted: true });

      expect(git(['ls-files', '-u', '--', relPath]).trim()).toBe('');
      expect(fs.existsSync(absPath())).toBe(false);
    });

    it('keeps our version when OURS is the surviving side', async () => {
      commitBase();
      git(['checkout', '-b', 'feature']);
      git(['rm', '-q', '--', relPath]);
      git(['commit', '-m', 'delete on feature']);
      git(['checkout', '-']);
      fs.writeFileSync(absPath(), 'meta {\n  name: edited-locally\n}\n');
      git(['commit', '-am', 'edit on main']);
      expect(() => git(['merge', 'feature'])).toThrow();

      await expect(resolveConflictFile(workspacePath, relPath, 'ours')).resolves.toMatchObject({ deleted: false });

      expect(git(['ls-files', '-u', '--', relPath]).trim()).toBe('');
      expect(fs.readFileSync(absPath(), 'utf8')).toContain('edited-locally');
    });

    it('accepts the deletion when WE deleted the file (modified by them)', async () => {
      commitBase();
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(absPath(), 'meta {\n  name: edited-remotely\n}\n');
      git(['commit', '-am', 'edit on feature']);
      git(['checkout', '-']);
      git(['rm', '-q', '--', relPath]);
      git(['commit', '-m', 'delete on main']);
      expect(() => git(['merge', 'feature'])).toThrow();

      await expect(resolveConflictFile(workspacePath, relPath, 'ours')).resolves.toMatchObject({ deleted: true });

      expect(git(['ls-files', '-u', '--', relPath]).trim()).toBe('');
      expect(fs.existsSync(absPath())).toBe(false);
    });
  });

  // "We press discard changes and get various errors (save changes...)": git
  // cannot build a tree from an unmerged index, so `git stash push` aborts with
  // "Cannot save the current index state" / "<path>: needs merge" and the panel
  // showed that verbatim. Discard has to refuse first, with the way out.
  describe('discard while the repository is mid-operation', () => {
    // Persian path on purpose: this is what the real workspaces look like.
    const relPath = 'collections/002/انتشار ازدواج و طلاق/request.bru';
    const absPath = () => path.join(workspacePath, relPath);

    const commitBase = async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.mkdirSync(path.dirname(absPath()), { recursive: true });
      fs.writeFileSync(absPath(), 'meta {\n  name: base\n}\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
    };

    it('refuses to discard during a merge and says to abort first', async () => {
      await commitBase();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(absPath(), 'meta {\n  name: feature\n}\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', mainBranch]);
      fs.writeFileSync(absPath(), 'meta {\n  name: main\n}\n');
      git(['commit', '-am', 'main edit']);
      expect(() => git(['merge', 'feature'])).toThrow();

      const state = await getRepositoryState(workspacePath);
      expect(state.merging).toBe(true);
      expect(state.unmergedPaths).toEqual([relPath]);

      await expect(discardWorkspaceChanges(workspacePath, 'Discarded via Gridman on test'))
        .rejects.toThrow('A merge is in progress — abort it first, then discard');
      // The stash must not have been attempted at all
      expect(await listStashes(workspacePath)).toEqual([]);
    });

    it('discards normally once the merge is aborted', async () => {
      await commitBase();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(absPath(), 'meta {\n  name: feature\n}\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', mainBranch]);
      fs.writeFileSync(absPath(), 'meta {\n  name: main\n}\n');
      git(['commit', '-am', 'main edit']);
      expect(() => git(['merge', 'feature'])).toThrow();

      await abortConflictResolution(workspacePath);
      fs.writeFileSync(absPath(), 'meta {\n  name: unwanted\n}\n');

      await expect(discardWorkspaceChanges(workspacePath, 'Discarded via Gridman on test'))
        .resolves.toMatchObject({ label: 'Discarded via Gridman on test' });
      expect(fs.readFileSync(absPath(), 'utf8')).toContain('name: main');
      expect(await listStashes(workspacePath)).toHaveLength(1);
    });
  });

  // Abort was hardcoded to `git merge --abort` behind an fs.existsSync check on
  // <root>/.git/MERGE_HEAD, so every other stopped state — rebase, cherry-pick,
  // revert, and a conflicting stash apply produced by Gridman's own "Restore
  // discarded changes" — answered "No merge in progress" and dead-ended.
  describe('abortConflictResolution across repository states', () => {
    const filePath = () => path.join(workspacePath, 'conflict.txt');

    const commitBase = async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(filePath(), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
    };

    it('aborts a conflicted rebase', async () => {
      await commitBase();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(filePath(), 'feature change\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', mainBranch]);
      fs.writeFileSync(filePath(), 'main change\n');
      git(['commit', '-am', 'main edit']);
      git(['checkout', 'feature']);
      expect(() => git(['rebase', mainBranch])).toThrow();

      const midRebase = await getRepositoryState(workspacePath);
      expect(midRebase).toMatchObject({ rebasing: true, merging: false });

      await abortConflictResolution(workspacePath);

      const afterAbort = await getRepositoryState(workspacePath);
      expect(afterAbort).toMatchObject({ rebasing: false, unmergedPaths: [] });
      expect(fs.readFileSync(filePath(), 'utf8')).toBe('feature change\n');
    });

    it('aborts a conflicted cherry-pick', async () => {
      await commitBase();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(filePath(), 'feature change\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', mainBranch]);
      fs.writeFileSync(filePath(), 'main change\n');
      git(['commit', '-am', 'main edit']);
      expect(() => git(['cherry-pick', 'feature'])).toThrow();

      expect(await getRepositoryState(workspacePath)).toMatchObject({ cherryPicking: true });

      await abortConflictResolution(workspacePath);

      expect(await getRepositoryState(workspacePath)).toMatchObject({ cherryPicking: false, unmergedPaths: [] });
      expect(fs.readFileSync(filePath(), 'utf8')).toBe('main change\n');
    });

    // A stash apply leaves unmerged index entries with NO in-progress operation
    // — no --abort command applies, and the workspace stays unstashable until
    // the conflict is cleared. Abort has no confirmation modal in front of it
    // (Discard does), so it may only unstick Git's index: the working tree is
    // left exactly as it is.
    it('clears an unmerged index that has no MERGE_HEAD without rewriting the file', async () => {
      await commitBase();
      fs.writeFileSync(filePath(), 'discarded work\n');
      await discardWorkspaceChanges(workspacePath, 'Discarded via Gridman on test');

      fs.writeFileSync(filePath(), 'later work\n');
      git(['commit', '-am', 'later edit']);

      await expect(restoreWorkspaceDiscard(workspacePath, 0)).rejects.toThrow('conflict with what is in the workspace now');

      const stuck = await getRepositoryState(workspacePath);
      expect(stuck).toMatchObject({ merging: false, rebasing: false, cherryPicking: false, reverting: false, operation: '' });
      expect(stuck.unmergedPaths).toEqual(['conflict.txt']);
      // The stash survived the failed apply, so the work is still recoverable
      expect(await listStashes(workspacePath)).toHaveLength(1);

      await expect(abortConflictResolution(workspacePath))
        .resolves.toMatchObject({ clearedConflicts: 1, keptWorkingTreeContent: true });

      expect((await getRepositoryState(workspacePath)).unmergedPaths).toEqual([]);
      // Both sides of the conflict are still on disk — nothing was thrown away
      const afterAbort = fs.readFileSync(filePath(), 'utf8');
      expect(afterAbort).toContain('later work');
      expect(afterAbort).toContain('discarded work');

      // And the workspace can be discarded again now that the index is clean
      await expect(discardWorkspaceChanges(workspacePath, 'Discarded via Gridman on test 2')).resolves.toBeTruthy();
      expect(fs.readFileSync(filePath(), 'utf8')).toBe('later work\n');
    });

    // Pathspecs are glob-matched, so a conflicted `req[1].bru` — `[` and `]`
    // are legal filename characters, and `GET [v2] users.bru` is an ordinary
    // request name — made reset/checkout match req1.bru as well and revert its
    // uncommitted edits, with no snapshot anywhere.
    it('does not touch other files when a conflicted path contains glob characters', async () => {
      const conflictedName = 'req[1].bru';
      const bystanderName = 'req1.bru';
      const conflictedPath = path.join(workspacePath, conflictedName);
      const bystanderPath = path.join(workspacePath, bystanderName);

      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(conflictedPath, 'meta {\n  name: base\n}\n');
      fs.writeFileSync(bystanderPath, 'meta {\n  name: bystander-committed\n}\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);

      fs.writeFileSync(conflictedPath, 'meta {\n  name: discarded\n}\n');
      await discardWorkspaceChanges(workspacePath, 'Discarded via Gridman on test');

      fs.writeFileSync(conflictedPath, 'meta {\n  name: later\n}\n');
      git(['commit', '-am', 'later edit']);

      await expect(restoreWorkspaceDiscard(workspacePath, 0)).rejects.toThrow('conflict with what is in the workspace now');
      expect((await getRepositoryState(workspacePath)).unmergedPaths).toEqual([conflictedName]);

      // Unsaved work in a file that merely MATCHES the conflicted path as a
      // glob, STAGED — the abort clears the index with `git reset`, which never
      // writes the working tree, so the index is the only place where the
      // damage to a bystander shows up. Asserting the file's content alone
      // passes with or without the :(literal) prefix and guards nothing.
      fs.writeFileSync(bystanderPath, 'meta {\n  name: bystander-unsaved\n}\n');
      git(['add', '--', bystanderName]);
      // The conflicted path is listed too while its index entries are unmerged
      expect(stagedPaths()).toEqual([bystanderName, conflictedName].sort());

      await expect(abortConflictResolution(workspacePath)).resolves.toMatchObject({ clearedConflicts: 1 });

      // Still staged: the reset hit `req[1].bru` and nothing else
      expect(stagedPaths()).toEqual([bystanderName]);
      expect(fs.readFileSync(bystanderPath, 'utf8')).toContain('bystander-unsaved');
      expect((await getRepositoryState(workspacePath)).unmergedPaths).toEqual([]);
    });
  });

  // Same glob mechanism, on the paths that REWRITE the working tree. A request
  // named `GET [v2] users.bru` is an ordinary name — `[` and `]` are legal
  // filename characters on Windows too — and every one of these commands takes
  // a PATHSPEC, so an unprotected path reverted, deleted or staged whatever
  // else matched it, while the Trash snapshot covered only the target.
  describe('literal pathspecs on the destructive single-file paths', () => {
    const conflictedName = 'req[1].bru';
    const bystanderName = 'req1.bru';
    const conflictedPath = () => path.join(workspacePath, conflictedName);
    const bystanderPath = () => path.join(workspacePath, bystanderName);

    const commitBothFiles = async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(conflictedPath(), 'committed target\n');
      fs.writeFileSync(bystanderPath(), 'committed bystander\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
    };

    // "Revert to Last Commit" on a single request. The IPC handler copies ONLY
    // the file the user clicked into the app Trash, so a second file dragged in
    // by the glob loses its unsaved edits with no copy anywhere.
    it('reverts only the file that was asked for', async () => {
      await commitBothFiles();
      fs.writeFileSync(conflictedPath(), 'unsaved target\n');
      fs.writeFileSync(bystanderPath(), 'unsaved bystander\n');

      // The status probe drives the decision between "move to Trash" (untracked)
      // and "restore from the index", so it must not answer with another file.
      const line = await getWorkspaceFileGitStatus(workspacePath, conflictedPath());
      expect(line).toBe(`M ${conflictedName}`);

      await restoreWorkspaceFileFromIndex(workspacePath, conflictedPath());

      expect(fs.readFileSync(conflictedPath(), 'utf8')).toBe('committed target\n');
      expect(fs.readFileSync(bystanderPath(), 'utf8')).toBe('unsaved bystander\n');
    });

    it('stages only the file that was asked for', async () => {
      await commitBothFiles();
      fs.writeFileSync(conflictedPath(), 'edited target\n');
      fs.writeFileSync(bystanderPath(), 'edited bystander\n');

      await stageChanges(workspacePath, [conflictedPath()]);

      expect(stagedPaths()).toEqual([conflictedName]);
    });

    it('unstages only the file that was asked for', async () => {
      await commitBothFiles();
      fs.writeFileSync(conflictedPath(), 'edited target\n');
      fs.writeFileSync(bystanderPath(), 'edited bystander\n');
      git(['add', '.']);
      expect(stagedPaths()).toEqual([conflictedName, bystanderName].sort());

      await unstageChanges(workspacePath, [conflictedPath()]);

      expect(stagedPaths()).toEqual([bystanderName]);
    });

    // "Accept remote" on a conflicted file: `git checkout --theirs` overwrites
    // the working tree, so a glob match rewrites the bystander from a blob that
    // has nothing to do with it.
    it('resolves only the conflicted file, leaving a glob-matching bystander alone', async () => {
      await commitBothFiles();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-q', '-b', 'feature']);
      fs.writeFileSync(conflictedPath(), 'feature target\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', '-q', mainBranch]);
      fs.writeFileSync(conflictedPath(), 'main target\n');
      git(['commit', '-am', 'main edit']);
      expect(() => git(['merge', 'feature'])).toThrow();

      // Unsaved, unstaged work in the bystander while the merge is stopped
      fs.writeFileSync(bystanderPath(), 'unsaved bystander\n');

      await expect(resolveConflictFile(workspacePath, conflictedName, 'theirs'))
        .resolves.toMatchObject({ deleted: false });

      expect(fs.readFileSync(conflictedPath(), 'utf8')).toBe('feature target\n');
      expect(fs.readFileSync(bystanderPath(), 'utf8')).toBe('unsaved bystander\n');
      expect(stagedPaths()).toEqual([conflictedName]);
    });

    // The modify/delete branch runs `git rm -f`, which DELETES files.
    it('deletes only the conflicted file when the deletion is accepted', async () => {
      await commitBothFiles();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-q', '-b', 'feature']);
      // :(literal) in the SETUP too — plain `git rm -- 'req[1].bru'` deletes the
      // bystander as well, which is the very bug being guarded against.
      git(['rm', '-q', '--', `:(literal)${conflictedName}`]);
      git(['commit', '-m', 'delete on feature']);
      git(['checkout', '-q', mainBranch]);
      fs.writeFileSync(conflictedPath(), 'main target\n');
      git(['commit', '-am', 'main edit']);
      expect(() => git(['merge', 'feature'])).toThrow();

      await expect(resolveConflictFile(workspacePath, conflictedName, 'theirs'))
        .resolves.toMatchObject({ deleted: true });

      expect(fs.existsSync(conflictedPath())).toBe(false);
      expect(fs.existsSync(bystanderPath())).toBe(true);
      expect(fs.readFileSync(bystanderPath(), 'utf8')).toBe('committed bystander\n');
    });

    // A legal filename that contains a BACKSLASH on macOS/Linux. Rewriting
    // backslashes on the way into a pathspec turns it into one that matches
    // nothing ("fatal: pathspec ':(literal)back/slash-ish.bru' did not match
    // any files"), which throws out of the shared literal-pathspec helper — and
    // so out of the pre-pull safety commit and out of abort.
    (process.platform === 'win32' ? it.skip : it)('stages a path whose filename contains a backslash', async () => {
      const backslashName = 'back\\slash-ish.bru';
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(path.join(workspacePath, backslashName), 'meta {\n  name: odd\n}\n');

      await stageChanges(workspacePath, [path.join(workspacePath, backslashName)]);

      expect(stagedPaths()).toEqual([backslashName]);
    });
  });

  // The Conflicts section renders for a rebase, cherry-pick and revert too, so
  // Continue has to drive whichever operation is stopped — it ran `git merge
  // --continue` unconditionally and dead-ended everywhere else.
  describe('continueResolvedMerge across repository states', () => {
    const filePath = () => path.join(workspacePath, 'conflict.txt');

    const startConflictedRebase = async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(filePath(), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(filePath(), 'feature change\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', mainBranch]);
      fs.writeFileSync(filePath(), 'main change\n');
      git(['commit', '-am', 'main edit']);
      git(['checkout', 'feature']);
      expect(() => git(['rebase', mainBranch])).toThrow();
    };

    it('continues a conflicted rebase once the file is resolved', async () => {
      await startConflictedRebase();
      expect(await getRepositoryState(workspacePath)).toMatchObject({ operation: 'rebase' });

      fs.writeFileSync(filePath(), 'resolved\n');
      await continueResolvedMerge(workspacePath, ['conflict.txt'], 'ignored for a rebase');

      const afterContinue = await getRepositoryState(workspacePath);
      expect(afterContinue).toMatchObject({ rebasing: false, operation: '', unmergedPaths: [] });
      expect(fs.readFileSync(filePath(), 'utf8')).toBe('resolved\n');
    });

    it('names the files still in conflict instead of failing inside git', async () => {
      await startConflictedRebase();

      await expect(continueResolvedMerge(workspacePath, [], 'nothing resolved'))
        .rejects.toThrow('1 file still has unresolved conflicts, so the rebase cannot continue: conflict.txt');
    });
  });

  // "Discard all changes should also work after committing": a pull turns the
  // dirty tree into a real commit, so the applicable control is "Discard local
  // commits" — which was hard-disabled without an upstream, and a workspace
  // created by the panel's own "Initialize Git" never has one.
  describe('discardLocalCommits without an upstream', () => {
    const commitSequence = async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(path.join(workspacePath, 'a.txt'), 'one\n');
      git(['add', '.']);
      git(['commit', '-m', 'first']);
      fs.writeFileSync(path.join(workspacePath, 'b.txt'), 'two\n');
      git(['add', '.']);
      git(['commit', '-m', 'second']);
      fs.writeFileSync(path.join(workspacePath, 'c.txt'), 'three\n');
      git(['add', '.']);
      git(['commit', '-m', 'third']);
    };

    it('discards the commits no remote has yet', async () => {
      await commitSequence();
      // A remote-tracking ref without a configured upstream: exactly the state
      // a cloned-then-detached workspace lands in.
      const firstCommit = git(['rev-list', '--max-parents=0', 'HEAD']).trim();
      git(['update-ref', 'refs/remotes/origin/main', firstCommit]);

      const result = await discardLocalCommits(workspacePath, 'Discarded via Gridman on test');

      expect(result).toMatchObject({ discarded: true, commits: 2, stashed: true, upstream: '' });
      expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      expect(fs.existsSync(path.join(workspacePath, 'b.txt'))).toBe(false);
      expect(await listStashes(workspacePath)).toHaveLength(1);
    });

    it('keeps the initial commit when the whole history is local', async () => {
      await commitSequence();

      const result = await discardLocalCommits(workspacePath, 'Discarded via Gridman on test');

      expect(result).toMatchObject({ discarded: true, commits: 2, stashed: true, keptInitialCommit: true });
      expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('first');
    });

    // Gridman pulls with --no-rebase, so merge commits happen on a branch with
    // no upstream (getTrackingTarget aims at an explicit remote+branch instead).
    // HEAD~<local commit count> then points at the PRE-merge base, and resetting
    // there throws the pulled remote commit away — the branch silently goes a
    // commit behind the remote, with the file it carried in "Recently
    // discarded".
    it('keeps the merged-in remote commit when history is not linear', async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(path.join(workspacePath, 'base.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const baseCommit = git(['rev-parse', 'HEAD']).trim();

      fs.writeFileSync(path.join(workspacePath, 'remote.txt'), 'remote\n');
      git(['add', '.']);
      git(['commit', '-m', 'remote']);
      const remoteCommit = git(['rev-parse', 'HEAD']).trim();
      git(['update-ref', 'refs/remotes/origin/main', remoteCommit]);

      git(['reset', '-q', '--hard', baseCommit]);
      fs.writeFileSync(path.join(workspacePath, 'local.txt'), 'local\n');
      git(['add', '.']);
      git(['commit', '-m', 'local']);
      git(['merge', '--no-edit', remoteCommit]);

      const result = await discardLocalCommits(workspacePath, 'Discarded via Gridman on test');

      expect(result).toMatchObject({ discarded: true, commits: 2 });
      expect(git(['rev-parse', 'HEAD']).trim()).toBe(remoteCommit);
      // The pulled file is still there; only the local work moved to the stash
      expect(fs.existsSync(path.join(workspacePath, 'remote.txt'))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, 'local.txt'))).toBe(false);
    });

    // Same shape, other direction: a --no-ff merge makes the local commit count
    // deeper than the first-parent chain, so HEAD~<count> is not a commit at all
    // and git answers "fatal: ambiguous argument" — raw git text in a toast.
    it('resets to the last published commit when local work was merged with --no-ff', async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(path.join(workspacePath, 'base.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const baseCommit = git(['rev-parse', 'HEAD']).trim();
      git(['update-ref', 'refs/remotes/origin/main', baseCommit]);

      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-q', '-b', 'work']);
      for (const name of ['one', 'two', 'three']) {
        fs.writeFileSync(path.join(workspacePath, `${name}.txt`), `${name}\n`);
        git(['add', '.']);
        git(['commit', '-m', `local ${name}`]);
      }
      git(['checkout', '-q', mainBranch]);
      git(['merge', '--no-ff', '--no-edit', 'work']);

      const result = await discardLocalCommits(workspacePath, 'Discarded via Gridman on test');

      expect(result).toMatchObject({ discarded: true, commits: 4 });
      expect(git(['rev-parse', 'HEAD']).trim()).toBe(baseCommit);
      expect(await listStashes(workspacePath)).toHaveLength(1);
    });

    // Two remote branches merged locally: no single commit can be reset to
    // without deleting one of them, so the button has to say so rather than
    // pick one.
    it('refuses when the branch merges more than one published line', async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      fs.writeFileSync(path.join(workspacePath, 'base.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const baseCommit = git(['rev-parse', 'HEAD']).trim();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';

      const publishedBranch = (name) => {
        git(['checkout', '-q', baseCommit]);
        git(['checkout', '-q', '-b', name]);
        fs.writeFileSync(path.join(workspacePath, `${name}.txt`), `${name}\n`);
        git(['add', '.']);
        git(['commit', '-m', name]);
        const head = git(['rev-parse', 'HEAD']).trim();
        git(['update-ref', `refs/remotes/origin/${name}`, head]);
        return head;
      };
      const first = publishedBranch('ra');
      const second = publishedBranch('rb');

      git(['checkout', '-q', mainBranch]);
      git(['merge', '--no-edit', first]);
      git(['merge', '--no-edit', second]);

      const result = await discardLocalCommits(workspacePath, 'Discarded via Gridman on test');

      expect(result).toMatchObject({ discarded: false });
      expect(result.reason).toContain('more than one published line of history');
      // Nothing moved: both published commits are still reachable
      expect(git(['merge-base', '--is-ancestor', first, 'HEAD'])).toBe('');
      expect(git(['merge-base', '--is-ancestor', second, 'HEAD'])).toBe('');
      expect(await listStashes(workspacePath)).toEqual([]);
    });

    // The remote branch was deleted on the server and something pruned the
    // tracking ref — VS Code, SourceTree and GitHub Desktop all prune on fetch —
    // so branch.<name>.merge still names a ref that no longer exists. git then
    // answers "fatal: ambiguous argument '@{upstream}': unknown revision", the
    // same words a broken repository produces, and reading that as "broken
    // repository" put raw git text (argv and all) back in the toast on one of
    // the most ordinary states a branch can be in.
    it('discards local commits after the upstream ref was pruned', async () => {
      await initWorkspaceGit({ workspacePath });
      configureIdentity();
      git(['remote', 'add', 'origin', 'https://example.com/ws.git']);
      fs.writeFileSync(path.join(workspacePath, 'base.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const baseCommit = git(['rev-parse', 'HEAD']).trim();
      git(['update-ref', 'refs/remotes/origin/main', baseCommit]);

      // `git push -u origin feature`: the tracking ref exists and the branch is
      // configured against it.
      git(['checkout', '-q', '-b', 'feature']);
      fs.writeFileSync(path.join(workspacePath, 'one.txt'), 'one\n');
      git(['add', '.']);
      git(['commit', '-m', 'published']);
      git(['update-ref', 'refs/remotes/origin/feature', git(['rev-parse', 'HEAD']).trim()]);
      git(['branch', '--set-upstream-to=origin/feature', 'feature']);

      // ...the branch is deleted on the server and a fetch --prune removes the
      // tracking ref, while branch.feature.merge stays behind.
      git(['update-ref', '-d', 'refs/remotes/origin/feature']);
      fs.writeFileSync(path.join(workspacePath, 'two.txt'), 'two\n');
      git(['add', '.']);
      git(['commit', '-m', 'after the prune']);

      expect(() => git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).toThrow();
      expect(git(['config', '--get', 'branch.feature.merge']).trim()).toBe('refs/heads/feature');

      const result = await discardLocalCommits(workspacePath, 'Discarded via Gridman on test');

      expect(result).toMatchObject({ discarded: true, commits: 2, stashed: true });
      expect(git(['rev-parse', 'HEAD']).trim()).toBe(baseCommit);
      expect(fs.existsSync(path.join(workspacePath, 'two.txt'))).toBe(false);
      expect(await listStashes(workspacePath)).toHaveLength(1);
    });

    it('refuses while a merge is in progress', async () => {
      await commitSequence();
      const mainBranch = (await getCurrentGitBranch(workspacePath)) || 'master';
      git(['checkout', '-b', 'feature']);
      fs.writeFileSync(path.join(workspacePath, 'c.txt'), 'feature\n');
      git(['commit', '-am', 'feature edit']);
      git(['checkout', mainBranch]);
      fs.writeFileSync(path.join(workspacePath, 'c.txt'), 'main\n');
      git(['commit', '-am', 'main edit']);
      expect(() => git(['merge', 'feature'])).toThrow();

      await expect(discardLocalCommits(workspacePath, 'Discarded via Gridman on test'))
        .rejects.toThrow('A merge is in progress — abort it first, then discard local commits');
    });
  });
});
