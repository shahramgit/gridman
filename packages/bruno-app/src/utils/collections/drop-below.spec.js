import { getReorderedItemsInTargetDirectory, determineCollectionItemDrop, isAdjacentDrop } from './index';

/**
 * THE LAST ROW OF A LIST HAS TO BE REACHABLE.
 *
 * The sidebar had one adjacent drop type and it always meant "above", so there
 * was no gesture for "put this at the end": dropping a folder on the bottom
 * folder inserted it BEFORE that folder and it came second to last, every time,
 * wherever in the row the pointer was. On a request row it was worse — the
 * bottom half returned no drop type at all, so half of every row silently
 * refused the drop. Upstream reported the folder half as #8722.
 *
 * Two halves to get right and both are tested here: the zone the pointer is in,
 * and the reorder that follows from it.
 */

const folders = () => [
  { uid: 'a', name: 'Alpha', seq: 1, items: [] },
  { uid: 'b', name: 'Beta', seq: 2, items: [] },
  { uid: 'c', name: 'Gamma', seq: 3, items: [] }
];

// Merge the changed rows back over the originals so the assertion is about the
// order the user ends up looking at, not about which rows happened to change.
const orderAfter = ({ targetItemUid, draggedItemUid, dropType }) => {
  const changed = getReorderedItemsInTargetDirectory({ items: folders(), targetItemUid, draggedItemUid, dropType });
  return folders()
    .map((f) => changed.find((c) => c.uid === f.uid) || f)
    .sort((x, y) => x.seq - y.seq)
    .map((f) => f.uid)
    .join(',');
};

describe('reordering siblings', () => {
  it('moves an item to the END when dropped below the last one', () => {
    // The bug: this used to produce b,a,c — Alpha could not reach the bottom.
    expect(orderAfter({ targetItemUid: 'c', draggedItemUid: 'a', dropType: 'below' })).toBe('b,c,a');
  });

  it('moves an item to the START when dropped above the first one', () => {
    expect(orderAfter({ targetItemUid: 'a', draggedItemUid: 'c', dropType: 'above' })).toBe('c,a,b');
  });

  it('drops above a middle row', () => {
    expect(orderAfter({ targetItemUid: 'b', draggedItemUid: 'c', dropType: 'above' })).toBe('a,c,b');
  });

  it('drops below a middle row', () => {
    expect(orderAfter({ targetItemUid: 'b', draggedItemUid: 'a', dropType: 'below' })).toBe('b,a,c');
  });

  it('is a no-op when the drop lands where the item already is', () => {
    // Dropping Beta below Alpha is where Beta already sits; renumbering every
    // sibling for that would write every folder.bru in the directory.
    expect(getReorderedItemsInTargetDirectory({ items: folders(), targetItemUid: 'a', draggedItemUid: 'b', dropType: 'below' })).toEqual([]);
  });

  it('returns nothing when either row is not in the list', () => {
    expect(getReorderedItemsInTargetDirectory({ items: folders(), targetItemUid: 'zz', draggedItemUid: 'a', dropType: 'below' })).toEqual([]);
  });

  it('defaults to above, which is what the collection header row still sends', () => {
    expect(orderAfter({ targetItemUid: 'c', draggedItemUid: 'a' })).toBe('b,a,c');
    expect(isAdjacentDrop('adjacent')).toBe(true);
  });
});

describe('which zone of a row the pointer is in', () => {
  const rect = { top: 100, height: 20 };
  const at = (offsetWithinRow, isFolder) =>
    determineCollectionItemDrop({ isFolder, hoverBoundingRect: rect, clientOffset: { y: rect.top + offsetWithinRow } });

  it('gives a folder three zones', () => {
    expect(at(2, true)).toBe('above');
    expect(at(10, true)).toBe('inside');
    expect(at(18, true)).toBe('below');
  });

  it('gives a request two, with no dead half', () => {
    expect(at(4, false)).toBe('above');
    // Used to be null: the drop was refused with no indicator and no feedback.
    expect(at(16, false)).toBe('below');
  });

  it('has no gap between a folder\'s zones', () => {
    for (let y = 0; y <= 20; y += 1) {
      expect(['above', 'inside', 'below']).toContain(at(y, true));
    }
  });

  it('returns null rather than guessing when the pointer is unknown', () => {
    expect(determineCollectionItemDrop({ isFolder: true, hoverBoundingRect: rect, clientOffset: null })).toBeNull();
    expect(determineCollectionItemDrop({ isFolder: true, hoverBoundingRect: null, clientOffset: { y: 1 } })).toBeNull();
  });
});
