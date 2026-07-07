import { doesTabMatchRequestNode } from './index';

// The unified (indexed) sidebar must recognize an already-open request tab
// whether it was opened by the sidebar itself (synthetic uid + itemPathname)
// or by the new-request task middleware — curl paste / New Request — which
// keys the tab by the request's real uid + itemUid without an itemPathname.
describe('doesTabMatchRequestNode', () => {
  const node = { collectionUid: 'col', pathname: '/ws/col/api/get-user.bru', uid: 'req-uid' };

  it('matches an indexed-style tab by itemPathname', () => {
    const tab = { collectionUid: 'col', uid: 'indexed-request:col:/ws/col/api/get-user.bru', itemPathname: '/ws/col/api/get-user.bru' };
    expect(doesTabMatchRequestNode(tab, node)).toBe(true);
  });

  it('matches a new-request-middleware tab by uid (no itemPathname)', () => {
    const tab = { collectionUid: 'col', uid: 'req-uid' };
    expect(doesTabMatchRequestNode(tab, node)).toBe(true);
  });

  it('matches by itemUid', () => {
    const tab = { collectionUid: 'col', uid: 'some-other-uid', itemUid: 'req-uid' };
    expect(doesTabMatchRequestNode(tab, node)).toBe(true);
  });

  it('normalizes path separators and trailing slashes when comparing itemPathname', () => {
    const tab = { collectionUid: 'col', itemPathname: '\\ws\\col\\api\\get-user.bru' };
    expect(doesTabMatchRequestNode(tab, node)).toBe(true);
  });

  it('does not match a tab from a different collection', () => {
    const tab = { collectionUid: 'other', itemPathname: node.pathname };
    expect(doesTabMatchRequestNode(tab, node)).toBe(false);
  });

  it('does not match an unrelated request (different path and uid)', () => {
    const tab = { collectionUid: 'col', uid: 'x', itemUid: 'y', itemPathname: '/ws/col/api/other.bru' };
    expect(doesTabMatchRequestNode(tab, node)).toBe(false);
  });

  it('is safe on null tab / missing node fields', () => {
    expect(doesTabMatchRequestNode(null, node)).toBe(false);
    expect(doesTabMatchRequestNode({ collectionUid: 'col' }, { collectionUid: 'col' })).toBe(false);
  });
});
