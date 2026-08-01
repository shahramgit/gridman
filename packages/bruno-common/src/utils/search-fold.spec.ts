import { foldSearchText, foldSearchTextWithMap, findFoldedMatchRange, foldedIncludes } from './search-fold';

describe('foldSearchText', () => {
  it('folds Arabic Yeh and Alef Maksura and Hamza Yeh to Farsi Yeh', () => {
    expect(foldSearchText('علي')).toBe(foldSearchText('علی'));
    expect(foldSearchText('موسى')).toBe(foldSearchText('موسی'));
    expect(foldSearchText('جزئیات')).toBe(foldSearchText('جزییات'));
  });

  it('folds Arabic Kaf to Keheh', () => {
    expect(foldSearchText('كتاب')).toBe(foldSearchText('کتاب'));
  });

  it('folds Alef variants', () => {
    expect(foldSearchText('أحوال')).toBe(foldSearchText('احوال'));
    expect(foldSearchText('آب')).toBe(foldSearchText('اب'));
  });

  it('removes diacritics, tatweel and ZWNJ', () => {
    expect(foldSearchText('مَدْرَسَة')).toBe(foldSearchText('مدرسه'));
    expect(foldSearchText('کتــــاب')).toBe(foldSearchText('کتاب'));
    expect(foldSearchText('می‌خواهم')).toBe(foldSearchText('میخواهم'));
  });

  it('unifies Arabic-Indic digits with ASCII', () => {
    expect(foldSearchText('۱۲۳')).toBe('123');
    expect(foldSearchText('٤٥٦')).toBe('456');
  });

  it('lowercases by default, preserves case when caseSensitive', () => {
    expect(foldSearchText('GetImage')).toBe('getimage');
    expect(foldSearchText('GetImage', { caseSensitive: true })).toBe('GetImage');
  });
});

// foldSearchText takes a bulk path and foldSearchTextWithMap a per-code-unit
// one; the index folds with the first and highlights with the second, so any
// disagreement is a match the user can see but not jump to.
describe('foldSearchText matches foldSearchTextWithMap exactly', () => {
  const CASES: [string, string][] = [
    ['ascii', 'GetImage6.bru'],
    ['persian', 'بسته سرويسهای اسْتعلامی ۱۲۳'],
    ['persian with zwnj', 'می‌خواهم کتــــاب'],
    ['emoji', '{"status":"ok 🙂","flag":"🇮🇷","family":"👨‍👩‍👧‍👦"}'],
    ['emoji after a lot of text', `${'a'.repeat(5000)}🙂${'b'.repeat(5000)}`],
    ['greek with final sigma', 'ΟΔΟΣ ΑΘΗΝΑΣ Σ'],
    ['astral letters that case-map', '𐐀𐐁𐐂 Deseret 𞤀𞤁 Adlam'],
    ['astral letters next to persian', 'سرویس 𐐀 ۱۲۳'],
    ['lone high surrogate', `a\uD800b`],
    ['lone low surrogate', `a\uDC00b`],
    ['dotted capital I', 'İSTANBUL'],
    ['mixed everything', 'Σ سرويس 🙂 𐐀 ۱۲۳ İ ς'],
    ['empty', '']
  ];

  it.each(CASES)('%s', (_label, text) => {
    expect(foldSearchText(text)).toBe(foldSearchTextWithMap(text).folded);
    expect(foldSearchText(text, { caseSensitive: true })).toBe(
      foldSearchTextWithMap(text, { caseSensitive: true }).folded
    );
  });

  it('agrees on every BMP character in a fold-relevant context', () => {
    const contexts = ['', 'a', 'Α', 'ς', 'ی', 'ً', '‌'];
    for (let cp = 0; cp < 0x10000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue; // lone surrogates are covered by the table above
      }
      const char = String.fromCharCode(cp);
      for (const context of contexts) {
        const text = `${context}${char}${context}`;
        if (foldSearchText(text) !== foldSearchTextWithMap(text).folded) {
          throw new Error(`fold mismatch at U+${cp.toString(16)} in context ${JSON.stringify(context)}`);
        }
      }
    }
  });
});

describe('foldSearchText astral fast path', () => {
  // One emoji used to send the WHOLE field down the per-code-unit path (which
  // also allocates an index array the size of the text). Response examples are
  // full of emoji, so a 5 MB example took ~280 ms on the main process instead
  // of ~4 ms — the stall this fold split was written to remove.
  it('stays on the bulk path when the only astral characters are caseless', () => {
    const big = `${'a'.repeat(2 * 1024 * 1024)}🙂`;
    const timed = (fn: () => string) => {
      const started = Date.now();
      const value = fn();
      return { value, ms: Date.now() - started };
    };

    const bulk = timed(() => foldSearchText(big));
    const exact = timed(() => foldSearchTextWithMap(big).folded);

    expect(bulk.value).toBe(exact.value);
    // Relative so the bound holds on slow machines: routing the field to the
    // per-code-unit path (what a field-wide surrogate check did) makes these
    // two identical instead of an order of magnitude apart.
    expect(bulk.ms * 5).toBeLessThan(exact.ms);
  });
});

describe('foldedIncludes', () => {
  it('matches across Persian/Arabic variants', () => {
    const query = foldSearchText('سرویس');
    expect(foldedIncludes('بسته سرويسهای استعلامی', query)).toBe(true);
  });

  it('respects case sensitivity option', () => {
    const queryCs = foldSearchText('GetImage', { caseSensitive: true });
    expect(foldedIncludes('getimage', queryCs, { caseSensitive: true })).toBe(false);
    expect(foldedIncludes('GetImage6.bru', queryCs, { caseSensitive: true })).toBe(true);
  });
});

describe('findFoldedMatchRange', () => {
  it('maps the folded match back to original indices', () => {
    const text = 'بسته سرويسهای استعلامی';
    const range = findFoldedMatchRange(text, 'سرویسهای');
    expect(range).not.toBeNull();
    expect(text.slice(range!.start, range!.end)).toBe('سرويسهای');
  });

  it('maps ranges across removed characters', () => {
    const text = 'می‌خواهم تستی';
    const range = findFoldedMatchRange(text, 'میخواهم');
    expect(range).not.toBeNull();
    expect(text.slice(range!.start, range!.end)).toBe('می‌خواهم');
  });

  it('returns null when there is no match', () => {
    expect(findFoldedMatchRange('hello', 'world')).toBeNull();
  });
});
