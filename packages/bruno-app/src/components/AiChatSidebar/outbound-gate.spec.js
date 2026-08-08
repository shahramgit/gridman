/**
 * THE OUTBOUND GATE.
 *
 * The previous round fixed the URL in one emitter and three others kept
 * leaking, so this suite is written to fail when a NEW emitter is added and
 * not routed through the gate — not to enumerate today's known leaks.
 *
 * Three layers, each of which must fail on its own:
 *
 *  1. REGISTRY COVERAGE — every exported function whose name marks it as a
 *     formatter/emitter must appear in EMITTERS below. Add
 *     `export const formatWhatever = …` to the slice and forget it here and
 *     this suite fails naming the export.
 *  2. PER-EMITTER FIXTURE — each registered emitter is driven with a fixture
 *     carrying the known secrets and its output must contain none of them.
 *     Each is also required to show evidence it actually consumed the fixture
 *     (a redaction marker in its output), so a formatter that silently ignores
 *     its input cannot pass by returning nothing.
 *  3. THE EXIT — `sendAiMessage` is now the ONLY way this renderer can reach a
 *     provider (`aiGenerateScript` went with the AIAssist surface it served).
 *     It is driven with a hand-rolled context that never touched a builder, and
 *     with a context key that does not exist yet, and the payload that crosses
 *     IPC must be clean. A test below asserts the module exports no second exit.
 */
import { configureStore } from '@reduxjs/toolkit';

jest.mock('utils/collections', () => {
  const actual = jest.requireActual('utils/collections');
  return { ...actual, getAllVariables: jest.fn(() => ({})) };
});
jest.mock('idb', () => ({ openDB: jest.fn(() => Promise.resolve(null)) }));

const { getAllVariables } = require('utils/collections');
const slice = require('providers/ReduxStore/slices/ai');

const {
  REDACTED_PLACEHOLDER,
  AI_BODY_OMITTED_NOTICE,
  OUTBOUND_VERBATIM_KEYS,
  scrubAiOutboundPayload,
  sendAiMessage,
  default: aiReducer
} = slice;

/**
 * Every string here must be absent from anything that crosses IPC. They cover
 * each detection route: vendor prefix, JWT, long hex, uuid, opaque bearer,
 * userinfo password, and a value sitting under a credential-shaped NAME.
 */
const SECRETS = {
  vendorKey: 'sk-live-AAAABBBBCCCCDDDD',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl',
  hex: '0123456789abcdef0123456789abcdef',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  opaque: 'Ab3xY9zQ1mN7pR4tV6wK2sJ8',
  userinfoPassword: 'p4ssw0rd',
  namedValue: 'hunter2'
};

const secretValues = Object.values(SECRETS);

const expectNoSecrets = (label, value) => {
  const serialized = JSON.stringify(value ?? null);
  for (const [name, secret] of Object.entries(SECRETS)) {
    if (serialized.includes(secret)) {
      throw new Error(`${label} leaked the ${name} fixture: ${serialized}`);
    }
  }
};

const REDACTION_MARKERS = [REDACTED_PLACEHOLDER, AI_BODY_OMITTED_NOTICE];

const expectFixtureWasConsumed = (label, value) => {
  const serialized = JSON.stringify(value ?? null);
  const consumed = REDACTION_MARKERS.some((marker) => serialized.includes(marker));
  if (!consumed) {
    throw new Error(
      `${label} produced no redaction marker, so the fixture never reached it — `
      + `this assertion would be vacuous. Output: ${serialized}`
    );
  }
};

const leakyUrl = `//svc:${SECRETS.userinfoPassword}@api.internal.example/v1/keys/${SECRETS.vendorKey}?t=${SECRETS.jwt}`;

const leakyRequest = {
  request: {
    method: 'POST',
    url: leakyUrl,
    headers: [
      { name: 'Authorization', value: `Bearer ${SECRETS.jwt}`, enabled: true },
      { name: 'X-Corp-Ticket', value: SECRETS.opaque, enabled: true }
    ],
    params: [{ name: 'sid', value: SECRETS.uuid, enabled: true, type: 'query' }],
    body: { mode: 'json', json: `{"pw":"${SECRETS.namedValue}","q":"${SECRETS.vendorKey}"}` }
  },
  response: { status: 200, data: { session: SECRETS.hex } }
};

const leakyContext = {
  method: 'POST',
  url: leakyUrl,
  headers: [{ name: 'X-Api-Key', value: SECRETS.vendorKey, enabled: true }],
  params: [{ name: 'sid', value: SECRETS.uuid, enabled: true }],
  body: { mode: 'json', json: `{"pw":"${SECRETS.namedValue}"}` },
  responseData: { token: SECRETS.hex }
};

const leakyCollection = {
  items: [
    {
      uid: 'r1',
      type: 'http-request',
      name: 'Legacy',
      pathname: '/c/Legacy.bru',
      request: { method: 'GET', url: leakyUrl }
    }
  ]
};

/**
 * name -> how to drive it with the fixture. Registry coverage is asserted
 * against the module's real exports below, so this cannot silently fall
 * behind the module.
 */
const EMITTERS = {
  redactUrlForAi: () => slice.redactUrlForAi(leakyUrl),
  sanitizeAiRequestBody: () => slice.sanitizeAiRequestBody(leakyRequest.request.body),
  sanitizeAiRequestContext: () => slice.sanitizeAiRequestContext(leakyContext),
  buildAiRequestContext: () => slice.buildAiRequestContext(leakyRequest),
  buildAiRequestsPayload: () => slice.buildAiRequestsPayload(leakyCollection),
  buildAiVariablesPayload: () => {
    getAllVariables.mockReturnValue({
      API_TOKEN: SECRETS.vendorKey,
      innocuous_name: SECRETS.jwt,
      pw: SECRETS.namedValue
    });
    return slice.buildAiVariablesPayload({}, null, false);
  },
  scrubOutboundText: () => slice.scrubOutboundText(`prefix ${SECRETS.vendorKey} suffix ${SECRETS.jwt}`),
  scrubAiOutbound: () => slice.scrubAiOutbound(leakyContext, 'requestContext'),
  scrubAiOutboundPayload: () => slice.scrubAiOutboundPayload({ requestContext: leakyContext })
};

// Anything exported under one of these prefixes formats or emits outbound
// context and therefore needs an entry above.
const EMITTER_NAME_RE = /^(build|sanitize|redact|format|scrub)/;

describe('outbound gate — registry coverage', () => {
  const exportedEmitterNames = Object.keys(slice)
    .filter((name) => typeof slice[name] === 'function')
    .filter((name) => EMITTER_NAME_RE.test(name))
    .sort();

  it('finds emitters to check at all', () => {
    // Guards the two layers below from becoming a loop over an empty list.
    expect(exportedEmitterNames.length).toBeGreaterThanOrEqual(9);
  });

  it('has every exported emitter registered with a fixture', () => {
    const unregistered = exportedEmitterNames.filter((name) => !EMITTERS[name]);
    expect(unregistered).toEqual([]);
  });

  it('registers nothing that the module no longer exports', () => {
    const stale = Object.keys(EMITTERS).filter((name) => typeof slice[name] !== 'function');
    expect(stale).toEqual([]);
  });
});

describe('outbound gate — every emitter redacts the fixture', () => {
  it.each(Object.keys(EMITTERS))('%s', (name) => {
    const out = EMITTERS[name]();
    expectFixtureWasConsumed(name, out);
    expectNoSecrets(name, out);
  });
});

describe('outbound gate — the verbatim escape hatch', () => {
  /**
   * The gate is default-deny: everything is scrubbed unless its key is on this
   * list. Widening the list is the only way to bypass the gate, so the list is
   * pinned here — adding a key fails this test and forces a reviewer to look.
   */
  it('is exactly the reviewed set of keys', () => {
    expect([...OUTBOUND_VERBATIM_KEYS].sort()).toEqual(
      ['allContent', 'contentType', 'docs', 'messages', 'model', 'requestId'].sort()
    );
  });

  /**
   * A key on this list is an exemption from redaction, so one that nothing
   * sends is not inert — it sits waiting for a future payload to reuse the name
   * and ship unscrubbed with nobody deciding that. `prompt`, `currentScript`,
   * `docsContext`, `scriptType`, `streamId` and `tabUid` all belonged to the
   * deleted generation surface; this pins that they stay gone.
   */
  it('exempts nothing left over from the deleted generation surface', () => {
    for (const key of ['prompt', 'currentScript', 'docsContext', 'scriptType', 'streamId', 'tabUid']) {
      expect(OUTBOUND_VERBATIM_KEYS.has(key)).toBe(false);
      const out = scrubAiOutboundPayload({ [key]: `leaked ${SECRETS.vendorKey}` });
      expectNoSecrets(`verbatim leftover ${key}`, out);
    }
  });

  it('scrubs a context key that does not exist yet', () => {
    // The property a future emitter depends on: it does not have to remember
    // to call anything, because unknown keys are scrubbed by default.
    const out = scrubAiOutboundPayload({
      someContextKeyInventedLater: { url: leakyUrl, note: SECRETS.vendorKey }
    });
    expectNoSecrets('unknown context key', out);
  });

  it('leaves the user\'s own words and the edit target alone', () => {
    const out = scrubAiOutboundPayload({
      messages: [{ role: 'user', content: `explain ${SECRETS.vendorKey}` }],
      allContent: { docs: `token: ${SECRETS.vendorKey}` }
    });
    expect(out.messages[0].content).toContain(SECRETS.vendorKey);
    expect(out.allContent.docs).toContain(SECRETS.vendorKey);
  });
});

describe('outbound gate — the IPC exit', () => {
  const makeStore = () =>
    configureStore({
      reducer: {
        ai: aiReducer,
        app: (state = { preferences: { ai: { enabled: true } } }) => state
      }
    });

  let send;
  let invoke;

  beforeEach(() => {
    send = jest.fn();
    invoke = jest.fn(() => Promise.resolve({ content: '' }));
    window.ipcRenderer = { send, invoke, on: jest.fn(() => jest.fn()) };
  });

  afterEach(() => {
    delete window.ipcRenderer;
  });

  it('scrubs a chat context that never went through a builder', () => {
    const store = makeStore();
    store.dispatch(
      sendAiMessage(
        'tab-1',
        'hello',
        {},
        // Hand-rolled: exactly the shape a future surface would assemble
        // inline, which is how the URL got out the first time.
        leakyContext,
        '',
        'docs',
        [{ name: 'innocuous_name', value: SECRETS.jwt, scope: 'env', secret: false }],
        [{ name: 'Legacy', method: 'GET', url: leakyUrl }]
      )
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0];
    expect(channel).toBe('renderer:ai-chat-stream');
    expectFixtureWasConsumed('renderer:ai-chat-stream', payload);
    expectNoSecrets('renderer:ai-chat-stream', payload);
    // One channel, one direction. `invoke` is wired up above precisely so a
    // second exit smuggled into the send path would show here rather than be
    // invisible for want of a mock.
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * The generation surface (components/AIAssist) and its two IPC exits are
   * gone. They were unredacted-adjacent passthroughs with no reachable caller,
   * and preload.js has no channel allowlist — so the only safe amount of them
   * is none. This fails if either export comes back without a review.
   */
  it('exposes no second way out', () => {
    expect(slice.aiGenerateScript).toBeUndefined();
    expect(slice.stopAiGeneration).toBeUndefined();

    const senders = Object.keys(slice).filter((name) => typeof slice[name] === 'function' && /^(ai|stop)/i.test(name));
    expect(senders.sort()).toEqual(['stopAiStream']);
  });

  it('still tells the model which endpoint it is looking at', () => {
    const store = makeStore();
    store.dispatch(sendAiMessage('tab-2', 'hello', {}, leakyContext, '', 'docs', [], []));
    const payload = send.mock.calls[0][1];
    expect(payload.requestContext.url).toContain('api.internal.example');
    expect(payload.requestContext.method).toBe('POST');
  });
});

describe('outbound gate — fixture sanity', () => {
  it('every fixture secret is detectable, so no assertion above is trivially true', () => {
    for (const secret of secretValues) {
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(6);
    }
    // Everything except the plain word must be catchable on shape alone; the
    // plain word is caught by its key name (`pw`) and is here to prove the
    // name route still runs.
    for (const [name, secret] of Object.entries(SECRETS)) {
      if (name === 'namedValue' || name === 'userinfoPassword') continue;
      expect(slice.looksLikeCredential(secret)).toBe(true);
    }
    expect(slice.looksLikeCredential(SECRETS.namedValue)).toBe(false);
  });
});
