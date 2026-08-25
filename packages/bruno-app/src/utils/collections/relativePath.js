/**
 * A node's path relative to its collection root, in posix form.
 *
 * This is the shape the UI-state snapshot stores expanded folders in. It has to
 * be a path rather than a uid because `getRequestUid` is a per-process Map of
 * pathname to a fresh uuid (see bruno-electron cache/requestUids.js), so a uid
 * written today resolves to nothing tomorrow.
 *
 * NFC because the reported workspace is Persian throughout and the same folder
 * arrives in either normalization depending on which machine created it; a
 * case-insensitive prefix test because a Windows drive letter and a macOS
 * volume name can each come back cased differently from the root.
 *
 * Returns '' for the root itself and for anything outside it — a caller must
 * never persist an absolute path, which would leak the user's directory layout
 * into a settings file and could not resolve back to a node anyway.
 */
const normalize = (pathname) => String(pathname || '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '');

export const toCollectionRelativePathname = (collectionPathname, nodePathname) => {
  const root = normalize(collectionPathname);
  const file = normalize(nodePathname);
  if (!root || !file || file === root) {
    return '';
  }
  return file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : '';
};
