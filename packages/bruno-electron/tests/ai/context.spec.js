const {
  isSensitiveName,
  maskValue,
  redactResponseValues,
  formatResponseShape,
  formatRequestContext,
  formatVariablesList,
  searchVariables,
  formatSearchVariablesResult,
  formatRequestsList,
  searchRequests,
  formatSearchRequestsResult
} = require('../../src/ipc/ai/context');

describe('ipc/ai/context', () => {
  describe('isSensitiveName', () => {
    it.each([
      ['Authorization'],
      ['Cookie'],
      ['X-API-Key'],
      ['api_key'],
      ['accessToken'],
      ['refresh_token'],
      ['id_token'],
      ['csrfToken'],
      ['TOKEN'],
      ['client_secret'],
      ['password']
    ])('flags %s as sensitive', (name) => {
      expect(isSensitiveName(name)).toBe(true);
    });

    it.each([
      ['X-Trace-Id'],
      ['Content-Type'],
      ['User-Agent'],
      ['email']
    ])('does not flag %s', (name) => {
      expect(isSensitiveName(name)).toBe(false);
    });
  });

  describe('maskValue', () => {
    it('redacts the value when the name is sensitive', () => {
      expect(maskValue('Authorization', 'Bearer abc')).toBe('<redacted>');
    });
    it('passes the value through when the name is not sensitive', () => {
      expect(maskValue('X-Trace-Id', '123')).toBe('123');
    });
  });

  describe('redactResponseValues', () => {
    it('replaces primitives with type placeholders, preserving keys', () => {
      expect(redactResponseValues({ id: 1, name: 'a', active: true })).toEqual({
        id: '<number>',
        name: '<string>',
        active: '<boolean>'
      });
    });

    it('samples long arrays and reports the rest', () => {
      const out = redactResponseValues([1, 2, 3, 4, 5]);
      expect(out).toEqual(['<number>', '<number>', '<number>', '<2 more items>']);
    });

    it('caps deep nesting with a placeholder', () => {
      // 8 levels deep — exceeds the default maxDepth of 6.
      const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'leaf' } } } } } } } };
      const out = redactResponseValues(deep);
      expect(JSON.stringify(out)).toContain('<truncated>');
    });
  });

  describe('formatResponseShape', () => {
    it('returns an empty string when neither status nor data is present', () => {
      expect(formatResponseShape(null, null)).toBe('');
    });

    it('parses a JSON string body and emits a redacted shape block', () => {
      const out = formatResponseShape(200, JSON.stringify({ user: { id: 1, email: 'a@b' } }));
      expect(out).toContain('**Last Response Status:** 200');
      expect(out).toContain('"id": "<number>"');
      expect(out).toContain('"email": "<string>"');
      // Real values must not leak.
      expect(out).not.toContain('a@b');
    });

    it('summarizes non-JSON string bodies without echoing them', () => {
      const out = formatResponseShape(200, 'plain text body');
      expect(out).toContain('non-JSON');
      expect(out).not.toContain('plain text body');
    });
  });

  describe('formatRequestContext', () => {
    it('masks sensitive header / param values', () => {
      const out = formatRequestContext({
        method: 'GET',
        url: '/x',
        headers: [
          { name: 'Authorization', value: 'Bearer xyz', enabled: true },
          { name: 'X-Trace-Id', value: '123', enabled: true }
        ],
        params: [{ name: 'api_key', value: 'secret-key', enabled: true, type: 'query' }],
        body: null
      });
      expect(out).toContain('Authorization: <redacted>');
      expect(out).toContain('X-Trace-Id: 123');
      expect(out).toContain('api_key: <redacted>');
      expect(out).not.toContain('Bearer xyz');
      expect(out).not.toContain('secret-key');
    });

    it('redacts the full subtree under a sensitive key (not just direct primitives)', () => {
      const out = formatRequestContext({
        method: 'POST',
        url: '/x',
        headers: [],
        params: [],
        body: {
          mode: 'json',
          json: JSON.stringify({
            password: { value: 'hunter2', hint: 'first pet' },
            data: { safe: 'ok' }
          })
        }
      });
      expect(out).toContain('"password": "<redacted>"');
      expect(out).not.toContain('hunter2');
      expect(out).not.toContain('first pet');
      expect(out).toContain('"safe": "ok"');
    });

    it('masks credential-named formUrlEncoded values whatever the toggles say', () => {
      const ctx = {
        method: 'POST',
        url: '/login',
        headers: [],
        params: [],
        body: {
          mode: 'formUrlEncoded',
          formUrlEncoded: [
            { name: 'username', value: 'alice', enabled: true },
            { name: 'password', value: 'hunter2', enabled: true }
          ]
        }
      };
      const bodyOn = formatRequestContext(ctx, { security: { redactHeaders: false, redactBody: true } });
      expect(bodyOn).toContain('password: <redacted>');
      expect(bodyOn).not.toContain('hunter2');

      // A toggle may widen redaction, never remove it: `redactBody: false`
      // used to print `password: hunter2` in full.
      const bodyOff = formatRequestContext(ctx, { security: { redactHeaders: true, redactBody: false } });
      expect(bodyOff).toContain('password: <redacted>');
      expect(bodyOff).not.toContain('hunter2');
      // Non-credential fields are still visible — this degrades, it doesn't disable.
      expect(bodyOff).toContain('username: alice');
    });

    it('redacts sensitive keys inside JSON bodies but keeps the shape', () => {
      const out = formatRequestContext({
        method: 'POST',
        url: '/login',
        headers: [],
        params: [],
        body: {
          mode: 'json',
          json: JSON.stringify({
            username: 'alice',
            password: 'hunter2',
            nested: { refresh_token: 'tok', safe: 'ok' }
          })
        }
      });
      expect(out).toContain('"username": "alice"');
      expect(out).toContain('"password": "<redacted>"');
      expect(out).toContain('"refresh_token": "<redacted>"');
      expect(out).toContain('"safe": "ok"');
      expect(out).not.toContain('hunter2');
      expect(out).not.toContain('"tok"');
    });

    it('redacts sensitive keys inside GraphQL variables JSON', () => {
      const out = formatRequestContext({
        method: 'POST',
        url: '/g',
        headers: [],
        params: [],
        body: {
          mode: 'graphql',
          graphql: { query: 'mutation X', variables: '{"token": "abc", "id": 1}' }
        }
      });
      expect(out).toContain('"token": "<redacted>"');
      expect(out).toContain('"id": 1');
      expect(out).not.toContain('"abc"');
    });

    it('includes the response shape only when opts.includeResponse is true', () => {
      const base = {
        method: 'GET',
        url: '/x',
        headers: [],
        params: [],
        body: null,
        responseStatus: 200,
        responseData: { id: 1 }
      };
      expect(formatRequestContext(base)).not.toContain('Response Shape');
      expect(formatRequestContext(base, { includeResponse: true })).toContain('Response Shape');
    });

    it('truncates the body when bodyMaxChars is set', () => {
      // A JSON body, because a text body is no longer sent at all.
      const long = JSON.stringify({ note: 'x'.repeat(1000) });
      const out = formatRequestContext(
        { method: 'GET', url: '/x', headers: [], params: [], body: { mode: 'json', json: long } },
        { bodyMaxChars: 50 }
      );
      // The shown body should be 50 chars plus the ellipsis marker.
      expect(out).toContain('…');
      expect(out).not.toContain('x'.repeat(60));
    });

    it('still redacts credential names when every security toggle is off', () => {
      // Turning a toggle off is a request for LESS masking, not for the
      // credentials in that channel to be handed over. This used to emit
      // `Authorization: Bearer xyz` and `"password": "hunter2"` verbatim.
      const out = formatRequestContext({
        method: 'POST',
        url: '/x?api_key=sk-live-1',
        headers: [
          { name: 'Authorization', value: 'Bearer xyz', enabled: true },
          { name: 'X-Request-Id', value: 'req-1', enabled: true }
        ],
        params: [],
        body: { mode: 'json', json: JSON.stringify({ password: 'hunter2', plan: 'pro' }) }
      }, {
        security: {
          redactHeaders: false,
          redactBody: false,
          redactVariables: false,
          redactResponse: false
        }
      });
      expect(out).not.toContain('Bearer xyz');
      expect(out).not.toContain('hunter2');
      expect(out).not.toContain('sk-live-1');
      expect(out).toContain('Authorization: <redacted>');
      expect(out).toContain('"password": "<redacted>"');
      expect(out).toContain('api_key=<redacted>');
      // Everything non-credential is still readable.
      expect(out).toContain('X-Request-Id: req-1');
      expect(out).toContain('"plan": "pro"');
    });

    it('honors customRedactedHeaders for a user-added header name', () => {
      const out = formatRequestContext({
        method: 'GET',
        url: '/x',
        headers: [{ name: 'X-Trace-Id', value: 'trace-abc', enabled: true }],
        params: [],
        body: null
      }, { security: { customRedactedHeaders: ['X-Trace-Id'] } });
      expect(out).toContain('X-Trace-Id: <redacted>');
      expect(out).not.toContain('trace-abc');
    });

    it('sends the raw response body when redactResponse is off', () => {
      const base = {
        method: 'GET',
        url: '/x',
        headers: [],
        params: [],
        body: null,
        responseStatus: 200,
        responseData: { user: { id: 42, email: 'a@b' } }
      };
      const redacted = formatRequestContext(base, { includeResponse: true });
      expect(redacted).toContain('Response Shape');
      expect(redacted).not.toContain('a@b');

      const raw = formatRequestContext(base, {
        includeResponse: true,
        security: { redactResponse: false }
      });
      expect(raw).toContain('Response Body');
      expect(raw).toContain('"email": "a@b"');
    });
  });

  describe('formatVariablesList', () => {
    it('groups by scope and tags secret entries', () => {
      const out = formatVariablesList([
        { name: 'API_URL', value: 'u', scope: 'env', secret: false },
        { name: 'API_TOKEN', value: '<redacted>', scope: 'env', secret: true },
        { name: 'runtimeKey', value: 'r', scope: 'runtime', secret: false }
      ]);
      expect(out).toContain('env (2)');
      expect(out).toContain('API_TOKEN (secret)');
      expect(out).toContain('runtime (1)');
      expect(out).toContain('runtimeKey');
    });

    it('returns an empty string for no variables', () => {
      expect(formatVariablesList([])).toBe('');
      expect(formatVariablesList(null)).toBe('');
    });

    it('keeps name-pattern matches tagged secret even when redactVariables is off', () => {
      // `redactVariables: false` used to hand the model the real value of
      // every `*_token` / `*secret*` / `password` variable in the collection.
      const out = formatVariablesList([
        { name: 'API_TOKEN', value: 'v', scope: 'env', secret: false }
      ], { security: { redactVariables: false } });
      expect(out).toContain('API_TOKEN (secret)');
    });

    it('always tags variables in customRedactedVariables as secret, even when redactVariables is off', () => {
      const out = formatVariablesList([
        { name: 'MY_SESSION', value: 'v', scope: 'env', secret: false }
      ], { security: { redactVariables: false, customRedactedVariables: ['MY_SESSION'] } });
      expect(out).toContain('MY_SESSION (secret)');
    });

    it('keeps secret: true variables tagged even with all toggles off', () => {
      const out = formatVariablesList([
        { name: 'plain_name', value: '<redacted>', scope: 'env', secret: true }
      ], { security: { redactVariables: false } });
      expect(out).toContain('plain_name (secret)');
    });
  });

  describe('searchVariables / formatSearchVariablesResult', () => {
    const vars = [
      { name: 'API_URL', value: 'https://x', scope: 'env', secret: false },
      { name: 'API_TOKEN', value: '<redacted>', scope: 'env', secret: true },
      { name: 'runtimeKey', value: 'r1', scope: 'runtime', secret: false }
    ];

    it('returns case-insensitive substring matches with a totalMatched count', () => {
      const r = searchVariables(vars, 'api');
      expect(r.items.map((v) => v.name)).toEqual(['API_URL', 'API_TOKEN']);
      expect(r.totalMatched).toBe(2);
    });

    it('returns all entries (up to the limit) for an empty query', () => {
      const r = searchVariables(vars, '');
      expect(r.items).toHaveLength(3);
      expect(r.totalMatched).toBe(3);
    });

    it('truncates to the limit and reports the surplus in totalMatched', () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        name: 'token_' + i, value: 'v' + i, scope: 'env', secret: false
      }));
      const r = searchVariables(many, 'token', 50);
      expect(r.items).toHaveLength(50);
      expect(r.totalMatched).toBe(60);
    });

    it('formats matches with scope + secret tags', () => {
      const out = formatSearchVariablesResult(searchVariables(vars, 'api'), 'api');
      expect(out).toContain('API_URL = https://x    [env]');
      expect(out).toContain('API_TOKEN = <redacted>    [env, secret]');
    });

    it('says "no matches" when nothing matched the query', () => {
      expect(formatSearchVariablesResult(searchVariables(vars, 'zzz'), 'zzz'))
        .toBe('No variables match "zzz".');
    });

    it('includes a trailer when limit was hit', () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        name: 'token_' + i, value: 'v' + i, scope: 'env', secret: false
      }));
      const out = formatSearchVariablesResult(searchVariables(many, 'token', 50), 'token');
      expect(out).toContain('Found 50 of 60');
      expect(out).toContain('(10 more match');
    });
  });

  describe('searchRequests / formatRequestsList / formatSearchRequestsResult', () => {
    const requests = [
      { name: 'Login', method: 'POST', url: 'https://api/login', pathname: '/coll/Auth/Login.bru', folderPath: 'Auth', type: 'http-request' },
      { name: 'Logout', method: 'POST', url: 'https://api/logout', pathname: '/coll/Auth/Logout.bru', folderPath: 'Auth', type: 'http-request' },
      { name: 'GetUser', method: 'GET', url: 'https://api/users/{id}', pathname: '/coll/Users/GetUser.bru', folderPath: 'Users', type: 'http-request' },
      { name: 'GraphQL Query', method: 'POST', url: 'https://api/gql', pathname: '/coll/gql.bru', folderPath: '', type: 'graphql-request' }
    ];

    it('formats the inline preview with method + folder-qualified name', () => {
      const out = formatRequestsList(requests);
      expect(out).toContain('POST Auth/Login');
      expect(out).toContain('GET Users/GetUser');
      expect(out).toContain('POST GraphQL Query');
    });

    it('adds a trailer when the collection exceeds the preview limit', () => {
      const many = Array.from({ length: 40 }, (_, i) => ({
        name: 'Req' + i, method: 'GET', url: '/r/' + i, pathname: '/p/' + i, folderPath: '', type: 'http-request'
      }));
      const out = formatRequestsList(many);
      expect(out).toContain('(+15 more');
    });

    it('returns case-insensitive substring matches across name, url, pathname, folder', () => {
      expect(searchRequests(requests, 'login').totalMatched).toBe(1);
      expect(searchRequests(requests, 'auth').totalMatched).toBe(2);
      expect(searchRequests(requests, 'users').totalMatched).toBe(1);
      expect(searchRequests(requests, 'GQL').totalMatched).toBe(1);
    });

    it('exact-matches HTTP methods without letting "get" match every URL', () => {
      const result = searchRequests(requests, 'get');
      expect(result.totalMatched).toBe(1);
      expect(result.items[0].name).toBe('GetUser');
    });

    it('returns every request for an empty query, capped at the limit', () => {
      const result = searchRequests(requests, '', 50);
      expect(result.items).toHaveLength(4);
      expect(result.totalMatched).toBe(4);
    });

    it('formats matches with pathname so the model can pass it to bru.ctx.runRequest', () => {
      const out = formatSearchRequestsResult(searchRequests(requests, 'login'), 'login');
      expect(out).toContain('Found 1');
      expect(out).toContain('POST Auth/Login');
      expect(out).toContain('pathname: /coll/Auth/Login.bru');
    });

    it('says "no matches" when nothing matched the query', () => {
      expect(formatSearchRequestsResult(searchRequests(requests, 'zzz'), 'zzz'))
        .toBe('No requests match "zzz".');
    });
  });

  // --- Gridman additions to upstream's redaction suite --------------------

  describe('X-WSSE (auth header this fork emits)', () => {
    // src/ipc/network/prepare-request.js sets X-WSSE for the WSSE auth mode.
    // Its value is `UsernameToken Username="…", PasswordDigest="…", Nonce="…"`
    // — a credential derived from the user's password. None of upstream's
    // patterns match the NAME `X-WSSE`, so this is a fork-specific addition.
    it('flags X-WSSE as sensitive', () => {
      expect(isSensitiveName('X-WSSE')).toBe(true);
      expect(isSensitiveName('x-wsse')).toBe(true);
    });

    it('flags X-WSSE-Nonce style variants', () => {
      expect(isSensitiveName('X-WSSE-Nonce')).toBe(true);
    });

    it('redacts the X-WSSE header value out of request context', () => {
      const digest = 'UsernameToken Username="alice", PasswordDigest="Zm9vYmFy", Nonce="abc123"';
      const out = formatRequestContext({
        method: 'GET',
        url: '/secure',
        headers: [
          { name: 'X-WSSE', value: digest, enabled: true },
          { name: 'Content-Type', value: 'application/json', enabled: true }
        ],
        params: [],
        body: null
      });
      expect(out).toContain('X-WSSE: <redacted>');
      expect(out).not.toContain('PasswordDigest');
      expect(out).not.toContain('Zm9vYmFy');
      expect(out).not.toContain('abc123');
      // Non-sensitive headers still pass through.
      expect(out).toContain('Content-Type: application/json');
    });

    it('redacts an x-wsse key inside a JSON request body', () => {
      const out = formatRequestContext({
        method: 'POST',
        url: '/secure',
        headers: [],
        params: [],
        body: { mode: 'json', json: JSON.stringify({ 'x-wsse': 'PasswordDigest="abc"', 'id': 1 }) }
      });
      expect(out).toContain('"x-wsse": "<redacted>"');
      expect(out).not.toContain('PasswordDigest');
      expect(out).toContain('"id": 1');
    });
  });

  describe('non-Latin (Persian) variable names', () => {
    // Enterprise users on this deployment name variables in Persian. The
    // built-in patterns are ASCII regexes and cannot match those names, so
    // `secret: true` from the renderer and the custom-name list are the ONLY
    // things standing between a Persian-named credential and the provider.
    const persianToken = 'توکن_دسترسی'; // "access token"
    const persianPassword = 'رمز_عبور'; // "password"

    it('honors secret: true on a Persian-named variable', () => {
      const vars = [{ name: persianToken, value: 'real-secret-value', scope: 'env', secret: true }];
      expect(formatVariablesList(vars)).toContain(`${persianToken} (secret)`);

      const out = formatSearchVariablesResult(searchVariables(vars, persianToken), persianToken);
      expect(out).toContain(`${persianToken} = <redacted>`);
      expect(out).toContain('[env, secret]');
      expect(out).not.toContain('real-secret-value');
    });

    it('keeps a Persian secret redacted even with every pattern toggle off', () => {
      const vars = [{ name: persianPassword, value: 'real-secret-value', scope: 'env', secret: true }];
      const security = {
        redactHeaders: false,
        redactBody: false,
        redactVariables: false,
        redactResponse: false
      };
      const out = formatSearchVariablesResult(searchVariables(vars, ''), '', { security });
      expect(out).toContain(`${persianPassword} = <redacted>`);
      expect(out).not.toContain('real-secret-value');
    });

    it('redacts a Persian variable listed in customRedactedVariables', () => {
      // No case folding exists in Persian script — normalizeList lowercases
      // both sides, which must remain a no-op rather than mangling the name.
      const vars = [{ name: persianToken, value: 'real-secret-value', scope: 'env', secret: false }];
      const security = { customRedactedVariables: [persianToken] };
      const out = formatSearchVariablesResult(searchVariables(vars, ''), '', { security });
      expect(out).toContain(`${persianToken} = <redacted>`);
      expect(out).not.toContain('real-secret-value');
      expect(formatVariablesList(vars, { security })).toContain(`${persianToken} (secret)`);
    });

    it('does NOT redact an ordinary Persian variable that is not marked secret', () => {
      // Guards against over-redaction: a plain name must survive so generated
      // code can reference it.
      const vars = [{ name: 'نام_کاربر', value: 'ali', scope: 'env', secret: false }];
      const out = formatSearchVariablesResult(searchVariables(vars, ''), '');
      expect(out).toContain('نام_کاربر = ali');
    });

    it('redacts a Persian-named custom header', () => {
      const out = formatRequestContext({
        method: 'GET',
        url: '/x',
        headers: [{ name: 'x-توکن', value: 'real-secret-value', enabled: true }],
        params: [],
        body: null
      }, { security: { customRedactedHeaders: ['x-توکن'] } });
      expect(out).toContain('x-توکن: <redacted>');
      expect(out).not.toContain('real-secret-value');
    });
  });
});
