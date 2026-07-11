const normalizePathname = (pathname) => String(pathname || '').replace(/\\/g, '/').replace(/\/+$/, '');

// Given the selected items ({ uid, pathname, type, ... }), drop any item that
// is a descendant of another selected folder — moving the folder moves its
// contents, so moving the descendant separately would double-move it.
export const excludeDescendantItems = (items = []) => {
  const folderPathnames = items
    .filter((item) => item?.type === 'folder' && item.pathname)
    .map((item) => normalizePathname(item.pathname));

  return items.filter((item) => {
    const pathname = normalizePathname(item?.pathname);
    if (!pathname) {
      return true;
    }

    return !folderPathnames.some(
      (folderPathname) => folderPathname !== pathname && pathname.startsWith(`${folderPathname}/`)
    );
  });
};

// Inclusive range of uids between anchorUid and targetUid in visible order.
// Falls back to just the target when either endpoint is not visible.
export const getRangeUids = (visibleUids = [], anchorUid, targetUid) => {
  const anchorIndex = visibleUids.indexOf(anchorUid);
  const targetIndex = visibleUids.indexOf(targetUid);
  if (anchorIndex === -1 || targetIndex === -1) {
    return targetUid ? [targetUid] : [];
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visibleUids.slice(start, end + 1);
};
