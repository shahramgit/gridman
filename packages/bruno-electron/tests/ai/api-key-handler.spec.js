/**
 * API KEYS ARE WRITE-ONLY ACROSS THE IPC BOUNDARY.
 *
 * `renderer:get-ai-api-key` used to decrypt the stored key and hand the
 * plaintext back so a Preferences text field could be pre-filled — and it was
 * the ONLY network-adjacent AI handler with no `isEnabled()` gate, so a
 * renderer with AI switched off could still pull every configured key out of
 * the encrypted store. It now answers with an empty string in every case, and
 * refuses outright while AI is off.
 *
 * Nothing is lost: whether a key exists is reported by
 * `renderer:get-ai-status` as `providers[id].configured`, which is what the
 * Preferences cards actually render.
 */

const mockHandlers = new Map();
const mockListeners = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockListeners.set(channel, fn),
    removeHandler: (channel) => mockHandlers.delete(channel)
  },
  safeStorage: { isEncryptionAvailable: () => false }
}));

jest.mock('ai', () => ({
  generateText: jest.fn(),
  streamText: jest.fn(),
  stepCountIs: (n) => n
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

const registerAllAiIpc = require('../../src/ipc');
const { aiKeyStore } = require('../../src/store/ai-keys');
const { invalidateAiPreferencesCache } = require('../../src/store/preferences');

const invoke = (channel, payload) => mockHandlers.get(channel)(null, payload);

const KEY = 'sk-live-RENDERER-MUST-NOT-SEE-THIS';

const aiOn = {
  ai: {
    enabled: true,
    providers: { openai: { enabled: true } }
  }
};

beforeAll(() => {
  registerAllAiIpc({ webContents: { isDestroyed: () => true, send: jest.fn() } });
});

beforeEach(() => {
  mockStoreData = { preferences: {} };
  invalidateAiPreferencesCache();
});

describe('renderer:get-ai-api-key', () => {
  it('does not return the key even when one is configured and AI is on', async () => {
    mockStoreData.preferences = aiOn;
    invalidateAiPreferencesCache();
    await invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: KEY });
    // The key really is stored — this is not passing by accident.
    expect(aiKeyStore.getKey('openai')).toBe(KEY);

    const returned = await invoke('renderer:get-ai-api-key', { providerId: 'openai' });
    expect(returned).toBe('');
    expect(JSON.stringify(returned)).not.toContain(KEY);
  });

  it('is gated: it answers nothing while AI is disabled', async () => {
    mockStoreData.preferences = aiOn;
    invalidateAiPreferencesCache();
    await invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: KEY });

    mockStoreData.preferences = {}; // AI off
    invalidateAiPreferencesCache();

    const returned = await invoke('renderer:get-ai-api-key', { providerId: 'openai' });
    expect(returned).toBe('');
  });

  it('does not throw on a missing payload', async () => {
    await expect(invoke('renderer:get-ai-api-key', undefined)).resolves.toBe('');
  });

  it('still lets the renderer learn that a key EXISTS, via status', async () => {
    mockStoreData.preferences = aiOn;
    invalidateAiPreferencesCache();
    await invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: KEY });

    const status = await invoke('renderer:get-ai-status');
    expect(status.providers.openai.configured).toBe(true);
    // …without the status payload carrying any key material.
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('clearing still works, so the key stays manageable', async () => {
    mockStoreData.preferences = aiOn;
    invalidateAiPreferencesCache();
    await invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: KEY });
    await invoke('renderer:clear-ai-api-key', { providerId: 'openai' });
    expect(aiKeyStore.hasKey('openai')).toBe(false);
  });
});

describe('writing a key is gated on ai.enabled too', () => {
  /**
   * Not a leak on its own — these are writes, and the Preferences pane cannot
   * reach them until the master switch is on. Gated anyway so the rule has no
   * exception: with `tests/ai/ipc-gate.spec.js` asserting the channel list
   * exactly, "everything below get-ai-status refuses while AI is off" is a
   * property a reviewer can check by reading the list.
   */
  it('refuses to store a key while AI is off, and stores nothing', async () => {
    mockStoreData.preferences = {}; // AI off
    invalidateAiPreferencesCache();

    await expect(invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: KEY }))
      .rejects.toThrow(/disabled/i);
    expect(aiKeyStore.hasKey('openai')).toBe(false);
  });

  it('refuses to clear a key while AI is off, and leaves the stored key intact', async () => {
    mockStoreData.preferences = aiOn;
    invalidateAiPreferencesCache();
    await invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: KEY });

    mockStoreData.preferences = {}; // AI off
    invalidateAiPreferencesCache();

    await expect(invoke('renderer:clear-ai-api-key', { providerId: 'openai' }))
      .rejects.toThrow(/disabled/i);
    // The gate refused rather than half-applying: the key is still there, so
    // turning AI back on finds the configuration the user left behind.
    expect(aiKeyStore.getKey('openai')).toBe(KEY);
  });
});
