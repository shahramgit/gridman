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

describe('the watcher lookup the release depends on (real CollectionWatcher)', () => {
  // A removed collection keeps its key with a null value. The release used to
  // sit behind getWatcherByItemPath, an unanchored prefix match that returned
  // the FIRST key — so after removing collection "X", a folder delete in "X - 1"
  // found X's null entry, skipped the release, and the Windows hang was back.
  const CollectionWatcher = require('../../src/app/collection-watcher');
  const make = () => {
    const w = Object.create(Object.getPrototypeOf(CollectionWatcher));
    w.watchers = {};
    w.watcherMeta = {};
    return w;
  };
  const X = path.resolve('/w/collections/سامانه');
  const X1 = path.resolve('/w/collections/سامانه - 1');

  it('does not pair "X - 1" with a removed "X"', () => {
    const w = make();
    w.watchers[X] = null; // removed earlier in the session
    w.watchers[X1] = { close: () => {} };
    expect(w.getWatcherByItemPath(path.join(X1, 'Api'))).toBe(w.watchers[X1]);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    const w = make();
    w.watchers[X] = { close: () => {} };
    expect(w.getWatcherByItemPath(path.join(X1, 'Api'))).toBeNull();
  });

  it('still suspends "X - 1" for a folder move after "X" was removed', async () => {
    const calls = [];
    const w = make();
    w.watchers[X] = null;
    w.watchers[X1] = { close: () => calls.push('close') };
    w.watcherMeta[X1] = { collectionUid: 'c', win: {}, brunoConfig: {} };
    w.addWatcher = (win, watchPath, uid, cfg, poll, worker, options) => {
      calls.push('resume ' + path.basename(watchPath));
      w.watchers[watchPath] = { close: () => {} };
      options.onReady();
    };
    await withWatchReleased(w, { sourcePathname: path.join(X1, 'Api'), targetPathname: path.join(X1, 'Api') }, async () => calls.push('move'));
    expect(calls).toEqual(['close', 'move', 'resume سامانه - 1']);
  });

  it('waits for the re-attached watcher to be ready before returning', async () => {
    const w = make();
    w.watchers[X1] = { close: () => {} };
    w.watcherMeta[X1] = { collectionUid: 'c', win: {}, brunoConfig: {} };
    let fireReady;
    w.addWatcher = (win, watchPath, uid, cfg, poll, worker, options) => {
      w.watchers[watchPath] = { close: () => {} };
      fireReady = options.onReady;
    };
    let returned = false;
    const op = withWatchReleased(w, { sourcePathname: path.join(X1, 'Api') }, async () => {}).then(() => { returned = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(returned).toBe(false); // a request created now would be missed by a walk still in progress
    fireReady();
    await op;
    expect(returned).toBe(true);
  });
});
