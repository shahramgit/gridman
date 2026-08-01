/**
 * Forward compatibility of the .bru grammar.
 *
 * BruFile is a whitelist, so a top level block we do not know used to be a hard parse
 * failure of the whole file. Bruno v4.0.0 added `app { }` and `auth:akamai-edgegrid { }`
 * (upstream v4.0.0 packages/bruno-lang/v2/src/bruToJson.js). Workspaces here are git
 * shared, so a teammate saving from stock Bruno would otherwise make the file unreadable
 * for everyone.
 *
 * Tolerating the block on read is only half of it: a block we keep but do not write back is
 * deleted, silently and with nothing in the UI to warn anyone, by the next save. So every
 * test that proves we read an unknown block is paired with one that proves we write it back.
 *
 * The fixture `fixtures/v4-request.bru` is verbatim output of the v4.0.0 serializer.
 */
const fs = require('fs');
const path = require('path');
const parser = require('../src/bruToJson');
const jsonToBru = require('../src/jsonToBru');
const collectionParser = require('../src/collectionBruToJson');
const jsonToCollectionBru = require('../src/jsonToCollectionBru');

describe('forward compatibility - unknown top level blocks', () => {
  it('parses an `app` block (added in Bruno v4) instead of failing the whole file', () => {
    const input = `meta {
  name: request
}

app {
  enabled: true
  code: '''
    <div>hello</div>
  '''
}
`;
    const output = parser(input);
    expect(output.meta.name).toBe('request');
    expect(output.unknownBlocks).toEqual([
      {
        name: 'app',
        raw: 'app {\n  enabled: true\n  code: \'\'\'\n    <div>hello</div>\n  \'\'\'\n}'
      }
    ]);
  });

  it('parses an `auth:akamai-edgegrid` block (added in Bruno v4) instead of failing the whole file', () => {
    const input = `get {
  url: https://example.com
  auth: akamai-edgegrid
}

auth:akamai-edgegrid {
  accessToken: akab-access-token
  clientToken: akab-client-token
  clientSecret: client-secret
  maxBodySize: 131072
}
`;
    const output = parser(input);
    expect(output.http.auth).toBe('akamai-edgegrid');
    expect(output.unknownBlocks).toHaveLength(1);
    expect(output.unknownBlocks[0].name).toBe('auth:akamai-edgegrid');
    expect(output.unknownBlocks[0].raw).toContain('accessToken: akab-access-token');
  });

  it('parses a whole v4 authored request and keeps every block we do understand', () => {
    const input = fs.readFileSync(path.join(__dirname, './fixtures/v4-request.bru'), 'utf8');
    const output = parser(input);

    expect(output.meta).toEqual({ name: 'v4 request', type: 'http', seq: '1' });
    expect(output.http).toEqual({
      method: 'get',
      url: 'https://example.com/api',
      body: 'none',
      auth: 'akamai-edgegrid'
    });
    expect(output.docs).toBe('some docs');

    // v4 typed variable annotations survive as plain annotations
    expect(output.vars.req.map((v) => [v.name, v.annotations])).toEqual([
      ['port', [{ name: 'number' }]],
      ['isAdmin', [{ name: 'boolean' }, { name: 'description', value: 'admin flag' }]],
      ['payload', [{ name: 'object' }]]
    ]);

    expect(output.unknownBlocks.map((b) => b.name)).toEqual(['auth:akamai-edgegrid', 'app']);
  });

  it('keeps the unknown block source verbatim so a caller can surface it', () => {
    const input = `futureblock {
  foo: bar
  nested: {{value}}
}
`;
    const output = parser(input);
    expect(output.unknownBlocks[0].raw).toBe('futureblock {\n  foo: bar\n  nested: {{value}}\n}');
  });

  it('tolerates an unknown list style block', () => {
    const input = `meta {
  name: request
}

futurelist [
  one
  two
]
`;
    const output = parser(input);
    expect(output.unknownBlocks).toEqual([{ name: 'futurelist', raw: 'futurelist [\n  one\n  two\n]' }]);
  });

  it('tolerates an empty unknown block', () => {
    const output = parser('app {\n}\n');
    expect(output.unknownBlocks).toEqual([{ name: 'app', raw: 'app {\n}' }]);
  });

  it('collects multiple unknown blocks in source order', () => {
    const input = `alpha {
  a: 1
}

beta {
  b: 2
}
`;
    const output = parser(input);
    expect(output.unknownBlocks.map((b) => b.name)).toEqual(['alpha', 'beta']);
  });

  it('does not emit unknownBlocks when every block is known', () => {
    const output = parser('meta {\n  name: request\n}\n');
    expect(output).not.toHaveProperty('unknownBlocks');
  });

  it('still throws on a malformed known block rather than swallowing it as unknown', () => {
    // A `headers` block with a pair missing its colon. Swallowing this would stop the
    // headers being interpreted at all, which is worse than refusing to read the file.
    expect(() => parser('headers {\n  key value\n}\n')).toThrow();
  });

  it('still throws on a malformed block whose name merely starts like a known one', () => {
    expect(() => parser('body:json {\n  no tagend here')).toThrow();
  });

  it('treats a name that only shares a prefix with a known block as unknown', () => {
    // `metadata` is known, `metadatax` is not - the boundary check must not stop at `metadata`
    const output = parser('metadatax {\n  a: 1\n}\n');
    expect(output.unknownBlocks).toEqual([{ name: 'metadatax', raw: 'metadatax {\n  a: 1\n}' }]);
  });

  it('does not reinterpret any known block as an unknown block', () => {
    const knownBlocks = [
      'meta {\n  name: r\n}\n',
      'settings {\n  encodeUrl: true\n}\n',
      'get {\n  url: https://example.com\n}\n',
      'http {\n  method: LIST\n  url: https://example.com\n}\n',
      'headers {\n  a: 1\n}\n',
      'metadata {\n  a: 1\n}\n',
      'query {\n  a: 1\n}\n',
      'params:path {\n  a: 1\n}\n',
      'params:query {\n  a: 1\n}\n',
      'vars:pre-request {\n  a: 1\n}\n',
      'vars:post-response {\n  a: 1\n}\n',
      'assert {\n  res.status: eq 200\n}\n',
      'auth:basic {\n  username: u\n  password: p\n}\n',
      'auth:oauth2:additional_params:access_token_req:body {\n  a: 1\n}\n',
      'body {\n  {}\n}\n',
      'body:json {\n  {}\n}\n',
      'body:graphql:vars {\n  {}\n}\n',
      'body:form-urlencoded {\n  a: 1\n}\n',
      'body:multipart-form {\n  a: 1\n}\n',
      'script:pre-request {\n  const a = 1;\n}\n',
      'script:post-response {\n  const a = 1;\n}\n',
      'tests {\n  test();\n}\n',
      'docs {\n  hello\n}\n',
      'example {\n  name: Example Request\n\n  request: {\n    url: https://api.example.com/example\n    method: get\n  }\n}\n'
    ];

    knownBlocks.forEach((block) => {
      expect(parser(block)).not.toHaveProperty('unknownBlocks');
    });
  });
});

/**
 * The data loss half. Reading an unknown block is only safe if writing puts it back.
 */
describe('forward compatibility - unknown blocks survive a save', () => {
  it('re-emits an unknown block verbatim instead of dropping it', () => {
    const input = `meta {
  name: request
}

app {
  enabled: true
  code: '''
    <div>hello</div>
  '''
}
`;
    const output = jsonToBru(parser(input));

    expect(output).toContain('app {');
    expect(output).toContain('code: \'\'\'');
    expect(output).toContain('<div>hello</div>');
    // and it is still an unknown block after the round trip, not text glued onto docs
    expect(parser(output).unknownBlocks).toEqual(parser(input).unknownBlocks);
  });

  it('keeps every block of a v4 authored request through parse -> save -> parse', () => {
    const input = fs.readFileSync(path.join(__dirname, './fixtures/v4-request.bru'), 'utf8');
    const first = parser(input);
    const saved = jsonToBru(first);
    const second = parser(saved);

    // Only the position of an unknown block changes, never its content
    expect(second.unknownBlocks).toEqual(first.unknownBlocks);
    expect(saved).toContain('auth:akamai-edgegrid {');
    expect(saved).toContain('accessToken: akab-access-token');
    expect(saved).toContain('app {');

    // and nothing we do understand is disturbed by re-emitting them
    expect(second.meta).toEqual(first.meta);
    expect(second.http).toEqual(first.http);
    expect(second.headers).toEqual(first.headers);
    expect(second.vars).toEqual(first.vars);
    expect(second.docs).toEqual(first.docs);
  });

  it('is stable across repeated saves', () => {
    const input = fs.readFileSync(path.join(__dirname, './fixtures/v4-request.bru'), 'utf8');
    const once = jsonToBru(parser(input));
    const twice = jsonToBru(parser(once));

    expect(twice).toEqual(once);
  });

  it('re-emits several unknown blocks', () => {
    const input = `alpha {
  a: 1
}

beta [
  one
]

docs {
  hi
}
`;
    const output = jsonToBru(parser(input));
    expect(parser(output).unknownBlocks).toEqual([
      { name: 'alpha', raw: 'alpha {\n  a: 1\n}' },
      { name: 'beta', raw: 'beta [\n  one\n]' }
    ]);
    expect(parser(output).docs).toBe('hi');
  });

  it('reads a CRLF file and writes the block back with the file\'s other blocks line endings', () => {
    // Windows workspaces: every other block is written with \n here, so the unknown block
    // must not be the one thing that keeps \r\n and leaves the file with mixed endings.
    const input = 'meta {\r\n  name: r\r\n}\r\n\r\napp {\r\n  enabled: true\r\n}\r\n';
    const output = jsonToBru(parser(input));

    expect(output).not.toContain('\r');
    expect(parser(output).unknownBlocks).toEqual([{ name: 'app', raw: 'app {\n  enabled: true\n}' }]);
  });

  it('ignores an unknown block entry with no source text', () => {
    const bru = jsonToBru({ docs: 'hi', unknownBlocks: [{ name: 'app' }, { name: 'app2', raw: '' }] });
    expect(bru).toBe('docs {\n  hi\n}\n');
  });
});

/**
 * An unknown block body used to run to the next "\n}" anywhere in the file, so an
 * unterminated one absorbed whatever followed it. Combined with verbatim re-emission that
 * turns a visible parse error into blocks that exist only as text inside another block.
 */
describe('forward compatibility - an unknown block cannot absorb the blocks after it', () => {
  it('throws instead of swallowing a following known block', () => {
    const input = `app {
  a: 1

headers {
  x-secret: shhh
}

docs {
  hello
}
`;
    expect(() => parser(input)).toThrow();
  });

  it('does not let a mistyped known block name absorb the block after it', () => {
    // `header` (singular) is not a known block, so it is kept as unknown - but bounded to
    // its own body, so the real headers block after it is still parsed as headers.
    const input = `header {
  x-secret: shhh
}

headers {
  x-real: value
}
`;
    const output = parser(input);
    expect(output.unknownBlocks).toEqual([{ name: 'header', raw: 'header {\n  x-secret: shhh\n}' }]);
    expect(output.headers).toEqual([{ name: 'x-real', value: 'value', enabled: true }]);
  });

  it('throws when an unknown block body has an unindented line', () => {
    // Every Bruno serializer indents block content, so an unindented line means the block
    // was never closed. Reporting it beats absorbing the rest of the file.
    expect(() => parser('app {\n  a: 1\nnot-indented: 2\n}\n')).toThrow();
  });

  it('allows blank lines inside an unknown block body', () => {
    const input = 'app {\n  a: 1\n\n  b: 2\n}\n';
    expect(parser(input).unknownBlocks).toEqual([{ name: 'app', raw: 'app {\n  a: 1\n\n  b: 2\n}' }]);
  });

  it('throws instead of swallowing a following block from an unterminated list block', () => {
    const input = `futurelist [
  one

docs {
  hello
}
`;
    expect(() => parser(input)).toThrow();
  });
});

/**
 * collection.bru / folder.bru have the same whitelist problem, and it is worse there: a
 * collection level block we do not know takes down every request under that collection.
 */
describe('forward compatibility - collection.bru / folder.bru', () => {
  it('parses a collection level `auth:akamai-edgegrid` block instead of failing the file', () => {
    const input = `auth {
  mode: akamai-edgegrid
}

auth:akamai-edgegrid {
  accessToken: akab-access-token
  maxBodySize: 131072
}

docs {
  hello
}
`;
    const output = collectionParser(input);
    expect(output.auth.mode).toBe('akamai-edgegrid');
    expect(output.docs).toBe('hello');
    expect(output.unknownBlocks).toEqual([
      {
        name: 'auth:akamai-edgegrid',
        raw: 'auth:akamai-edgegrid {\n  accessToken: akab-access-token\n  maxBodySize: 131072\n}'
      }
    ]);
  });

  it('re-emits a collection level unknown block instead of dropping it', () => {
    const input = `meta {
  name: my folder
}

app {
  enabled: true
}
`;
    const first = collectionParser(input);
    const saved = jsonToCollectionBru(first);

    expect(saved).toContain('app {');
    expect(collectionParser(saved).unknownBlocks).toEqual(first.unknownBlocks);
    expect(collectionParser(saved).meta).toEqual(first.meta);
  });

  it('is stable across repeated saves', () => {
    const input = 'headers {\n  a: 1\n}\n\napp {\n  enabled: true\n}\n';
    const once = jsonToCollectionBru(collectionParser(input));
    const twice = jsonToCollectionBru(collectionParser(once));

    expect(twice).toEqual(once);
  });

  it('still throws on a malformed known block', () => {
    expect(() => collectionParser('headers {\n  key value\n}\n')).toThrow();
  });

  it('does not let an unterminated unknown block absorb a following known block', () => {
    expect(() => collectionParser('app {\n  a: 1\n\nheaders {\n  x-secret: shhh\n}\n')).toThrow();
  });

  it('does not reinterpret any known block as an unknown block', () => {
    const knownBlocks = [
      'meta {\n  name: f\n}\n',
      'query {\n  a: 1\n}\n',
      'headers {\n  a: 1\n}\n',
      'auth {\n  mode: none\n}\n',
      'auth:basic {\n  username: u\n}\n',
      'auth:oauth2:additional_params:access_token_req:body {\n  a: 1\n}\n',
      'vars:pre-request {\n  a: 1\n}\n',
      'vars:post-response {\n  a: 1\n}\n',
      'script:pre-request {\n  const a = 1;\n}\n',
      'script:post-response {\n  const a = 1;\n}\n',
      'tests {\n  test();\n}\n',
      'docs {\n  hello\n}\n'
    ];

    knownBlocks.forEach((block) => {
      expect(collectionParser(block)).not.toHaveProperty('unknownBlocks');
    });
  });
});

/**
 * Unknown annotation args on rows need no grammar change: `annotation` already accepts any
 * name with or without an arg, and serializeAnnotations writes them back verbatim. So unlike
 * unknown blocks, unknown annotations are round-trip safe today. These tests pin that down
 * so a future annotation change cannot quietly turn them into a data loss.
 */
describe('forward compatibility - unknown annotations on rows', () => {
  it('round-trips the v4 typed variable annotations byte for byte', () => {
    const input = `vars:pre-request {
  @number
  port: 8080
  @boolean
  @description('admin flag')
  isAdmin: true
}
`;
    expect(jsonToBru(parser(input))).toEqual(input);
  });

  it('round-trips an annotation name we have never seen', () => {
    const input = `headers {
  @futureThing('some value')
  @futureFlag
  key: value
}
`;
    const output = parser(input);
    expect(output.headers[0].annotations).toEqual([
      { name: 'futureThing', value: 'some value' },
      { name: 'futureFlag' }
    ]);
    expect(jsonToBru(output)).toEqual(input);
  });

  it('round-trips an unknown annotation on a param row', () => {
    const input = `params:query {
  @futureThing('some value')
  q: search
}
`;
    expect(jsonToBru(parser(input))).toEqual(input);
  });
});
