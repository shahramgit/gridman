/**
 * THE CHOKEPOINT TEST.
 *
 * An earlier round fixed URL redaction in ONE emitter and three others kept
 * leaking — the collection preview inlined into every chat message, the
 * list_requests / search_requests tool results, and autocomplete's own private
 * copy of the request formatter. (Autocomplete has since been removed
 * entirely: its two IPC channels had no caller in packages/bruno-app/src.)
 * Fixing emitters one at a time does not converge, so this file tests the RULE
 * instead of the instances:
 *
 *   1. every `format*` export of a model-facing module is wrapped in
 *      context.outbound() — an unwrapped one fails here;
 *   2. every one of them has a fixture in the table below — a NEW formatter
 *      with no fixture fails here, so the table cannot silently fall behind;
 *   3. every fixture's output, built from a payload with a credential in every
 *      field, contains none of them — under strict preferences AND with every
 *      redaction toggle switched off.
 *
 * Non-vacuity: each fixture also declares `mustContain`. A formatter that
 * returned '' (or that we called with arguments it ignores) would pass 3 for
 * free; it cannot pass `mustContain`. And the discovered-vs-declared sets are
 * compared both ways, so this file cannot be satisfied by a loop that never
 * runs.
 */

const path = require('node:path');
const fs = require('node:fs');

const context = require('../../src/ipc/ai/context');
const chatPrompts = require('../../src/ipc/ai/chat-prompts');

const { isOutboundGuarded, searchVariables, searchRequests } = context;

// --- a payload with a credential in every channel a URL can carry ---------

const SECRETS = {
  userinfo: 'hunter2-USERINFO-LEAK',
  pathSegment: 'sk-live-PATHSEGMENTLEAK00',
  queryValue: 'sk-live-QUERYVALUELEAK00',
  semicolonValue: 'sk-live-SEMICOLONLEAK000',
  fragment: 'sk-live-FRAGMENTLEAK0000',
  header: 'sk-live-HEADERLEAK000000',
  jsonBody: 'sk-live-JSONBODYLEAK0000',
  xmlBody: 'sk-live-XMLBODYLEAK00000',
  variable: 'sk-live-VARIABLELEAK0000',
  response: 'sk-live-RESPONSELEAK0000',
  // The credential-shape detector used to run on URL components only, so every
  // one of these — a credential-shaped VALUE under an innocuous NAME — reached
  // the model verbatim through the tables the formatters print.
  innocuousHeader: 'sk-live-HEADERSHAPELEAK0',
  innocuousParam: 'sk-live-PARAMSHAPELEAK00',
  innocuousJson: 'sk-live-JSONSHAPELEAK000',
  innocuousVariable: 'sk-live-VARSHAPELEAK0000',
  innocuousResponse: 'sk-live-RESPSHAPELEAK000',
  // The OTHER axis. Every rule above masks a VALUE; these sit in the NAME
  // position — a header name, a param name, a JSON key, a response key, a
  // variable name — which every emitter used to copy through verbatim.
  headerName: 'sk-live-HEADERNAMELEAK00',
  paramName: 'sk-live-PARAMNAMELEAK000',
  jsonKey: 'sk-live-JSONKEYLEAK00000',
  responseKey: 'sk-live-RESPKEYLEAK00000',
  variableName: 'sk-live-VARNAMELEAK00000'
};

const ALL_SECRETS = Object.values(SECRETS);

const LEAKY_URL
  = `https://alice:${SECRETS.userinfo}@hooks.internal.example`
    + `/services/${SECRETS.pathSegment}/deliver`
    + `?api_key=${SECRETS.queryValue};handle=${SECRETS.semicolonValue}&page=2`
    + `#access_token=${SECRETS.fragment}`;

const requestContext = () => ({
  method: 'POST',
  url: LEAKY_URL,
  headers: [
    { name: 'Authorization', value: `Bearer ${SECRETS.header}`, enabled: true },
    { name: 'X-Trace-Id', value: SECRETS.innocuousHeader, enabled: true },
    { name: `X-${SECRETS.headerName}`, value: 'relay', enabled: true },
    { name: 'Accept', value: 'application/json', enabled: true }
  ],
  params: [
    { name: 'api_key', value: SECRETS.queryValue, enabled: true, type: 'query' },
    { name: 'page', value: SECRETS.innocuousParam, enabled: true, type: 'query' },
    { name: SECRETS.paramName, value: '1', enabled: true, type: 'query' }
  ],
  body: {
    mode: 'json',
    json: `{"client_secret":"${SECRETS.jsonBody}","session":"${SECRETS.innocuousJson}","${SECRETS.jsonKey}":"1","plan":"pro"}`
  },
  docs: 'Delivers an event.',
  responseStatus: 200,
  responseData: {
    access_token: SECRETS.response,
    session: SECRETS.innocuousResponse,
    [SECRETS.responseKey]: 1,
    user: { name: 'alice' }
  }
});

const variables = () => [
  { name: 'API_TOKEN', value: SECRETS.variable, scope: 'env', secret: false },
  { name: 'SESSION_ID', value: SECRETS.innocuousVariable, scope: 'env', secret: false },
  { name: SECRETS.variableName, value: 'x', scope: 'env', secret: false },
  { name: 'BASE_URL', value: 'https://api.example.com', scope: 'env', secret: false }
];

const requests = () => [
  {
    name: 'Deliver',
    method: 'POST',
    url: LEAKY_URL,
    pathname: '/coll/Hooks/Deliver.bru',
    folderPath: 'Hooks',
    type: 'http-request'
  }
];

// --- the fixture table ---------------------------------------------------
//
// key: `<module>.<export>`. `call(security)` invokes the formatter the way its
// real caller does; `mustContain` proves the call produced real output.

const FIXTURES = {
  'context.formatRequestContext': {
    call: (security) => context.formatRequestContext(requestContext(), { includeResponse: true, security }),
    mustContain: ['hooks.internal.example', 'Accept: application/json']
  },
  'context.formatResponseShape': {
    call: (security) => context.formatResponseShape(200, requestContext().responseData, { security }),
    mustContain: ['access_token']
  },
  'context.formatVariablesList': {
    call: (security) => context.formatVariablesList(variables(), { security }),
    mustContain: ['API_TOKEN', 'BASE_URL']
  },
  'context.formatSearchVariablesResult': {
    call: (security) => context.formatSearchVariablesResult(searchVariables(variables(), ''), '', { security }),
    mustContain: ['API_TOKEN', 'BASE_URL = https://api.example.com']
  },
  'context.formatRequestsList': {
    call: (security) => context.formatRequestsList(requests(), { security }),
    mustContain: ['POST Hooks/Deliver', 'hooks.internal.example']
  },
  'context.formatSearchRequestsResult': {
    call: (security) => context.formatSearchRequestsResult(searchRequests(requests(), ''), '', { security }),
    mustContain: ['pathname: /coll/Hooks/Deliver.bru', 'hooks.internal.example']
  }
};

// --- discovery -----------------------------------------------------------

const MODULES = {
  'context': context,
  'chat-prompts': chatPrompts
};

const discoverFormatters = () => {
  const found = [];
  for (const [moduleName, mod] of Object.entries(MODULES)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value === 'function' && /^format/.test(exportName)) {
        found.push({ key: `${moduleName}.${exportName}`, fn: value });
      }
    }
  }
  return found;
};

const EVERYTHING_OFF = {
  redactHeaders: false,
  redactBody: false,
  redactVariables: false,
  redactResponse: false
};

describe('every outbound formatter goes through the chokepoint', () => {
  const discovered = discoverFormatters();

  it('found the formatters at all (guards this file against testing nothing)', () => {
    expect(discovered.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(FIXTURES).length).toBe(discovered.length);
  });

  it('has a fixture for every exported formatter, and no stale ones', () => {
    // A NEW formatter added without a fixture fails here. This is the check
    // that stops the next round of "we fixed one emitter out of four".
    expect(new Set(discovered.map((d) => d.key))).toEqual(new Set(Object.keys(FIXTURES)));
  });

  it.each(discovered.map((d) => [d.key, d.fn]))('%s is wrapped in outbound()', (_key, fn) => {
    expect(isOutboundGuarded(fn)).toBe(true);
  });

  describe.each(Object.entries(FIXTURES))('%s', (key, fixture) => {
    it('emits no credential under strict (default) preferences', () => {
      const out = fixture.call(undefined);
      expect(typeof out).toBe('string');
      for (const marker of fixture.mustContain) expect(out).toContain(marker);
      for (const secret of ALL_SECRETS) expect(out).not.toContain(secret);
    });

    it('emits no credential with every redaction toggle switched off', () => {
      const out = fixture.call(EVERYTHING_OFF);
      for (const marker of fixture.mustContain) expect(out).toContain(marker);
      for (const secret of ALL_SECRETS) expect(out).not.toContain(secret);
    });
  });
});

describe('the guard actually redacts rather than merely tagging', () => {
  // If outbound() only set the symbol and returned the string untouched, the
  // suite above would still pass for formatters that redact internally. This
  // pins the wrapper's own behaviour on a formatter that does NOT.
  it('scrubs a URL an unguarded formatter would have printed verbatim', () => {
    const naive = (ctx) => `Request: ${ctx.url}`;
    const guarded = context.outbound(naive);

    expect(naive({ url: LEAKY_URL })).toContain(SECRETS.queryValue);

    const out = guarded({ url: LEAKY_URL });
    expect(out).toContain('Request: https://alice:');
    for (const secret of ALL_SECRETS) expect(out).not.toContain(secret);
  });

  it('honours the caller\'s custom redaction list in the final pass', () => {
    const naive = (ctx) => `Request: ${ctx.url}`;
    const guarded = context.outbound(naive, (args) => args[1]);
    const url = 'https://h/p?tracking=abc123';

    expect(guarded({ url }, null)).toContain('tracking=abc123');
    expect(guarded({ url }, { customRedactedHeaders: ['tracking'] })).toContain('tracking=<redacted>');
  });

  it('is idempotent, so double-wrapping cannot corrupt the output', () => {
    const once = context.scrubOutbound(`GET ${LEAKY_URL}`);
    expect(context.scrubOutbound(once)).toBe(once);
    expect(once).not.toContain('<redacted><redacted>');
  });
});

// --- second net: no new emitter may interpolate a raw url ----------------

describe('source scan: url interpolations in src/ipc/ai go through redactUrl', () => {
  /**
   * A backstop for the emitter that is NOT exported and so cannot be
   * enumerated above. Every `${…url…}` template interpolation in the AI module
   * must either call `redactUrl` or be annotated `NOT-OUTBOUND` with a reason.
   *
   * Limits, stated: this reads source, not behaviour. It cannot see string
   * concatenation, and someone determined could satisfy it with a token
   * mention. It exists to make a raw URL emitter fail loudly at the moment it
   * is written; the behavioural nets are the enumerating suite above and
   * tests/ai/prompt-assembly.spec.js.
   */
  const AI_DIR = path.join(__dirname, '../../src/ipc/ai');
  const files = fs.readdirSync(AI_DIR).filter((f) => f.endsWith('.js'));

  it('scans a non-empty set of files', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files)('%s', (file) => {
    const source = fs.readFileSync(path.join(AI_DIR, file), 'utf8');
    const lines = source.split('\n');
    const offenders = [];

    lines.forEach((line, index) => {
      const interpolations = line.match(/\$\{[^}]*\}/g) || [];
      for (const expr of interpolations) {
        if (!/url/i.test(expr)) continue;
        if (/redact/i.test(expr)) continue;
        const window = lines.slice(Math.max(0, index - 4), index + 1).join('\n');
        if (window.includes('NOT-OUTBOUND')) continue;
        offenders.push(`${file}:${index + 1}  ${expr}`);
      }
    });

    expect(offenders).toEqual([]);
  });

  it('the scan detects a raw interpolation when one exists', () => {
    // Proves the matcher above is not inert. Same regex, applied to a line
    // that a new emitter would plausibly write.
    const line = 'parts.push(`**Request:** ${ctx.method} ${ctx.url}`);';
    const flagged = (line.match(/\$\{[^}]*\}/g) || [])
      .filter((expr) => /url/i.test(expr) && !/redact/i.test(expr));
    expect(flagged).toEqual(['${ctx.url}']);
  });
});
