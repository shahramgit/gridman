const { withWatchReleased } = require('../../src/app/watch-release');

/**
 * THE WATCH HAS TO BE OFF WHILE A DIRECTORY MOVES, AND BACK ON AFTERWARDS.
 *
 * chokidar without polling uses ReadDirectoryChangesW on Windows, which keeps
 * an open handle on every directory it watches (`depth: 20`, so the folder and
 * everything under it). Windows refuses to rename a directory that has an open
 * handle — so our own watcher was holding the folder the user was renaming.
 *
 * Windows-only because macOS FSEvents holds nothing. Survived restarting the
 * app because the watcher re-attaches on load. And renaming from a folder's TAB
 * worked because that path sends no newFilename, so no directory ever moves.
 *
 * What matters is the ORDER, and that a failure does not leave the folder
 * unwatched — that would silently stop sidebar updates for the rest of the
 * session, which is worse than the bug being fixed.
 */

const makeWatcher = (calls) => ({
  unlinkItemPathInWatcher: (p) => calls.push(['unwatch', p]),
  addItemPathInWatcher: (p) => calls.push(['watch', p])
});

const SOURCE = '/w/c/Auth';
const TARGET = '/w/c/Authentication';

describe('moving a watched directory', () => {
  it('unwatches before the move and watches the target after', async () => {
    const calls = [];
    await withWatchReleased(makeWatcher(calls), { sourcePathname: SOURCE, targetPathname: TARGET }, async () => {
      calls.push(['move']);
    });

    expect(calls).toEqual([['unwatch', SOURCE], ['move'], ['watch', TARGET]]);
  });

  it('returns whatever the move returned', async () => {
    const result = await withWatchReleased(makeWatcher([]), { sourcePathname: SOURCE, targetPathname: TARGET },
      async () => 'moved');
    expect(result).toBe('moved');
  });

  it('restores the watch on the SOURCE when the move fails', async () => {
    const calls = [];
    const boom = new Error('EPERM: operation not permitted');

    await expect(
      withWatchReleased(makeWatcher(calls), { sourcePathname: SOURCE, targetPathname: TARGET }, async () => {
        throw boom;
      })
    ).rejects.toThrow(boom);

    // Not the target: the directory is still at the source, and watching a
    // path that does not exist leaves the real folder unwatched.
    expect(calls).toEqual([['unwatch', SOURCE], ['watch', SOURCE]]);
  });

  it('rethrows the original error, so the user sees the real reason', async () => {
    const boom = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    await expect(
      withWatchReleased(makeWatcher([]), { sourcePathname: SOURCE, targetPathname: TARGET }, async () => {
        throw boom;
      })
    ).rejects.toMatchObject({ code: 'EBUSY' });
  });

  it('falls back to the source when no target is given', async () => {
    const calls = [];
    await withWatchReleased(makeWatcher(calls), { sourcePathname: SOURCE }, async () => {});
    expect(calls).toEqual([['unwatch', SOURCE], ['watch', SOURCE]]);
  });

  it('still runs the move when there is no watcher at all', async () => {
    let ran = false;
    await withWatchReleased(null, { sourcePathname: SOURCE, targetPathname: TARGET }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('still runs the move when the watcher cannot unwatch', async () => {
    // The temp-directory watcher has no such method; a move must not become
    // impossible because of that.
    let ran = false;
    await withWatchReleased({}, { sourcePathname: SOURCE, targetPathname: TARGET }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
