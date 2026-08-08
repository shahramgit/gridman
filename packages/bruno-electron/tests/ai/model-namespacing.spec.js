/**
 * A CUSTOM MODEL MUST NEVER RESOLVE TO THE CLOUD.
 *
 * The failure this suite exists to prevent: a customer on a restricted network
 * proxies an internal model through an OpenAI-compatible gateway and names it
 * `gpt-4o` — the obvious name when you are proxying. The old lookup consulted
 * the built-in catalog FIRST, so the model was listed as belonging to their
 * internal endpoint and then resolved to api.openai.com. Their request URLs,
 * headers and bodies left the network.
 *
 * Custom model ids are now namespaced by endpoint
 * (`openai-compatible:<endpointId>::<modelId>`) and resolution is
 * endpoint-first, so the collision cannot be expressed at all.
 */

const mockOpenaiFactory = jest.fn();
const mockAnthropicFactory = jest.fn();

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args) => {
    mockOpenaiFactory(...args);
    const model = (modelId) => ({ __sdk: 'openai', modelId });
    model.chat = (modelId) => ({ __sdk: 'openai.chat', modelId });
    return model;
  }
}));

jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: (...args) => {
    mockAnthropicFactory(...args);
    return (modelId) => ({ __sdk: 'anthropic', modelId });
  }
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
  getModel,
  getAvailableModels,
  listModels,
  clearSdkCache,
  resolveModelDefinition,
  customModelId,
  isBuiltInModelId
} = require('../../src/ipc/ai/providers');
const { ENV_PROXY_VARS } = require('../../src/ipc/ai/proxy');

const noKeys = () => null;
const noKeysConfigured = () => false;

// The whole point: the internal endpoint serves a model the user called
// `gpt-4o`, which is also a built-in OpenAI model id.
const COLLIDING_ENDPOINT = {
  id: 'corp-llm',
  name: 'Corp LLM',
  baseURL: 'https://llm.corp.internal/v1',
  enabled: true,
  models: [{ id: 'gpt-4o', label: 'Internal GPT-4o proxy', modelId: 'internal-gpt4o' }]
};

const NAMESPACED = 'openai-compatible:corp-llm::gpt-4o';

const prefsWith = (endpoints, overrides = {}) => ({
  enabled: true,
  providers: { openai: { enabled: true }, anthropic: { enabled: true } },
  models: {},
  defaultModel: '',
  openaiCompatibleEndpoints: endpoints,
  ...overrides
});

let savedEnv;

beforeEach(() => {
  mockStoreData = {};
  mockOpenaiFactory.mockClear();
  mockAnthropicFactory.mockClear();
  clearSdkCache();
  // Keep the developer's shell proxy out of the SDK construction assertions.
  savedEnv = {};
  for (const name of ENV_PROXY_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('a custom model id can never collide with a built-in one', () => {
  it('publishes the custom model under a namespaced id, not the raw one', () => {
    const models = listModels(prefsWith([COLLIDING_ENDPOINT]));
    const custom = models.filter((m) => m.isCustom);

    expect(custom).toEqual([
      expect.objectContaining({
        id: NAMESPACED,
        rawId: 'gpt-4o',
        provider: 'openai-compatible:corp-llm'
      })
    ]);

    // And the built-in `gpt-4o` is still exactly one entry, owned by OpenAI.
    const gpt4o = models.filter((m) => m.id === 'gpt-4o');
    expect(gpt4o).toEqual([expect.objectContaining({ provider: 'openai', isCustom: false })]);

    // No id appears twice — the list the renderer picks from is unambiguous.
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves the namespaced id to the INTERNAL endpoint, never to OpenAI', () => {
    const aiPreferences = prefsWith([COLLIDING_ENDPOINT]);

    expect(resolveModelDefinition(NAMESPACED, aiPreferences)).toEqual({
      providerId: 'openai-compatible:corp-llm',
      sdkModelId: 'internal-gpt4o',
      label: 'Internal GPT-4o proxy',
      baseURL: 'https://llm.corp.internal/v1'
    });

    const model = getModel(NAMESPACED, { aiPreferences, getApiKey: noKeys });
    expect(model).toEqual({ __sdk: 'openai.chat', modelId: 'internal-gpt4o' });
    expect(mockOpenaiFactory).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://llm.corp.internal/v1' })
    );
    // createOpenAI without a baseURL defaults to https://api.openai.com/v1 —
    // that call must never have happened.
    const baseUrls = mockOpenaiFactory.mock.calls.map((call) => call[0].baseURL);
    expect(baseUrls).toEqual(['https://llm.corp.internal/v1']);
  });

  it('resolves even a BARE colliding id endpoint-first', () => {
    // A `defaultModel` written by hand, or carried over from an older build.
    const aiPreferences = prefsWith([COLLIDING_ENDPOINT]);

    expect(resolveModelDefinition('gpt-4o', aiPreferences)).toMatchObject({
      providerId: 'openai-compatible:corp-llm',
      sdkModelId: 'internal-gpt4o'
    });

    getModel('gpt-4o', { aiPreferences, getApiKey: () => 'sk-live-cloud-key' });
    expect(mockOpenaiFactory).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://llm.corp.internal/v1' })
    );
    // The cloud key was never handed to an SDK pointed at api.openai.com.
    expect(mockOpenaiFactory).toHaveBeenCalledTimes(1);
  });

  it('lists the colliding model as available under the internal endpoint only', () => {
    const available = getAvailableModels({
      aiPreferences: prefsWith([COLLIDING_ENDPOINT]),
      hasApiKey: noKeysConfigured
    });
    expect(available).toEqual([
      { id: NAMESPACED, label: 'Internal GPT-4o proxy', provider: 'openai-compatible:corp-llm' }
    ]);
  });

  it('refuses a bare id claimed by two endpoints instead of falling back to the cloud', () => {
    const aiPreferences = prefsWith([
      COLLIDING_ENDPOINT,
      { ...COLLIDING_ENDPOINT, id: 'other-llm', baseURL: 'https://other.corp.internal/v1' }
    ]);

    // Ambiguous: refuse. Falling through to MODEL_DEFINITIONS here would send
    // the request to OpenAI, which is the very outcome being prevented.
    expect(resolveModelDefinition('gpt-4o', aiPreferences)).toBeNull();
    expect(() => getModel('gpt-4o', { aiPreferences, getApiKey: () => 'sk-live-cloud-key' }))
      .toThrow(/Unknown model/i);
    expect(mockOpenaiFactory).not.toHaveBeenCalled();

    // Each is still reachable by its own namespaced id.
    expect(resolveModelDefinition(NAMESPACED, aiPreferences)).toMatchObject({
      baseURL: 'https://llm.corp.internal/v1'
    });
    expect(resolveModelDefinition('openai-compatible:other-llm::gpt-4o', aiPreferences)).toMatchObject({
      baseURL: 'https://other.corp.internal/v1'
    });
  });

  it('never retries a dangling namespaced id against the built-in catalog', () => {
    // The endpoint was deleted but a pinned `defaultModel` still names it.
    const aiPreferences = prefsWith([]);
    expect(resolveModelDefinition('openai-compatible:gone::gpt-4o', aiPreferences)).toBeNull();
    expect(() => getModel('openai-compatible:gone::gpt-4o', { aiPreferences, getApiKey: () => 'sk-live' }))
      .toThrow(/Unknown model/i);
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
  });

  it('ignores an endpoint whose id would make its model ids ambiguous', () => {
    // `::` in an endpoint id would break the namespace apart. savePreferences
    // rejects it; here the resolver refuses to guess.
    const aiPreferences = prefsWith([{ ...COLLIDING_ENDPOINT, id: 'a::b' }]);
    expect(listModels(aiPreferences).filter((m) => m.isCustom)).toEqual([]);
    expect(getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured })).toEqual([]);
    expect(resolveModelDefinition('gpt-4o', aiPreferences)).toMatchObject({ providerId: 'openai' });
  });

  it('builds ids the same way callers do', () => {
    expect(customModelId('corp-llm', 'gpt-4o')).toBe(NAMESPACED);
    expect(isBuiltInModelId(NAMESPACED)).toBe(false);
    expect(isBuiltInModelId('gpt-4o')).toBe(true);
  });
});

describe('per-model enable toggles survive the rename', () => {
  it('honours a toggle stored under the namespaced id', () => {
    const aiPreferences = prefsWith([COLLIDING_ENDPOINT], {
      models: { [NAMESPACED]: { enabled: false } }
    });
    expect(getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured })).toEqual([]);
  });

  it('also honours a toggle stored under the bare id the endpoint editor writes', () => {
    // The Preferences endpoint card keys its checkbox on the raw model id.
    // Either id saying `false` disables the model — a toggle is a restriction.
    const aiPreferences = prefsWith([COLLIDING_ENDPOINT], {
      models: { 'gpt-4o': { enabled: false } }
    });
    const available = getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured });
    expect(available.map((m) => m.id)).not.toContain(NAMESPACED);
  });

  /**
   * KNOWN, DELIBERATE OVER-REACH — pinned so it is a decision, not an accident.
   *
   * A bare id is ambiguous: `models['gpt-4o'] = { enabled: false }` could mean
   * the built-in OR the identically-named model on the internal endpoint,
   * because the Preferences endpoint card keys its checkbox on the raw id.
   * We resolve the ambiguity by disabling BOTH.
   *
   * Fail closed: a toggle is a restriction, and the cost of guessing wrong in
   * the other direction is offering a model the user meant to switch off — for
   * this customer, potentially the cloud one. The user can still enable the
   * one they want by its namespaced id. Documented in the README.
   */
  it('a bare-id toggle disables the identically-named built-in too (fail closed)', () => {
    const aiPreferences = prefsWith([COLLIDING_ENDPOINT], {
      providers: { openai: { enabled: true }, [`openai-compatible:${COLLIDING_ENDPOINT.id}`]: { enabled: true } },
      models: { 'gpt-4o': { enabled: false } }
    });
    const ids = getAvailableModels({ aiPreferences, hasApiKey: () => true }).map((m) => m.id);

    expect(ids).not.toContain('gpt-4o'); // the built-in, disabled as collateral
    expect(ids).not.toContain(NAMESPACED); // the custom one the user aimed at
    // Non-vacuous: other models are still offered, so this is not "everything off".
    expect(ids).toContain('gpt-4o-mini');
  });

  it('a namespaced toggle disables ONLY the custom model, never the built-in', () => {
    const aiPreferences = prefsWith([COLLIDING_ENDPOINT], {
      providers: { openai: { enabled: true }, [`openai-compatible:${COLLIDING_ENDPOINT.id}`]: { enabled: true } },
      models: { [NAMESPACED]: { enabled: false } }
    });
    const ids = getAvailableModels({ aiPreferences, hasApiKey: () => true }).map((m) => m.id);

    expect(ids).not.toContain(NAMESPACED);
    expect(ids).toContain('gpt-4o');
  });
});
