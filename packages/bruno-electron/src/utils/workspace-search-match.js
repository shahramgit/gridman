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

const extractSearchBlocks = (content, regex) => {
  const parts = [];
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(content)) !== null) {
    parts.push(match[1]);
  }
  return parts.join('\n');
};

// Structured per-example entries (name + folded name/content) so examples can
// be surfaced as their own search results, in file order (index = the
// example's position, matching the parsed request.examples order).
const extractExampleEntries = (content, format) => {
  if (format !== 'bru' || !content) {
    return [];
  }
  const entries = [];
  let match;
  BRU_EXAMPLE_BLOCK_REGEX.lastIndex = 0;
  while ((match = BRU_EXAMPLE_BLOCK_REGEX.exec(content)) !== null) {
    const block = match[1] || '';
    const nameMatch = block.match(/(?:^|\n)\s*name:\s*(.+?)\s*(?:\n|$)/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    entries.push({
      name,
      index: entries.length,
      foldedName: utils.foldSearchText(name),
      foldedContent: utils.foldSearchText(block)
    });
  }
  return entries;
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
  const headersRaw = format === 'bru' ? extractSearchBlocks(content, BRU_HEADERS_BLOCK_REGEX) : content;
  const bodyRaw = format === 'bru' ? extractSearchBlocks(content, BRU_BODY_BLOCK_REGEX) : content;
  const examplesRaw = format === 'bru' ? extractSearchBlocks(content, BRU_EXAMPLE_BLOCK_REGEX) : content;

  const raw = {
    name: name || '',
    filename: filename || '',
    url: url || '',
    headers: headersRaw,
    body: bodyRaw,
    examples: examplesRaw
  };

  return {
    raw,
    folded: {
      name: utils.foldSearchText(raw.name),
      filename: utils.foldSearchText(raw.filename),
      url: utils.foldSearchText(raw.url),
      headers: utils.foldSearchText(raw.headers),
      body: utils.foldSearchText(raw.body),
      examples: utils.foldSearchText(raw.examples)
    },
    exampleEntries: extractExampleEntries(content, format)
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
  BRU_EXAMPLE_BLOCK_REGEX,
  extractSearchBlocks,
  extractExampleEntries,
  matchExampleEntries,
  buildSearchFields,
  matchSearchFields,
  boundSnippetSource,
  createSearchSnippet
};
