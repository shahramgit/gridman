/**
 * The IPC layer registers unconditionally and every handler re-checks
 * `ai.enabled` on each call. These tests pin that behaviour: with default
 * preferences the handlers are present but refuse before anything can
 * construct a provider or hit the network.
 *
 * They also pin the CHANNEL LIST ITSELF, on TWO axes.
 *
 * Axis 1 — EXACTLY THIS SET, no more and no less. preload.js has no channel
 * allowlist, so anything registered here is reachable from any renderer code
 * that can call ipcRenderer. `renderer:ai-generate-text` and
 * `renderer:ai-stream-text` were unredacted passthroughs — they took `system` /
 * `prompt` / `messages` from the renderer and handed them to the model as-is —
 * with no callers anywhere in bruno-app. They were removed rather than
 * hardened, together with `renderer:ai-generate-script` (whose only caller, the
 * AIAssist sparkle component, went with it) and `renderer:ai-stop-stream`
 * (which existed only to abort those).
 *
 * Axis 2 — EVERY CHANNEL ON THE SET HAS A RENDERER CALLER. The exact-match
 * assertion alone is not enough, because it is satisfied by editing the list.
 * `renderer:ai-autocomplete` and `renderer:ai-autocomplete-cancel` were ON that
 * list and still had no caller in packages/bruno-app/src: ghost text reached
 * generateText with prefix/suffix/requestContext/variableNames/siblingScripts,
 * and because nothing sent that way went through slices/ai.js, the renderer's
 * outbound gate never saw it — the redaction was main-process-only. Same
 * reasoning that cut `renderer:ai-generate-script`. They are gone, and
 * `every registered AI channel is reachable from the renderer` below is what
 * stops the next one: a provider exit re-added with no caller fails here even
 * if someone remembers to add it to the intended list.
 */

const fs = require('node:fs');
const path = require('node:path');

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

const mockGenerateText = jest.fn();
const mockStreamText = jest.fn();
jest.mock('ai', () => ({
  generateText: (...args) => mockGenerateText(...args),
  streamText: (...args) => mockStreamText(...args),
  stepCountIs: (n) => n
}));

const mockGetModel = jest.fn();
const mockValidateApiKey = jest.fn();
jest.mock('../../src/ipc/ai/providers', () => {
  const actual = jest.requireActual('../../src/ipc/ai/providers');
  return {
    ...actual,
    getModel: (...args) => mockGetModel(...args),
    validateApiKeyForProvider: (...args) => mockValidateApiKey(...args)
  };
});

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
const { invalidateAiPreferencesCache } = require('../../src/store/preferences');

const invoke = (channel, payload) => mockHandlers.get(channel)(null, payload);

// store/preferences.js keeps a short-lived cache in front of the AI prefs.
// savePreferences invalidates it in the app; these tests swap the backing store
// directly, so they invalidate by hand.
const setStorePreferences = (preferences) => {
  mockStoreData.preferences = preferences;
  invalidateAiPreferencesCache();
};

const mainWindow = { webContents: { isDestroyed: () => true, send: jest.fn() } };

let fetchSpy;

beforeAll(() => {
  registerAllAiIpc(mainWindow);
});

beforeEach(() => {
  // Empty preferences => shipped defaults => AI off.
  mockStoreData = { preferences: {} };
  mockGetModel.mockReset();
  mockValidateApiKey.mockReset();
  mockGenerateText.mockReset();
  mockStreamText.mockReset();
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

/**
 * The intended surface, in full. Keep these lists sorted — the assertions
 * compare them element by element against what registration actually produced,
 * so an extra channel and a missing one both fail.
 */
const INTENDED_INVOKE_CHANNELS = [
  'renderer:ai-test-provider',
  'renderer:clear-ai-api-key',
  'renderer:get-ai-api-key',
  'renderer:get-ai-status',
  'renderer:set-ai-api-key'
];

const INTENDED_SEND_CHANNELS = [
  'renderer:ai-chat-stop',
  'renderer:ai-chat-stream'
];

// Named individually so a revert that re-registers one fails with the channel
// in the message, not just a list diff. The last two are the ghost-text pair:
// registered, wired to generateText, and never called by the renderer.
const REMOVED_CHANNELS = [
  'renderer:ai-generate-text',
  'renderer:ai-stream-text',
  'renderer:ai-generate-script',
  'renderer:ai-stop-stream',
  'renderer:ai-autocomplete',
  'renderer:ai-autocomplete-cancel'
];

/* ------------------------------------------------------------------ *
 * The renderer-caller scan.
 *
 * A registered channel is only legitimate if some renderer code actually
 * sends on it. Spec files do not count: a channel exercised only by a test is
 * still an entry point no shipped code uses, which is exactly the shape both
 * removed surfaces had.
 * ------------------------------------------------------------------ */

const RENDERER_SRC = path.join(__dirname, '..', '..', '..', 'bruno-app', 'src');

const IGNORED_DIRS = new Set(['node_modules', '__tests__', '__mocks__', 'test-utils']);
const SOURCE_EXT = /\.(js|jsx|ts|tsx)$/;
const SPEC_FILE = /\.(spec|test)\.(js|jsx|ts|tsx)$/;

const collectRendererSources = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...collectRendererSources(path.join(dir, entry.name)));
      continue;
    }
    if (!SOURCE_EXT.test(entry.name) || SPEC_FILE.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
};

// Read once. Fail closed: a missing or empty renderer tree is a broken test,
// not a pass.
const rendererSources = (() => {
  if (!fs.existsSync(RENDERER_SRC)) {
    throw new Error(`renderer source tree not found at ${RENDERER_SRC}`);
  }
  return collectRendererSources(RENDERER_SRC).map((file) => ({
    file: path.relative(RENDERER_SRC, file),
    text: fs.readFileSync(file, 'utf8')
  }));
})();

const rendererCallersOf = (channel) =>
  rendererSources.filter(({ text }) => text.includes(`'${channel}'`) || text.includes(`"${channel}"`))
    .map(({ file }) => file);

describe('registration', () => {
  it('registers every AI channel regardless of ai.enabled', () => {
    // Registration is unconditional so toggling AI on in Preferences takes
    // effect without an app restart. The gate lives in the handlers.
    expect([...mockHandlers.keys()].sort()).toEqual(INTENDED_INVOKE_CHANNELS);
    expect([...mockListeners.keys()].sort()).toEqual(INTENDED_SEND_CHANNELS);
  });

  it('registers NOTHING beyond that list — an ungated passthrough cannot come back', () => {
    // The exact-match above already fails on an extra channel. This states the
    // specific ones that must stay gone, so the failure names them.
    const registered = new Set([...mockHandlers.keys(), ...mockListeners.keys()]);
    for (const channel of REMOVED_CHANNELS) {
      expect([channel, registered.has(channel)]).toEqual([channel, false]);
    }
  });

  it('every registered AI channel is reachable from the renderer', () => {
    // THE ASSERTION THAT CUT THE GHOST-TEXT PAIR. A handler with no caller is
    // a provider exit nothing exercises and nothing watches — and, because its
    // payload never passes through slices/ai.js, nothing the renderer's own
    // outbound gate protects. Adding a channel to INTENDED_* is not enough to
    // satisfy this: the renderer has to actually send on it.
    const registered = [...mockHandlers.keys(), ...mockListeners.keys()].sort();
    const unreachable = registered.filter((channel) => rendererCallersOf(channel).length === 0);
    expect(unreachable).toEqual([]);
  });

  /* --- non-vacuity guards for the scan above ------------------------- */

  it('scanned a real renderer tree, and one that excludes spec files', () => {
    // The failure mode this guards is a corpus so broad that everything looks
    // reachable. Pin all three properties the assertion above relies on: the
    // tree is substantial, it contains the module the surviving channels are
    // actually sent from, and it contains no spec file — a channel exercised
    // only by a test must NOT count as a caller.
    expect(rendererSources.length).toBeGreaterThan(100);
    expect(rendererSources.some((s) => s.file === path.join('providers', 'ReduxStore', 'slices', 'ai.js'))).toBe(true);
    expect(rendererSources.filter((s) => SPEC_FILE.test(s.file))).toEqual([]);
  });

  it('the scan can say NO — the removed ghost-text channels have no renderer caller', () => {
    // Proves `rendererCallersOf` is capable of returning empty, so the
    // assertion above is not passing because the helper always finds something.
    expect(rendererCallersOf('renderer:ai-autocomplete')).toEqual([]);
    expect(rendererCallersOf('renderer:ai-autocomplete-cancel')).toEqual([]);
    // ...and capable of returning a hit, on a channel that IS called.
    expect(rendererCallersOf('renderer:ai-chat-stream').length).toBeGreaterThan(0);
  });
});

describe('handlers refuse while ai.enabled is false', () => {
  it('reports a disabled, model-less status without touching a provider', async () => {
    const status = await invoke('renderer:get-ai-status');
    expect(status.enabled).toBe(false);
    expect(status.availableModels).toEqual([]);
    expect(mockGetModel).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to write or clear an API key', async () => {
    // Not network-adjacent, but gated for consistency: with the channel list
    // asserted exactly, "every channel below get-ai-status refuses while AI is
    // off" is a rule with no exceptions to remember.
    await expect(invoke('renderer:set-ai-api-key', { providerId: 'openai', apiKey: 'sk-live-XYZ' }))
      .rejects.toThrow(/disabled/i);
    await expect(invoke('renderer:clear-ai-api-key', { providerId: 'openai' }))
      .rejects.toThrow(/disabled/i);
  });

  it('refuses the provider reachability test', async () => {
    const res = await invoke('renderer:ai-test-provider', { providerId: 'openai' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disabled/i);
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses the chat stream channel', () => {
    mockListeners.get('renderer:ai-chat-stream')(null, { requestId: 'r1', messages: [{ role: 'user', content: 'hi' }] });
    expect(mockGetModel).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

describe('the on-prem / internal-endpoint path', () => {
  it('surfaces the internal endpoint as the default model with no cloud key present', async () => {
    setStorePreferences({
      ai: {
        enabled: true,
        openaiCompatibleEndpoints: [{
          id: 'corp-llm',
          name: 'Corp LLM',
          baseURL: 'https://llm.corp.internal/v1',
          enabled: true,
          models: [{ id: 'corp-qwen', label: 'Qwen', modelId: 'qwen2.5-coder-32b' }]
        }]
      }
    });
    const status = await invoke('renderer:get-ai-status');
    expect(status.enabled).toBe(true);
    expect(status.availableModels).toEqual([
      { id: 'openai-compatible:corp-llm::corp-qwen', label: 'Qwen', provider: 'openai-compatible:corp-llm' }
    ]);
    // No key configured, yet the endpoint reports as ready to use.
    expect(status.providers['openai-compatible:corp-llm']).toMatchObject({
      enabled: true,
      configured: true,
      requiresApiKey: false
    });
    // The cloud providers remain off and unconfigured.
    expect(status.providers.openai).toMatchObject({ enabled: false, configured: false });
    expect(status.providers.anthropic).toMatchObject({ enabled: false, configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
