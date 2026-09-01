const path = require('path');

/**
 * MOVING A WATCHED DIRECTORY ON WINDOWS NEEDS THE WATCHER CLOSED, NOT UNWATCHED.
 *
 * Measured on Windows 11 with chokidar 3.6 and the collection watcher's own
 * options (usePolling false, depth 20). Renaming a watched subdirectory fails
 * with EPERM, and `unwatch()` does not release the handle — not immediately and
 * not after seconds:
 *
 *     no-watcher                ALLOWED     close()               ALLOWED
 *     no-watcher + open file    BLOCKED     unwatch(folder)       BLOCKED
 *     watching                  BLOCKED     unwatch(folder) + 2s  BLOCKED
 *     watching depth:0          ALLOWED     unwatch(root)         BLOCKED
 *     watching usePolling       ALLOWED
 *
 * An earlier version of this file used unwatch/rewatch and did nothing at all;
 * closing is the only release that works. macOS allows the rename either way,
 * which is why none of this was visible from a developer machine.
 *
 * Note the second row: a file held open INSIDE the folder blocks the rename
 * too, with no watcher involved. Closing ours removes the cause we control; an
 * editor, a terminal or antivirus holding a file can still block it, and that
 * failure is the user's to resolve.
 */
const withWatchReleased = async (watcher, { sourcePathname, targetPathname }, run) => {
  // Only a directory move needs this, and only the collection that contains it.
  const watchPath = watcher?.getWatcherByItemPath?.(sourcePathname)
    ? findWatchPath(watcher, sourcePathname)
    : null;

  if (!watchPath || !watcher?.suspendForMove) {
    return run();
  }

  const suspended = watcher.suspendForMove(watchPath);
  if (!suspended) {
    return run();
  }

  try {
    return await run();
  } finally {
    // Always: the collection must not be left unwatched, whether the move
    // succeeded, failed, or threw something unexpected. Without this a failed
    // rename would silently stop the sidebar updating for the rest of the
    // session — worse than the bug being fixed.
    watcher.resumeAfterMove(suspended);
  }
};

// The watched root that contains this path — the collection directory, not the
// item. `getWatcherByItemPath` finds the instance; this finds its key.
const findWatchPath = (watcher, itemPath) => {
  const normalized = path.resolve(String(itemPath || ''));
  const candidates = Object.keys(watcher.watchers || {}).filter((watchPath) => {
    if (!watcher.watchers[watchPath]) return false;
    const root = path.resolve(watchPath);
    return normalized === root || normalized.startsWith(root + path.sep);
  });
  // Deepest match wins, so a collection nested inside another is handled.
  return candidates.sort((a, b) => b.length - a.length)[0] || null;
};

module.exports = { withWatchReleased };
