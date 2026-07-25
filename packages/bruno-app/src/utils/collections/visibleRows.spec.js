const { describe, it, expect } = require('@jest/globals');
import { buildVisibleRows, sortNodes, nodeMatchesSearch } from './visibleRows';

// Index fixture:
// root
// ├── folder-b (فولدر سرویس)
// │   ├── req-b1 (Get User, url /users)
// │   └── folder-b-sub
// │       └── req-b2 (Delete User)
// └── req-a (Login, url /auth/login)
const makeIndex = () => {
  const nodes = {
    'folder-b': { uid: 'folder-b', type: 'folder', name: 'فولدر سرویس', pathname: '/col/folder-b', parentUid: null },
    'req-b1': { uid: 'req-b1', type: 'http', name: 'Get User', url: '/users', method: 'GET', pathname: '/col/folder-b/get-user.bru', parentUid: 'folder-b', seq: 1 },
    'folder-b-sub': { uid: 'folder-b-sub', type: 'folder', name: 'sub', pathname: '/col/folder-b/sub', parentUid: 'folder-b' },
    'req-b2': { uid: 'req-b2', type: 'http', name: 'Delete User', method: 'DELETE', pathname: '/col/folder-b/sub/delete-user.bru', parentUid: 'folder-b-sub', seq: 1 },
    'req-a': { uid: 'req-a', type: 'http', name: 'Login', url: '/auth/login', method: 'POST', pathname: '/col/login.bru', parentUid: null, seq: 2 }
  };
  return {
    nodesByUid: nodes,
    childrenByParentUid: {
      'root': ['folder-b', 'req-a'],
      'folder-b': ['req-b1', 'folder-b-sub'],
      'folder-b-sub': ['req-b2']
    },
    uidByPathname: Object.fromEntries(Object.values(nodes).map((n) => [n.pathname, n.uid]))
  };
};

describe('buildVisibleRows (no filter)', () => {
  it('walks only expanded folders', () => {
    const index = makeIndex();
    expect(buildVisibleRows({ index }).map((r) => r.uid)).toEqual(['folder-b', 'req-a']);
    expect(
      buildVisibleRows({ index, expandedNodeUids: new Set(['folder-b']) }).map((r) => r.uid)
    ).toEqual(['folder-b', 'folder-b-sub', 'req-b1', 'req-a']);
  });

  it('returns [] without an index', () => {
    expect(buildVisibleRows({ index: null })).toEqual([]);
  });

  it('adds a synthetic empty-folder CTA row under an expanded empty folder', () => {
    const index = makeIndex();
    index.nodesByUid['folder-empty'] = { uid: 'folder-empty', type: 'folder', name: 'empty', pathname: '/col/empty', parentUid: null };
    index.childrenByParentUid.root.push('folder-empty');

    const rows = buildVisibleRows({ index, expandedNodeUids: new Set(['folder-empty']) });
    const ctaRow = rows.find((r) => r.type === 'empty-folder');
    expect(ctaRow).toEqual({
      uid: 'folder-empty:empty-folder',
      type: 'empty-folder',
      folderUid: 'folder-empty',
      pathname: '/col/empty::empty-folder'
    });
    // Directly follows its folder
    expect(rows[rows.indexOf(ctaRow) - 1].uid).toBe('folder-empty');

    // Not rendered during filtered views
    const filtered = buildVisibleRows({
      index,
      searchText: 'empty',
      searchMatches: {
        matchedPathnames: new Set(['/col/empty']),
        matchMeta: new Map([['/col/empty', { field: 'name', text: 'empty' }]])
      }
    });
    expect(filtered.some((r) => r.type === 'empty-folder')).toBe(false);
  });
});

describe('buildVisibleRows (content search / external matches)', () => {
  it('shows matched requests with their ancestor chain, fully expanded, with match meta', () => {
    const index = makeIndex();
    const rows = buildVisibleRows({
      index,
      searchText: 'token',
      searchMatches: {
        matchedPathnames: new Set(['/col/folder-b/sub/delete-user.bru']),
        matchMeta: new Map([
          ['/col/folder-b/sub/delete-user.bru', { field: 'body', text: '"token": "abc"' }]
        ])
      }
    });

    expect(rows.map((r) => r.uid)).toEqual(['folder-b', 'folder-b-sub', 'req-b2']);
    expect(rows[2].searchMatchMeta).toEqual({ field: 'body', text: '"token": "abc"' });
    expect(rows[0].searchMatchMeta).toBeUndefined();
  });

  it('includes the full subtree of a matched folder', () => {
    const index = makeIndex();
    const rows = buildVisibleRows({
      index,
      searchText: 'سرویس',
      searchMatches: {
        matchedPathnames: new Set(['/col/folder-b']),
        matchMeta: new Map([['/col/folder-b', { field: 'name', text: 'فولدر سرویس' }]])
      }
    });

    expect(rows.map((r) => r.uid)).toEqual(['folder-b', 'folder-b-sub', 'req-b2', 'req-b1']);
  });

  it('does not mutate index nodes when attaching match meta', () => {
    const index = makeIndex();
    buildVisibleRows({
      index,
      searchText: 'user',
      searchMatches: {
        matchedPathnames: new Set(['/col/folder-b/get-user.bru']),
        matchMeta: new Map([['/col/folder-b/get-user.bru', { field: 'url', text: '/users' }]])
      }
    });
    expect(index.nodesByUid['req-b1'].searchMatchMeta).toBeUndefined();
  });

  it('resolves NFD pathnames from the main process against an NFC index (macOS)', () => {
    const index = makeIndex();
    // Persian folder name stored NFC in the index, hit reported NFD-decomposed
    const nfcPath = '/col/سرویس/req.bru'.normalize('NFC');
    const nfdPath = nfcPath.normalize('NFD');
    index.nodesByUid['req-fa'] = { uid: 'req-fa', type: 'http', name: 'FA', pathname: nfcPath, parentUid: null, seq: 3 };
    index.childrenByParentUid.root.push('req-fa');

    const rows = buildVisibleRows({
      index,
      searchText: 'fa',
      searchMatches: {
        matchedPathnames: new Set([nfdPath]),
        matchMeta: new Map([[nfdPath, { field: 'body', text: 'x' }]])
      }
    });

    expect(rows.map((r) => r.uid)).toContain('req-fa');
    expect(rows.find((r) => r.uid === 'req-fa').searchMatchMeta).toEqual({ field: 'body', text: 'x' });
  });

  it('collection matched by name only (empty match set) browses normally', () => {
    const index = makeIndex();
    const searchMatches = { matchedPathnames: new Set(), matchMeta: new Map() };
    expect(buildVisibleRows({ index, searchText: 'col', searchMatches }).map((r) => r.uid))
      .toEqual(['folder-b', 'req-a']);
    expect(
      buildVisibleRows({ index, searchText: 'col', searchMatches, expandedNodeUids: new Set(['folder-b']) })
        .map((r) => r.uid)
    ).toEqual(['folder-b', 'folder-b-sub', 'req-b1', 'req-a']);
  });

  it('returns [] when no matched pathname resolves in the index', () => {
    const index = makeIndex();
    const rows = buildVisibleRows({
      index,
      searchText: 'zz',
      searchMatches: {
        matchedPathnames: new Set(['/other/unknown.bru']),
        matchMeta: new Map([['/other/unknown.bru', { field: 'body', text: 'zz' }]])
      }
    });
    expect(rows).toEqual([]);
  });
});

describe('buildVisibleRows (short renderer-side filter)', () => {
  it('matches folded name/url and keeps ancestors', () => {
    const index = makeIndex();
    const rows = buildVisibleRows({ index, searchText: 'delete' });
    expect(rows.map((r) => r.uid)).toEqual(['folder-b', 'folder-b-sub', 'req-b2']);
  });

  it('matches Persian names', () => {
    const index = makeIndex();
    const rows = buildVisibleRows({ index, searchText: 'سرویس' });
    expect(rows.map((r) => r.uid)).toEqual(['folder-b', 'folder-b-sub', 'req-b2', 'req-b1']);
  });
});

describe('sortNodes', () => {
  it('orders folders first, then requests by seq', () => {
    const nodes = [
      { uid: 'r2', type: 'http', name: 'b', seq: 2 },
      { uid: 'f1', type: 'folder', name: 'f' },
      { uid: 'r1', type: 'http', name: 'a', seq: 1 }
    ];
    expect(sortNodes(nodes).map((n) => n.uid)).toEqual(['f1', 'r1', 'r2']);
  });
});

describe('nodeMatchesSearch', () => {
  it('matches on name, url, method and pathname (folded)', () => {
    const node = { name: 'Get User', url: '/users', method: 'GET', pathname: '/col/x.bru' };
    expect(nodeMatchesSearch(node, 'user')).toBe(true);
    expect(nodeMatchesSearch(node, 'get')).toBe(true);
    expect(nodeMatchesSearch(node, 'nope')).toBe(false);
    expect(nodeMatchesSearch(node, '')).toBe(true);
  });
});

describe('buildVisibleRows filterCollapsedUids', () => {
  const index = {
    nodesByUid: {
      f1: { uid: 'f1', name: 'Api', type: 'folder', pathname: '/c/Api', parentUid: null },
      r1: { uid: 'r1', name: 'inquiry-nested', type: 'http-request', pathname: '/c/Api/r1.bru', parentUid: 'f1' },
      r2: { uid: 'r2', name: 'inquiry-root', type: 'http-request', pathname: '/c/r2.bru', parentUid: null }
    },
    childrenByParentUid: { root: ['f1', 'r2'], f1: ['r1'] },
    uidByPathname: { '/c/Api': 'f1', '/c/Api/r1.bru': 'r1', '/c/r2.bru': 'r2' }
  };
  const searchMatches = {
    matchedPathnames: new Set(['/c/Api/r1.bru', '/c/r2.bru']),
    matchMeta: new Map()
  };

  it('hides a collapsed folder\'s children but keeps the folder row', () => {
    const rows = buildVisibleRows({ index, searchText: 'inquiry', searchMatches, filterCollapsedUids: new Set(['f1']) });
    const names = rows.map((r) => r.name);
    expect(names).toContain('Api');
    expect(names).toContain('inquiry-root');
    expect(names).not.toContain('inquiry-nested');
  });

  it('shows everything when no folders are collapsed', () => {
    const rows = buildVisibleRows({ index, searchText: 'inquiry', searchMatches });
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['Api', 'inquiry-nested', 'inquiry-root']));
  });
});
