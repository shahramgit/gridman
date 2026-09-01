import path from 'path';
import { getSubdirectoriesFromRoot } from './platform';

// The function resolves through the app's path shim, which picks win32 vs posix
// from `isWindowsOS()` — and that reads the BROWSER user agent. Under jsdom the
// agent never says Windows, so the shim is posix even when the suite is running
// on Windows. Building fixtures from Node's `path.sep` therefore produced
// backslash paths that the posix shim could not split, and these failed only on
// a Windows host. Posix literals keep the fixtures and the shim in agreement
// wherever the suite runs.

/**
 * A PATH OUTSIDE THE COLLECTION HAS NO FOLDERS INSIDE IT.
 *
 * Transient requests live in a temp directory outside the collection, so `path.relative`
 * returned a '..'-prefixed path and every segment of it — including the '..' — was rendered
 * as a folder in the sidebar tree. usebruno/bruno#8977.
 */
describe('getSubdirectoriesFromRoot', () => {
  const root = '/w/collection';

  it('returns the folders between the root and a file inside it', () => {
    expect(getSubdirectoriesFromRoot(root, '/w/collection/Api/v1/r.bru'))
      .toEqual(['Api', 'v1', 'r.bru']);
  });

  it('returns nothing for a path that walks out of the root', () => {
    // A transient request's temp directory. This used to yield ['..','..','tmp',…].
    expect(getSubdirectoriesFromRoot(root, '/tmp/gridman/r.bru')).toEqual([]);
  });

  it('returns nothing for the root itself', () => {
    expect(getSubdirectoriesFromRoot(root, root)).toEqual([]);
  });

  it('returns nothing when relative() yields an absolute path', () => {
    // On Windows, relative() across drive letters returns an absolute path rather
    // than a '..' walk — the '..' check alone would miss it.
    const spy = jest.spyOn(path, 'relative').mockReturnValue('/elsewhere/r.bru');
    expect(getSubdirectoriesFromRoot(root, 'anything')).toEqual([]);
    spy.mockRestore();
  });
});
