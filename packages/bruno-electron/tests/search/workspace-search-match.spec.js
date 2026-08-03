const {
  buildSearchFields,
  matchSearchFields,
  extractExampleEntries,
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

    it('carries NOTHING but name and index — no per-example folded copies', () => {
      // Folded copies of the name and of the whole example block used to be
      // built here for a matcher no production code called; on the real
      // 11,277-file workspace they retained 260 MB. Example content is matched
      // through the `examples` FIELD, which is folded once for the whole file.
      const entries = extractExampleEntries(MULTI, 'bru');
      expect(entries.map((e) => Object.keys(e).sort())).toEqual([
        ['index', 'name'],
        ['index', 'name']
      ]);
    });

    it('still matches example content through the examples field', () => {
      const fields = buildSearchFields({ content: MULTI, format: 'bru', name: 'Get User', filename: 'get-user.bru', url: '' });
      expect(matchSearchFields(fields, job('failuretoken', { ...ALL_OFF, examples: true }))).toEqual({ field: 'examples' });
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

    it('lists every example of an oversized request by name, in file order', () => {
      // The examples FIELD is capped, so content past the cap is not
      // searchable (that is what `truncated` reports) — but the example list
      // itself must stay complete so the row can still show them.
      const content = `example {\n  name: Huge Example\n  ${'b'.repeat(SEARCH_INDEX_MAX_FIELD_CHARS + 5000)}\n}\n\n`
        + 'example {\n  name: Small Example\n  response: { body: laterneedletoken }\n}\n';
      const entries = extractExampleEntries(content, 'bru');

      expect(entries).toEqual([
        { name: 'Huge Example', index: 0 },
        { name: 'Small Example', index: 1 }
      ]);
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

    it('re-folds nothing on the next keystroke, for a working set past any small budget', () => {
      // A global 8 MB fold budget was tried here and reverted: one realistic
      // match-case query over the real workspace has a 99.3M code unit fold
      // working set, so the budget cached 266 of 1,310 allocating folds and
      // left the rest re-folding on EVERY keystroke — 163 ms per keystroke
      // against 32-35 ms with the cache doing its job.
      //
      // 'سرويس' carries an ARABIC YEH, which folds to FARSI YEH, so these
      // folds really do allocate (an all-ASCII field folds to the raw string
      // itself and retains nothing). 10.4M code units — past the budget that
      // was measured to defeat this cache.
      const PERSIAN_UNIT = 'سرويس ';
      const FIELD_CHARS = 2 * 1024 * 1024;
      const NEEDLE = 'NeedleToken';
      const entries = Array.from({ length: 5 }, () => {
        const body = PERSIAN_UNIT.repeat(Math.ceil(FIELD_CHARS / PERSIAN_UNIT.length)) + NEEDLE;
        return { raw: { body }, folded: { body: utils.foldSearchText(body) } };
      });
      const matchCaseJob = {
        scopes: { ...ALL_OFF, body: true },
        matchCase: true,
        foldedQueryCi: utils.foldSearchText(NEEDLE),
        foldedQueryCs: utils.foldSearchText(NEEDLE, { caseSensitive: true })
      };

      for (const entry of entries) {
        expect(matchSearchFields(entry, matchCaseJob)).toEqual({ field: 'body' });
        expect(entry.foldedCs.body).not.toBe(entry.raw.body);
      }

      // Poison the raw text every cached fold came from: a second keystroke
      // that still matches can only be reading the cache. Any entry whose fold
      // was dropped instead of kept re-folds the poison and stops matching.
      for (const entry of entries) {
        entry.raw.body = 'poisoned';
      }
      for (const entry of entries) {
        expect(matchSearchFields(entry, matchCaseJob)).toEqual({ field: 'body' });
      }
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
