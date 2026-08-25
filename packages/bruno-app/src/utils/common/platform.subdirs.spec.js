import path from 'path';
import { getSubdirectoriesFromRoot } from './platform';

/**
 * A PATH OUTSIDE THE COLLECTION HAS NO FOLDERS INSIDE IT.
 *
 * Transient requests live in a temp directory outside the collection, so `path.relative`
 * returned a '..'-prefixed path and every segment of it — including the '..' — was rendered
 * as a folder in the sidebar tree. usebruno/bruno#8977.
 */
describe('getSubdirectoriesFromRoot', () => {
  const root = path.join(path.sep, 'w', 'collection');

  it('returns the folders between the root and a file inside it', () => {
    expect(getSubdirectoriesFromRoot(root, path.join(root, 'Api', 'v1', 'r.bru')))
      .toEqual(['Api', 'v1', 'r.bru']);
  });

  it('returns nothing for a path that walks out of the root', () => {
    // A transient request's temp directory. This used to yield ['..','..','tmp',…].
    expect(getSubdirectoriesFromRoot(root, path.join(path.sep, 'tmp', 'gridman', 'r.bru'))).toEqual([]);
  });

  it('returns nothing for the root itself', () => {
    expect(getSubdirectoriesFromRoot(root, root)).toEqual([]);
  });

  it('returns nothing when relative() yields an absolute path', () => {
    // On Windows, relative() across drive letters returns an absolute path rather
    // than a '..' walk — the '..' check alone would miss it.
    const spy = jest.spyOn(path, 'relative').mockReturnValue(path.join(path.sep, 'elsewhere', 'r.bru'));
    expect(getSubdirectoriesFromRoot(root, 'anything')).toEqual([]);
    spy.mockRestore();
  });
});
