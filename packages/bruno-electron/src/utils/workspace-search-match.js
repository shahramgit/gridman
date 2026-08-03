const { utils } = require('@usebruno/common');

// Output field -> scope key. Order is match priority (mirrors the result
// label order shown in the sidebar).
const SEARCH_FIELD_SCOPES = [
  ['name', 'names'],
  ['filename', 'names'],
  ['url', 'url'],
  ['headers', 'headers'],
  ['body', 'body'],
  ['examples', 'examples']
];

const BRU_HEADERS_BLOCK_REGEX = /(?:^|\n)headers\s*\{([\s\S]*?)\n\}/g;
const BRU_BODY_BLOCK_REGEX = /(?:^|\n)body(?::[\w:-]+)?\s*\{([\s\S]*?)\n\}/g;
// Capture each example block fully. Example blocks are top-level (start at
// column 0) and close with a column-0 brace.
const BRU_EXAMPLE_BLOCK_REGEX = /(?:^|\n)example\s*\{([\s\S]*?)\n\}/g;

// A single request can carry megabytes of response examples (a 5 MB folder in
// a customer collection hung the app on startup: warming the index folded and
// then retained several full-size copies of that text per file). Fields above
// this cap are indexed up to the cap only and the entry is marked truncated;
// name/filename/url — the identity fields a request is usually looked up by —
// are never capped.
//
// The unit is UTF-16 code units (what String.length and String.slice count),
// NOT bytes. V8 stores any string with a non-Latin1 character as two bytes per
// code unit, so a capped field costs up to ~2 MB resident for ASCII and up to
// ~4 MB for Persian — doubled again because an entry keeps both the raw and
// the folded copy. Counting code units rather than bytes is deliberate: it
// gives Persian and ASCII collections the same number of searchable
// characters.
const SEARCH_INDEX_MAX_FIELD_CHARS = 2 * 1024 * 1024;

const extractSearchBlocks = (content, regex) => {
  const parts = [];
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(content)) !== null) {
    parts.push(match[1]);
  }
  return parts.join('\n');
};

const extractExampleBlocks = (content) => {
  const blocks = [];
  let match;
  BRU_EXAMPLE_BLOCK_REGEX.lastIndex = 0;
  while ((match = BRU_EXAMPLE_BLOCK_REGEX.exec(content)) !== null) {
    blocks.push(match[1] || '');
  }
  return blocks;
};

// A substring keeps its whole parent alive in V8, so a block cut out of a
// request file pins that file's full text for as long as the cache holds the
// entry — a 200-char headers block was enough to retain a 5 MB request, and
// capping a field would otherwise save nothing. Copy what we keep out of the
// parent. The round trip is exact for well-formed UTF-16, which is what the
// utf8-decoded file content is — but only as long as nothing hands this a
// half of a surrogate pair, which utf8 cannot encode and which would come back
// as U+FFFD. See capIndex: our own slicing is the one place that could.
const detachSearchText = (text) => (text ? Buffer.from(text).toString() : '');

// Cut at the cap, or one code unit earlier when the cap lands between the two
// halves of a surrogate pair (an emoji or astral character straddling it).
const capIndex = (value) => {
  const code = value.charCodeAt(SEARCH_INDEX_MAX_FIELD_CHARS - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return isHighSurrogate ? SEARCH_INDEX_MAX_FIELD_CHARS - 1 : SEARCH_INDEX_MAX_FIELD_CHARS;
};

// One capped field: { text, truncated }, folded lazily so callers that share
// a field (yml has no block syntax — headers/body/examples are all the whole
// file) fold and retain it once instead of three times.
const createSearchField = (text) => {
  const value = text || '';
  return value.length > SEARCH_INDEX_MAX_FIELD_CHARS
    ? { text: detachSearchText(value.slice(0, capIndex(value))), truncated: true }
    : { text: detachSearchText(value), truncated: false };
};

const foldSearchField = (field) => {
  if (field.folded === undefined) {
    field.folded = utils.foldSearchText(field.text);
  }
  return field.folded;
};

// Structured per-example entries (name + file order index, matching the
// parsed request.examples order) so a search row can list a request's
// examples without parsing the file.
//
// These used to carry folded copies of the example name AND of the whole
// example block, for a per-example matcher that no production code ever
// called — content inside an example is matched through the `examples` field,
// which is folded once for the whole file. Measured on the real 11,277-file
// workspace, the dead per-example fold cost 253 MB of retained heap (894 ->
// 641 MB) and 927 ms of every index build (3,173 -> 2,246 ms).
const buildExampleEntries = (blocks) => {
  return blocks.map((block, index) => {
    const nameMatch = block.match(/(?:^|\n)\s*name:\s*(.+?)\s*(?:\n|$)/);
    return {
      name: detachSearchText(nameMatch ? nameMatch[1].trim() : ''),
      index
    };
  });
};

const extractExampleEntries = (content, format) => {
  if (format !== 'bru' || !content) {
    return [];
  }
  return buildExampleEntries(extractExampleBlocks(content));
};

// Build the raw + folded searchable fields for a request file. yml files do
// not have the bru block syntax, so headers/body/examples fall back to the
// whole content (still scoped by the checkbox).
const buildSearchFields = ({ content = '', format = 'bru', name = '', filename = '', url = '' }) => {
  const isBru = format === 'bru';
  const exampleBlocks = isBru ? extractExampleBlocks(content) : [];
  const headersField = createSearchField(isBru ? extractSearchBlocks(content, BRU_HEADERS_BLOCK_REGEX) : content);
  const bodyField = isBru ? createSearchField(extractSearchBlocks(content, BRU_BODY_BLOCK_REGEX)) : headersField;
  const examplesField = isBru ? createSearchField(exampleBlocks.join('\n')) : headersField;

  const raw = {
    name: name || '',
    filename: filename || '',
    url: url || '',
    headers: headersField.text,
    body: bodyField.text,
    examples: examplesField.text
  };

  return {
    raw,
    folded: {
      name: utils.foldSearchText(raw.name),
      filename: utils.foldSearchText(raw.filename),
      url: utils.foldSearchText(raw.url),
      headers: foldSearchField(headersField),
      body: foldSearchField(bodyField),
      examples: foldSearchField(examplesField)
    },
    truncated: headersField.truncated || bodyField.truncated || examplesField.truncated,
    exampleEntries: isBru ? buildExampleEntries(exampleBlocks) : []
  };
};

// Case-sensitive folds are only needed when match-case is on, so they are
// computed lazily and cached on the entry — the first match-case keystroke
// pays the fold once per field; every keystroke after that is a map lookup.
// (Folding the full raw field per entry per keystroke was a main-process
// stall on large workspaces.)
//
// Deliberately NOT budgeted, and that was measured. A global 8 MB char budget
// was tried and reverted: the fold working set for ONE realistic match-case
// query over the real 11,277-file workspace is 99.3M code units, so an 8 MB
// budget cached 266 of the 1,310 allocating folds and left the rest re-folding
// on every keystroke — 163 ms per keystroke, permanently, against 32-35 ms with
// the cache doing its job. A budget small enough to be worth having is a
// budget that leaves the stall this cache exists to remove.
//
// What it costs: +190 MB retained on top of the 633 MB index for that query
// ('DATA' matches ~4,000 fields case-INsensitively — the fold is taken for
// each of them, whether or not the case-sensitive check then passes — and only
// 26 case-sensitively, so the pass never early-breaks). Paid only when the
// user turns match-case ON, only for what they actually searched, and the fold
// hangs off the index entry so it is freed with the collection when the index
// is rebuilt or evicted.
//
// An all-ASCII field folds to the raw string itself (foldSearchText's fast
// path returns its input), so caching it retains nothing at all — on that
// search that was true of most matching fields.
const getCaseSensitiveFold = (entry, field) => {
  entry.foldedCs = entry.foldedCs || {};
  if (entry.foldedCs[field] === undefined) {
    entry.foldedCs[field] = utils.foldSearchText(entry.raw[field], { caseSensitive: true });
  }
  return entry.foldedCs[field];
};

// Returns { field } of the first scope-enabled match, or null. Snippet/label
// text is the caller's concern (it needs the original content + position).
const matchSearchFields = (entry, { scopes, foldedQueryCi, foldedQueryCs, matchCase }) => {
  for (const [field, scope] of SEARCH_FIELD_SCOPES) {
    if (!scopes[scope]) {
      continue;
    }
    const foldedValue = entry.folded[field];
    if (!foldedValue || !foldedValue.includes(foldedQueryCi)) {
      continue;
    }
    if (matchCase && !getCaseSensitiveFold(entry, field).includes(foldedQueryCs)) {
      continue;
    }
    return { field };
  }
  return null;
};

const SNIPPET_WINDOW_MARGIN = 300;

// Bound the text handed to the (char-by-char) fold-and-find pass to a window
// around the match instead of the whole field. The already-folded field gives
// an approximate offset; folding only removes characters, so the true raw
// match start lies within [approx, approx + removedChars] — the window covers
// that span plus display margins. Without this, one large body/example block
// re-folds in full for every matched result on every keystroke.
const boundSnippetSource = (entry, field, { matchCase, foldedQueryCi, foldedQueryCs }) => {
  const raw = entry.raw?.[field];
  if (!raw) {
    return { source: '', truncatedStart: false };
  }
  const folded = matchCase ? getCaseSensitiveFold(entry, field) : entry.folded?.[field];
  const foldedQuery = matchCase ? foldedQueryCs : foldedQueryCi;
  const approx = folded && foldedQuery ? folded.indexOf(foldedQuery) : -1;
  if (approx < 0) {
    return { source: raw, truncatedStart: false };
  }
  const removed = Math.max(0, raw.length - folded.length);
  const start = Math.max(0, approx - 100);
  const end = Math.min(raw.length, approx + removed * 2 + foldedQuery.length + SNIPPET_WINDOW_MARGIN);
  return { source: raw.slice(start, end), truncatedStart: start > 0 };
};

const createSearchSnippet = (content, query, foldOptions = {}, { truncatedStart = false } = {}) => {
  if (!content || !query) {
    return '';
  }

  const normalizedContent = String(content);
  const range = utils.findFoldedMatchRange(normalizedContent, query, foldOptions);
  if (!range) {
    return '';
  }

  const start = Math.max(0, range.start - 40);
  const end = Math.min(normalizedContent.length, range.end + 60);
  const prefix = start > 0 || truncatedStart ? '...' : '';
  const suffix = end < normalizedContent.length ? '...' : '';

  return `${prefix}${normalizedContent.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
};

module.exports = {
  SEARCH_FIELD_SCOPES,
  SEARCH_INDEX_MAX_FIELD_CHARS,
  BRU_EXAMPLE_BLOCK_REGEX,
  detachSearchText,
  extractSearchBlocks,
  extractExampleEntries,
  buildSearchFields,
  matchSearchFields,
  boundSnippetSource,
  createSearchSnippet
};
