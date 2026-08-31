/**
 * MOVING A WATCHED DIRECTORY NEEDS THE WATCH DROPPED FIRST.
 *
 * chokidar without polling uses ReadDirectoryChangesW on Windows, which keeps
 * an open handle on every directory it watches — and the collection watcher
 * runs at `depth: 20`, so that is a folder AND everything under it. Windows
 * refuses to rename a directory that has an open handle, so our own watcher was
 * holding the folder the user was trying to rename.
 *
 * That is why it was Windows-only (macOS FSEvents holds nothing), why it
 * survived restarting the app (the watcher re-attaches on load), and why
 * renaming from a folder's TAB worked — the tab sends no newFilename, so no
 * directory ever moves.
 *
 * `unlinkItemPathInWatcher` / `addItemPathInWatcher` already existed on the
 * watcher for exactly this and had no callers anywhere.
 */
const withWatchReleased = async (watcher, { sourcePathname, targetPathname }, run) => {
  if (!watcher?.unlinkItemPathInWatcher || !sourcePathname) {
    return run();
  }

  watcher.unlinkItemPathInWatcher(sourcePathname);

  let result;
  try {
    result = await run();
  } catch (error) {
    // Put the watch back where the directory still is. Restoring it on the
    // target instead would leave the folder unwatched for the rest of the
    // session, so edits inside it would stop reaching the sidebar.
    watcher.addItemPathInWatcher?.(sourcePathname);
    throw error;
  }

  watcher.addItemPathInWatcher?.(targetPathname || sourcePathname);
  return result;
};

module.exports = { withWatchReleased };
