const { PassThrough } = require('stream');

// These tests drive the real `send-http-request` IPC handler end to end, because the SSE body fix
// (usebruno/bruno#8212, 79504ed72) is three lines of wiring — collect on 'data', rebuild on
// 'close', never let the collector reach the renderer — and helper-level unit tests
// (index.spec.js) cannot tell whether those three lines are connected to anything.
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn(), removeHandler: jest.fn(), removeAllListeners: jest.fn() },
  app: {
    getPath: () => require('os').tmpdir(),
    getName: () => 'gridman',
    getVersion: () => '0.0.0',
    on: jest.fn()
  },
  shell: { openExternal: jest.fn() },
  BrowserWindow: class {},
  dialog: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false },
  session: { defaultSession: { cookies: { get: jest.fn(), set: jest.fn() } } }
}));

// Keeps the cookie jar off disk (and its 5s debounce timer out of the test run).
jest.mock('../../src/store/cookies', () => ({
  cookiesStore: { saveCookieJar: jest.fn() }
}));

// The response the stubbed axios instance resolves with; each test swaps in its own stream.
let mockResponseStream;

jest.mock('../../src/ipc/network/axios-instance', () => ({
  makeAxiosInstance: () => {
    const instance = () => {
      const { AxiosHeaders } = require('axios');
      return Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders({ 'content-type': 'text/event-stream' }),
        data: mockResponseStream,
        config: {},
        request: { protocol: 'http:', host: 'example.com', path: '/sse' },
        timeline: []
      });
    };
    instance.defaults = { headers: { common: {} } };
    instance.interceptors = { request: { use: jest.fn() }, response: { use: jest.fn() } };
    return instance;
  }
}));

const { ipcMain } = require('electron');
const registerNetworkIpc = require('../../src/ipc/network/index');
const { MAX_SSE_BODY_BYTES } = require('../../src/ipc/network/index');

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
};

describe('send-http-request: SSE body wiring (GitHub #8212)', () => {
  let sent;
  let handler;
  let warnSpy;

  // Runs the post-response script under the developer sandbox so it executes as plain node code;
  // the script copies res.getBody() into an env var, which reaches us as a
  // `main:script-environment-update` payload. That is the only place where "what a script sees"
  // is observable from outside the main process.
  const buildFixtures = (responseScript) => {
    const item = {
      uid: 'item-1',
      name: 'stream events',
      type: 'http-request',
      pathname: '/tmp/collection/sse.bru',
      request: {
        method: 'GET',
        url: 'http://example.com/sse',
        headers: [],
        params: [],
        body: { mode: 'none' },
        auth: { mode: 'none' },
        script: { res: responseScript },
        vars: {},
        assertions: []
      }
    };

    const collection = {
      uid: 'coll-1',
      pathname: '/tmp/collection',
      name: 'coll',
      brunoConfig: {},
      root: {},
      items: [item],
      securityConfig: { jsSandboxMode: 'developer' }
    };

    return { item, collection, environment: { name: 'Env', variables: [] } };
  };

  const eventsOn = (channel) => sent.filter(([ch]) => ch === channel).map(([, payload]) => payload);

  const scriptEnvVars = () => {
    const updates = eventsOn('main:script-environment-update');
    return updates.length ? updates[updates.length - 1].envVariables : null;
  };

  beforeEach(() => {
    sent = [];
    ipcMain.handle.mockClear();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mainWindow = { webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
    registerNetworkIpc(mainWindow);
    handler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'send-http-request')[1];

    mockResponseStream = new PassThrough();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('collects chunks off the stream and rebuilds the body scripts read on close', async () => {
    const { item, collection, environment } = buildFixtures('bru.setEnvVar(\'seen\', res.getBody())');

    const response = await handler({}, item, collection, environment, {});
    expect(response.status).toBe(200);

    mockResponseStream.write('data: one\n\n');
    mockResponseStream.write('data: two\n\n');
    mockResponseStream.end();

    await waitFor(() => scriptEnvVars()?.seen !== undefined);

    // Before the fix res.getBody() was '' for every event-stream response.
    expect(scriptEnvVars().seen).toBe('data: one\n\ndata: two\n\n');
  });

  it('still gives scripts an empty body when the stream carried no events', async () => {
    const { item, collection, environment } = buildFixtures('bru.setEnvVar(\'seen\', res.getBody())');

    await handler({}, item, collection, environment, {});

    mockResponseStream.end();

    await waitFor(() => scriptEnvVars()?.seen !== undefined);
    expect(scriptEnvVars().seen).toBe('');
  });

  it('never puts the chunk collector on the object handed back over IPC', async () => {
    const { item, collection, environment } = buildFixtures('bru.setEnvVar(\'seen\', res.getBody())');

    const response = await handler({}, item, collection, environment, {});

    mockResponseStream.write('data: one\n\n');
    mockResponseStream.end();
    await waitFor(() => scriptEnvVars()?.seen !== undefined);

    // The renderer structured-clones this object, and bru.runRequest / the runner hand the very
    // same object to user scripts — a collector riding along would be copied, chunks and all.
    expect(response).not.toHaveProperty('sseBody');
    expect(Object.values(response).some((value) => value && value.chunks)).toBe(false);
  });

  it('announces truncation on the console and on the stream-end event', async () => {
    const { item, collection, environment } = buildFixtures('bru.setEnvVar(\'len\', String(res.getBody().length))');

    await handler({}, item, collection, environment, {});

    // One chunk larger than the whole cap: the prefix is kept, the rest is dropped.
    mockResponseStream.write(Buffer.alloc(MAX_SSE_BODY_BYTES + 1024, 0x61));
    mockResponseStream.end();

    await waitFor(() => scriptEnvVars()?.len !== undefined);

    expect(scriptEnvVars().len).toBe(String(MAX_SSE_BODY_BYTES));

    // Surface 1: the console panel, the moment the cap is hit rather than at close.
    const warnings = eventsOn('main:console-log').filter((entry) => entry.type === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].args[0]).toContain('stream events');
    expect(warnings[0].args[0]).toContain(`${MAX_SSE_BODY_BYTES} byte`);

    // Surface 2: the stream-end event the renderer already listens to.
    expect(eventsOn('main:http-stream-end')[0].truncated).toBe(true);
  });

  it('reports a complete body as not truncated', async () => {
    const { item, collection, environment } = buildFixtures('bru.setEnvVar(\'seen\', res.getBody())');

    await handler({}, item, collection, environment, {});

    mockResponseStream.write('data: one\n\n');
    mockResponseStream.end();

    await waitFor(() => scriptEnvVars()?.seen !== undefined);

    expect(eventsOn('main:console-log').filter((entry) => entry.type === 'warn')).toHaveLength(0);
    expect(eventsOn('main:http-stream-end')[0].truncated).toBe(false);
  });
});
