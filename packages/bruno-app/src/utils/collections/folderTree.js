// Folders-only tree for location pickers (e.g. the request "Save As" modal).
// Prefers the collection index — it covers lazily hydrated (indexed)
// collections where the tree items are never fully loaded — and falls back to
// walking the hydrated collection tree.

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

export const buildFolderTreeFromIndex = (index) => {
  if (!index?.nodesByUid) {
    return null;
  }

  const childrenByParentUid = index.childrenByParentUid || {};
  const build = (parentKey) => (childrenByParentUid[parentKey] || [])
    .map((uid) => index.nodesByUid[uid])
    .filter((node) => node && node.type === 'folder')
    .sort(byName)
    .map((node) => ({
      uid: node.uid,
      name: node.name || node.filename || 'Untitled',
      pathname: node.pathname,
      children: build(node.uid)
    }));

  return build('root');
};

export const buildFolderTreeFromItems = (items = []) => {
  return (items || [])
    .filter((item) => item?.type === 'folder')
    .sort(byName)
    .map((item) => ({
      uid: item.uid,
      name: item.name || item.filename || 'Untitled',
      pathname: item.pathname,
      children: buildFolderTreeFromItems(item.items)
    }));
};

export const buildFolderTree = ({ index, collection }) => {
  const fromIndex = buildFolderTreeFromIndex(index);
  if (fromIndex) {
    return fromIndex;
  }
  return buildFolderTreeFromItems(collection?.items);
};

// Flatten a folder tree (depth-first) into rows for rendering an indented
// list: [{ uid, name, pathname, depth }].
export const flattenFolderTree = (tree = [], depth = 0) => {
  const rows = [];
  for (const node of tree) {
    rows.push({ uid: node.uid, name: node.name, pathname: node.pathname, depth });
    rows.push(...flattenFolderTree(node.children || [], depth + 1));
  }
  return rows;
};
