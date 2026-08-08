import { diffLines } from './diffLines';

const render = (parts) =>
  parts
    .map((p) => {
      const prefix = p.added ? '+' : p.removed ? '-' : ' ';
      return p.value
        .split('\n')
        .slice(0, -1)
        .map((l) => `${prefix}${l}`)
        .join('\n');
    })
    .join('\n');

describe('diffLines', () => {
  it('returns a single unchanged part for identical input', () => {
    const parts = diffLines('a\nb\n', 'a\nb\n');
    expect(parts).toEqual([{ value: 'a\nb\n' }]);
  });

  it('reports a pure insertion', () => {
    const parts = diffLines('a\nc\n', 'a\nb\nc\n');
    expect(render(parts)).toBe(' a\n+b\n c');
  });

  it('reports a pure deletion', () => {
    const parts = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(render(parts)).toBe(' a\n-b\n c');
  });

  it('reports a replacement as removal then addition', () => {
    const parts = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    expect(render(parts)).toBe(' a\n-b\n+B\n c');
    const changed = parts.filter((p) => p.added || p.removed);
    expect(changed[0].removed).toBe(true);
    expect(changed[1].added).toBe(true);
  });

  it('handles an empty original', () => {
    const parts = diffLines('', 'x\ny\n');
    expect(parts).toEqual([{ value: 'x\ny\n', added: true }]);
  });

  it('handles an empty replacement', () => {
    const parts = diffLines('x\ny\n', '');
    expect(parts).toEqual([{ value: 'x\ny\n', removed: true }]);
  });

  it('treats both empty as no change', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('tolerates missing trailing newlines', () => {
    const parts = diffLines('a\nb', 'a\nb\nc');
    expect(render(parts)).toBe(' a\n b\n+c');
  });

  it('counts additions and deletions the way the renderer does', () => {
    const parts = diffLines('one\ntwo\nthree\n', 'one\ntwo point five\nthree\nfour\n');
    let additions = 0;
    let deletions = 0;
    for (const part of parts) {
      const count = part.value.split('\n').length - 1;
      if (part.added) additions += count;
      else if (part.removed) deletions += count;
    }
    expect(additions).toBe(2);
    expect(deletions).toBe(1);
  });

  it('keeps a shared prefix and suffix out of the changed set', () => {
    const before = ['h1', 'h2', 'x', 't1', 't2'].join('\n') + '\n';
    const after = ['h1', 'h2', 'y', 't1', 't2'].join('\n') + '\n';
    const parts = diffLines(before, after);
    expect(parts[0]).toEqual({ value: 'h1\nh2\n' });
    expect(parts[parts.length - 1]).toEqual({ value: 't1\nt2\n' });
  });

  it('finds a common subsequence rather than replacing everything', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nc\ne\n';
    const parts = diffLines(before, after);
    expect(parts.some((p) => p.added)).toBe(false);
    expect(render(parts)).toBe(' a\n-b\n c\n-d\n e');
  });

  it('degrades to a whole-file replace past the LCS ceiling instead of stalling', () => {
    const before = Array.from({ length: 3200 }, (_, i) => `old-${i}`).join('\n') + '\n';
    const after = Array.from({ length: 3200 }, (_, i) => `new-${i}`).join('\n') + '\n';
    const started = Date.now();
    const parts = diffLines(before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(parts).toHaveLength(2);
    expect(parts[0].removed).toBe(true);
    expect(parts[1].added).toBe(true);
  });
});
