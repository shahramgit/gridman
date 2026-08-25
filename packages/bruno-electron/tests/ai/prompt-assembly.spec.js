/**
 * The one string this app actually sends.
 *
 * The enumerating suite (outbound-chokepoint.spec.js) covers every EXPORTED
 * formatter. This one covers the assembled prompt, so a private helper inside
 * a prompt module — which is exactly what autocomplete-prompts.js had, and how
 * it reproduced two already-closed findings — is caught too.
 *
 *   chat  buildContextMessage  -> streamText({ messages[0] })
 *
 * There used to be three. Script generation's `buildScriptUserPrompt` went
 * with `renderer:ai-generate-script` and the AIAssist component it served;
 * autocomplete's `buildUserPrompt` went with `renderer:ai-autocomplete` and
 * `renderer:ai-autocomplete-cancel`, which had no caller in
 * packages/bruno-app/src at all. One prompt ships, so one prompt is asserted
 * on here.
 *
 * Everything runs with STRICT (default) preferences, which is the
 * configuration the finding was verified under.
 */

jest.mock('electron', () => ({
  ipcMain: { on: jest.fn(), handle: jest.fn() }
}));
jest.mock('electron-store', () =>
  jest.fn().mockImplementation(() => ({ get: (_k, fallback) => fallback, set: jest.fn() }))
);

const { buildContextMessage } = require('../../src/ipc/ai/chat');

const SECRETS = {
  userinfo: 'hunter2-USERINFO-LEAK',
  pathSegment: 'sk-live-PATHSEGMENTLEAK00',
  queryValue: 'sk-live-QUERYVALUELEAK00',
  semicolonValue: 'sk-live-SEMICOLONLEAK000',
  fragment: 'sk-live-FRAGMENTLEAK0000',
  header: 'sk-live-HEADERLEAK000000',
  jsonBody: 'sk-live-JSONBODYLEAK0000',
  variable: 'sk-live-VARIABLELEAK0000',
  response: 'sk-live-RESPONSELEAK0000',
  // Credential-shaped VALUES under innocuous NAMES. The shape detector used to
  // run on URL components only, so these reached the model through the tables
  // the formatters print, in the prompt this app actually sends.
  innocuousHeader: 'sk-live-HEADERSHAPELEAK0',
  innocuousJson: 'sk-live-JSONSHAPELEAK000',
  // The NAME axis: a credential sitting in a header name, a JSON body key, a
  // response key or a variable name. Every emitter used to copy those through
  // verbatim while masking the value beside them.
  headerName: 'sk-live-HEADERNAMELEAK00',
  jsonKey: 'sk-live-JSONKEYLEAK00000',
  responseKey: 'sk-live-RESPKEYLEAK00000',
  variableName: 'sk-live-VARNAMELEAK00000'
};
// Every entry above is planted in the payload below. A sentinel that appears
// in no payload is a free pass for `expectNoLeak`, so there are none.
const ALL_SECRETS = Object.values(SECRETS);

const LEAKY_URL
  = `https://alice:${SECRETS.userinfo}@hooks.internal.example`
    + `/services/${SECRETS.pathSegment}/deliver`
    + `?api_key=${SECRETS.queryValue};handle=${SECRETS.semicolonValue}&page=2`
    + `#access_token=${SECRETS.fragment}`;

const jsonRequestContext = () => ({
  method: 'POST',
  url: LEAKY_URL,
  headers: [
    { name: 'X-Api-Key', value: SECRETS.header, enabled: true },
    { name: 'X-Trace-Id', value: SECRETS.innocuousHeader, enabled: true },
    { name: `X-${SECRETS.headerName}`, value: 'relay', enabled: true }
  ],
  params: [],
  body: {
    mode: 'json',
    json: `{"client_secret":"${SECRETS.jsonBody}","session":"${SECRETS.innocuousJson}","${SECRETS.jsonKey}":"1","plan":"pro"}`
  },
  responseStatus: 200,
  responseData: { access_token: SECRETS.response, [SECRETS.responseKey]: 1 }
});

const variables = () => [
  { name: 'API_TOKEN', value: SECRETS.variable, scope: 'env', secret: false },
  { name: SECRETS.variableName, value: 'x', scope: 'env', secret: false },
  { name: 'BASE_URL', value: 'https://api.example.com', scope: 'env', secret: false }
];

const expectNoLeak = (out) => {
  expect(typeof out).toBe('string');
  expect(out.length).toBeGreaterThan(0);
  for (const secret of ALL_SECRETS) expect(out).not.toContain(secret);
};

describe('chat buildContextMessage — the message prepended to EVERY conversation', () => {
  const build = () => buildContextMessage(
    'tests',
    { tests: 'test("existing", () => {});' },
    jsonRequestContext(),
    variables(),
    null, // strict defaults
    [{
      name: 'Deliver',
      method: 'POST',
      url: LEAKY_URL,
      pathname: '/coll/Hooks/Deliver.bru',
      folderPath: 'Hooks',
      type: 'http-request'
    }]
  );

  it('leaks nothing through the inlined collection preview', () => {
    const out = build();
    expectNoLeak(out);
    // Non-vacuous: the preview is there, and it is the no-tool-call path the
    // finding called out as the common one.
    expect(out).toContain('Requests in this collection');
    expect(out).toContain('POST Hooks/Deliver');
    expect(out).toContain('hooks.internal.example');
  });

  it('leaks nothing through the inlined request context or response', () => {
    const out = build();
    expect(out).toContain('HTTP Request Context');
    expect(out).toContain('Response Shape');
    expect(out).not.toContain(SECRETS.response);
  });

  /**
   * The deliberate boundary of the chokepoint, pinned so it cannot be widened
   * by accident.
   *
   * The model is asked to return the COMPLETE updated file. If we rewrote a URL
   * inside the user's existing code, the model would hand `<redacted>` straight
   * back and it would be written into their script — data loss dressed up as
   * redaction. So the user's own content is forwarded verbatim, and that is
   * listed as a verbatim channel in the README instead of being papered over.
   */
  it('does NOT rewrite the user\'s own code — that would corrupt what comes back', () => {
    const code = 'const u = "https://api.example.com/v1?api_key=" + bru.getEnvVar("k");';
    const out = buildContextMessage('tests', { tests: code }, null, [], null, []);
    expect(out).toContain(code);
    expect(out).not.toContain('api_key=<redacted>');
  });
});
