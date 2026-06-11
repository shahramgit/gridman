import { foldSearchText, findFoldedMatchRange, foldedIncludes } from './search-fold';

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
