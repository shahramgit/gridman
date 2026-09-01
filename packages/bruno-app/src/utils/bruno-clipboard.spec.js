/* global __dirname */
import brunoClipboard, { COPY, CUT } from './bruno-clipboard';

/**
 * CUT IS THE SAME CLIPBOARD WITH A DIFFERENT VERB.
 *
 * The operation has to travel with the item, because paste is the only place
 * that knows whether to duplicate or move — and a cut has to be consumed by
 * its paste, or the next paste tries to move a path that is no longer there.
 */

beforeEach(() => brunoClipboard.clear());

describe('the sidebar clipboard', () => {
  it('starts empty', () => {
    expect(brunoClipboard.read()).toEqual({ items: [], operation: COPY, hasData: false });
  });

  it('remembers a copy as a copy', () => {
    brunoClipboard.write({ pathname: '/w/c/a.bru' }, COPY);
    expect(brunoClipboard.read()).toMatchObject({ operation: COPY, hasData: true });
  });

  it('remembers a cut as a cut', () => {
    brunoClipboard.write({ pathname: '/w/c/a.bru' }, CUT);
    expect(brunoClipboard.read()).toMatchObject({ operation: CUT, hasData: true });
  });

  it('defaults to copy, so an un-updated caller cannot silently move a file', () => {
    brunoClipboard.write({ pathname: '/w/c/a.bru' });
    expect(brunoClipboard.read().operation).toBe(COPY);
  });

  it('treats an unrecognised operation as a copy for the same reason', () => {
    brunoClipboard.write({ pathname: '/w/c/a.bru' }, 'move-maybe');
    expect(brunoClipboard.read().operation).toBe(COPY);
  });

  it('a later copy disarms an earlier cut', () => {
    brunoClipboard.write({ pathname: '/w/c/a.bru' }, CUT);
    brunoClipboard.write({ pathname: '/w/c/b.bru' }, COPY);
    expect(brunoClipboard.read()).toMatchObject({ operation: COPY, items: [{ pathname: '/w/c/b.bru' }] });
  });

  it('clears back to empty and to copy', () => {
    brunoClipboard.write({ pathname: '/w/c/a.bru' }, CUT);
    brunoClipboard.clear();
    expect(brunoClipboard.read()).toEqual({ items: [], operation: COPY, hasData: false });
  });
});

/**
 * WHERE PASTE IS OFFERED MUST MATCH WHERE IT WORKS.
 *
 * `Ctrl+V` on a request pastes into that request's PARENT folder — the
 * keybinding has always done this. The ... menu offered Paste only on folders,
 * so on a request the menu did less than the keyboard and a user who reached
 * for the menu concluded paste was broken.
 */
describe('the paste menu entry', () => {
  const SOURCE = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'components', 'Sidebar', 'Collections', 'Collection', 'IndexedCollectionItems.js'),
    'utf8'
  );

  it('is gated on having something to paste, not on the row being a folder', () => {
    expect(SOURCE).toContain('if (hasCopiedItems) {');
    expect(SOURCE).not.toContain('if (isFolder && hasCopiedItems) {');
  });

  it('still pastes into the parent when the row is a request', () => {
    // handlePasteItem targets the folder itself, or the request's parent.
    expect(SOURCE).toContain('isFolder ? node.uid : node.parentUid');
  });
});
