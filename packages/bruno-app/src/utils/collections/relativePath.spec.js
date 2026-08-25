import { toCollectionRelativePathname } from './relativePath';

/**
 * WHAT GETS SAVED HAS TO FIND ITS WAY BACK.
 *
 * Reopening the sidebar where the user left it stores collection-relative
 * paths, not uids — `getRequestUid` is a per-process Map handing out a fresh
 * uuid per pathname, so a uid written today resolves to nothing tomorrow.
 *
 * That makes this mapping the whole feature, and it has to survive the two
 * things the reported workspace does constantly: Windows separators, and
 * Persian folder names that arrive in either unicode normalization depending
 * on which machine created them.
 */

const ROOT = '/w/collections/alpha';

describe('the path an expanded folder is remembered by', () => {
  it('is relative to the collection root', () => {
    expect(toCollectionRelativePathname(ROOT, `${ROOT}/auth/tokens`)).toBe('auth/tokens');
  });

  it('normalizes Windows separators, so a path saved on Windows is still a path', () => {
    expect(toCollectionRelativePathname('C:\\w\\alpha', 'C:\\w\\alpha\\auth\\tokens')).toBe('auth/tokens');
  });

  it('tolerates the root and the node disagreeing on case', () => {
    expect(toCollectionRelativePathname('/W/Collections/Alpha', '/w/collections/alpha/auth')).toBe('auth');
  });

  it('matches a Persian folder across unicode normalizations', () => {
    // آ (U+0622, alef with madda) is one of the Persian letters that actually
    // has a canonical decomposition — U+0627 U+0653 — so it is the letter that
    // makes a folder name differ between a Windows checkout and a macOS one.
    // Most Persian text is normalization-invariant; picking a word without one
    // of these letters would make this test pass on its own.
    const nfc = 'آمار پرونده'.normalize('NFC');
    const nfd = 'آمار پرونده'.normalize('NFD');
    expect(nfc).not.toBe(nfd);

    // Saved from an NFD path, and what comes out is the NFC spelling the
    // restore side compares against — so the two agree whichever machine wrote
    // the folder.
    expect(toCollectionRelativePathname(ROOT, `${ROOT}/${nfd}`)).toBe(nfc);
    expect(toCollectionRelativePathname(ROOT, `${ROOT}/${nfc}`)).toBe(nfc);
  });

  it('refuses a node outside the collection instead of emitting an absolute path', () => {
    expect(toCollectionRelativePathname(ROOT, '/somewhere/else/auth')).toBe('');
    // A sibling whose name merely starts with the root's is not inside it.
    expect(toCollectionRelativePathname(ROOT, '/w/collections/alpha-sibling/auth')).toBe('');
  });

  it('treats the collection root itself as nothing to remember', () => {
    expect(toCollectionRelativePathname(ROOT, ROOT)).toBe('');
    expect(toCollectionRelativePathname(ROOT, `${ROOT}/`)).toBe('');
  });

  it('is unbothered by trailing slashes on either side', () => {
    // Both come from callers, not from a normalizer: the collection pathname is
    // whatever the user picked in the directory dialog. Without trimming them
    // the prefix test looks for a doubled slash and matches nothing.
    expect(toCollectionRelativePathname(`${ROOT}/`, `${ROOT}/auth/`)).toBe('auth');
    expect(toCollectionRelativePathname(`${ROOT}//`, `${ROOT}/auth/tokens`)).toBe('auth/tokens');
  });

  it('returns empty rather than throwing on missing input', () => {
    expect(toCollectionRelativePathname(null, `${ROOT}/auth`)).toBe('');
    expect(toCollectionRelativePathname(ROOT, undefined)).toBe('');
  });
});
