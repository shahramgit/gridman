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
  preferencesUtil,
  stripAiEndpointCredentials,
  invalidateAiPreferencesCache
} = require('../../src/store/preferences');

// The autocomplete gate is served from a short-lived cache (it is read on the
// keystroke path). In the app the cache is invalidated by savePreferences;
// these tests rewrite the store underneath it, so they invalidate by hand.
const setStorePreferences = (preferences) => {
  mockStoreData.preferences = preferences;
  invalidateAiPreferencesCache();
};

describe('AI preferences', () => {
  beforeEach(() => {
    mockStoreData = {};
    invalidateAiPreferencesCache();
  });

  describe('defaults on a fresh install', () => {
    it('has AI off at the master switch', () => {
      mockStoreData.preferences = {};
      expect(getPreferences().ai.enabled).toBe(false);
      expect(preferencesUtil.isAiEnabled()).toBe(false);
    });

    it('has every built-in provider off', () => {
      mockStoreData.preferences = {};
      const { providers } = getPreferences().ai;
      expect(providers.openai.enabled).toBe(false);
      expect(providers.anthropic.enabled).toBe(false);
    });

    it('has no internal endpoints configured', () => {
      mockStoreData.preferences = {};
      expect(getPreferences().ai.openaiCompatibleEndpoints).toEqual([]);
    });

    it('has autocomplete off, gated independently of the chat', () => {
      setStorePreferences({});
      expect(getPreferences().ai.autocomplete.enabled).toBe(false);
      expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(false);

      // Turning the master switch on must NOT turn autocomplete on.
      setStorePreferences({ ai: { enabled: true } });
      expect(preferencesUtil.isAiEnabled()).toBe(true);
      expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(false);

      // And autocomplete alone is not enough either.
      setStorePreferences({ ai: { enabled: false, autocomplete: { enabled: true } } });
      expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(false);

      setStorePreferences({ ai: { enabled: true, autocomplete: { enabled: true } } });
      expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(true);
    });

    it('has every redaction toggle on', () => {
      mockStoreData.preferences = {};
      expect(getPreferences().ai.security).toEqual({
        redactHeaders: true,
        redactBody: true,
        redactVariables: true,
        redactResponse: true,
        customRedactedHeaders: [],
        customRedactedVariables: []
      });
    });

    it('does not treat a truthy non-boolean as enabled', () => {
      // A hand-edited or half-migrated preferences file must fail closed.
      mockStoreData.preferences = { ai: { enabled: 'false' } };
      expect(preferencesUtil.isAiEnabled()).toBe(false);
      mockStoreData.preferences = { ai: { enabled: 1 } };
      expect(preferencesUtil.isAiEnabled()).toBe(false);
    });

    it('leaves existing users with AI off after an upgrade', () => {
      // Preferences written before this feature existed have no `ai` key at
      // all; the merge with defaults must land on off, not on.
      mockStoreData.preferences = { request: { sslVerification: true } };
      expect(getPreferences().ai.enabled).toBe(false);
      expect(getPreferences().ai.autocomplete.enabled).toBe(false);
    });
  });

  describe('endpoint credentials never reach preferences.json', () => {
    it('strips credential-shaped fields from endpoint entries', () => {
      const prefs = {
        ai: {
          openaiCompatibleEndpoints: [
            {
              id: 'corp',
              name: 'Corp LLM',
              baseURL: 'https://llm.corp.internal/v1',
              apiKey: 'internal-key',
              token: 'another-secret',
              password: 'nope',
              enabled: true
            }
          ]
        }
      };
      const cleaned = stripAiEndpointCredentials(prefs);
      const endpoint = cleaned.ai.openaiCompatibleEndpoints[0];

      expect(endpoint).not.toHaveProperty('apiKey');
      expect(endpoint).not.toHaveProperty('token');
      expect(endpoint).not.toHaveProperty('password');
      expect(JSON.stringify(cleaned)).not.toContain('internal-key');
      // Non-credential config survives.
      expect(endpoint).toMatchObject({
        id: 'corp',
        name: 'Corp LLM',
        baseURL: 'https://llm.corp.internal/v1',
        enabled: true
      });
    });

    it('rejects a save carrying an endpoint apiKey instead of writing it', async () => {
      // The schema is the primary lock: an unknown key on an endpoint entry
      // fails validation outright rather than being silently preserved.
      await expect(savePreferences({
        ...getPreferences(),
        ai: {
          ...getPreferences().ai,
          enabled: true,
          openaiCompatibleEndpoints: [
            { id: 'corp', name: 'Corp LLM', baseURL: 'https://llm.corp.internal/v1', enabled: true, apiKey: 'internal-key', models: [] }
          ]
        }
      })).rejects.toThrow(/apiKey/);

      expect(JSON.stringify(mockStoreData.preferences || {})).not.toContain('internal-key');
    });
  });

  describe('schema validation', () => {
    it('accepts a valid internal endpoint with a model list', async () => {
      await expect(savePreferences({
        ...getPreferences(),
        ai: {
          ...getPreferences().ai,
          enabled: true,
          openaiCompatibleEndpoints: [
            {
              id: 'corp',
              name: 'Corp LLM',
              baseURL: 'https://llm.corp.internal/v1',
              enabled: true,
              models: [{ id: 'corp-qwen', label: 'Qwen', modelId: 'qwen2.5-coder-32b' }]
            }
          ]
        }
      })).resolves.toBeUndefined();

      expect(mockStoreData.preferences.ai.openaiCompatibleEndpoints[0].models).toHaveLength(1);
    });

    it('rejects an endpoint with no id', async () => {
      await expect(savePreferences({
        ...getPreferences(),
        ai: {
          ...getPreferences().ai,
          openaiCompatibleEndpoints: [{ name: 'Corp LLM', baseURL: 'https://x/v1' }]
        }
      })).rejects.toBeDefined();
    });

    it('rejects an unknown autocomplete trigger mode', async () => {
      await expect(savePreferences({
        ...getPreferences(),
        ai: { ...getPreferences().ai, autocomplete: { enabled: true, model: '', triggerMode: 'instant' } }
      })).rejects.toBeDefined();
    });
  });
});
