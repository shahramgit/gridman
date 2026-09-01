const path = require('path');
const { withWatchReleased } = require('../../src/app/watch-release');

/**
 * MOVING A WATCHED DIRECTORY NEEDS THE WATCHER CLOSED, NOT UNWATCHED.
 *
 * Measured on Windows 11 with chokidar 3.6 and the collection watcher's own
 * options (usePolling false, depth 20):
 *
 *     no-watcher                ALLOWED     close()               ALLOWED
 *     no-watcher + open file    BLOCKED     unwatch(folder)       BLOCKED
 *     watching                  BLOCKED     unwatch(folder) + 2s  BLOCKED
 *     watching depth:0          ALLOWED     unwatch(root)         BLOCKED
 *     watching usePolling       ALLOWED
 *
 * The first version of this shipped with unwatch/rewatch and did nothing at
 * all. What is pinned here is the property that made the difference: the
 * watcher is CLOSED for the move and always brought back, including when the
 * move throws — a collection left unwatched stops updating the sidebar for the
 * rest of the session, which is worse than the bug being fixed.
 */

const COLLECTION = path.resolve('/w/c');
const FOLDER = path.join(COLLECTION, 'Auth');
const TARGET = path.join(COLLECTION, 'Authentication');

const makeWatcher = (calls, { watching = [COLLECTION] } = {}) => {
  const watchers = {};
  for (const p of watching) watchers[p] = { close: () => {} };
  return {
    watchers,
    watcherMeta: { [COLLECTION]: { collectionUid: 'col-1', win: {}, brunoConfig: {} } },
    getWatcherByItemPath: (itemPath) =>
      Object.keys(watchers).find((w) => path.resolve(itemPath).startsWith(path.resolve(w))) ? {} : null,
    suspendForMove: (p) => {
      calls.push(['suspend', p]);
      return { watchPath: p, collectionUid: 'col-1', win: {}, brunoConfig: {} };
    },
    resumeAfterMove: (s) => calls.push(['resume', s.watchPath])
  };
};

describe('moving a directory inside a watched collection', () => {
  it('closes the collection watcher for the move and brings it back', async () => {
    const calls = [];
    await withWatchReleased(makeWatcher(calls), { sourcePathname: FOLDER, targetPathname: TARGET }, async () => {
      calls.push(['move']);
    });

    expect(calls).toEqual([['suspend', COLLECTION], ['move'], ['resume', COLLECTION]]);
  });

  it('suspends the COLLECTION, not the folder being moved', async () => {
    // Closing only the folder's own watch is what unwatch did, and Windows
    // ignores it — the handle lives on the instance watching the tree.
    const calls = [];
    await withWatchReleased(makeWatcher(calls), { sourcePathname: FOLDER, targetPathname: TARGET }, async () => {});
    expect(calls[0]).toEqual(['suspend', COLLECTION]);
  });

  it('brings the watcher back when the move throws', async () => {
    const calls = [];
    const boom = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

    await expect(
      withWatchReleased(makeWatcher(calls), { sourcePathname: FOLDER, targetPathname: TARGET }, async () => {
        throw boom;
      })
    ).rejects.toMatchObject({ code: 'EPERM' });

    expect(calls).toEqual([['suspend', COLLECTION], ['resume', COLLECTION]]);
  });

  it('returns whatever the move returned', async () => {
    const result = await withWatchReleased(makeWatcher([]), { sourcePathname: FOLDER, targetPathname: TARGET },
      async () => 'moved');
    expect(result).toBe('moved');
  });

  it('picks the deepest watched root when collections are nested', async () => {
    const inner = path.join(COLLECTION, 'inner');
    const calls = [];
    const watcher = makeWatcher(calls, { watching: [COLLECTION, inner] });
    watcher.watcherMeta[inner] = { collectionUid: 'col-2', win: {}, brunoConfig: {} };

    await withWatchReleased(watcher, { sourcePathname: path.join(inner, 'Auth'), targetPathname: TARGET }, async () => {});
    expect(calls[0]).toEqual(['suspend', inner]);
  });

  it('just runs the move when nothing is watching that path', async () => {
    const calls = [];
    let ran = false;
    await withWatchReleased(makeWatcher(calls, { watching: [] }), { sourcePathname: '/elsewhere/x', targetPathname: '/elsewhere/y' },
      async () => { ran = true; });

    expect(ran).toBe(true);
    expect(calls).toEqual([]);
  });

  it('just runs the move when there is no watcher at all', async () => {
    let ran = false;
    await withWatchReleased(null, { sourcePathname: FOLDER, targetPathname: TARGET }, async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
