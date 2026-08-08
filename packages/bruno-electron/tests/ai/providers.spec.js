/**
 * providers.js is the only module that can construct a model client or reach a
 * provider, so the two safety properties are asserted HERE rather than on the
 * IPC layer that calls it:
 *
 *   1. Default preferences  => no provider constructed, no fetch attempted.
 *   2. An OpenAI-compatible endpoint alone (no OpenAI / Anthropic key anywhere)
 *      is enough to use the feature.
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
  listProviders,
  clearSdkCache,
  isProviderEnabled,
  providerRequiresApiKey,
  isKnownProviderId,
  providerLabel,
  validateApiKeyForProvider,
  NO_KEY_PLACEHOLDER
} = require('../../src/ipc/ai/providers');
const { getPreferences } = require('../../src/store/preferences');

// An internal, on-prem model server. No key: the gateway authenticates by
// network position, which is the whole reason this path exists.
const INTERNAL_ENDPOINT = {
  id: 'corp-llm',
  name: 'Corp LLM',
  baseURL: 'https://llm.corp.internal/v1',
  enabled: true,
  models: [
    { id: 'corp-qwen', label: 'Qwen 2.5 Coder', modelId: 'qwen2.5-coder-32b' }
  ]
};

// Custom model ids are namespaced by endpoint, so a custom model can never
// collide with (and be shadowed by) a built-in id. See the collision suite in
// model-namespacing.spec.js.
const CORP_QWEN = 'openai-compatible:corp-llm::corp-qwen';

const internalOnlyPrefs = (overrides = {}) => ({
  enabled: true,
  providers: {
    openai: { enabled: false },
    anthropic: { enabled: false }
  },
  models: {},
  defaultModel: '',
  openaiCompatibleEndpoints: [{ ...INTERNAL_ENDPOINT }],
  ...overrides
});

// Simulates an install with NO key configured for any provider at all.
const noKeys = () => null;
const noKeysConfigured = () => false;

let fetchSpy;

beforeEach(() => {
  mockStoreData = {};
  mockOpenaiFactory.mockClear();
  mockAnthropicFactory.mockClear();
  clearSdkCache();
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('default-off', () => {
  // `mockStoreData.preferences` is left empty, so getPreferences() returns the
  // shipped defaults — exactly what a fresh install sees.
  const defaultAiPrefs = () => getPreferences().ai;

  it('ships with every AI switch off', () => {
    const ai = defaultAiPrefs();
    expect(ai.enabled).toBe(false);
    expect(ai.providers.openai.enabled).toBe(false);
    expect(ai.providers.anthropic.enabled).toBe(false);
    expect(ai.openaiCompatibleEndpoints).toEqual([]);
    // Autocomplete is gated independently of the chat and is also off.
    expect(ai.autocomplete.enabled).toBe(false);
  });

  it('offers no available models with default preferences', () => {
    expect(getAvailableModels({ aiPreferences: defaultAiPrefs(), hasApiKey: noKeysConfigured })).toEqual([]);
  });

  it('constructs no provider and attempts no fetch with default preferences', () => {
    const aiPreferences = defaultAiPrefs();

    getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured });
    listProviders(aiPreferences);
    expect(() => getModel('gpt-4o-mini', { aiPreferences, getApiKey: noKeys })).toThrow(/disabled/i);
    expect(() => getModel('claude-haiku-4-5', { aiPreferences, getApiKey: noKeys })).toThrow(/disabled/i);

    expect(mockOpenaiFactory).not.toHaveBeenCalled();
    expect(mockAnthropicFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses even when a key IS present, while ai.enabled is false', () => {
    // A leftover key from a previous install must not re-enable the feature.
    const aiPreferences = {
      ...defaultAiPrefs(),
      providers: { openai: { enabled: true }, anthropic: { enabled: true } }
    };
    expect(() => getModel('gpt-4o-mini', { aiPreferences, getApiKey: () => 'sk-live-key' }))
      .toThrow(/disabled/i);
    expect(getAvailableModels({ aiPreferences, hasApiKey: () => true })).toEqual([]);
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to run the provider reachability test while disabled', async () => {
    await expect(validateApiKeyForProvider({
      providerId: 'openai',
      apiKey: 'sk-live-key',
      aiPreferences: defaultAiPrefs()
    })).rejects.toThrow(/disabled/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a configured-but-not-enabled internal endpoint dormant', () => {
    const aiPreferences = internalOnlyPrefs({
      openaiCompatibleEndpoints: [{ ...INTERNAL_ENDPOINT, enabled: false }]
    });
    expect(getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured })).toEqual([]);
    expect(() => getModel('corp-qwen', { aiPreferences, getApiKey: noKeys })).toThrow(/not enabled/i);
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('openai-compatible endpoint as a first-class provider', () => {
  it('is usable with NO OpenAI or Anthropic key configured anywhere', () => {
    const aiPreferences = internalOnlyPrefs();

    const available = getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured });
    expect(available).toEqual([
      { id: CORP_QWEN, label: 'Qwen 2.5 Coder', provider: 'openai-compatible:corp-llm' }
    ]);

    const model = getModel(CORP_QWEN, { aiPreferences, getApiKey: noKeys });
    expect(model).toEqual({ __sdk: 'openai.chat', modelId: 'qwen2.5-coder-32b' });

    // Built-in providers stayed out of it entirely.
    expect(mockAnthropicFactory).not.toHaveBeenCalled();
    expect(mockOpenaiFactory).toHaveBeenCalledTimes(1);
    expect(mockOpenaiFactory).toHaveBeenCalledWith({
      apiKey: NO_KEY_PLACEHOLDER,
      baseURL: 'https://llm.corp.internal/v1'
    });
  });

  it('never falls back to process.env.OPENAI_API_KEY for a keyless endpoint', () => {
    // @ai-sdk/openai's loadApiKey reads OPENAI_API_KEY when apiKey is
    // undefined. That would ship the user's OpenAI key to their internal host.
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-should-never-be-used';
    try {
      getModel('corp-qwen', { aiPreferences: internalOnlyPrefs(), getApiKey: noKeys });
      expect(mockOpenaiFactory).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: NO_KEY_PLACEHOLDER })
      );
      const passedKeys = mockOpenaiFactory.mock.calls.map((call) => call[0].apiKey);
      expect(passedKeys).not.toContain('sk-should-never-be-used');
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('passes an endpoint key through when the user did configure one', () => {
    getModel('corp-qwen', {
      aiPreferences: internalOnlyPrefs(),
      getApiKey: (providerId) => (providerId === 'openai-compatible:corp-llm' ? 'internal-key' : null)
    });
    expect(mockOpenaiFactory).toHaveBeenCalledWith({
      apiKey: 'internal-key',
      baseURL: 'https://llm.corp.internal/v1'
    });
  });

  it('accepts enablement via the providers map as well as the endpoint entry', () => {
    const aiPreferences = internalOnlyPrefs({
      openaiCompatibleEndpoints: [{ ...INTERNAL_ENDPOINT, enabled: false }],
      providers: {
        'openai': { enabled: false },
        'anthropic': { enabled: false },
        'openai-compatible:corp-llm': { enabled: true }
      }
    });
    expect(isProviderEnabled('openai-compatible:corp-llm', aiPreferences)).toBe(true);
    expect(getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured })).toHaveLength(1);
  });

  it('reports the endpoint as a known provider that does not require a key', () => {
    const aiPreferences = internalOnlyPrefs();
    expect(isKnownProviderId('openai-compatible:corp-llm', aiPreferences)).toBe(true);
    expect(providerRequiresApiKey('openai-compatible:corp-llm')).toBe(false);
    expect(providerRequiresApiKey('openai')).toBe(true);
    expect(providerRequiresApiKey('anthropic')).toBe(true);
    expect(providerLabel('openai-compatible:corp-llm', aiPreferences)).toBe('Corp LLM');
  });

  it('lists the endpoint alongside the built-ins with requiresApiKey false', () => {
    const entry = listProviders(internalOnlyPrefs())
      .find((p) => p.id === 'openai-compatible:corp-llm');
    expect(entry).toMatchObject({
      label: 'Corp LLM',
      isCustom: true,
      requiresApiKey: false,
      baseURL: 'https://llm.corp.internal/v1'
    });
  });

  it('refuses an endpoint with no base URL instead of silently hitting api.openai.com', () => {
    // createOpenAI defaults baseURL to https://api.openai.com/v1 — sending an
    // internal-only prompt there would be the exact failure this fork must avoid.
    const aiPreferences = internalOnlyPrefs({
      openaiCompatibleEndpoints: [{ ...INTERNAL_ENDPOINT, baseURL: '' }]
    });
    expect(() => getModel('corp-qwen', { aiPreferences, getApiKey: noKeys })).toThrow(/Base URL/i);
    expect(getAvailableModels({ aiPreferences, hasApiKey: noKeysConfigured })).toEqual([]);
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
  });

  it('still requires a key for the built-in providers', () => {
    const aiPreferences = internalOnlyPrefs({
      providers: { openai: { enabled: true }, anthropic: { enabled: true } }
    });
    expect(() => getModel('gpt-4o-mini', { aiPreferences, getApiKey: noKeys }))
      .toThrow(/API key is not configured/i);
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
  });

  it('validates a keyless endpoint with the SAME Authorization the SDK will send', async () => {
    // Test and real generation must agree. @ai-sdk/openai always sends an
    // Authorization header and uses NO_KEY_PLACEHOLDER when no key is set, so
    // a Test that sent none could pass against a gateway that then rejects
    // every generation.
    await validateApiKeyForProvider({
      providerId: 'openai-compatible:corp-llm',
      apiKey: null,
      aiPreferences: internalOnlyPrefs()
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://llm.corp.internal/v1/models',
      expect.objectContaining({ headers: { Authorization: `Bearer ${NO_KEY_PLACEHOLDER}` } })
    );

    // And that is exactly the key handed to the SDK for the same endpoint.
    getModel('corp-qwen', { aiPreferences: internalOnlyPrefs(), getApiKey: noKeys });
    expect(mockOpenaiFactory).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: NO_KEY_PLACEHOLDER })
    );
  });

  it('sends a bearer token when validating an endpoint that has one', async () => {
    await validateApiKeyForProvider({
      providerId: 'openai-compatible:corp-llm',
      apiKey: 'internal-key',
      aiPreferences: internalOnlyPrefs()
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://llm.corp.internal/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer internal-key' } })
    );
  });

  it('does not reuse a cached SDK after the base URL changes', () => {
    const first = internalOnlyPrefs();
    getModel('corp-qwen', { aiPreferences: first, getApiKey: noKeys });

    const moved = internalOnlyPrefs({
      openaiCompatibleEndpoints: [{ ...INTERNAL_ENDPOINT, baseURL: 'https://llm2.corp.internal/v1' }]
    });
    getModel('corp-qwen', { aiPreferences: moved, getApiKey: noKeys });

    expect(mockOpenaiFactory).toHaveBeenCalledTimes(2);
    expect(mockOpenaiFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: 'https://llm2.corp.internal/v1' })
    );
  });
});
