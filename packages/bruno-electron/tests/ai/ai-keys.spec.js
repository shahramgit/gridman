let mockStoreData = {};

jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: (key, fallback) => (key in mockStoreData ? mockStoreData[key] : fallback),
    set: (key, value) => {
      mockStoreData[key] = value;
    }
  }));
});

// Deliberately NOT mocking utils/encryption — the point of these tests is that
// keys really do round-trip through the existing encryption util (AES-256
// fallback path, since safeStorage only exists in a live main process).
const { AiKeyStore } = require('../../src/store/ai-keys');

describe('store/ai-keys', () => {
  let store;

  beforeEach(() => {
    mockStoreData = {};
    store = new AiKeyStore();
  });

  it('round-trips a key through the encryption util', () => {
    store.setKey('openai', 'sk-test-abc123');
    expect(store.getKey('openai')).toBe('sk-test-abc123');
    expect(store.hasKey('openai')).toBe(true);
  });

  it('never persists the key in plaintext', () => {
    store.setKey('openai', 'sk-test-abc123');
    const onDisk = JSON.stringify(mockStoreData);
    expect(onDisk).not.toContain('sk-test-abc123');
    // The encryption util tags its output with an algo prefix.
    expect(mockStoreData.keys.openai).toMatch(/^\$0[01]:/);
  });

  it('returns null for a provider with no key', () => {
    expect(store.getKey('anthropic')).toBeNull();
    expect(store.hasKey('anthropic')).toBe(false);
  });

  it('clears a key', () => {
    store.setKey('openai', 'sk-test-abc123');
    store.clearKey('openai');
    expect(store.getKey('openai')).toBeNull();
    expect(mockStoreData.keys).not.toHaveProperty('openai');
  });

  it('treats setting an empty key as a clear', () => {
    store.setKey('openai', 'sk-test-abc123');
    store.setKey('openai', '');
    expect(store.getKey('openai')).toBeNull();
  });

  it('keeps providers isolated from one another', () => {
    store.setKey('openai', 'sk-openai');
    store.setKey('anthropic', 'sk-ant');
    expect(store.getKey('openai')).toBe('sk-openai');
    expect(store.getKey('anthropic')).toBe('sk-ant');
    store.clearKey('openai');
    expect(store.getKey('anthropic')).toBe('sk-ant');
  });

  // electron-store's dot-path addressing would have split these ids into
  // nested objects, so the key could be written but never read back.
  it('handles provider ids containing dots and colons', () => {
    const providerId = 'openai-compatible:llm.corp.internal';
    store.setKey(providerId, 'internal-key');
    expect(store.getKey(providerId)).toBe('internal-key');
    expect(Object.keys(mockStoreData.keys)).toEqual([providerId]);

    store.clearKey(providerId);
    expect(store.getKey(providerId)).toBeNull();
  });

  it('reports configured status without exposing key material', () => {
    store.setKey('openai', 'sk-openai');
    store.setKey('openai-compatible:corp', 'internal-key');
    const status = store.getKeyStatus();

    expect(status).toEqual({
      'openai': { configured: true },
      'openai-compatible:corp': { configured: true }
    });
    expect(JSON.stringify(status)).not.toContain('sk-openai');
    expect(JSON.stringify(status)).not.toContain('internal-key');
  });

  it('survives a corrupted stored value without throwing or logging the value', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockStoreData.keys = { openai: '$01:not-valid-ciphertext' };

    expect(store.getKey('openai')).toBeNull();
    expect(store.hasKey('openai')).toBe(false);

    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('not-valid-ciphertext');
    errorSpy.mockRestore();
  });

  it('ignores a missing provider id instead of writing a bogus entry', () => {
    store.setKey('', 'sk-nope');
    store.setKey(undefined, 'sk-nope');
    expect(store.getKey('')).toBeNull();
    expect(mockStoreData.keys).toBeUndefined();
  });
});
