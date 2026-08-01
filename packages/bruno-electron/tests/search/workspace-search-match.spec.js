const {
  buildSearchFields,
  matchSearchFields,
  extractExampleEntries,
  matchExampleEntries,
  boundSnippetSource,
  createSearchSnippet,
  SEARCH_INDEX_MAX_FIELD_CHARS
} = require('../../src/utils/workspace-search-match');
const { utils } = require('@usebruno/common');

// A realistic .bru request with a response example block. The needle
// 'exampleonlytoken' appears ONLY inside the example block.
const BRU = `meta {
  name: Get User
  type: http
  seq: 1
}

get {
  url: https://api.example.com/users
  body: none
  auth: none
}

headers {
  x-real-header: realvalue
}

example {
  name: Sample Response
  request: {
    url: https://api.example.com/users
  }
  response: {
    body: exampleonlytoken
  }
}
`;

const fieldsFor = (content) => buildSearchFields({
  content,
  format: 'bru',
  name: 'Get User',
  filename: 'get-user.bru',
  url: 'https://api.example.com/users'
});

const job = (query, scopes) => ({
  scopes,
  matchCase: false,
  foldedQueryCi: utils.foldSearchText(query),
  foldedQueryCs: utils.foldSearchText(query, { caseSensitive: true })
});

const ALL_OFF = { collections: false, names: false, url: false, headers: false, body: false, examples: false };

describe('workspace search matching', () => {
  it('captures the full example block', () => {
    const { raw } = fieldsFor(BRU);
    expect(raw.examples).toContain('Sample Response');
    expect(raw.examples).toContain('exampleonlytoken');
  });

  it('matches a term that is only in an example WHEN the examples scope is on', () => {
    const entry = fieldsFor(BRU);
    expect(matchSearchFields(entry, job('exampleonlytoken', { ...ALL_OFF, examples: true }))).toEqual({ field: 'examples' });
  });

  it('does NOT match the example term when the examples scope is off', () => {
    const entry = fieldsFor(BRU);
    expect(matchSearchFields(entry, job('exampleonlytoken', { ...ALL_OFF, names: true, url: true, headers: true, body: true }))).toBeNull();
  });

  it('still matches name/url/headers in their own scopes', () => {
    const entry = fieldsFor(BRU);
    expect(matchSearchFields(entry, job('Get User', { ...ALL_OFF, names: true }))).toEqual({ field: 'name' });
    expect(matchSearchFields(entry, job('realvalue', { ...ALL_OFF, headers: true }))).toEqual({ field: 'headers' });
    expect(matchSearchFields(entry, job('realvalue', { ...ALL_OFF, examples: true }))).toBeNull();
  });

  it('folds Persian variants in example content', () => {
    const entry = fieldsFor(BRU.replace('exampleonlytoken', 'سرويس'));
    // query typed with the other yeh variant still matches
    expect(matchSearchFields(entry, job('سرویس', { ...ALL_OFF, examples: true }))).toEqual({ field: 'examples' });
  });

  describe('examples as their own results', () => {
    const MULTI = `meta {
  name: Get User
  type: http
  seq: 1
}

get {
  url: https://api.example.com/users
}

example {
  name: Success case
  response: { body: ok }
}

example {
  name: Error case
  response: { body: boom failuretoken }
}
`;

    it('extracts each example with name and index', () => {
      const entries = extractExampleEntries(MULTI, 'bru');
      expect(entries.map((e) => ({ name: e.name, index: e.index }))).toEqual([
        { name: 'Success case', index: 0 },
        { name: 'Error case', index: 1 }
      ]);
    });

    it('matches examples by name and by content, returning original indices', () => {
      const entries = extractExampleEntries(MULTI, 'bru');
      const byName = matchExampleEntries(entries, { foldedQueryCi: utils.foldSearchText('error case') });
      expect(byName.map((e) => e.index)).toEqual([1]);

      const byContent = matchExampleEntries(entries, { foldedQueryCi: utils.foldSearchText('failuretoken') });
      expect(byContent.map((e) => e.index)).toEqual([1]);
    });
  });

  describe('oversized fields', () => {
    it('caps a body past the index limit and reports the entry as truncated', () => {
      const content = `body:json {\n  ${'a'.repeat(SEARCH_INDEX_MAX_FIELD_CHARS + 5000)}\n}\n`;
      const fields = buildSearchFields({ content, format: 'bru', name: 'Big Body', filename: 'big.bru', url: 'https://api.example.com/big' });

      expect(fields.truncated).toBe(true);
      expect(fields.raw.body.length).toBe(SEARCH_INDEX_MAX_FIELD_CHARS);
      expect(fields.folded.body.length).toBeLessThanOrEqual(SEARCH_INDEX_MAX_FIELD_CHARS);
      // identity fields are never capped, so the request stays findable
      expect(fields.raw.name).toBe('Big Body');
      expect(fields.folded.url).toBe('https://api.example.com/big');
      expect(matchSearchFields(fields, job('Big Body', { ...ALL_OFF, names: true }))).toEqual({ field: 'name' });
    });

    it('leaves fields under the limit untruncated', () => {
      const fields = fieldsFor(BRU);
      expect(fields.truncated).toBe(false);
    });

    it('keeps an example past the fold budget matchable by name', () => {
      const content = `example {\n  name: Huge Example\n  ${'b'.repeat(SEARCH_INDEX_MAX_FIELD_CHARS + 5000)}\n}\n`;
      const entries = extractExampleEntries(content, 'bru');

      expect(entries[0].name).toBe('Huge Example');
      expect(entries[0].foldedContent).toBe('');
      const byName = matchExampleEntries(entries, { foldedQueryCi: utils.foldSearchText('huge example') });
      expect(byName.map((e) => e.index)).toEqual([0]);
    });

    it('still indexes the content of examples that FOLLOW an oversized one', () => {
      // The budget must only be spent on blocks that were actually folded.
      // Charging it for a block we refused to fold drove it negative, and
      // every later example in the file lost its content index — a request
      // with one huge example made all its other examples unsearchable.
      const content = `example {\n  name: Huge Example\n  ${'b'.repeat(SEARCH_INDEX_MAX_FIELD_CHARS + 5000)}\n}\n\n`
        + 'example {\n  name: Small Example\n  response: { body: laterneedletoken }\n}\n';
      const entries = extractExampleEntries(content, 'bru');

      expect(entries.map((e) => e.name)).toEqual(['Huge Example', 'Small Example']);
      expect(entries[0].foldedContent).toBe('');
      expect(entries[1].foldedContent).toContain('laterneedletoken');

      const byContent = matchExampleEntries(entries, { foldedQueryCi: utils.foldSearchText('laterneedletoken') });
      expect(byContent.map((e) => e.index)).toEqual([1]);
    });

    it('never cuts a surrogate pair in half when capping a field', () => {
      // A lone surrogate is not encodable as utf8, so detaching the slice
      // would replace it with U+FFFD — a character the raw text never had.
      // The captured body block opens with the newline after '{', so this
      // padding puts the emoji's high surrogate exactly on the cap boundary.
      const filler = 'a'.repeat(SEARCH_INDEX_MAX_FIELD_CHARS - 2);
      const content = `body:json {\n${filler}🙂${'z'.repeat(1000)}\n}\n`;
      const fields = buildSearchFields({ content, format: 'bru', name: 'Emoji', filename: 'emoji.bru', url: '' });

      expect(fields.truncated).toBe(true);
      expect(fields.raw.body).not.toContain('�');
      expect(fields.folded.body).not.toContain('�');
      // the pair was dropped whole rather than split
      expect(fields.raw.body.length).toBe(SEARCH_INDEX_MAX_FIELD_CHARS - 1);
      expect(fields.raw.body.endsWith('a')).toBe(true);
    });
  });

  describe('case-sensitive fold caching', () => {
    it('computes the case-sensitive fold once and caches it on the entry', () => {
      const entry = buildSearchFields({ content: '', format: 'bru', name: 'Get User', filename: 'get-user.bru' });
      expect(entry.foldedCs).toBeUndefined();

      const match = matchSearchFields(entry, {
        scopes: { names: true },
        foldedQueryCi: utils.foldSearchText('get'),
        foldedQueryCs: utils.foldSearchText('Get', { caseSensitive: true }),
        matchCase: true
      });
      expect(match).toEqual({ field: 'name' });
      expect(entry.foldedCs.name).toBe(utils.foldSearchText('Get User', { caseSensitive: true }));

      // wrong case must not match when matchCase is on
      const noMatch = matchSearchFields(entry, {
        scopes: { names: true },
        foldedQueryCi: utils.foldSearchText('gET uSER'),
        foldedQueryCs: utils.foldSearchText('gET uSER', { caseSensitive: true }),
        matchCase: true
      });
      expect(noMatch).toBeNull();
    });
  });

  describe('boundSnippetSource + createSearchSnippet', () => {
    const makeEntry = (body) => {
      const raw = { body };
      return { raw, folded: { body: utils.foldSearchText(body) } };
    };

    it('returns a bounded window that still contains the match in a large body', () => {
      const needle = 'uniqueneedletoken';
      const body = `${'x'.repeat(50000)} ${needle} ${'y'.repeat(50000)}`;
      const entry = makeEntry(body);
      const job = { matchCase: false, foldedQueryCi: utils.foldSearchText(needle), foldedQueryCs: '' };

      const { source, truncatedStart } = boundSnippetSource(entry, 'body', job);
      expect(source.length).toBeLessThan(2000);
      expect(truncatedStart).toBe(true);

      const snippet = createSearchSnippet(source, needle, {}, { truncatedStart });
      expect(snippet).toContain(needle);
      expect(snippet.startsWith('...')).toBe(true);
    });

    it('finds a Persian needle despite folded/raw length differences', () => {
      // ZWNJ and diacritics are removed by folding, shifting offsets.
      const persian = 'می‌خواهم '.repeat(2000);
      const needle = 'نشانه‌جستجو';
      const body = `${persian}${needle} پایان`;
      const entry = makeEntry(body);
      const job = { matchCase: false, foldedQueryCi: utils.foldSearchText(needle), foldedQueryCs: '' };

      const { source, truncatedStart } = boundSnippetSource(entry, 'body', job);
      const snippet = createSearchSnippet(source, needle, {}, { truncatedStart });
      expect(snippet.length).toBeGreaterThan(0);
      expect(snippet).toContain('نشانه');
    });

    it('falls back to the full field when the folded offset is not found', () => {
      const entry = makeEntry('short body');
      const job = { matchCase: false, foldedQueryCi: utils.foldSearchText('absent'), foldedQueryCs: '' };
      const { source, truncatedStart } = boundSnippetSource(entry, 'body', job);
      expect(source).toBe('short body');
      expect(truncatedStart).toBe(false);
    });
  });
});
