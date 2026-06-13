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
    }
  };
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
    if (matchCase
      && !utils.foldSearchText(entry.raw[field], { caseSensitive: true }).includes(foldedQueryCs)) {
      continue;
    }
    return { field };
  }
  return null;
};

module.exports = {
  SEARCH_FIELD_SCOPES,
  BRU_EXAMPLE_BLOCK_REGEX,
  extractSearchBlocks,
  buildSearchFields,
  matchSearchFields
};
