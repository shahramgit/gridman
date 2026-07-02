import filter from 'lodash/filter';
import { isItemARequest, isItemAFolder } from 'utils/collections';
import { sortByNameThenSequence } from 'utils/common';

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

// Flattened uid order of the classic (non-indexed) sidebar tree: at each
// level folders render first (sortByNameThenSequence), then requests by seq,
// and a collapsed folder hides its children — mirroring CollectionItem's
// render order so shift-click ranges match what the user sees.
export const buildClassicVisibleUids = (collectionItems = [], { treatFoldersAsExpanded = false } = {}) => {
  const uids = [];

  const walk = (items = []) => {
    const folders = sortByNameThenSequence(filter(items, (i) => isItemAFolder(i) && !i.isTransient));
    const requests = filter(items, (i) => isItemARequest(i) && !i.isTransient)
      .sort((a, b) => a.seq - b.seq);

    for (const folderItem of folders) {
      uids.push(folderItem.uid);
      if (treatFoldersAsExpanded || !folderItem.collapsed) {
        walk(folderItem.items);
      }
    }

    for (const requestItem of requests) {
      uids.push(requestItem.uid);
    }
  };

  walk(collectionItems);
  return uids;
};
