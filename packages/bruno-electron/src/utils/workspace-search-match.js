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

// Structured per-example entries (name + folded name/content) so examples can
// be surfaced as their own search results, in file order (index = the
// example's position, matching the parsed request.examples order).
const buildExampleEntries = (blocks) => {
  // The same text is already folded once into the examples field, so a
  // per-example copy of it is a second full-size retention. Fold example
  // bodies only until the field cap is spent; past it the example is still
  // listed and still matchable by name.
  let foldBudget = SEARCH_INDEX_MAX_FIELD_CHARS;
  return blocks.map((block, index) => {
    const nameMatch = block.match(/(?:^|\n)\s*name:\s*(.+?)\s*(?:\n|$)/);
    const name = detachSearchText(nameMatch ? nameMatch[1].trim() : '');
    const withinBudget = block.length <= foldBudget;
    // Only spend what was actually folded. Charging the budget for a block we
    // refused to fold drove it negative, which silently un-indexed the content
    // of every LATER example in the file — one oversized example next to
    // small ones made all of them unsearchable.
    if (withinBudget) {
      foldBudget -= block.length;
    }
    return {
      name,
      index,
      foldedName: utils.foldSearchText(name),
      foldedContent: withinBudget ? detachSearchText(utils.foldSearchText(block)) : ''
    };
  });
};

const extractExampleEntries = (content, format) => {
  if (format !== 'bru' || !content) {
    return [];
  }
  return buildExampleEntries(extractExampleBlocks(content));
};

// Returns matching example entries for a query (name or content), each with
// the original index so the renderer can resolve the example after hydration.
const matchExampleEntries = (exampleEntries, { foldedQueryCi }) => {
  if (!foldedQueryCi) {
    return [];
  }
  return (exampleEntries || []).filter(
    (entry) => entry.foldedName.includes(foldedQueryCi) || entry.foldedContent.includes(foldedQueryCi)
  );
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
  matchExampleEntries,
  buildSearchFields,
  matchSearchFields,
  boundSnippetSource,
  createSearchSnippet
};
