/**
 * Tests for providers/ReduxStore/slices/ai.js.
 *
 * They live next to the chat panel rather than beside the slice because this
 * change owns the AiChatSidebar directory outright; the slice itself is a
 * single owned file. The subject under test is the slice.
 *
 * The redaction cases are the important ones — a leak there is the worst
 * outcome this feature can produce, so they assert on the exact payload that
 * would cross the IPC boundary.
 */
import { configureStore } from '@reduxjs/toolkit';

jest.mock('utils/collections', () => {
  const actual = jest.requireActual('utils/collections');
  return { ...actual, getAllVariables: jest.fn() };
});

// idb is only touched by the persistence helpers; stub it so importing the
// slice never opens a real database in jsdom.
jest.mock('idb', () => ({ openDB: jest.fn(() => Promise.resolve(null)) }));

const { getAllVariables } = require('utils/collections');

const {
  buildAiRequestsPayload,
  buildAiVariablesPayload,
  buildAiRequestContext,
  isSensitiveVariableName,
  redactUrlForAi,
  sanitizeAiRequestBody,
  scrubOutboundText,
  scrubAiOutboundPayload,
  looksLikeCredential,
  AI_BODY_OMITTED_NOTICE,
  REDACTED_PLACEHOLDER,
  OUTBOUND_VERBATIM_KEYS,
  NESTED_VERBATIM_KEYS,
  sendAiMessage,
  stopAiStream,
  default: aiReducer,
  closeAiPanel,
  toggleAiPanel,
  addAiMessage,
  setCurrentRequestId
} = require('providers/ReduxStore/slices/ai');

const byName = (list) => Object.fromEntries(list.map((v) => [v.name, v]));

/**
 * A VENDOR-PREFIXED CREDENTIAL GLUED TO SURROUNDING TEXT.
 *
 * The regression these pin: the prefix test used to be anchored with `^` and
 * was applied to a "candidate run" — a maximal stretch of
 * `[A-Za-z0-9+/=_.~-]`. That character class contains `/`, `.`, `-`, `_` and
 * `=`, which are exactly the characters a key is glued to in a real payload, so
 * each shape below arrived as ONE run that did not START with a vendor prefix.
 * The anchor never matched; the surrounding text dragged the run below the
 * mixed-case/digit bar of the opaque rule, so nothing else fired either; the
 * key went to the model in full. All five were confirmed leaking end to end.
 *
 * Every shape is asserted twice on purpose — once on `scrubOutboundText` (the
 * primitive) and once through `scrubAiOutboundPayload` (the gate every IPC exit
 * runs), because the leak was only visible end to end.
 */
const VENDOR_KEY = 'sk-live-AAAABBBBCCCCDDDD';

const GLUED_CREDENTIAL_SHAPES = [
  ['a secret in a URL path', `/keys/${VENDOR_KEY}`, '/keys/'],
  ['a secret in an absolute URL', `https://h/cb/${VENDOR_KEY}`, 'https://h/cb/'],
  ['a secret after `=`', `key=${VENDOR_KEY}`, 'key='],
  ['a secret after `-`', `x-${VENDOR_KEY}`, 'x-'],
  ['a secret after `.`', `key.${VENDOR_KEY}`, 'key.']
];

describe('vendor-prefixed credentials glued to surrounding text', () => {
  it.each(GLUED_CREDENTIAL_SHAPES)('scrubOutboundText redacts %s', (_label, input, keptPrefix) => {
    const out = scrubOutboundText(input);
    expect(out).not.toContain(VENDOR_KEY);
    expect(out).toBe(`${keptPrefix}${REDACTED_PLACEHOLDER}`);
  });

  it.each(GLUED_CREDENTIAL_SHAPES)('the outbound gate redacts %s', (_label, input) => {
    // An arbitrary, non-verbatim context key — the route any emitter takes.
    const out = scrubAiOutboundPayload({ someContext: { note: input } });
    expect(JSON.stringify(out)).not.toContain(VENDOR_KEY);
    expect(out.someContext.note).toContain(REDACTED_PLACEHOLDER);
  });

  it.each(GLUED_CREDENTIAL_SHAPES)('looksLikeCredential recognises %s', (_label, input) => {
    expect(looksLikeCredential(input)).toBe(true);
  });

  /**
   * The counterpart the un-anchoring must NOT break: a prefix preceded by an
   * alphanumeric is part of a longer word, not a credential.
   */
  it.each(['compat_value_here', 'break_something_here', 'MSG.something_here'])(
    'does not read %s as a vendor prefix',
    (word) => {
      expect(scrubOutboundText(word)).toBe(word);
    }
  );

  /**
   * A `{{…}}` template name is still redacted by the candidate-run pass, as it
   * was before the un-anchoring — the point here is that the embedded pass must
   * not start ONE CHARACTER INTO the opener and hand back a lopsided
   * `{<redacted>}}`. The braces survive intact, so the value still reads as a
   * template to whoever is looking at the prompt.
   */
  it('does not eat a brace when redacting a template name', () => {
    expect(scrubOutboundText('{{sk_secret}}')).toBe(`{{${REDACTED_PLACEHOLDER}}}`);
  });
});

describe('ai slice — variable redaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('always redacts variables explicitly marked secret, even with the toggle off', () => {
    getAllVariables.mockReturnValue({ API_TOKEN: 'live-value', PLAIN: 'ok' });

    const collection = {
      environments: [
        {
          uid: 'env-1',
          variables: [
            { name: 'API_TOKEN', value: 'live-value', enabled: true, secret: true },
            { name: 'PLAIN', value: 'ok', enabled: true, secret: false }
          ]
        }
      ],
      activeEnvironmentUid: 'env-1'
    };

    const out = byName(buildAiVariablesPayload(collection, null, false));

    expect(out.API_TOKEN.value).toBe(REDACTED_PLACEHOLDER);
    expect(out.API_TOKEN.secret).toBe(true);
    expect(out.PLAIN.value).toBe('ok');
  });

  it('redacts global environment secrets', () => {
    getAllVariables.mockReturnValue({ GLOBAL_SECRET: 'hunter2', GLOBAL_OPEN: 'fine' });

    const collection = {
      globalEnvironmentVariables: { GLOBAL_SECRET: 'hunter2', GLOBAL_OPEN: 'fine' },
      globalEnvSecrets: ['GLOBAL_SECRET']
    };

    const out = byName(buildAiVariablesPayload(collection, null, false));

    expect(out.GLOBAL_SECRET.value).toBe(REDACTED_PLACEHOLDER);
    expect(out.GLOBAL_SECRET.scope).toBe('global');
    expect(out.GLOBAL_OPEN.value).toBe('fine');
  });

  it('always redacts OAuth2 credentials', () => {
    getAllVariables.mockReturnValue({ '$oauth2.cred-1.access_token': 'at-123' });

    const collection = {
      oauth2Credentials: [{ credentialsId: 'cred-1', credentials: { access_token: 'at-123' } }]
    };

    const out = byName(buildAiVariablesPayload(collection, null, false));

    expect(out['$oauth2.cred-1.access_token'].value).toBe(REDACTED_PLACEHOLDER);
    expect(out['$oauth2.cred-1.access_token'].secret).toBe(true);
    expect(out['$oauth2.cred-1.access_token'].scope).toBe('oauth2');
  });

  it('redacts secret-looking names by pattern while the preference is on', () => {
    getAllVariables.mockReturnValue({
      authToken: 'a',
      refresh_token: 'b',
      MY_API_KEY: 'c',
      client_secret: 'd',
      userPassword: 'e',
      authorization: 'f',
      cookie: 'g',
      baseUrl: 'https://example.test'
    });

    const out = byName(buildAiVariablesPayload({}, null, true));

    for (const name of ['authToken', 'refresh_token', 'MY_API_KEY', 'client_secret', 'userPassword', 'authorization', 'cookie']) {
      expect(out[name].value).toBe(REDACTED_PLACEHOLDER);
      expect(out[name].secret).toBe(true);
    }
    expect(out.baseUrl.value).toBe('https://example.test');
    expect(out.baseUrl.secret).toBe(false);
  });

  // The toggle may widen redaction, never remove it — the same rule the main
  // process's buildRedactionPolicy already enforced. With it off, the renderer
  // used to put every `*_token` / `password` value on the IPC wire in the
  // clear and rely on the backend to mask them again.
  it('keeps pattern redaction on even when the preference is off', () => {
    getAllVariables.mockReturnValue({ authToken: 'a', plainName: 'a' });

    const out = byName(buildAiVariablesPayload({}, null, false));

    expect(out.authToken.value).toBe(REDACTED_PLACEHOLDER);
    expect(out.authToken.secret).toBe(true);
    // …and it is still redaction, not blanket blanking.
    expect(out.plainName.value).toBe('a');
  });

  it('defaults the redaction preference to on', () => {
    getAllVariables.mockReturnValue({ session_token: 'a' });

    const out = byName(buildAiVariablesPayload({}, null));

    expect(out.session_token.value).toBe(REDACTED_PLACEHOLDER);
  });

  it('keeps secret sticky when one source flags it and another does not', () => {
    getAllVariables.mockReturnValue({ SHARED: 'v' });

    const collection = {
      globalEnvironmentVariables: { SHARED: 'v' },
      globalEnvSecrets: ['SHARED'],
      runtimeVariables: { SHARED: 'v' }
    };

    const out = byName(buildAiVariablesPayload(collection, null, false));

    expect(out.SHARED.secret).toBe(true);
    expect(out.SHARED.value).toBe(REDACTED_PLACEHOLDER);
  });

  it('never emits internal bookkeeping keys', () => {
    getAllVariables.mockReturnValue({
      pathParams: { id: 1 },
      maskedEnvVariables: ['x'],
      process: { env: { SECRET: 's' } },
      real: 'v'
    });

    const names = buildAiVariablesPayload({}, null, true).map((v) => v.name);

    expect(names).toEqual(['real']);
  });

  it('returns an empty payload without a collection', () => {
    expect(buildAiVariablesPayload(null, null, true)).toEqual([]);
  });

  it('stringifies non-string values and normalises null', () => {
    getAllVariables.mockReturnValue({ count: 7, nothing: null, flag: false });

    const out = byName(buildAiVariablesPayload({}, null, true));

    expect(out.count.value).toBe('7');
    expect(out.nothing.value).toBe('');
    expect(out.flag.value).toBe('false');
  });
});

describe('isSensitiveVariableName', () => {
  it.each([
    'token',
    'TOKEN',
    'idToken',
    'x_csrf_token',
    'api-key',
    'apiKey',
    'secret',
    'password',
    'authorization',
    'cookie'
  ])('matches %s', (name) => {
    expect(isSensitiveVariableName(name)).toBe(true);
  });

  it.each(['baseUrl', 'userId', 'host', 'timeout', ''])('does not match %s', (name) => {
    expect(isSensitiveVariableName(name)).toBe(false);
  });

  it('does not match a missing name', () => {
    expect(isSensitiveVariableName(undefined)).toBe(false);
  });
});

describe('buildAiRequestsPayload', () => {
  it('lists requests with folder paths and no header/body content', () => {
    const collection = {
      pathname: '/c',
      items: [
        {
          uid: 'f1',
          type: 'folder',
          name: 'Users',
          seq: 1,
          items: [
            {
              uid: 'r1',
              type: 'http-request',
              name: 'List',
              seq: 1,
              pathname: '/c/Users/List.bru',
              request: { method: 'GET', url: '{{base}}/users', headers: [{ name: 'Authorization', value: 'Bearer x' }] }
            }
          ]
        },
        {
          uid: 'r2',
          type: 'http-request',
          name: 'Root',
          seq: 2,
          pathname: '/c/Root.bru',
          request: { method: 'POST', url: '{{base}}/root' }
        }
      ]
    };

    const out = buildAiRequestsPayload(collection);

    expect(out).toEqual([
      {
        name: 'List',
        pathname: 'Users/List.bru',
        folderPath: 'Users',
        type: 'http-request',
        method: 'GET',
        url: '{{base}}/users'
      },
      { name: 'Root', pathname: 'Root.bru', folderPath: '', type: 'http-request', method: 'POST', url: '{{base}}/root' }
    ]);
    expect(JSON.stringify(out)).not.toContain('Bearer');
  });

  /**
   * `item.pathname` is absolute on disk, and it was going to the model as-is:
   * the user's home directory, their employer's name in a client folder, and
   * every directory in between, on EVERY request in the collection, on every
   * chat turn.
   *
   * Collection-relative is also the only form that works — the model is
   * instructed to hand this value to `bru.ctx.runRequest(pathname)`, which
   * resolves it with `path.join(collection.pathname, pathname)`.
   */
  describe('the .bru path sent to the model', () => {
    const collectionAt = (root, itemPathname) => ({
      pathname: root,
      items: [{ uid: 'r1', type: 'http-request', name: 'Login', pathname: itemPathname, request: { method: 'GET' } }]
    });

    const pathnameOf = (collection) => buildAiRequestsPayload(collection)[0].pathname;

    it('is relative to the collection, never the absolute path on disk', () => {
      const out = pathnameOf(collectionAt('/Users/someone/work/acme', '/Users/someone/work/acme/Auth/Login.bru'));
      expect(out).toBe('Auth/Login.bru');
    });

    it('carries no fragment of the home directory or the collection root', () => {
      const payload = buildAiRequestsPayload(
        collectionAt('/Users/someone/work/clients/acme', '/Users/someone/work/clients/acme/Auth/Login.bru')
      );
      const serialized = JSON.stringify(payload);
      for (const leak of ['/Users', 'someone', 'work', 'clients', 'acme']) {
        expect(serialized).not.toContain(leak);
      }
    });

    it('handles a windows collection root and separators', () => {
      expect(pathnameOf(collectionAt('C:\\Users\\someone\\acme', 'C:\\Users\\someone\\acme\\Auth\\Login.bru'))).toBe(
        'Auth/Login.bru'
      );
    });

    it('tolerates a trailing separator on the collection root', () => {
      expect(pathnameOf(collectionAt('/Users/someone/acme/', '/Users/someone/acme/Login.bru'))).toBe('Login.bru');
    });

    it('falls back to the bare file name when the item is not under the root', () => {
      expect(pathnameOf(collectionAt('/Users/someone/acme', '/Users/someone/elsewhere/Login.bru'))).toBe('Login.bru');
    });

    it('falls back to the bare file name when the collection root is unknown', () => {
      expect(pathnameOf(collectionAt(undefined, '/Users/someone/acme/Login.bru'))).toBe('Login.bru');
    });

    it('emits an empty path rather than inventing one when the item has none', () => {
      expect(pathnameOf(collectionAt('/Users/someone/acme', undefined))).toBe('');
    });
  });

  it('redacts credentials inlined in a sibling request url', () => {
    // The backend prints every one of these urls to the model verbatim, so a
    // single request with an inline key would leak on every chat turn.
    const collection = {
      items: [
        {
          uid: 'r1',
          type: 'http-request',
          name: 'Legacy',
          pathname: '/c/Legacy.bru',
          request: { method: 'GET', url: 'https://api.example.test/v1?api_key=sk-live-SUPERSECRET' }
        }
      ]
    };

    expect(JSON.stringify(buildAiRequestsPayload(collection))).not.toContain('sk-live-SUPERSECRET');
  });

  it('skips transient items', () => {
    const collection = {
      items: [{ uid: 'r1', type: 'http-request', name: 'Scratch', isTransient: true, request: { method: 'GET' } }]
    };
    expect(buildAiRequestsPayload(collection)).toEqual([]);
  });

  it('returns an empty payload without a collection', () => {
    expect(buildAiRequestsPayload(null)).toEqual([]);
  });
});

describe('redactUrlForAi', () => {
  it('redacts a credential carried in the query string', () => {
    const out = redactUrlForAi('https://api.example.test/v1/users?api_key=sk-live-SUPERSECRET&page=2');
    expect(out).not.toContain('sk-live-SUPERSECRET');
    expect(out).toBe(`https://api.example.test/v1/users?api_key=${REDACTED_PLACEHOLDER}&page=${REDACTED_PLACEHOLDER}`);
  });

  it.each([
    ['access_token', 'https://x.test/a?access_token=AT-123'],
    ['bearer in an odd param name', 'https://x.test/a?k=AT-123'],
    ['signature', 'https://x.test/a?sig=abc123&Expires=99'],
    ['jwt', 'https://x.test/a?t=eyJhbGciOiJIUzI1NiJ9.payload.sig']
  ])('redacts a %s regardless of the parameter name', (_label, url) => {
    const out = redactUrlForAi(url);
    for (const secret of ['AT-123', 'abc123', 'eyJhbGciOiJIUzI1NiJ9.payload.sig']) {
      expect(out).not.toContain(secret);
    }
  });

  it('strips userinfo credentials', () => {
    expect(redactUrlForAi('https://admin:hunter2@internal.test/v1')).toBe(
      `https://${REDACTED_PLACEHOLDER}@internal.test/v1`
    );
  });

  // The stated rule was "userinfo is replaced wholesale"; the regex required a
  // literal `scheme://`, so the protocol-relative form walked straight past a
  // rule this module already claimed to enforce.
  it('strips protocol-relative userinfo', () => {
    expect(redactUrlForAi('//svc:p4ssw0rd@api.internal.example/x')).toBe(
      `//${REDACTED_PLACEHOLDER}@api.internal.example/x`
    );
  });

  describe('credentials in the URL PATH', () => {
    it.each([
      ['a vendor-prefixed key', 'https://api.internal.example/v1/keys/sk-live-AAAABBBBCCCC', 'sk-live-AAAABBBBCCCC'],
      ['a jwt', 'https://api.internal.example/session/eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln', 'eyJhbGciOiJIUzI1NiJ9'],
      ['a long hex token', 'https://api.internal.example/t/0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
      ['a uuid session id', 'https://api.internal.example/s/550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000'],
      ['an opaque bearer', 'https://api.internal.example/d/Ab3xY9zQ1mN7pR4tV6wK2sJ8', 'Ab3xY9zQ1mN7pR4tV6wK2sJ8'],
      ['a scheme-less templated url', '{{baseUrl}}/keys/sk-live-AAAABBBBCCCC', 'sk-live-AAAABBBBCCCC']
    ])('redacts %s', (_label, url, secret) => {
      const out = redactUrlForAi(url);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED_PLACEHOLDER);
    });

    it('leaves ordinary path segments readable so the model can still write code', () => {
      expect(redactUrlForAi('https://api.internal.example/v1/users/42/acme-corporation-limited')).toBe(
        'https://api.internal.example/v1/users/42/acme-corporation-limited'
      );
    });

    it('never mistakes the host for a credential', () => {
      const url = 'https://Ab3xY9zQ1mN7pR4tV6wK2sJ8.internal.example/v1';
      expect(redactUrlForAi(url)).toBe(url);
    });

    /**
     * Segment matching asks `looksLikeCredential` about the WHOLE segment, and
     * that function bails on anything containing a `{` (a Bruno template is a
     * name, never a literal secret). A template glued to a vendor key is both,
     * so the segment walked through untouched. Callers compose this with
     * `scrubOutboundText`, which caught it downstream — but this function is
     * exported and documents that every credential-shaped path segment is
     * replaced, so it has to hold on its own.
     */
    it('redacts a vendor key glued to a template inside one segment', () => {
      const out = redactUrlForAi('https://h/keys/{{env}}-sk-live-AAAABBBBCCCCDDDD');
      expect(out).not.toContain('sk-live-AAAABBBBCCCCDDDD');
      expect(out).toBe(`https://h/keys/{{env}}-${REDACTED_PLACEHOLDER}`);
    });

    it('still leaves a bare template segment alone', () => {
      expect(redactUrlForAi('{{baseUrl}}/v1/{{sk_secret}}/users')).toBe('{{baseUrl}}/v1/{{sk_secret}}/users');
    });
  });

  it('redacts a fragment that is not a template', () => {
    expect(redactUrlForAi('https://x.test/a#token=abc')).toBe(`https://x.test/a#${REDACTED_PLACEHOLDER}`);
  });

  it('keeps the scheme, host and path so the model still knows the request', () => {
    expect(redactUrlForAi('https://api.example.test/v1/users/42?x=y')).toContain('https://api.example.test/v1/users/42');
  });

  it('keeps Bruno templates, which carry no literal secret', () => {
    expect(redactUrlForAi('{{baseUrl}}/users?token={{authToken}}')).toBe('{{baseUrl}}/users?token={{authToken}}');
  });

  it('redacts a bare query token it cannot tell from a flag', () => {
    expect(redactUrlForAi('https://x.test/a?SUPERSECRET')).toBe(`https://x.test/a?${REDACTED_PLACEHOLDER}`);
  });

  it('leaves a plain url alone', () => {
    expect(redactUrlForAi('https://api.example.test/v1/users')).toBe('https://api.example.test/v1/users');
  });

  it('handles empty input', () => {
    expect(redactUrlForAi('')).toBe('');
    expect(redactUrlForAi(null)).toBe('');
    expect(redactUrlForAi(undefined)).toBe('');
  });
});

describe('sanitizeAiRequestBody', () => {
  it('redacts credential values inside JSON it can parse, keeping the shape', () => {
    const out = sanitizeAiRequestBody({ mode: 'json', json: '{"user":"a","password":"hunter2"}' });
    const parsed = JSON.parse(out.json);
    expect(parsed).toEqual({ user: 'a', password: REDACTED_PLACEHOLDER });
    expect(out.json).not.toContain('hunter2');
  });

  // The two cases the previous pass's "fail closed" wording papered over:
  // anything that JSON.parses used to be forwarded verbatim and guarded only
  // by key-name matching downstream.
  it('redacts a short key the old name list did not know (`pw`)', () => {
    const out = sanitizeAiRequestBody({ mode: 'json', json: '{"pw":"hunter2"}' });
    expect(out.json).not.toContain('hunter2');
    expect(JSON.parse(out.json)).toEqual({ pw: REDACTED_PLACEHOLDER });
  });

  it('redacts a credential-shaped VALUE under an innocuous key (`q`)', () => {
    const out = sanitizeAiRequestBody({ mode: 'json', json: '{"q":"sk-live-AAAABBBBCCCCDDDD"}' });
    expect(out.json).not.toContain('sk-live-AAAABBBBCCCCDDDD');
    expect(JSON.parse(out.json)).toEqual({ q: REDACTED_PLACEHOLDER });
  });

  it('redacts a credential nested inside arrays and objects', () => {
    const out = sanitizeAiRequestBody({
      mode: 'json',
      json: '{"items":[{"meta":{"pwd":"hunter2","jwt":"eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln"}}]}'
    });
    expect(out.json).not.toContain('hunter2');
    expect(out.json).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  /**
   * ISOLATES THE PER-FIELD VALUE-SHAPE RULE from the outbound gate.
   *
   * The serialized body leaves under the non-verbatim key `json`, so the gate's
   * `scrubOutboundText` would blank the credential here either way — which made
   * every other case above pass with the body walker's value-shape branch
   * deleted. The two are not equivalent, though: the body walker replaces the
   * WHOLE field, the gate only the credential-shaped run inside it. Asserting
   * on the surrounding words is what gives that branch independent weight, so
   * removing it fails this test instead of silently loosening redaction.
   */
  it('replaces the whole field value, not just the credential-shaped run in it', () => {
    const out = sanitizeAiRequestBody({
      mode: 'json',
      json: '{"note":"see /keys/sk-live-AAAABBBBCCCCDDDD now"}'
    });
    expect(out.json).not.toContain('sk-live-AAAABBBBCCCCDDDD');
    expect(JSON.parse(out.json)).toEqual({ note: REDACTED_PLACEHOLDER });
    // Gate-only redaction would leave `see …<redacted>… now` behind.
    expect(out.json).not.toContain('see');
    expect(out.json).not.toContain('now');
  });

  // Stated honestly rather than promised away: shape+name matching cannot see
  // an ordinary word under an ordinary key. The comment in the slice says so
  // and this test pins the claim so it cannot quietly rot into a lie.
  it('does NOT catch an ordinary-looking secret under an ordinary-looking key', () => {
    const out = sanitizeAiRequestBody({ mode: 'json', json: '{"a":"hunter2"}' });
    expect(out.json).toContain('hunter2');
  });

  it('drops JSON that cannot be parsed — the templated case', () => {
    // The backend redactor JSON.parses in a try and returns the RAW string on
    // failure. Bruno bodies routinely mix a literal secret with a template, so
    // this is the common case, not the edge case.
    const body = { mode: 'json', json: '{"id": {{userId}}, "password": "hunter2"}' };
    const out = sanitizeAiRequestBody(body);
    expect(out.json).toBe(AI_BODY_OMITTED_NOTICE);
    expect(out.json).not.toContain('hunter2');
  });

  it.each(['text', 'xml', 'sparql'])('drops a %s body, which nothing downstream can redact', (mode) => {
    const out = sanitizeAiRequestBody({ mode, [mode]: 'password=hunter2' });
    expect(out[mode]).toBe(AI_BODY_OMITTED_NOTICE);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('keeps structured form fields but masks the credential ones here, not downstream', () => {
    const out = sanitizeAiRequestBody({
      mode: 'formUrlEncoded',
      formUrlEncoded: [
        { name: 'password', value: 'hunter2', enabled: true },
        { name: 'grant_type', value: 'client_credentials', enabled: true }
      ]
    });
    expect(out).toEqual({
      mode: 'formUrlEncoded',
      formUrlEncoded: [
        { name: 'password', value: REDACTED_PLACEHOLDER, enabled: true },
        { name: 'grant_type', value: 'client_credentials', enabled: true }
      ]
    });
  });

  it('drops unparseable graphql variables but keeps the query', () => {
    const out = sanitizeAiRequestBody({
      mode: 'graphql',
      graphql: { query: 'query { me { id } }', variables: '{ "t": {{tok}} , "p": "hunter2" }' }
    });
    expect(out.graphql.query).toBe('query { me { id } }');
    expect(out.graphql.variables).toBe(AI_BODY_OMITTED_NOTICE);
  });

  it('redacts inline string literals in a graphql query but keeps its shape', () => {
    const out = sanitizeAiRequestBody({
      mode: 'graphql',
      graphql: { query: 'mutation Login { login(user: "admin", password: "hunter2") { token } }' }
    });
    expect(out.graphql.query).not.toContain('hunter2');
    expect(out.graphql.query).not.toContain('admin');
    expect(out.graphql.query).toBe(
      `mutation Login { login(user: "${REDACTED_PLACEHOLDER}", password: "${REDACTED_PLACEHOLDER}") { token } }`
    );
  });

  it('redacts a graphql block string', () => {
    const out = sanitizeAiRequestBody({
      mode: 'graphql',
      graphql: { query: 'mutation { note(body: """line1\nhunter2\n""") { id } }' }
    });
    expect(out.graphql.query).not.toContain('hunter2');
    expect(out.graphql.query).toBe(`mutation { note(body: "${REDACTED_PLACEHOLDER}") { id } }`);
  });

  it('leaves a literal-free graphql query untouched', () => {
    const query = 'query GetUser($id: ID!) { user(id: $id) { id name } }';
    expect(sanitizeAiRequestBody({ mode: 'graphql', graphql: { query } }).graphql.query).toBe(query);
  });

  it('sends nothing for a body mode it does not understand', () => {
    expect(sanitizeAiRequestBody({ mode: 'file', file: [{ filePath: '/secret/keys.pem' }] })).toEqual({ mode: 'file' });
  });

  it('handles a missing body', () => {
    expect(sanitizeAiRequestBody(null)).toBeNull();
    expect(sanitizeAiRequestBody({ mode: 'none' })).toEqual({ mode: 'none' });
  });
});

describe('buildAiRequestContext', () => {
  it('prefers the draft request when one exists', () => {
    const item = {
      request: { url: 'saved', method: 'GET' },
      draft: { request: { url: 'draft', method: 'POST', headers: [], params: [] } }
    };
    expect(buildAiRequestContext(item)).toMatchObject({ url: 'draft', method: 'POST' });
  });

  it('returns null for an item with no request', () => {
    expect(buildAiRequestContext({})).toBeNull();
    expect(buildAiRequestContext(null)).toBeNull();
  });

  // The whole point of the feature: nothing leaves the machine that the
  // customer did not intend to send.
  it('never assembles a context carrying an unredacted url', () => {
    const ctx = buildAiRequestContext({
      request: {
        url: 'https://admin:hunter2@api.example.test/v1?api_key=sk-live-SUPERSECRET',
        method: 'GET',
        headers: [],
        params: []
      }
    });
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('sk-live-SUPERSECRET');
    expect(serialized).not.toContain('hunter2');
  });

  it('never assembles a context carrying an unredactable body', () => {
    const ctx = buildAiRequestContext({
      request: {
        url: 'https://api.example.test/v1',
        method: 'POST',
        headers: [],
        params: [],
        body: { mode: 'json', json: '{"client_secret": "SUPERSECRET", "id": {{userId}}}' }
      }
    });
    expect(JSON.stringify(ctx)).not.toContain('SUPERSECRET');
  });

  it('redacts the draft url, not just the saved one', () => {
    const ctx = buildAiRequestContext({
      request: { url: 'https://x.test/a' },
      draft: { request: { url: 'https://x.test/a?api_key=DRAFTSECRET', method: 'GET' } }
    });
    expect(ctx.url).not.toContain('DRAFTSECRET');
  });
});

/**
 * THE VERBATIM LIST IS POSITIONAL, NOT A SET OF MAGIC FIELD NAMES.
 *
 * The regression these pin: `scrubAiOutbound` applied the verbatim key list at
 * EVERY depth, and `requestContext.responseData` is arbitrary captured traffic.
 * A response body of `{"model": "sk-live-…"}` therefore matched the `model`
 * exemption and reached the provider in full, while the same value under
 * `{"ordinary": …}` was redacted. All six exempt names — `model`, `messages`,
 * `docs`, `contentType`, `requestId`, `allContent` — are ordinary field names
 * that real APIs return; a chat API's own response is `{"messages": […]}`.
 *
 * Confirmed leaking through `buildAiRequestContext` AND through the payload
 * gate before the fix.
 */
describe('verbatim exemptions do not apply inside captured response data', () => {
  const KEY = 'sk-live-AAAABBBBCCCCDDDD';

  const contextWithResponse = (data) =>
    buildAiRequestContext({
      request: { url: 'https://api.example.test/v1', method: 'GET', headers: [], params: [] },
      response: { status: 200, data }
    });

  it.each([...OUTBOUND_VERBATIM_KEYS])('redacts a credential under a response field called %s', (key) => {
    const ctx = contextWithResponse({ [key]: KEY });

    expect(JSON.stringify(ctx.responseData)).not.toContain(KEY);
    expect(ctx.responseData[key]).toBe(REDACTED_PLACEHOLDER);
  });

  it.each([...OUTBOUND_VERBATIM_KEYS])('redacts it through the payload gate too, under %s', (key) => {
    const out = scrubAiOutboundPayload({
      requestContext: { url: 'https://api.example.test/v1', method: 'GET', responseData: { [key]: KEY } }
    });

    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  /**
   * Not vacuous by way of everything being redacted: an ordinary response
   * field is redacted by the SAME rule, so the assertions above only mean
   * something alongside this one — the exempt names must behave identically to
   * an unexempt one, and both must be redacted.
   */
  it('treats an exempt field name exactly like an ordinary one', () => {
    const ctx = contextWithResponse({ model: KEY, ordinary: KEY });
    expect(ctx.responseData.model).toBe(ctx.responseData.ordinary);
    expect(ctx.responseData.ordinary).toBe(REDACTED_PLACEHOLDER);
  });

  /**
   * The counterpart the fix must NOT break. `docs` is the user's own prose and
   * is the one exemption that has to survive one level down, as a direct field
   * of the request context — it is the same text `allContent` carries, and the
   * disclosure names it. Nested one level further, inside a response, it is
   * captured traffic and gets no exemption.
   */
  it('still sends the request context docs verbatim', () => {
    const ctx = buildAiRequestContext({
      request: {
        url: 'https://api.example.test/v1',
        method: 'GET',
        headers: [],
        params: [],
        docs: `Call with ${KEY} in the header`
      }
    });
    expect(ctx.docs).toBe(`Call with ${KEY} in the header`);
  });

  it('pins the one key that stays verbatim below the top level', () => {
    expect([...NESTED_VERBATIM_KEYS]).toEqual(['docs']);
  });
});

describe('ai slice — reducer', () => {
  it('starts closed and empty', () => {
    const state = aiReducer(undefined, { type: '@@INIT' });
    expect(state).toEqual({ isOpen: false, chats: {} });
  });

  it('toggles and closes', () => {
    let state = aiReducer(undefined, toggleAiPanel());
    expect(state.isOpen).toBe(true);
    state = aiReducer(state, closeAiPanel());
    expect(state.isOpen).toBe(false);
  });

  // The popout was cut from this pass — the main process denies every
  // window.open, so the button could never work. Nothing may dispatch it.
  it('exposes no popout action', () => {
    const slice = require('providers/ReduxStore/slices/ai');
    expect(slice.popOutAiChat).toBeUndefined();
    expect(slice.dockAiChat).toBeUndefined();
  });
});

describe('sendAiMessage — default off', () => {
  const makeStore = (aiEnabled) =>
    configureStore({
      reducer: {
        ai: aiReducer,
        app: (state = { preferences: { ai: { enabled: aiEnabled } } }) => state
      }
    });

  let send;
  beforeEach(() => {
    send = jest.fn();
    window.ipcRenderer = { send, on: jest.fn(() => jest.fn()) };
  });

  afterEach(() => {
    delete window.ipcRenderer;
  });

  it('sends nothing when ai.enabled is false', async () => {
    const store = makeStore(false);
    await store.dispatch(sendAiMessage('tab-1', 'hello', {}, null, '', 'docs', [], []));
    expect(send).not.toHaveBeenCalled();
    expect(store.getState().ai.chats['tab-1']).toBeUndefined();
  });

  it('sends on the chat channel when ai.enabled is true', async () => {
    const store = makeStore(true);
    store.dispatch(sendAiMessage('tab-1', 'hello', {}, null, '', 'docs', [], []));
    expect(send).toHaveBeenCalledWith('renderer:ai-chat-stream', expect.objectContaining({ requestId: expect.any(String) }));
  });

  it('refuses a second concurrent send for the same tab', async () => {
    const store = makeStore(true);
    store.dispatch(sendAiMessage('tab-1', 'first', {}, null, '', 'docs', [], []));
    send.mockClear();
    await store.dispatch(sendAiMessage('tab-1', 'second', {}, null, '', 'docs', [], []));
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * GROUND TRUTH FOR THE DISCLOSURE.
   *
   * `allContent` is verbatim, and it is not just Docs — it carries the Tests,
   * Pre-Request script and Post-Response script of the open request too, by
   * exactly the same route. The UI used to name only Docs, which read as a
   * promise about the other three. This test is what the wording in
   * Preferences > AI > Security and the chat empty state has to describe; the
   * matching assertions live in Preferences/AI/index.spec.js and index.spec.js.
   */
  it('sends every allContent slot verbatim, not just docs', async () => {
    const store = makeStore(true);
    const allContent = {
      'docs': 'docs sk-live-DOCSDOCSDOCSDOCS',
      'tests': 'tests sk-live-TESTSTESTSTESTS',
      'pre-request': 'pre sk-live-PREPREPREPREPRE',
      'post-response': 'post sk-live-POSTPOSTPOSTPOST'
    };

    store.dispatch(sendAiMessage('tab-1', 'hello', allContent, null, '', 'docs', [], []));

    const [, payload] = send.mock.calls[0];
    expect(payload.allContent).toEqual(allContent);
    // And the user's own words, which the disclosure also has to mention.
    expect(payload.messages[payload.messages.length - 1]).toEqual({ role: 'user', content: 'hello' });
  });
});

describe('stopAiStream', () => {
  it('only stops when a request is in flight', () => {
    const send = jest.fn();
    window.ipcRenderer = { send, on: jest.fn(() => jest.fn()) };

    const store = configureStore({ reducer: { ai: aiReducer } });
    store.dispatch(stopAiStream('tab-1'));
    expect(send).not.toHaveBeenCalled();

    store.dispatch(addAiMessage({ tabUid: 'tab-1', message: { role: 'user', content: 'hi' } }));
    store.dispatch(setCurrentRequestId({ tabUid: 'tab-1', requestId: 'req-9' }));
    store.dispatch(stopAiStream('tab-1'));
    expect(send).toHaveBeenCalledWith('renderer:ai-chat-stop', { requestId: 'req-9' });

    delete window.ipcRenderer;
  });
});
