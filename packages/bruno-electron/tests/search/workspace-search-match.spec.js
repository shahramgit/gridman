const { buildSearchFields, matchSearchFields, extractExampleEntries, matchExampleEntries } = require('../../src/utils/workspace-search-match');
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
});
