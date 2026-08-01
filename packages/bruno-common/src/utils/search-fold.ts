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

// Every character the fold touches, derived from the two tables above so it
// can never drift from them. Used to jump between the characters that
// actually change instead of visiting all of them.
const FOLDED_CHARS = new RegExp(`[${REMOVED_CHARS.source.slice(1, -1)}${Object.keys(CHAR_FOLD_MAP).join('')}]`, 'g');

const NON_ASCII_CHARS = /[^\x00-\x7F]/;

// Greek capital sigma lowercases to ς or σ depending on its neighbours, so
// lowercasing a whole string differs from lowercasing each character of it.
const FINAL_SIGMA_TRIGGER = /Σ/;

// A surrogate pair is one code point to String.prototype.toLowerCase but two
// uncased code units to foldSearchTextWithMap, which walks code units — so the
// two disagree on astral letters that carry a case mapping (Deseret, Osage,
// Adlam: 260 code points in total). Testing for a high surrogate alone was too
// blunt: emoji are routine in JSON response examples, and one of them sent a
// whole multi-MB field down the per-character path the fast path exists to
// avoid. Emoji and symbols are caseless, so only pairs that actually change
// under toLowerCase need the exact path.
const SURROGATE_PAIRS = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

const hasCasedSurrogatePair = (source: string): boolean => {
  SURROGATE_PAIRS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURROGATE_PAIRS.exec(source)) !== null) {
    if (match[0].toLowerCase() !== match[0]) {
      return true;
    }
  }
  return false;
};

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
 *
 * Kept separate from foldSearchTextWithMap: the search index folds whole
 * request bodies and example blocks and never needs the position map, and
 * paying a character-sized number array (plus the per-character loop) for
 * multi-MB fields is what made indexing a 5 MB folder hang the app.
 */
export const foldSearchText = (text: unknown, options: FoldOptions = {}): string => {
  const raw = String(text ?? '');
  // ASCII is unchanged by NFC and holds no foldable character, so the whole
  // fold collapses into one native lowercase. Request bodies are mostly
  // ASCII, which makes this the index's hot path.
  if (!NON_ASCII_CHARS.test(raw)) {
    return options.caseSensitive ? raw : raw.toLowerCase();
  }

  const source = raw.normalize('NFC');
  // Only the lowercasing step can disagree with the per-character path, so a
  // case-sensitive fold never needs the exact fallback.
  if (!options.caseSensitive && (FINAL_SIGMA_TRIGGER.test(source) || hasCasedSurrogatePair(source))) {
    return foldSearchTextWithMap(source, options).folded;
  }

  const parts: string[] = [];
  let runStart = 0;
  let match: RegExpExecArray | null;
  FOLDED_CHARS.lastIndex = 0;
  while ((match = FOLDED_CHARS.exec(source)) !== null) {
    const char = match[0];
    parts.push(source.slice(runStart, match.index));
    if (!REMOVED_CHARS.test(char)) {
      parts.push(CHAR_FOLD_MAP[char] || char);
    }
    runStart = match.index + 1;
  }

  if (!parts.length) {
    return options.caseSensitive ? source : source.toLowerCase();
  }

  parts.push(source.slice(runStart));
  const folded = parts.join('');
  return options.caseSensitive ? folded : folded.toLowerCase();
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
