import {
  buildFolderTree,
  buildFolderTreeFromIndex,
  buildFolderTreeFromItems,
  flattenFolderTree
} from './folderTree';

describe('folderTree', () => {
  const index = {
    nodesByUid: {
      f1: { uid: 'f1', type: 'folder', name: 'Zeta', pathname: '/c/zeta', parentUid: null },
      f2: { uid: 'f2', type: 'folder', name: 'Alpha', pathname: '/c/alpha', parentUid: null },
      f3: { uid: 'f3', type: 'folder', name: 'Nested', pathname: '/c/alpha/nested', parentUid: 'f2' },
      r1: { uid: 'r1', type: 'http', name: 'Req', pathname: '/c/req.bru', parentUid: null },
      r2: { uid: 'r2', type: 'http', name: 'Inner', pathname: '/c/alpha/inner.bru', parentUid: 'f2' }
    },
    childrenByParentUid: {
      root: ['f1', 'f2', 'r1'],
      f2: ['f3', 'r2']
    }
  };

  describe('buildFolderTreeFromIndex', () => {
    it('returns null without an index', () => {
      expect(buildFolderTreeFromIndex(null)).toBeNull();
      expect(buildFolderTreeFromIndex({})).toBeNull();
    });

    it('builds a folders-only tree sorted by name', () => {
      const tree = buildFolderTreeFromIndex(index);
      expect(tree.map((n) => n.name)).toEqual(['Alpha', 'Zeta']);
      expect(tree[0].children.map((n) => n.name)).toEqual(['Nested']);
      expect(tree[0].children[0].pathname).toBe('/c/alpha/nested');
      expect(tree[1].children).toEqual([]);
    });

    it('excludes requests at every level', () => {
      const tree = buildFolderTreeFromIndex(index);
      const flat = flattenFolderTree(tree);
      expect(flat.some((row) => row.uid === 'r1' || row.uid === 'r2')).toBe(false);
    });
  });

  describe('buildFolderTreeFromItems', () => {
    const items = [
      { uid: 'a', type: 'http-request', name: 'Req', pathname: '/c/req.bru' },
      {
        uid: 'b',
        type: 'folder',
        name: 'B folder',
        pathname: '/c/b',
        items: [
          { uid: 'c', type: 'folder', name: 'C folder', pathname: '/c/b/c', items: [] }
        ]
      }
    ];

    it('walks hydrated items and keeps only folders', () => {
      const tree = buildFolderTreeFromItems(items);
      expect(tree).toHaveLength(1);
      expect(tree[0].name).toBe('B folder');
      expect(tree[0].children[0].name).toBe('C folder');
    });

    it('handles empty/missing input', () => {
      expect(buildFolderTreeFromItems()).toEqual([]);
      expect(buildFolderTreeFromItems(null)).toEqual([]);
    });
  });

  describe('buildFolderTree', () => {
    it('prefers the index when present', () => {
      const tree = buildFolderTree({ index, collection: { items: [] } });
      expect(tree.map((n) => n.name)).toEqual(['Alpha', 'Zeta']);
    });

    it('falls back to collection items without an index', () => {
      const collection = { items: [{ uid: 'x', type: 'folder', name: 'X', pathname: '/c/x', items: [] }] };
      const tree = buildFolderTree({ index: null, collection });
      expect(tree.map((n) => n.name)).toEqual(['X']);
    });
  });

  describe('flattenFolderTree', () => {
    it('flattens depth-first with depth annotations', () => {
      const tree = buildFolderTreeFromIndex(index);
      const flat = flattenFolderTree(tree);
      expect(flat.map((row) => [row.name, row.depth])).toEqual([
        ['Alpha', 0],
        ['Nested', 1],
        ['Zeta', 0]
      ]);
    });
  });
});
