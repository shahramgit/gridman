/**
 * MOVING AN ENVIRONMENT VARIABLE UP OR DOWN.
 *
 * Requested by users. Every other editable table in the app reorders by dragging, but this
 * one is virtualised (TableVirtuoso) where rows unmount mid-gesture, so it uses buttons —
 * which is also what makes it usable from a keyboard.
 *
 * The rule that is easy to get wrong: the table always keeps a trailing empty row for
 * typing a new variable into. It must stay last. Swapping a real row past it would move
 * the input the user is about to type in.
 *
 * Imports the SAME function the table calls, rather than restating it — a spec that
 * reimplements the rule it is checking proves nothing about the component. Not a render
 * test because the table pulls in CodeMirror through MultiLineEditor, and the ordering is
 * what matters.
 */

import { moveEnvironmentVariable as moveVar, movableRowCount } from './reorder';

const names = (rows) => rows.map((r) => r.name);
const withTrailingEmpty = () => [
  { uid: '1', name: 'alpha' },
  { uid: '2', name: 'beta' },
  { uid: '3', name: 'gamma' },
  { uid: '4', name: '' }
];

describe('reordering environment variables', () => {
  it('moves a row down', () => {
    expect(names(moveVar(withTrailingEmpty(), 0, 1))).toEqual(['beta', 'alpha', 'gamma', '']);
  });

  it('moves a row up', () => {
    expect(names(moveVar(withTrailingEmpty(), 2, -1))).toEqual(['alpha', 'gamma', 'beta', '']);
  });

  it('never moves a row past the trailing empty row', () => {
    // gamma is the LAST real row; moving it down would swap it with the input row.
    expect(names(moveVar(withTrailingEmpty(), 2, 1))).toEqual(['alpha', 'beta', 'gamma', '']);
  });

  it('never moves the trailing empty row itself', () => {
    expect(names(moveVar(withTrailingEmpty(), 3, -1))).toEqual(['alpha', 'beta', 'gamma', '']);
  });

  it('does nothing at the top', () => {
    expect(names(moveVar(withTrailingEmpty(), 0, -1))).toEqual(['alpha', 'beta', 'gamma', '']);
  });

  it('treats a whitespace-only name as the empty row', () => {
    const rows = [{ uid: '1', name: 'alpha' }, { uid: '2', name: 'beta' }, { uid: '3', name: '   ' }];
    expect(names(moveVar(rows, 1, 1))).toEqual(['alpha', 'beta', '   ']);
  });

  it('moves the last row when there is no trailing empty row', () => {
    const rows = [{ uid: '1', name: 'alpha' }, { uid: '2', name: 'beta' }];
    expect(names(moveVar(rows, 0, 1))).toEqual(['beta', 'alpha']);
  });

  it('keeps every row — a reorder must never drop or duplicate one', () => {
    const before = withTrailingEmpty();
    const after = moveVar(before, 1, 1);
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.uid).sort()).toEqual(before.map((r) => r.uid).sort());
  });

  it('returns the SAME array when the move is refused, so no state update happens', () => {
    const rows = withTrailingEmpty();
    expect(moveVar(rows, 0, -1)).toBe(rows);
    expect(moveVar(rows, 3, -1)).toBe(rows);
  });

  it('counts movable rows without the trailing placeholder', () => {
    expect(movableRowCount(withTrailingEmpty())).toBe(3);
    expect(movableRowCount([{ uid: '1', name: 'a' }, { uid: '2', name: 'b' }])).toBe(2);
    expect(movableRowCount([])).toBe(0);
  });
});
