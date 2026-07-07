/**
 * Pure helpers backing the selection inspection tools (see ./selectionDataTools.js).
 *
 * Everything in here is side-effect free so it can be unit tested without a DOM:
 * epoch/date conversion, hash digests (md5 local, sha via Web Crypto), JSON string
 * escape/unescape, URL breakdown and unicode/normalization analysis.
 */

const EPOCH_RE = /^\d{10}$|^\d{13}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const URL_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const PLAUSIBLE_YEAR_MIN = 1980;
const PLAUSIBLE_YEAR_MAX = 2100;

const DEFAULT_PORTS = {
  http: '80',
  https: '443',
  ws: '80',
  wss: '443',
  ftp: '21'
};

// Mirrors normalizeSelectedToken() in selectionDataTools.js: strip wrapping
// quotes and trailing separators so tokens copied out of JSON/code still match.
const normalizeToken = (value) => {
  let token = String(value || '').trim();

  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith('\'') && token.endsWith('\''))
    || (token.startsWith('`') && token.endsWith('`'))
  ) {
    token = token.slice(1, -1);
  }

  return token.replace(/[,;]+$/, '');
};

const isPlausibleDate = (date) => {
  const year = date.getUTCFullYear();
  return year >= PLAUSIBLE_YEAR_MIN && year <= PLAUSIBLE_YEAR_MAX;
};

const describeDate = (label, epochMillis) => {
  const date = new Date(epochMillis);
  return {
    label,
    epochMillis,
    epochSeconds: Math.floor(epochMillis / 1000),
    iso: date.toISOString(),
    utc: date.toUTCString(),
    local: date.toLocaleString(),
    plausible: isPlausibleDate(date)
  };
};

/**
 * Epoch/date converter.
 * - 10/13 digit number -> local + UTC datetime (both seconds and millis
 *   interpretations are returned when both land on a plausible year).
 * - ISO-8601 date -> epoch seconds/millis.
 * Returns null when the selection is neither.
 */
export const getEpochDateDetails = (selection) => {
  const token = normalizeToken(selection);

  if (EPOCH_RE.test(token)) {
    const value = Number(token);
    const asSeconds = describeDate('As epoch seconds', value * 1000);
    const asMillis = describeDate('As epoch milliseconds', value);
    const primary = token.length === 10 ? asSeconds : asMillis;
    const secondary = token.length === 10 ? asMillis : asSeconds;
    const interpretations = [primary];

    // Ambiguous: show the other direction too when it is also plausible.
    if (secondary.plausible) {
      interpretations.push(secondary);
    }

    return { kind: 'epoch', input: token, interpretations };
  }

  if (ISO_DATE_RE.test(token)) {
    const epochMillis = Date.parse(token);
    if (Number.isNaN(epochMillis)) {
      return null;
    }
    return {
      kind: 'date',
      input: token,
      interpretations: [describeDate('ISO-8601 date', epochMillis)]
    };
  }

  return null;
};

export const bytesToHex = (bytes) => {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
};

/* ------------------------------- MD5 ---------------------------------- */
// Self-contained MD5 (RFC 1321) over UTF-8 bytes. No dependency in
// bruno-app's package.json provides md5 (crypto-js is only a bruno-js dep),
// and the Web Crypto API does not implement it, so we ship this ~100 line
// implementation instead of adding a dependency.

const safeAdd = (a, b) => {
  const lsw = (a & 0xffff) + (b & 0xffff);
  const msw = (a >> 16) + (b >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xffff);
};
const rotateLeft = (value, shift) => (value << shift) | (value >>> (32 - shift));
const md5cmn = (q, a, b, x, s, t) => safeAdd(rotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
const md5ff = (a, b, c, d, x, s, t) => md5cmn((b & c) | (~b & d), a, b, x, s, t);
const md5gg = (a, b, c, d, x, s, t) => md5cmn((b & d) | (c & ~d), a, b, x, s, t);
const md5hh = (a, b, c, d, x, s, t) => md5cmn(b ^ c ^ d, a, b, x, s, t);
const md5ii = (a, b, c, d, x, s, t) => md5cmn(c ^ (b | ~d), a, b, x, s, t);

const md5cycle = (state, k) => {
  let [a, b, c, d] = state;

  a = md5ff(a, b, c, d, k[0], 7, -680876936);
  d = md5ff(d, a, b, c, k[1], 12, -389564586);
  c = md5ff(c, d, a, b, k[2], 17, 606105819);
  b = md5ff(b, c, d, a, k[3], 22, -1044525330);
  a = md5ff(a, b, c, d, k[4], 7, -176418897);
  d = md5ff(d, a, b, c, k[5], 12, 1200080426);
  c = md5ff(c, d, a, b, k[6], 17, -1473231341);
  b = md5ff(b, c, d, a, k[7], 22, -45705983);
  a = md5ff(a, b, c, d, k[8], 7, 1770035416);
  d = md5ff(d, a, b, c, k[9], 12, -1958414417);
  c = md5ff(c, d, a, b, k[10], 17, -42063);
  b = md5ff(b, c, d, a, k[11], 22, -1990404162);
  a = md5ff(a, b, c, d, k[12], 7, 1804603682);
  d = md5ff(d, a, b, c, k[13], 12, -40341101);
  c = md5ff(c, d, a, b, k[14], 17, -1502002290);
  b = md5ff(b, c, d, a, k[15], 22, 1236535329);

  a = md5gg(a, b, c, d, k[1], 5, -165796510);
  d = md5gg(d, a, b, c, k[6], 9, -1069501632);
  c = md5gg(c, d, a, b, k[11], 14, 643717713);
  b = md5gg(b, c, d, a, k[0], 20, -373897302);
  a = md5gg(a, b, c, d, k[5], 5, -701558691);
  d = md5gg(d, a, b, c, k[10], 9, 38016083);
  c = md5gg(c, d, a, b, k[15], 14, -660478335);
  b = md5gg(b, c, d, a, k[4], 20, -405537848);
  a = md5gg(a, b, c, d, k[9], 5, 568446438);
  d = md5gg(d, a, b, c, k[14], 9, -1019803690);
  c = md5gg(c, d, a, b, k[3], 14, -187363961);
  b = md5gg(b, c, d, a, k[8], 20, 1163531501);
  a = md5gg(a, b, c, d, k[13], 5, -1444681467);
  d = md5gg(d, a, b, c, k[2], 9, -51403784);
  c = md5gg(c, d, a, b, k[7], 14, 1735328473);
  b = md5gg(b, c, d, a, k[12], 20, -1926607734);

  a = md5hh(a, b, c, d, k[5], 4, -378558);
  d = md5hh(d, a, b, c, k[8], 11, -2022574463);
  c = md5hh(c, d, a, b, k[11], 16, 1839030562);
  b = md5hh(b, c, d, a, k[14], 23, -35309556);
  a = md5hh(a, b, c, d, k[1], 4, -1530992060);
  d = md5hh(d, a, b, c, k[4], 11, 1272893353);
  c = md5hh(c, d, a, b, k[7], 16, -155497632);
  b = md5hh(b, c, d, a, k[10], 23, -1094730640);
  a = md5hh(a, b, c, d, k[13], 4, 681279174);
  d = md5hh(d, a, b, c, k[0], 11, -358537222);
  c = md5hh(c, d, a, b, k[3], 16, -722521979);
  b = md5hh(b, c, d, a, k[6], 23, 76029189);
  a = md5hh(a, b, c, d, k[9], 4, -640364487);
  d = md5hh(d, a, b, c, k[12], 11, -421815835);
  c = md5hh(c, d, a, b, k[15], 16, 530742520);
  b = md5hh(b, c, d, a, k[2], 23, -995338651);

  a = md5ii(a, b, c, d, k[0], 6, -198630844);
  d = md5ii(d, a, b, c, k[7], 10, 1126891415);
  c = md5ii(c, d, a, b, k[14], 15, -1416354905);
  b = md5ii(b, c, d, a, k[5], 21, -57434055);
  a = md5ii(a, b, c, d, k[12], 6, 1700485571);
  d = md5ii(d, a, b, c, k[3], 10, -1894986606);
  c = md5ii(c, d, a, b, k[10], 15, -1051523);
  b = md5ii(b, c, d, a, k[1], 21, -2054922799);
  a = md5ii(a, b, c, d, k[8], 6, 1873313359);
  d = md5ii(d, a, b, c, k[15], 10, -30611744);
  c = md5ii(c, d, a, b, k[6], 15, -1560198380);
  b = md5ii(b, c, d, a, k[13], 21, 1309151649);
  a = md5ii(a, b, c, d, k[4], 6, -145523070);
  d = md5ii(d, a, b, c, k[11], 10, -1120210379);
  c = md5ii(c, d, a, b, k[2], 15, 718787259);
  b = md5ii(b, c, d, a, k[9], 21, -343485551);

  state[0] = safeAdd(a, state[0]);
  state[1] = safeAdd(b, state[1]);
  state[2] = safeAdd(c, state[2]);
  state[3] = safeAdd(d, state[3]);
};

const bytesToWords = (bytes, offset) => {
  const words = new Array(16).fill(0);
  for (let i = 0; i < 64; i += 4) {
    words[i >> 2] = bytes[offset + i]
      | (bytes[offset + i + 1] << 8)
      | (bytes[offset + i + 2] << 16)
      | (bytes[offset + i + 3] << 24);
  }
  return words;
};

const wordToHex = (word) => {
  let hex = '';
  for (let i = 0; i < 4; i++) {
    hex += ((word >> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
};

export const md5Hex = (text) => {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const length = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i = 0;

  for (; i + 64 <= length; i += 64) {
    md5cycle(state, bytesToWords(bytes, i));
  }

  const tail = new Uint8Array(64);
  tail.set(bytes.subarray(i));
  tail[length - i] = 0x80;

  if (length - i >= 56) {
    md5cycle(state, bytesToWords(tail, 0));
    tail.fill(0);
  }

  const bitLength = length * 8;
  const words = bytesToWords(tail, 0);
  words[14] = bitLength & 0xffffffff;
  words[15] = Math.floor(bitLength / 0x100000000);
  md5cycle(state, words);

  return state.map(wordToHex).join('');
};

/* ----------------------------- SHA digests ----------------------------- */

export const shaDigestHex = async (algorithm, text) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return null;
  }
  const data = new TextEncoder().encode(String(text ?? ''));
  const digest = await subtle.digest(algorithm, data);
  return bytesToHex(new Uint8Array(digest));
};

export const getSelectionDigests = async (text) => {
  const [sha1, sha256] = await Promise.all([
    shaDigestHex('SHA-1', text),
    shaDigestHex('SHA-256', text)
  ]);

  return {
    md5: md5Hex(text),
    sha1,
    sha256
  };
};

/* ------------------------ JSON string literals ------------------------- */

export const escapeJsonString = (value) => JSON.stringify(String(value ?? ''));

/**
 * When the selection parses as a JSON string literal ("..." with escapes),
 * returns the unescaped string, otherwise null.
 */
export const getJsonStringLiteral = (selection) => {
  const token = String(selection || '').trim();

  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    return null;
  }

  try {
    const parsed = JSON.parse(token);
    return typeof parsed === 'string' ? parsed : null;
  } catch (e) {
    return null;
  }
};

/* ------------------------------ URL parts ------------------------------ */

/**
 * When the selection is a URL with an explicit scheme, returns
 * scheme/host/port/path plus a decoded query-param table, otherwise null.
 */
export const getUrlBreakdown = (selection) => {
  const token = normalizeToken(selection);

  if (!URL_WITH_SCHEME_RE.test(token)) {
    return null;
  }

  try {
    const url = new URL(token);
    const scheme = url.protocol.replace(/:$/, '');
    const params = [];
    url.searchParams.forEach((value, key) => params.push({ key, value }));

    return {
      href: url.href,
      scheme,
      host: url.hostname,
      port: url.port || DEFAULT_PORTS[scheme] || '',
      isDefaultPort: !url.port,
      path: url.pathname,
      hash: url.hash.replace(/^#/, ''),
      params
    };
  } catch (e) {
    return null;
  }
};

/* --------------------------- Unicode report ---------------------------- */

const INVISIBLE_CHARS = [
  { char: '\u200c', name: 'ZWNJ (zero-width non-joiner, U+200C)' },
  { char: '\u200d', name: 'ZWJ (zero-width joiner, U+200D)' },
  { char: '\u200e', name: 'LRM (left-to-right mark, U+200E)' },
  { char: '\u200f', name: 'RLM (right-to-left mark, U+200F)' },
  { char: '\u00a0', name: 'NBSP (no-break space, U+00A0)' },
  { char: '\u200b', name: 'ZWSP (zero-width space, U+200B)' },
  { char: '\ufeff', name: 'BOM/ZWNBSP (U+FEFF)' }
];

const countOccurrences = (text, char) => {
  let count = 0;
  for (const cp of text) {
    if (cp === char) count++;
  }
  return count;
};

/**
 * Unicode inspector: code point length, NFC/NFD normalization status (with
 * normalized forms when they differ) and counts of invisible/bidi characters
 * (ZWNJ, ZWJ, LRM, RLM, NBSP, ...). `interesting` gates UI visibility.
 */
export const getUnicodeReport = (selection) => {
  const text = String(selection || '');
  if (!text) {
    return null;
  }

  const codePointCount = Array.from(text).length;
  const nfc = text.normalize('NFC');
  const nfd = text.normalize('NFD');
  const isNFC = text === nfc;
  const isNFD = text === nfd;

  let normalizationForm;
  if (isNFC && isNFD) {
    normalizationForm = 'NFC = NFD (no combining marks)';
  } else if (isNFC) {
    normalizationForm = 'NFC (composed)';
  } else if (isNFD) {
    normalizationForm = 'NFD (decomposed)';
  } else {
    normalizationForm = 'Not normalized (neither NFC nor NFD)';
  }

  const invisibles = INVISIBLE_CHARS
    .map(({ char, name }) => ({ char, name, count: countOccurrences(text, char) }))
    .filter(({ count }) => count > 0);

  const hasNonAscii = /[^\x20-\x7e\t\r\n]/.test(text);

  return {
    codePointCount,
    utf16Length: text.length,
    nfc,
    nfd,
    isNFC,
    isNFD,
    normalizationForm,
    differsUnderNormalization: nfc !== nfd,
    invisibles,
    hasInvisibles: invisibles.length > 0,
    interesting: hasNonAscii || !isNFC || invisibles.length > 0
  };
};
