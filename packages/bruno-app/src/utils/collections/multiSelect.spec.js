const { describe, it, expect } = require('@jest/globals');
import { excludeDescendantItems, getRangeUids } from './multiSelect';

describe('excludeDescendantItems', () => {
  const folder = { uid: 'f1', type: 'folder', pathname: '/col/folder' };
  const childRequest = { uid: 'r1', type: 'http-request', pathname: '/col/folder/child.bru' };
  const nestedChild = { uid: 'r2', type: 'http-request', pathname: '/col/folder/sub/deep.bru' };
  const siblingRequest = { uid: 'r3', type: 'http-request', pathname: '/col/sibling.bru' };

  it('drops items that live inside another selected folder', () => {
    const result = excludeDescendantItems([folder, childRequest, nestedChild, siblingRequest]);
    expect(result.map((i) => i.uid)).toEqual(['f1', 'r3']);
  });

  it('keeps everything when no selected folder contains another item', () => {
    const result = excludeDescendantItems([childRequest, siblingRequest]);
    expect(result.map((i) => i.uid)).toEqual(['r1', 'r3']);
  });

  it('drops nested selected folders but keeps the outermost one', () => {
    const subFolder = { uid: 'f2', type: 'folder', pathname: '/col/folder/sub' };
    const result = excludeDescendantItems([folder, subFolder, nestedChild]);
    expect(result.map((i) => i.uid)).toEqual(['f1']);
  });

  it('does not treat prefix-named siblings as descendants', () => {
    const prefixSibling = { uid: 'r4', type: 'http-request', pathname: '/col/folder-two/req.bru' };
    const result = excludeDescendantItems([folder, prefixSibling]);
    expect(result.map((i) => i.uid)).toEqual(['f1', 'r4']);
  });

  it('normalizes windows separators before comparing', () => {
    const winFolder = { uid: 'f1', type: 'folder', pathname: 'C:\\col\\folder' };
    const winChild = { uid: 'r1', type: 'http-request', pathname: 'C:\\col\\folder\\child.bru' };
    const result = excludeDescendantItems([winFolder, winChild]);
    expect(result.map((i) => i.uid)).toEqual(['f1']);
  });

  it('does not exclude items under a selected request (only folders contain)', () => {
    const request = { uid: 'r5', type: 'http-request', pathname: '/col/thing' };
    const lookalike = { uid: 'r6', type: 'http-request', pathname: '/col/thing/child.bru' };
    const result = excludeDescendantItems([request, lookalike]);
    expect(result.map((i) => i.uid)).toEqual(['r5', 'r6']);
  });
});

describe('getRangeUids', () => {
  const visible = ['a', 'b', 'c', 'd', 'e'];

  it('returns the inclusive range top-down', () => {
    expect(getRangeUids(visible, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('returns the inclusive range bottom-up', () => {
    expect(getRangeUids(visible, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('returns a single uid when anchor and target match', () => {
    expect(getRangeUids(visible, 'c', 'c')).toEqual(['c']);
  });

  it('falls back to the target when the anchor is not visible', () => {
    expect(getRangeUids(visible, 'missing', 'c')).toEqual(['c']);
  });

  it('falls back to the target when the target is not visible', () => {
    expect(getRangeUids(visible, 'a', 'missing')).toEqual(['missing']);
  });

  it('returns an empty range without a target', () => {
    expect(getRangeUids(visible, 'a', undefined)).toEqual([]);
  });
});
