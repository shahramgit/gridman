/**
 * NO API KEY MAY REACH preferences.json.
 *
 * That file is plaintext on disk. Keys belong in store/ai-keys.js, which
 * encrypts them. The port's stripper only walked the top level of each
 * endpoint entry, and the Yup schema left `ai.providers` / `ai.models`
 * shapeless — and Yup PRESERVES unknown keys — so `ai.apiKey`,
 * `ai.providers.openai.apiKey` and every nested path went straight through to
 * disk in the clear.
 *
 * Two locks now: the schema rejects unknown key material outright, and the
 * stripper walks the whole `ai` subtree for anything credential-shaped.
 */

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
  getPreferences,
  savePreferences,
  stripAiEndpointCredentials,
  invalidateAiPreferencesCache
} = require('../../src/store/preferences');

const KEY = 'sk-live-NEVER-ON-DISK';

const onDisk = () => JSON.stringify(mockStoreData.preferences || {});

const saveAi = (ai) => savePreferences({ ...getPreferences(), ai: { ...getPreferences().ai, ...ai } });

beforeEach(() => {
  mockStoreData = {};
  invalidateAiPreferencesCache();
});

describe('the schema rejects credential-shaped keys instead of preserving them', () => {
  it('rejects ai.apiKey', async () => {
    await expect(saveAi({ apiKey: KEY })).rejects.toThrow(/apiKey/);
    expect(onDisk()).not.toContain(KEY);
  });

  it('rejects a key nested under ai.providers', async () => {
    await expect(saveAi({
      providers: { openai: { enabled: true, apiKey: KEY } }
    })).rejects.toBeDefined();
    expect(onDisk()).not.toContain(KEY);
  });

  it('rejects a key nested under ai.models', async () => {
    await expect(saveAi({
      models: { 'gpt-4o': { enabled: true, token: KEY } }
    })).rejects.toBeDefined();
    expect(onDisk()).not.toContain(KEY);
  });

  it('rejects an unknown container that could hold anything', async () => {
    await expect(saveAi({ credentials: { openai: KEY } })).rejects.toBeDefined();
    expect(onDisk()).not.toContain(KEY);
  });

  it('rejects a key on an endpoint model entry', async () => {
    await expect(saveAi({
      openaiCompatibleEndpoints: [{
        id: 'corp',
        baseURL: 'https://llm.corp.internal/v1',
        models: [{ id: 'm', modelId: 'x', apiKey: KEY }]
      }]
    })).rejects.toBeDefined();
    expect(onDisk()).not.toContain(KEY);
  });

  it('rejects an endpoint id that would break the model-id namespace', async () => {
    await expect(saveAi({
      openaiCompatibleEndpoints: [{ id: 'a::b', baseURL: 'https://x/v1', models: [] }]
    })).rejects.toThrow(/::/);
  });

  it('still accepts an ordinary AI configuration', async () => {
    await expect(saveAi({
      enabled: true,
      providers: { 'openai': { enabled: false }, 'openai-compatible:corp': { enabled: true } },
      models: { 'openai-compatible:corp::m': { enabled: true } },
      openaiCompatibleEndpoints: [{
        id: 'corp',
        name: 'Corp LLM',
        baseURL: 'https://llm.corp.internal/v1',
        enabled: true,
        models: [{ id: 'm', label: 'Qwen', modelId: 'qwen2.5-coder-32b' }]
      }]
    })).resolves.toBeUndefined();

    expect(mockStoreData.preferences.ai.openaiCompatibleEndpoints[0].baseURL)
      .toBe('https://llm.corp.internal/v1');
  });

  it('round-trips the shipped defaults', async () => {
    // Other parts of the app save the whole preferences object (zoom,
    // markAsLaunched). The AI defaults must validate under the stricter schema.
    await expect(savePreferences(getPreferences())).resolves.toBeUndefined();
  });
});

describe('the level ABOVE ai is closed too', () => {
  // The `ai` subtree was locked and the roof was left open: an unknown
  // TOP-LEVEL key was preserved by Yup and written into plaintext
  // preferences.json verbatim.
  const saveTop = (extra) => savePreferences({ ...getPreferences(), ...extra });

  it('does not persist an unknown top-level key carrying a credential', async () => {
    await expect(saveTop({ apiKey: KEY })).resolves.toBeUndefined();
    expect(onDisk()).not.toContain(KEY);
    expect(mockStoreData.preferences).not.toHaveProperty('apiKey');
  });

  it('does not persist an unknown top-level CONTAINER carrying a credential', async () => {
    await expect(saveTop({ integrations: { slack: { token: KEY } } })).resolves.toBeUndefined();
    expect(onDisk()).not.toContain(KEY);
    expect(mockStoreData.preferences).not.toHaveProperty('integrations');
  });

  it('still persists every declared top-level section', async () => {
    // Non-vacuous: proves the strip is surgical rather than a wipe.
    await expect(saveTop({ apiKey: KEY })).resolves.toBeUndefined();
    const saved = mockStoreData.preferences;
    for (const section of ['request', 'font', 'proxy', 'layout', 'general', 'display', 'ai']) {
      expect(saved).toHaveProperty(section);
    }
    expect(saved.proxy.source).toBe('inherit');
    expect(saved.ai.enabled).toBe(false);
  });

  it('keeps _migrations, so a migration does not re-run on every launch', async () => {
    await savePreferences({ ...getPreferences(), _migrations: { codeFontSize14to13: true } });
    expect(mockStoreData.preferences._migrations).toEqual({ codeFontSize14to13: true });
  });
});

describe('the stripper walks the whole ai subtree', () => {
  it('removes credentials at every depth, not just on endpoint entries', () => {
    const preferences = {
      ai: {
        apiKey: KEY,
        token: KEY,
        providers: {
          'openai': { enabled: true, apiKey: KEY },
          'openai-compatible:corp': { enabled: true, clientSecret: KEY }
        },
        models: { m: { enabled: true, access_token: KEY } },
        openaiCompatibleEndpoints: [
          { id: 'corp', baseURL: 'https://x/v1', apiKey: KEY, headers: { authorization: KEY } }
        ],
        deeply: { nested: { thing: { refresh_token: KEY } } }
      }
    };

    stripAiEndpointCredentials(preferences);

    expect(JSON.stringify(preferences)).not.toContain(KEY);
    expect(preferences.ai).not.toHaveProperty('apiKey');
    expect(preferences.ai.providers.openai).not.toHaveProperty('apiKey');
    expect(preferences.ai.providers['openai-compatible:corp']).not.toHaveProperty('clientSecret');
    expect(preferences.ai.deeply.nested.thing).not.toHaveProperty('refresh_token');
  });

  it('keeps ordinary configuration intact', () => {
    const preferences = {
      ai: {
        enabled: true,
        defaultModel: 'gpt-4o',
        providers: { openai: { enabled: true } },
        openaiCompatibleEndpoints: [
          { id: 'corp', name: 'Corp', baseURL: 'https://x/v1', enabled: true, models: [{ id: 'm', modelId: 'q' }] }
        ],
        security: { redactHeaders: true, customRedactedHeaders: ['X-Trace'] }
      }
    };

    stripAiEndpointCredentials(preferences);

    expect(preferences.ai).toMatchObject({
      enabled: true,
      defaultModel: 'gpt-4o',
      providers: { openai: { enabled: true } },
      security: { redactHeaders: true, customRedactedHeaders: ['X-Trace'] }
    });
    expect(preferences.ai.openaiCompatibleEndpoints[0].models[0]).toEqual({ id: 'm', modelId: 'q' });
  });

  it('does not delete a config OBJECT that happens to be named like a credential', () => {
    // `ai.models['token'] = { enabled: false }` is a user's model toggle.
    // Deleting it would silently re-enable a model they switched off.
    const preferences = { ai: { models: { token: { enabled: false } } } };
    stripAiEndpointCredentials(preferences);
    expect(preferences.ai.models.token).toEqual({ enabled: false });
  });

  it('survives a cyclic object without hanging', () => {
    const preferences = { ai: { enabled: true } };
    preferences.ai.self = preferences.ai;
    preferences.ai.apiKey = KEY;
    stripAiEndpointCredentials(preferences);
    expect(preferences.ai).not.toHaveProperty('apiKey');
  });

  it('leaves preferences with no ai section alone', () => {
    const preferences = { request: { timeout: 0 } };
    expect(stripAiEndpointCredentials(preferences)).toBe(preferences);
  });
});
