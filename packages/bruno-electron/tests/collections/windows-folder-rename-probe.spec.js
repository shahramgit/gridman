const fs = require('fs');
const os = require('os');
const path = require('path');
const chokidar = require('chokidar');
const { withWatchReleased } = require('../../src/app/watch-release');

/**
 * DOES OUR OWN WATCHER BLOCK A FOLDER RENAME? ASK THE OPERATING SYSTEM.
 *
 * The Windows folder-rename report could not be reproduced on macOS, and two
 * fixes went out on reasoning alone. This asks the OS directly instead: it
 * builds a folder tree, watches it with the SAME chokidar options the
 * collection watcher uses, and tries to rename a watched subdirectory.
 *
 * It is not a unit test of our code — it is a probe of the platform, and it is
 * meant to run on a windows-latest CI runner. On macOS and Linux it documents
 * that the rename succeeds even while watched, which is exactly why the bug was
 * invisible here.
 *
 * Read the console output: it prints what the platform actually did.
 */

const WATCH_OPTIONS = {
  ignoreInitial: false,
  usePolling: false,
  persistent: true,
  ignorePermissionErrors: true,
  awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 10 },
  depth: 20,
  disableGlobbing: true
};

let root;

const buildTree = () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-winprobe-'));
  const folder = path.join(root, 'Auth');
  fs.mkdirSync(path.join(folder, 'Admin', 'Deep'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'folder.bru'), 'meta {\n  name: Auth\n}\n');
  fs.writeFileSync(path.join(folder, 'login.bru'), 'meta {\n  name: login\n}\n');
  fs.writeFileSync(path.join(folder, 'Admin', 'Deep', 'x.bru'), 'meta {\n  name: x\n}\n');
  return folder;
};

const startWatcher = (target) =>
  new Promise((resolve) => {
    const watcher = chokidar.watch(target, WATCH_OPTIONS);
    watcher.on('ready', () => resolve(watcher));
  });

const attemptRename = (from, to) => {
  try {
    fs.renameSync(from, to);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
};

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe(`renaming a watched directory on ${process.platform}`, () => {
  it('reports what the platform does when the folder is being watched', async () => {
    const folder = buildTree();
    const watcher = await startWatcher(root);

    const result = attemptRename(folder, path.join(root, 'Authentication'));
    await watcher.close();

    console.log(`[probe] platform=${process.platform} watched-rename=${result.ok ? 'ALLOWED' : `BLOCKED ${result.code}`}`);
    if (!result.ok) console.log(`[probe] ${result.message}`);

    if (process.platform === 'win32') {
      // Whatever Windows says, say it out loud rather than asserting a guess.
      // A BLOCKED result here is the reported bug, reproduced.
      expect(['EPERM', 'EBUSY', 'EACCES', undefined]).toContain(result.code);
    } else {
      // The reason this was invisible on macOS: FSEvents holds no handle.
      expect(result.ok).toBe(true);
    }
  }, 30000);

  it('succeeds on every platform once the watcher is CLOSED first', async () => {
    const folder = buildTree();
    const target = path.join(root, 'Authentication');
    const watcher = await startWatcher(root);

    // What suspendForMove does. Measured on Windows 11: unwatch() does NOT
    // release the handle — not immediately and not after two seconds — while
    // close() does. That is the whole reason the first attempt at this fix
    // shipped and changed nothing.
    await watcher.close();
    const result = attemptRename(folder, target);

    console.log(`[probe] platform=${process.platform} closed-rename=${result.ok ? 'ALLOWED' : `BLOCKED ${result.code}`}`);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  }, 30000);

  it('records that unwatch alone is NOT enough', async () => {
    const folder = buildTree();
    const watcher = await startWatcher(root);

    watcher.unwatch(folder);
    await new Promise((r) => setTimeout(r, 300));
    const result = attemptRename(folder, path.join(root, 'Authentication'));
    await watcher.close();

    console.log(`[probe] platform=${process.platform} unwatch-rename=${result.ok ? 'ALLOWED' : `BLOCKED ${result.code}`}`);
    if (process.platform === 'win32') {
      // Pinned deliberately: if a future chokidar makes unwatch release the
      // handle, this fails and the cheaper release becomes available again.
      expect(result.ok).toBe(false);
    } else {
      expect(result.ok).toBe(true);
    }
  }, 30000);
});
