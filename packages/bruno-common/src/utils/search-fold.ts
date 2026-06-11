/**
 * Search text folding for consistent matching across scripts.
 *
 * Persian/Arabic text has multiple Unicode codepoints for visually or
 * phonetically equivalent letters (e.g. Arabic Yeh U+064A vs Farsi Yeh
 * U+06CC, Arabic Kaf U+0643 vs Keheh U+06A9). Users type either variant
 * depending on their keyboard layout, so search must treat them as equal.
 * Folding also strips diacritics, tatweel, and zero-width joiners, and
 * unifies Arabic-Indic digits with ASCII digits.
 */

const CHAR_FOLD_MAP: Record<string, string> = {
  // Yeh variants -> Farsi Yeh
  'ي': 'ی', // ي ARABIC YEH
  'ى': 'ی', // ى ALEF MAKSURA
  'ئ': 'ی', // ئ YEH WITH HAMZA ABOVE
  'ې': 'ی', // ې E
  'ے': 'ی', // ے YEH BARREE
  // Kaf variants -> Keheh
  'ك': 'ک', // ك ARABIC KAF
  'ڪ': 'ک', // ڪ SWASH KAF
  // Alef variants -> Alef
  'آ': 'ا', // آ ALEF WITH MADDA
  'أ': 'ا', // أ ALEF WITH HAMZA ABOVE
  'إ': 'ا', // إ ALEF WITH HAMZA BELOW
  'ٱ': 'ا', // ٱ ALEF WASLA
  // Waw with hamza -> Waw
  'ؤ': 'و', // ؤ
  // Teh marbuta -> Heh
  'ة': 'ه', // ة
  'ۀ': 'ه', // ۀ HEH WITH YEH ABOVE
  // Arabic-Indic digits -> ASCII
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  // Extended (Persian) Arabic-Indic digits -> ASCII
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

// Characters removed entirely: Arabic diacritics (tashkil), superscript
// alef, tatweel, zero-width non-joiner/joiner, BOM/zero-width no-break.
const REMOVED_CHARS = /[ً-ٰٟـ‌‍﻿]/;

export interface FoldOptions {
  caseSensitive?: boolean;
}

export interface FoldedTextWithMap {
  folded: string;
  // map[i] = index in the original string of the character that produced
  // folded[i]. Used to translate folded match ranges back to the original.
  map: number[];
}

/**
 * Fold text for matching. Lowercases unless options.caseSensitive is true.
 */
export const foldSearchText = (text: unknown, options: FoldOptions = {}): string => {
  return foldSearchTextWithMap(text, options).folded;
};

/**
 * Fold text and return an index map back to the original string, so a match
 * range found in the folded text can be highlighted in the original.
 */
export const foldSearchTextWithMap = (text: unknown, options: FoldOptions = {}): FoldedTextWithMap => {
  const source = String(text ?? '').normalize('NFC');
  const out: string[] = [];
  const map: number[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (REMOVED_CHARS.test(char)) {
      continue;
    }

    const mapped = CHAR_FOLD_MAP[char] || char;
    const finalChars = options.caseSensitive ? mapped : mapped.toLowerCase();
    // Lowercasing can expand a character (rare); keep all expansions
    // pointing at the same original index.
    for (const finalChar of finalChars) {
      out.push(finalChar);
      map.push(i);
    }
  }

  return { folded: out.join(''), map };
};

/**
 * Find the folded-aware match range of `query` inside `text`, expressed in
 * original string indices. Returns null when there is no match.
 */
export const findFoldedMatchRange = (
  text: unknown,
  query: unknown,
  options: FoldOptions = {}
): { start: number; end: number } | null => {
  const foldedQuery = foldSearchText(query, options);
  if (!foldedQuery) {
    return null;
  }

  const { folded, map } = foldSearchTextWithMap(text, options);
  const index = folded.indexOf(foldedQuery);
  if (index === -1) {
    return null;
  }

  const start = map[index];
  const lastFoldedIndex = index + foldedQuery.length - 1;
  const end = map[lastFoldedIndex] + 1;
  return { start, end };
};

export const foldedIncludes = (text: unknown, foldedQuery: string, options: FoldOptions = {}): boolean => {
  if (!foldedQuery) {
    return true;
  }
  return foldSearchText(text, options).includes(foldedQuery);
};
