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
