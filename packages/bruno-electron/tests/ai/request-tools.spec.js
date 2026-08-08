/**
 * THE ASSISTANT CAN PROPOSE A REQUEST — AND ONLY PROPOSE IT.
 *
 * Before create_request/update_request existed, "create a request that calls X"
 * came back as a paragraph telling the user what to type, because every tool
 * the model had wrote text sections and none of them wrote a request.
 *
 * The property that has to hold now that it can: calling the tool must change
 * NOTHING. It records a proposal, the proposal rides out on
 * `main:ai-chat-complete`, and the renderer is the only thing that can act on
 * it — after the user accepts. These drive the real IPC handler with a stubbed
 * model so the tools run exactly as they do in the app.
 */

const mockListeners = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    on: (channel, handler) => mockListeners.set(channel, handler),
    handle: jest.fn()
  }
}));
jest.mock('electron-store', () =>
  jest.fn().mockImplementation(() => ({ get: (_k, fallback) => fallback, set: jest.fn() }))
);

// The stub stands in for the provider: it runs whatever tool calls the test
// scripted, then ends the stream. `tools` is captured so assertions can reach
// the real execute() bodies from chat.js.
let mockScriptedCalls = [];
let mockCapturedTools = null;
jest.mock('ai', () => ({
  stepCountIs: jest.fn(),
  streamText: ({ tools }) => {
    mockCapturedTools = tools;
    return {
      fullStream: (async function* run() {
        for (const call of mockScriptedCalls) {
          await tools[call.name].execute(call.input);
          yield { type: 'tool-call', toolName: call.name, input: call.input };
          yield { type: 'tool-result', toolName: call.name };
        }
        yield { type: 'text-delta', text: 'done' };
      })()
    };
  }
}));

const registerChatIpc = require('../../src/ipc/ai/chat');

const sent = [];
const mainWindow = {
  webContents: { send: (channel, data) => sent.push({ channel, data }), isDestroyed: () => false }
};

const runTurn = async (calls, payloadOverrides = {}) => {
  mockScriptedCalls = calls;
  sent.length = 0;
  const handler = mockListeners.get('renderer:ai-chat-stream');
  await handler(null, {
    requestId: 'req-1',
    messages: [{ role: 'user', content: 'go' }],
    allContent: {},
    contentType: 'docs',
    ...payloadOverrides
  });
  return sent.find((m) => m.channel === 'main:ai-chat-complete')?.data;
};

beforeAll(() => {
  registerChatIpc({
    mainWindow,
    isAiEnabled: () => true,
    resolveModel: () => ({ modelId: 'test-model' }),
    pickDefaultModelId: () => 'test-model'
  });
});

describe('create_request', () => {
  it('proposes a request instead of performing one', async () => {
    const complete = await runTurn([
      {
        name: 'create_request',
        input: {
          name: 'Tehran Weather',
          method: 'GET',
          url: 'https://api.open-meteo.com/v1/forecast?latitude=35.6892&longitude=51.3890'
        }
      }
    ]);

    expect(complete.requestChanges).toHaveLength(1);
    expect(complete.requestChanges[0]).toMatchObject({
      op: 'create',
      name: 'Tehran Weather',
      method: 'GET'
    });
    // Nothing else went out: no write channel, no file event, no side effect
    // the main process could have performed on its own.
    const channels = sent.map((m) => m.channel);
    expect(channels).not.toContain('main:collection-tree-updated');
  });

  it('tells the model the user still has to accept', async () => {
    const result = await mockCapturedTools.create_request.execute({
      name: 'X',
      method: 'GET',
      url: 'https://example.test'
    });
    // If the tool result claimed the request existed, the model would go on to
    // write tests "for the request it just created".
    expect(result).toMatch(/review/i);
    expect(result).not.toMatch(/\bcreated\b/i);
  });
});

describe('update_request', () => {
  it('carries only the fields the model actually set', async () => {
    // The renderer only builds a requestContext when a request is open, so its
    // presence IS "a request is open" — there is no `kind` field to test, and
    // an earlier version of this suite passed against one that never existed.
    const complete = await runTurn(
      [{ name: 'update_request', input: { url: 'https://example.test/v2' } }],
      { requestContext: { method: 'GET', url: 'https://example.test/v1', headers: [] } }
    );

    expect(complete.requestChanges).toHaveLength(1);
    expect(complete.requestChanges[0]).toEqual({ op: 'update', url: 'https://example.test/v2' });
    // Absent, not null: the renderer treats `undefined` as "leave alone", so a
    // null here would clear the user's method.
    expect(complete.requestChanges[0]).not.toHaveProperty('method');
  });

  it('refuses when no request is open', async () => {
    // What a folder or collection chat actually sends: null. Not an object with
    // a discriminator on it.
    const complete = await runTurn(
      [{ name: 'update_request', input: { url: 'https://example.test' } }],
      { requestContext: null }
    );
    expect(complete.requestChanges).toBeUndefined();
  });

  it('refuses an empty change rather than proposing a no-op', async () => {
    const complete = await runTurn([{ name: 'update_request', input: {} }], {
      requestContext: { method: 'GET', url: 'https://example.test', headers: [] }
    });
    expect(complete.requestChanges).toBeUndefined();
  });
});

describe('the schema is the boundary', () => {
  it('accepts only none/inherit for auth — credentials cannot be set from a prompt', () => {
    const schema = mockCapturedTools.update_request.inputSchema;
    expect(schema.safeParse({ auth: { mode: 'inherit' } }).success).toBe(true);
    // The model cannot see a real credential (redaction), so anything it put
    // here would be a guess that sends the request with the wrong identity.
    expect(schema.safeParse({ auth: { mode: 'bearer', token: 'sk-live-x' } }).success).toBe(false);
    expect(schema.safeParse({ auth: { mode: 'basic' } }).success).toBe(false);
  });

  it('rejects a method outside the HTTP verb list', () => {
    const schema = mockCapturedTools.update_request.inputSchema;
    expect(schema.safeParse({ method: 'GET' }).success).toBe(true);
    expect(schema.safeParse({ method: 'TRACE' }).success).toBe(false);
  });

  it('requires a name, method and url to create anything', () => {
    const schema = mockCapturedTools.create_request.inputSchema;
    expect(schema.safeParse({ name: 'a', method: 'GET', url: 'https://x.test' }).success).toBe(true);
    expect(schema.safeParse({ name: 'a', method: 'GET' }).success).toBe(false);
  });
});

describe('proposals travel with text writes', () => {
  it('sends both in ONE completion', async () => {
    const complete = await runTurn([
      { name: 'create_request', input: { name: 'A', method: 'GET', url: 'https://x.test' } },
      { name: 'read_content', input: { type: 'docs' } },
      { name: 'write_content', input: { type: 'docs', content: '# A' } }
    ]);

    // Two completions for one requestId would race in the renderer and one of
    // the two sets of cards would be lost.
    expect(sent.filter((m) => m.channel === 'main:ai-chat-complete')).toHaveLength(1);
    expect(complete.requestChanges).toHaveLength(1);
    expect(complete.writes).toHaveLength(1);
  });
});

/**
 * The workflow tools follow the same propose-only contract. The extra property
 * here is `wasRead`: write_workflow REPLACES the flow, so a model that skipped
 * read_workflow is about to delete steps it never saw, and the renderer needs
 * to know that in order to refuse the apply.
 */
describe('workflow tools', () => {
  const WORKFLOW = {
    name: 'Nightly',
    exact: true,
    steps: [{ type: 'request', name: 'Login', ref: { collection: '/c', request: '/c/login.bru' } }]
  };

  it('reads the open workflow as a step list', async () => {
    await runTurn([{ name: 'read_workflow', input: {} }], { workflow: WORKFLOW, contentType: 'workflow' });
    const result = await mockCapturedTools.read_workflow.execute({});
    expect(JSON.parse(result)).toEqual(WORKFLOW.steps);
  });

  it('proposes a replacement without saving it', async () => {
    const complete = await runTurn(
      [
        { name: 'read_workflow', input: {} },
        { name: 'write_workflow', input: { steps: [{ type: 'delay', name: 'Wait', durationMs: 1000 }] } }
      ],
      { workflow: WORKFLOW, contentType: 'workflow' }
    );

    expect(complete.workflowChanges).toHaveLength(1);
    expect(complete.workflowChanges[0].steps).toEqual([{ type: 'delay', name: 'Wait', durationMs: 1000 }]);
    // Carried so the card can show what is being replaced.
    expect(complete.workflowChanges[0].originalSteps).toEqual(WORKFLOW.steps);
    expect(complete.workflowChanges[0].wasRead).toBe(true);
  });

  it('flags a write that skipped the read, because a replacement drops what it never saw', async () => {
    const complete = await runTurn(
      [{ name: 'write_workflow', input: { steps: [{ type: 'delay', durationMs: 1 }] } }],
      { workflow: WORKFLOW, contentType: 'workflow' }
    );
    expect(complete.workflowChanges[0].wasRead).toBe(false);
  });

  it('does nothing on a tab with no workflow', async () => {
    const complete = await runTurn(
      [{ name: 'write_workflow', input: { steps: [{ type: 'delay', durationMs: 1 }] } }],
      { workflow: null }
    );
    expect(complete.workflowChanges).toBeUndefined();
  });

  it('rejects a step type that does not exist', () => {
    const schema = mockCapturedTools.write_workflow.inputSchema;
    expect(schema.safeParse({ steps: [{ type: 'delay', durationMs: 5 }] }).success).toBe(true);
    // 'start' included: Gridman always adds exactly one, and a model emitting a
    // second would produce a workflow with two entry points.
    expect(schema.safeParse({ steps: [{ type: 'start' }] }).success).toBe(false);
    expect(schema.safeParse({ steps: [{ type: 'webhook' }] }).success).toBe(false);
  });
});
