/**
 * AI TRAFFIC HONOURS THE APP PROXY, OR DOES NOT LEAVE.
 *
 * Every other request in this app goes through the agents in
 * utils/proxy-util.js. The AI SDKs use global `fetch`, which honours nothing
 * from `preferences.proxy` — so on a restricted corporate network the AI
 * feature either failed for no visible reason or egressed outside the audited
 * path while everything else stayed inside it.
 *
 * The judgement call, made FAIL-CLOSED: when a proxy is configured and we
 * cannot route through it (PAC, SOCKS, or no dispatcher available), the
 * request is refused rather than sent direct.
 */

const mockOpenaiFactory = jest.fn();
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args) => {
    mockOpenaiFactory(...args);
    const model = (id) => ({ __sdk: 'openai', id });
    model.chat = (id) => ({ __sdk: 'openai.chat', id });
    return model;
  }
}));
jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (id) => ({ __sdk: 'anthropic', id })
}));

let mockStoreData = {};
jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: (key, fallback) => (key in mockStoreData ? mockStoreData[key] : fallback),
    set: (key, value) => {
      mockStoreData[key] = value;
    }
  }));
});

const {
  resolveAiProxy,
  getAiFetch,
  clearAiFetchCache,
  ENV_PROXY_VARS
} = require('../../src/ipc/ai/proxy');
const { getModel, clearSdkCache, validateApiKeyForProvider } = require('../../src/ipc/ai/providers');

const ENDPOINT = {
  id: 'corp',
  name: 'Corp LLM',
  baseURL: 'https://llm.corp.internal/v1',
  enabled: true,
  models: [{ id: 'm', label: 'Qwen', modelId: 'qwen' }]
};
const MODEL_ID = 'openai-compatible:corp::m';

const aiPrefs = {
  enabled: true,
  providers: {},
  models: {},
  openaiCompatibleEndpoints: [ENDPOINT]
};

const withProxy = (proxy) => {
  mockStoreData.preferences = { proxy, ai: aiPrefs };
  clearAiFetchCache();
  clearSdkCache();
};

const manualProxy = (overrides = {}) => ({
  source: 'manual',
  config: { protocol: 'http', hostname: 'proxy.corp.internal', port: 8080, auth: {}, ...overrides }
});

let savedEnv;
let fetchSpy;

beforeEach(() => {
  mockStoreData = {};
  mockOpenaiFactory.mockClear();
  clearAiFetchCache();
  clearSdkCache();
  savedEnv = {};
  for (const name of ENV_PROXY_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fetchSpy.mockRestore();
});

describe('resolveAiProxy', () => {
  it('goes direct when the proxy is disabled', () => {
    withProxy({ disabled: true, source: 'manual', config: { hostname: 'proxy.corp.internal', port: 8080 } });
    expect(resolveAiProxy()).toEqual({ mode: 'direct' });
  });

  it('goes direct when a manual proxy has no hostname', () => {
    withProxy({ source: 'manual', config: { protocol: 'http', hostname: '', port: null } });
    expect(resolveAiProxy()).toEqual({ mode: 'direct' });
  });

  it('builds a proxy url from a manual configuration', () => {
    withProxy(manualProxy());
    expect(resolveAiProxy()).toMatchObject({ mode: 'proxy', url: 'http://proxy.corp.internal:8080' });
  });

  it('sends proxy credentials as a header, never inside the url', () => {
    withProxy(manualProxy({ auth: { username: 'alice', password: 'hunter2' } }));
    const resolved = resolveAiProxy();
    expect(resolved.url).not.toContain('hunter2');
    expect(resolved.token).toBe(`Basic ${Buffer.from('alice:hunter2').toString('base64')}`);
  });

  it('inherits an environment proxy', () => {
    withProxy({ source: 'inherit' });
    process.env.HTTPS_PROXY = 'http://env-proxy.corp.internal:3128';
    expect(resolveAiProxy()).toMatchObject({ mode: 'proxy', url: 'http://env-proxy.corp.internal:3128' });
  });

  it('goes direct on inherit when the environment names no proxy', () => {
    withProxy({ source: 'inherit' });
    expect(resolveAiProxy()).toEqual({ mode: 'direct' });
  });

  it('REFUSES a PAC configuration rather than bypassing it', () => {
    withProxy({ source: 'pac', pac: { source: 'http://wpad/proxy.pac' } });
    expect(resolveAiProxy()).toMatchObject({ mode: 'refuse', reason: expect.stringMatching(/PAC/i) });
  });

  it('REFUSES a SOCKS proxy rather than bypassing it', () => {
    withProxy(manualProxy({ protocol: 'socks5' }));
    expect(resolveAiProxy()).toMatchObject({ mode: 'refuse', reason: expect.stringMatching(/socks/i) });
  });
});

describe('models are built with the proxy routing applied', () => {
  it('passes no custom fetch when no proxy applies', () => {
    withProxy({ source: 'inherit' });
    getModel(MODEL_ID, { aiPreferences: aiPrefs, getApiKey: () => null });
    expect(mockOpenaiFactory.mock.calls[0][0].fetch).toBeUndefined();
  });

  it('hands the SDK a fetch that carries a dispatcher when a proxy is configured', async () => {
    withProxy(manualProxy());
    getModel(MODEL_ID, { aiPreferences: aiPrefs, getApiKey: () => null });

    const passedFetch = mockOpenaiFactory.mock.calls[0][0].fetch;
    expect(typeof passedFetch).toBe('function');

    await passedFetch('https://llm.corp.internal/v1/chat/completions', { method: 'POST' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://llm.corp.internal/v1/chat/completions',
      expect.objectContaining({ method: 'POST', dispatcher: expect.anything() })
    );
  });

  it('REFUSES to build a model at all when the proxy cannot be honoured', () => {
    withProxy({ source: 'pac', pac: { source: 'http://wpad/proxy.pac' } });
    expect(() => getModel(MODEL_ID, { aiPreferences: aiPrefs, getApiKey: () => null }))
      .toThrow(/PAC/i);
    // Nothing was constructed, so nothing could have been sent.
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
  });

  it('refuses the reachability test on the same terms', async () => {
    withProxy(manualProxy({ protocol: 'socks5' }));
    await expect(validateApiKeyForProvider({
      providerId: 'openai-compatible:corp',
      apiKey: null,
      aiPreferences: aiPrefs
    })).rejects.toThrow(/socks/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes the reachability test through the proxy too', async () => {
    withProxy(manualProxy());
    await validateApiKeyForProvider({
      providerId: 'openai-compatible:corp',
      apiKey: null,
      aiPreferences: aiPrefs
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://llm.corp.internal/v1/models',
      expect.objectContaining({ dispatcher: expect.anything() })
    );
  });

  it('rebuilds the SDK when the proxy changes', () => {
    withProxy({ source: 'inherit' });
    getModel(MODEL_ID, { aiPreferences: aiPrefs, getApiKey: () => null });
    expect(mockOpenaiFactory).toHaveBeenCalledTimes(1);

    // Only the proxy changed; the endpoint and key are identical. A cache keyed
    // without the routing would hand back the direct SDK.
    mockStoreData.preferences = { proxy: manualProxy(), ai: aiPrefs };
    clearAiFetchCache();
    getModel(MODEL_ID, { aiPreferences: aiPrefs, getApiKey: () => null });

    expect(mockOpenaiFactory).toHaveBeenCalledTimes(2);
    expect(typeof mockOpenaiFactory.mock.calls[1][0].fetch).toBe('function');
  });
});

/**
 * RELEASE TRIPWIRE — undici must stay reachable, and must stay DECLARED.
 *
 * The proxy path above REFUSES when undici cannot be loaded. That is correct
 * (going direct would be the leak) but it means losing undici takes AI out
 * entirely — for exactly the restricted-network customer this feature exists
 * for, whose proxy is never optional. Nothing in a normal test run would
 * notice, because every other suite mocks the SDKs.
 *
 * It used to arrive only transitively —
 * `bruno-electron -> @usebruno/js -> cheerio -> undici` — so a cheerio bump
 * could have removed it. It is now a direct dependency of this package. Both
 * halves are pinned here: that it resolves, and that the manifest still asks
 * for it rather than relying on a hoist.
 */
describe('undici is reachable (release tripwire, see comment)', () => {
  it('resolves, so the proxy path has a dispatcher to build', () => {
    expect(() => require.resolve('undici')).not.toThrow();
    const { ProxyAgent } = require('undici');
    expect(typeof ProxyAgent).toBe('function');
  });

  it('is a declared dependency of bruno-electron, not a transitive one', () => {
    const manifest = require('../../package.json');
    expect(manifest.dependencies.undici).toEqual(expect.any(String));
  });
});
