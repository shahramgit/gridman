/**
 * What is allowed to leave the machine.
 *
 * Every case here is a hole a review found in the port: a secret that reached
 * the model despite the redaction layer being "on".
 */

const {
  formatRequestContext,
  formatResponseShape,
  formatVariablesList,
  formatSearchVariablesResult,
  searchVariables,
  redactJsonBodyString,
  redactUrl,
  scrubOutbound,
  isCredentialShapedToken,
  buildRedactionPolicy
} = require('../../src/ipc/ai/context');

const SECRET = 'sk-live-SUPERSECRET';

const ctx = (overrides = {}) => ({
  method: 'GET',
  url: 'https://api.example.com/v1/users',
  headers: [],
  params: [],
  body: null,
  ...overrides
});

describe('the request URL is redacted, not just the params table', () => {
  it('masks a credential carried in the query string', () => {
    // The exact case from the review: the URL was printed verbatim one line
    // above the params table that masked the same value by name.
    const out = formatRequestContext(ctx({
      url: `https://api.example.com/v1/users?api_key=${SECRET}&page=2`,
      params: [{ name: 'api_key', value: SECRET, enabled: true, type: 'query' }]
    }));

    expect(out).not.toContain(SECRET);
    expect(out).toContain('api_key=<redacted>');
    // Non-secrets and the path stay readable — the model needs them.
    expect(out).toContain('https://api.example.com/v1/users?');
    expect(out).toContain('page=2');
  });

  it('masks every credential-shaped query name, including custom ones', () => {
    const policy = buildRedactionPolicy({ customRedactedHeaders: ['tracking'] });
    const out = redactUrl(
      'https://h/p?access_token=a&refresh_token=b&password=c&tracking=d&sort=asc',
      policy
    );
    expect(out).toBe(
      'https://h/p?access_token=<redacted>&refresh_token=<redacted>'
      + '&password=<redacted>&tracking=<redacted>&sort=asc'
    );
  });

  it('masks a password in the URL userinfo', () => {
    expect(redactUrl('https://alice:hunter2@api.example.com/v1'))
      .toBe('https://alice:<redacted>@api.example.com/v1');
  });

  it('handles the templated URLs Bruno actually stores', () => {
    // `new URL()` throws on these, which is why the redaction is string-based.
    const out = redactUrl('{{baseUrl}}/v1/users?api_key={{apiKey}}&id={{id}}');
    expect(out).toBe('{{baseUrl}}/v1/users?api_key=<redacted>&id={{id}}');
  });

  it('leaves a URL with no query untouched', () => {
    expect(redactUrl('https://api.example.com/v1/users')).toBe('https://api.example.com/v1/users');
    expect(redactUrl('')).toBe('');
    expect(redactUrl(undefined)).toBe('');
  });

  it('keeps the fragment out of the query parse', () => {
    expect(redactUrl('https://h/p?token=x#section=token'))
      .toBe('https://h/p?token=<redacted>#section=token');
  });

  it('decodes percent-encoded parameter names before matching', () => {
    expect(redactUrl('https://h/p?api%5Fkey=' + SECRET)).not.toContain(SECRET);
  });
});

describe('the parts of a URL that were still going out verbatim', () => {
  it('masks a credential carried in the PATH', () => {
    // The Slack-webhook shape. There is no parameter name to match on, so the
    // name-based rules could never see it.
    const url = 'https://hooks.internal.example/services/T000/B000/sk-live-AAAAAAAAAAAAAAAAAAAA';
    expect(redactUrl(url))
      .toBe('https://hooks.internal.example/services/T000/B000/<redacted>');
  });

  it('masks the FRAGMENT — the OAuth2 implicit-grant callback shape', () => {
    expect(redactUrl('https://app/callback#access_token=sk-live-ZZZZ'))
      .toBe('https://app/callback#access_token=<redacted>');
    // …including a bare credential with no parameter name in front of it.
    expect(redactUrl('https://app/callback#sk-live-AAAAAAAAAAAAAAAAAAAA'))
      .toBe('https://app/callback#<redacted>');
  });

  it('treats `;` as a parameter separator, not as part of a value', () => {
    expect(redactUrl('https://h/x?a=1;api_key=SECRETVALUE'))
      .toBe('https://h/x?a=1;api_key=<redacted>');
  });

  it('masks userinfo when the URL has no scheme', () => {
    expect(redactUrl('alice:hunter2@api.example.com/v1'))
      .toBe('alice:<redacted>@api.example.com/v1');
    // A bare username carries no secret and stays readable.
    expect(redactUrl('https://alice@api.example.com/v1'))
      .toBe('https://alice@api.example.com/v1');
  });

  it('masks a credential-shaped VALUE even under an innocuous parameter name', () => {
    expect(redactUrl('https://h/p?t=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
      .toBe('https://h/p?t=<redacted>');
  });
});

describe('the credential-shape detector is conservative, by design', () => {
  const CREDENTIALS = [
    'sk-live-AAAAAAAAAAAAAAAAAAAA',
    'sk-proj-abc123DEF456ghi789JKL012',
    'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    'xoxb-123456789012-abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'glpat-xxxxxxxxxxxxxxxxxxxx',
    'AIzaSyD-1234567890abcdefghijk',
    '5f4dcc3b5aa765d61d8327deb882cf99', // 32 hex
    '550e8400-e29b-41d4-a716-446655440000', // uuid — masked, see below
    '2VbFf3sJ9kQpLmXnRtYuWz1A4C7e', // 28 random alnum
    'AbCdEfGhIjKlMnOpQrStUvWx' // alternating case, no digits
  ];

  const ROUTE_SEGMENTS = [
    'v1', 'users', 'services', 'subscriptions', 'authentication',
    'this-is-a-long-endpoint-name', 'very-long-resource-collection-name',
    'reports-quarterly-summary-2024', 'GetUserProfileByIdentifier',
    'MyVeryLongCamelCaseEndpointName', 'get_user_profile_by_identifier',
    'my.long.dotted.resource.name.here', 'application-json-schema-definition',
    'order-2024-11-30-summary', 'characteristicsdescription',
    '123456789012345678901234567', 'openapi.json', 'en-US', 'v2.1.0',
    'T00000000', 'B00000000'
  ];

  it.each(CREDENTIALS)('flags %s', (token) => {
    expect(isCredentialShapedToken(token)).toBe(true);
  });

  it.each(ROUTE_SEGMENTS)('leaves the route segment %s readable', (token) => {
    expect(isCredentialShapedToken(token)).toBe(false);
  });

  it('never flags a Bruno template — the value is not in the string', () => {
    expect(isCredentialShapedToken('{{someVeryLongSecretVariableName}}')).toBe(false);
    expect(redactUrl('{{baseUrl}}/v1/{{tenantId}}/users'))
      .toBe('{{baseUrl}}/v1/{{tenantId}}/users');
  });

  it('documented limit: a short credential with no known prefix is NOT detected', () => {
    // Nothing distinguishes `84719205` from an order id. Flagging it would
    // redact every URL in the collection. Stated so the customer can decide.
    expect(isCredentialShapedToken('84719205')).toBe(false);
  });

  it('documented limit: an opaque non-secret id IS masked (fail closed)', () => {
    expect(isCredentialShapedToken('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(redactUrl('https://h/v1/users/550e8400-e29b-41d4-a716-446655440000/orders'))
      .toBe('https://h/v1/users/<redacted>/orders');
  });
});

/**
 * The detector used to be ASYMMETRIC: it ran on URL path segments, query values
 * and fragment tokens, and nowhere else. So the identical credential was masked
 * when it sat in the URL and printed verbatim when it sat in the headers table,
 * a parameter table, a form field, a JSON body leaf or a variable — as long as
 * the NAME was innocuous. Every case below leaked before the fix.
 *
 * `SHAPED` deliberately carries no credential-ish NAME anywhere near it, and
 * each test also asserts an ordinary value survives, so a change that simply
 * redacted everything would fail too.
 */
describe('a credential-shaped VALUE is caught under an innocuous NAME', () => {
  const SHAPED = 'sk-live-INNOCUOUSNAMELEAK00';

  it('masks it in the headers table, and leaves ordinary headers readable', () => {
    const out = formatRequestContext(ctx({
      headers: [
        { name: 'X-Trace-Id', value: SHAPED, enabled: true },
        { name: 'Accept', value: 'application/json', enabled: true }
      ]
    }));
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('X-Trace-Id: <redacted>');
    expect(out).toContain('Accept: application/json');
  });

  it('masks it when it is one token inside a longer value', () => {
    // `Bearer sk-live-…` fails the charset test as a single string — it has a
    // space in it — so a whole-string check would miss the canonical shape.
    const out = formatRequestContext(ctx({
      headers: [{ name: 'X-Relay-Credential', value: `Bearer ${SHAPED}`, enabled: true }]
    }));
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('X-Relay-Credential: <redacted>');
  });

  it('masks it in the query and path parameter tables', () => {
    const out = formatRequestContext(ctx({
      params: [
        { name: 'page', value: SHAPED, enabled: true, type: 'query' },
        { name: 'sort', value: 'asc', enabled: true, type: 'query' },
        { name: 'id', value: SHAPED, enabled: true, type: 'path' }
      ]
    }));
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('page: <redacted>');
    expect(out).toContain('id: <redacted>');
    expect(out).toContain('sort: asc');
  });

  it('masks it in formUrlEncoded and multipartForm fields', () => {
    for (const mode of ['formUrlEncoded', 'multipartForm']) {
      const out = formatRequestContext(ctx({
        method: 'POST',
        body: { mode, [mode]: [
          { name: 'grant', value: SHAPED, enabled: true },
          { name: 'plan', value: 'pro', enabled: true }
        ] }
      }));
      expect(out).not.toContain(SHAPED);
      expect(out).toContain('grant: <redacted>');
      expect(out).toContain('plan: pro');
    }
  });

  it('masks it at a JSON body leaf whose key is innocuous', () => {
    const out = redactJsonBodyString(JSON.stringify({ session: SHAPED, plan: 'pro' }));
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('"session": "<redacted>"');
    expect(out).toContain('"plan": "pro"');
  });

  it('masks it in a GraphQL variable, while the query text stays verbatim', () => {
    const out = formatRequestContext(ctx({
      method: 'POST',
      body: {
        mode: 'graphql',
        graphql: {
          query: 'query Me { me { id } }',
          variables: JSON.stringify({ session: SHAPED, first: 10 })
        }
      }
    }));
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('"session": "<redacted>"');
    expect(out).toContain('"first": 10');
    // Documented verbatim channel — the query IS the request.
    expect(out).toContain('query Me { me { id } }');
  });

  it('masks it in a variable value whose name matches no pattern', () => {
    const vars = [
      { name: 'SESSION_ID', value: SHAPED, scope: 'env', secret: false },
      { name: 'BASE_URL', value: 'https://api.example.com', scope: 'env', secret: false }
    ];
    const out = formatSearchVariablesResult(searchVariables(vars, ''), '');
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('SESSION_ID = <redacted>');
    expect(out).toContain('BASE_URL = https://api.example.com');
  });

  it('masks it in a response body when value-blanking is switched off', () => {
    const out = formatResponseShape(200, { session: SHAPED, user: { name: 'alice' } }, {
      security: { redactResponse: false }
    });
    expect(out).not.toContain(SHAPED);
    expect(out).toContain('"session": "<redacted>"');
    expect(out).toContain('"name": "alice"');
  });

  it('does not fire on the placeholder a templated body is parsed through', () => {
    // parseTemplatedJson swaps `{{…}}` for an inert token before JSON.parse.
    // A run of them is long, mixed-case and underscore-heavy — close enough to
    // the entropy heuristic that it has to be skipped explicitly, or an
    // ordinary Bruno body would come back as `<redacted>`.
    const out = redactJsonBodyString('{"a": "{{w}}{{x}}{{y}}{{z}}", "plan": "pro"}');
    expect(out).toContain('"a": "{{w}}{{x}}{{y}}{{z}}"');
    expect(out).toContain('"plan": "pro"');
  });
});

/**
 * THE OTHER AXIS — the mirror of the block above, emitter for emitter.
 *
 * Every rule ran on the VALUE side only. The NAME side — a JSON object key, a
 * header name, a form field name, a variable name — was copied through
 * verbatim at every one of these emitters, so a credential sitting in a key
 * reached the model even in the mode whose own notice promises "no real data
 * is shown". A key is not metadata: in a captured response body it is text the
 * server chose, and an object keyed by token is an ordinary API shape.
 */
describe('a credential-shaped NAME is caught, the same as a credential-shaped value', () => {
  const KEY = 'sk-live-KEYNAMELEAK00000';
  const KEY2 = 'ghp_SECONDKEYNAMELEAK000';

  it('masks a response-shape KEY — the mode that promises no real data', () => {
    const out = formatResponseShape(200, { [KEY]: { seen: 1 }, ok: true });
    expect(out).not.toContain(KEY);
    expect(out).toContain('"<redacted>"');
    // Non-vacuous: the ordinary key and the shape survive.
    expect(out).toContain('"ok": "<boolean>"');
    expect(out).toContain('"seen": "<number>"');
  });

  it('masks a response-body KEY when value-blanking is switched off', () => {
    const out = formatResponseShape(200, { [KEY]: 'v', user: { name: 'alice' } }, {
      security: { redactResponse: false }
    });
    expect(out).not.toContain(KEY);
    expect(out).toContain('"name": "alice"');
  });

  it('masks a JSON request-body KEY', () => {
    const out = redactJsonBodyString(JSON.stringify({ [KEY]: 'v', plan: 'pro' }));
    expect(out).not.toContain(KEY);
    expect(out).toContain('"<redacted>": "v"');
    expect(out).toContain('"plan": "pro"');
  });

  it('masks it in the headers table, and leaves ordinary header names readable', () => {
    const out = formatRequestContext(ctx({
      headers: [
        { name: `X-${KEY}`, value: 'v', enabled: true },
        { name: 'Accept', value: 'application/json', enabled: true }
      ]
    }));
    expect(out).not.toContain(KEY);
    expect(out).toContain('<redacted>: v');
    expect(out).toContain('Accept: application/json');
  });

  it('masks it in the query and path parameter tables', () => {
    const out = formatRequestContext(ctx({
      params: [
        { name: KEY, value: 'v', enabled: true, type: 'query' },
        { name: KEY, value: 'v', enabled: true, type: 'path' },
        { name: 'sort', value: 'asc', enabled: true, type: 'query' }
      ]
    }));
    expect(out).not.toContain(KEY);
    expect(out).toContain('sort: asc');
  });

  it('masks it in formUrlEncoded and multipartForm field names', () => {
    for (const mode of ['formUrlEncoded', 'multipartForm']) {
      const out = formatRequestContext(ctx({
        method: 'POST',
        body: { mode, [mode]: [
          { name: KEY, value: 'v', enabled: true },
          { name: 'plan', value: 'pro', enabled: true }
        ] }
      }));
      expect(out).not.toContain(KEY);
      expect(out).toContain('plan: pro');
    }
  });

  it('masks it in the variables preview and in search results', () => {
    const vars = [
      { name: KEY, value: 'v', scope: 'env', secret: false },
      { name: 'BASE_URL', value: 'https://api.example.com', scope: 'env', secret: false }
    ];
    const preview = formatVariablesList(vars);
    expect(preview).not.toContain(KEY);
    expect(preview).toContain('BASE_URL');

    const searched = formatSearchVariablesResult(searchVariables(vars, ''), '');
    expect(searched).not.toContain(KEY);
    expect(searched).toContain('BASE_URL = https://api.example.com');
  });

  it('keeps TWO masked keys distinct instead of dropping one', () => {
    // Both mask to `<redacted>`. Overwriting would turn redaction into silent
    // data loss and hide from the model that there were two fields at all.
    const out = formatResponseShape(200, { [KEY]: 1, [KEY2]: 2, ok: true }, {
      security: { redactResponse: false }
    });
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY2);
    expect(out).toContain('"<redacted>": 1');
    expect(out).toContain('"<redacted> 2": 2');
    expect(out).toContain('"ok": true');
  });

  it('still asks the name-based rules about the ORIGINAL key', () => {
    // Masking the key first would make `<redacted>` the name every policy
    // check sees, and `isSensitiveKey` would stop matching. The custom list is
    // the strictest form of that check, so it is the one pinned.
    const policy = { customRedactedHeaders: ['ledgerBalance'] };
    const out = redactJsonBodyString(
      JSON.stringify({ ledgerBalance: 'PRIVATE', access_token: 'PRIVATE2', plan: 'pro' }),
      buildRedactionPolicy(policy)
    );
    expect(out).toContain('"ledgerBalance": "<redacted>"');
    expect(out).toContain('"access_token": "<redacted>"');
    expect(out).toContain('"plan": "pro"');
  });

  it('leaves ordinary and non-ASCII names alone', () => {
    // The detector's charset test is ASCII-only, so a Persian or Arabic field
    // name can never be flagged whatever its length — which matters here,
    // where collections are full of them.
    const ordinary = [
      'Access-Control-Allow-Credentials',
      'X-RateLimit-Remaining-Requests',
      'MY_LONG_ENVIRONMENT_VARIABLE_NAME',
      'شناسه_درخواست_کاربر_طولانی',
      'customerSubscriptionRenewalDate'
    ];
    for (const name of ordinary) {
      const out = formatRequestContext(ctx({ headers: [{ name, value: 'v', enabled: true }] }));
      expect(out).toContain(`${name}: v`);
    }
  });
});

describe('the schemeless userinfo rule needs a host-shaped right side', () => {
  // Without the host check, ANY `x:y@z` run matched, so the rule corrupted
  // ordinary formatter output on its way to the model.
  it('leaves a `x:y@z` run in JSON and prose alone', () => {
    expect(redactUrl('{"a":"b:c@d"}')).toBe('{"a":"b:c@d"}');
    expect(redactUrl('12:30@office')).toBe('12:30@office');
    // Through the chokepoint too — that is where formatter output passes.
    expect(scrubOutbound('shift 12:30@office, ticket A1:B2@desk')).toBe('shift 12:30@office, ticket A1:B2@desk');
  });

  it('still masks the schemeless URLs the rule exists for', () => {
    // Dotted authority with nothing after it.
    expect(redactUrl('alice:hunter2@api.example.com')).toBe('alice:<redacted>@api.example.com');
    // Single label counts once a path follows it — the internal-host shape.
    expect(redactUrl('alice:hunter2@internal/v1')).toBe('alice:<redacted>@internal/v1');
    // Templated authority, which is what Bruno actually stores.
    expect(redactUrl('{{user}}:{{pass}}@{{host}}/v1')).toBe('{{user}}:<redacted>@{{host}}/v1');
  });
});

describe('a body that cannot be parsed is not sent', () => {
  it('withholds a text body instead of emitting it verbatim', () => {
    const out = formatRequestContext(ctx({
      method: 'POST',
      body: { mode: 'text', text: `Authorization: Bearer ${SECRET}` }
    }));
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/not sent/i);
  });

  it('withholds an xml body instead of emitting it verbatim', () => {
    const out = formatRequestContext(ctx({
      method: 'POST',
      body: { mode: 'xml', xml: `<auth><token>${SECRET}</token></auth>` }
    }));
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/not sent/i);
  });

  it('withholds a sparql body instead of emitting it verbatim', () => {
    const out = formatRequestContext(ctx({
      method: 'POST',
      body: { mode: 'sparql', sparql: `SELECT * WHERE { ?s <urn:key> "${SECRET}" }` }
    }));
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/not sent/i);
  });

  it('withholds a json body that is too malformed to parse', () => {
    const out = formatRequestContext(ctx({
      method: 'POST',
      body: { mode: 'json', json: `{ "password": "${SECRET}", oops` }
    }));
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/not sent/i);
  });

  it('says nothing at all for an empty opaque body', () => {
    const out = formatRequestContext(ctx({ method: 'POST', body: { mode: 'xml', xml: '   ' } }));
    expect(out).not.toMatch(/not sent/i);
    expect(out).not.toContain('Body');
  });

  it('withholds a non-JSON response body whatever the toggle says', () => {
    const html = `<html>token=${SECRET}</html>`;
    for (const security of [{ redactResponse: true }, { redactResponse: false }]) {
      const out = formatResponseShape(200, html, { security });
      expect(out).not.toContain(SECRET);
    }
  });
});

describe('a templated json body still gets field-level redaction', () => {
  // `{{templating}}` is the COMMON case in Bruno, so "unparseable => withhold"
  // on its own would make the feature useless. Templates are substituted out,
  // the body is redacted by key, then the templates are put back.
  it('redacts credential keys and preserves the templates', () => {
    const body = '{\n  "user": "{{username}}",\n  "password": "{{loginPassword}}",\n  "plan": "pro"\n}';
    const out = redactJsonBodyString(body);

    expect(out).toContain('"user": "{{username}}"');
    expect(out).toContain('"password": "<redacted>"');
    expect(out).toContain('"plan": "pro"');
    // The template inside the redacted value went with it.
    expect(out).not.toContain('{{loginPassword}}');
  });

  it('reaches templates nested in arrays and objects', () => {
    const body = JSON.stringify({
      items: [{ id: '{{a}}', secret: '{{b}}' }],
      nested: { refresh_token: '{{c}}', keep: '{{d}}' }
    });
    const out = redactJsonBodyString(body);
    expect(out).toContain('"id": "{{a}}"');
    expect(out).toContain('"keep": "{{d}}"');
    expect(out).toContain('"secret": "<redacted>"');
    expect(out).toContain('"refresh_token": "<redacted>"');
  });

  it('withholds rather than guessing when a bare template breaks the JSON', () => {
    // `{"n": {{count}}}` cannot become valid JSON by quoting alone.
    const out = redactJsonBodyString('{"n": {{count}}, "password": "hunter2"}');
    expect(out).not.toContain('hunter2');
    expect(out).toMatch(/not sent/i);
  });

  it('withholds when the body already contains our substitution token', () => {
    const out = redactJsonBodyString('{"a": "__BRU_AI_TPL_0__ {{x}}", "b": oops}');
    expect(out).toMatch(/not sent/i);
  });
});

describe('a redaction toggle can widen protection, never remove it', () => {
  const everythingOff = {
    redactHeaders: false,
    redactBody: false,
    redactVariables: false,
    redactResponse: false
  };

  it('still masks credential-named response keys when redactResponse is off', () => {
    const out = formatResponseShape(200, { access_token: SECRET, user: { name: 'alice' } }, {
      security: everythingOff
    });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"access_token": "<redacted>"');
    // Degrade, don't disable: ordinary values are visible, which is what the
    // user asked for by turning value-blanking off.
    expect(out).toContain('"name": "alice"');
  });

  it('still masks credential-named headers when redactHeaders is off', () => {
    const out = formatRequestContext(ctx({
      headers: [
        { name: 'Authorization', value: `Bearer ${SECRET}`, enabled: true },
        { name: 'Accept', value: 'application/json', enabled: true }
      ]
    }), { security: everythingOff });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('Authorization: <redacted>');
    expect(out).toContain('Accept: application/json');
  });

  it('still masks credential-named variables when redactVariables is off', () => {
    const variables = [
      { name: 'API_TOKEN', value: SECRET, scope: 'env', secret: false },
      { name: 'BASE_URL', value: 'https://x', scope: 'env', secret: false }
    ];
    const listed = formatVariablesList(variables, { security: everythingOff });
    expect(listed).toContain('API_TOKEN (secret)');

    const searched = formatSearchVariablesResult(
      searchVariables(variables, ''), '', { security: everythingOff }
    );
    expect(searched).not.toContain(SECRET);
    expect(searched).toContain('BASE_URL = https://x');
  });

  it('still masks credential-named query values when redactHeaders is off', () => {
    const out = formatRequestContext(ctx({ url: `https://h/p?api_key=${SECRET}` }), {
      security: everythingOff
    });
    expect(out).not.toContain(SECRET);
  });
});

describe('custom redaction lists match across Persian letter variants', () => {
  // ARABIC YEH (U+064A) and FARSI YEH (U+06CC) are indistinguishable on
  // screen. A user adds a name typed one way and their variable is stored the
  // other way; without folding, the redaction silently never fires.
  const ARABIC_YEH = 'ي';
  const FARSI_YEH = 'ی';
  const ARABIC_KAF = 'ك';
  const KEHEH = 'ک';

  const nameWith = (yeh, kaf) => `رمز${kaf}ل${yeh}د`; // رمزکلید-ish

  it('matches a variable typed with the other yeh', () => {
    const configured = nameWith(ARABIC_YEH, KEHEH);
    const stored = nameWith(FARSI_YEH, KEHEH);
    expect(configured).not.toBe(stored); // different code points, same glyph

    const out = formatSearchVariablesResult(
      searchVariables([{ name: stored, value: SECRET, scope: 'env', secret: false }], ''),
      '',
      { security: { customRedactedVariables: [configured] } }
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain('secret');
  });

  it('matches a header typed with the other kaf', () => {
    const configured = nameWith(FARSI_YEH, ARABIC_KAF);
    const stored = nameWith(FARSI_YEH, KEHEH);
    const out = formatRequestContext(ctx({
      headers: [{ name: stored, value: SECRET, enabled: true }]
    }), { security: { customRedactedHeaders: [configured] } });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('<redacted>');
  });

  it('matches across NFC / NFD normalization forms', () => {
    // Nothing in this name matches a built-in pattern, so the custom list is
    // the only thing that can redact it.
    const configured = 'X-Caf\u00e9-Ref'.normalize('NFC');
    const stored = 'X-Caf\u00e9-Ref'.normalize('NFD');
    expect(configured).not.toBe(stored);

    const out = formatRequestContext(ctx({
      headers: [{ name: stored, value: SECRET, enabled: true }]
    }), { security: { customRedactedHeaders: [configured] } });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('<redacted>');
  });

  it('does not start matching unrelated names', () => {
    const out = formatRequestContext(ctx({
      headers: [{ name: 'X-Trace', value: 'trace-1', enabled: true }]
    }), { security: { customRedactedHeaders: ['X-Other'] } });
    expect(out).toContain('X-Trace: trace-1');
  });
});
