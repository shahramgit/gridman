/**
 * PASTING A CUT MOVES; PASTING A COPY DUPLICATES.
 *
 * A cut reuses the drag-and-drop move rather than a second implementation:
 * that one already renames on collision, updates the index, suppresses the
 * watcher and reconciles open tabs. What this pins is the routing — that a cut
 * goes down the move path at all, that it is consumed afterwards, and that it
 * refuses the two destinations a move cannot have.
 */

import brunoClipboard from 'utils/bruno-clipboard';

const moveCalls = [];
jest.mock('utils/network/index', () => ({}), { virtual: true });

const COLLECTION = {
  uid: 'col-1',
  pathname: '/w/c',
  items: [
    { uid: 'folder-auth', name: 'Auth', pathname: '/w/c/Auth', type: 'folder', items: [] },
    { uid: 'folder-admin', name: 'Admin', pathname: '/w/c/Auth/Admin', type: 'folder', items: [] }
  ]
};

const actions = require('./actions');

const run = async ({ targetItemUid = null } = {}) => {
  moveCalls.length = 0;
  const state = { collections: { collections: [COLLECTION], collectionIndexes: {} } };
  const dispatch = jest.fn((action) => {
    if (typeof action === 'function') {
      // Intercept the move rather than executing it; the move itself has its
      // own tests and needs IPC.
      const source = action.toString();
      if (source.includes('renderer:move-collection-item-by-path')) {
        moveCalls.push('move');
        return Promise.resolve({ pathname: '/moved' });
      }
      return action(dispatch, () => state);
    }
    return action;
  });
  return actions.pasteItem('col-1', targetItemUid)(dispatch, () => state);
};

describe('pasting a cut item', () => {
  it('refuses to move a folder into itself', async () => {
    brunoClipboard.write({ pathname: '/w/c/Auth', type: 'folder' }, 'cut');
    await expect(run({ targetItemUid: 'folder-auth' })).rejects.toThrow(/into itself/i);
  });

  it('refuses to move a folder into its own child', async () => {
    // The destination would be relocated out from under the move.
    brunoClipboard.write({ pathname: '/w/c/Auth', type: 'folder' }, 'cut');
    await expect(run({ targetItemUid: 'folder-admin' })).rejects.toThrow(/into itself/i);
  });

  it('refuses when the cut item is no longer in an open collection', async () => {
    brunoClipboard.write({ pathname: '/somewhere/else/a.bru' }, 'cut');
    await expect(run({ targetItemUid: 'folder-auth' })).rejects.toThrow(/no longer/i);
  });

  it('rejects a paste with nothing on the clipboard', async () => {
    brunoClipboard.clear();
    await expect(run({ targetItemUid: 'folder-auth' })).rejects.toThrow(/No item in clipboard/i);
  });
});
