const EventEmitter = require('events');
const path = require('path');

// Tracks which workspace git roots currently have a mutating git operation
// (checkout, pull, sync, merge, conflict resolution) in flight.
//
// While an operation runs, git rewrites large parts of the working tree and the
// chokidar collection watcher would otherwise process thousands of per-file
// add/change/unlink events — parsing each file and dispatching an IPC message —
// which freezes the UI on big collections (worse on Windows/Linux than macOS's
// coalescing FSEvents backend). The watcher consults this registry to skip that
// churn and, when the operation finishes, performs a single efficient reindex.

// chokidar's awaitWriteFinish delays events ~80ms, so events from the operation
// can land just after git returns. Keep the root "active" for a short grace
// window after the operation completes to absorb that trailing burst before we
// reindex.
const GRACE_PERIOD_MS = 750;

const activeGitRoots = new Map(); // normalized root -> { count, graceTimer }
const emitter = new EventEmitter();

const normalizeRoot = (value) =>
  path.resolve(String(value || '')).replace(/\\/g, '/').replace(/\/+$/, '');

const beginGitOperation = (gitRootPath) => {
  const key = normalizeRoot(gitRootPath);
  if (!key) {
    return;
  }
  const entry = activeGitRoots.get(key) || { count: 0, graceTimer: null };
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  entry.count += 1;
  activeGitRoots.set(key, entry);
};

const endGitOperation = (gitRootPath) => {
  const key = normalizeRoot(gitRootPath);
  const entry = activeGitRoots.get(key);
  if (!entry) {
    return;
  }
  entry.count -= 1;
  if (entry.count > 0) {
    return;
  }

  entry.count = 0;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
  }
  entry.graceTimer = setTimeout(() => {
    activeGitRoots.delete(key);
    emitter.emit('git-operation-end', { gitRootPath: key });
  }, GRACE_PERIOD_MS);
};

const isPathUnderActiveGitOperation = (pathname) => {
  if (!activeGitRoots.size) {
    return false;
  }
  const target = normalizeRoot(pathname);
  if (!target) {
    return false;
  }
  for (const root of activeGitRoots.keys()) {
    if (target === root || target.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
};

module.exports = {
  beginGitOperation,
  endGitOperation,
  isPathUnderActiveGitOperation,
  gitOperationEvents: emitter
};
