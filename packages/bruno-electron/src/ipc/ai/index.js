const { ipcMain } = require('electron');
const { preferencesUtil } = require('../../store/preferences');
const { aiKeyStore } = require('../../store/ai-keys');
const {
  listProviders,
  listModels,
  getModel,
  getAvailableModels,
  clearSdkCache,
  isKnownProviderId,
  isProviderEnabled,
  providerRequiresApiKey,
  validateApiKeyForProvider,
  providerLabel
} = require('./providers');
const registerChatIpc = require('./chat');

const AI_DISABLED_MESSAGE = 'AI features are disabled. Enable them in Preferences > AI.';

const getAiPrefs = () => preferencesUtil.getAiPreferences();

const isEnabled = () => preferencesUtil.isAiEnabled();

const buildStatus = () => {
  const aiPreferences = getAiPrefs();
  const hasApiKey = (providerId) => aiKeyStore.hasKey(providerId);

  const providers = {};
  for (const provider of listProviders(aiPreferences)) {
    providers[provider.id] = {
      ...provider,
      enabled: isProviderEnabled(provider.id, aiPreferences),
      // An internal endpoint that doesn't need a key counts as configured as
      // soon as it has a base URL — that's the whole point of the BYO-endpoint
      // path, and the UI should not nag for a key it doesn't need.
      configured: providerRequiresApiKey(provider.id)
        ? hasApiKey(provider.id)
        : Boolean(provider.baseURL) || hasApiKey(provider.id)
    };
  }

  return {
    enabled: Boolean(aiPreferences.enabled),
    providers,
    models: listModels(aiPreferences),
    // Empty while AI is off — getAvailableModels enforces the master switch
    // itself, so the renderer can't be tricked into offering a model.
    availableModels: getAvailableModels({ aiPreferences, hasApiKey })
  };
};

const resolveModel = (modelId) => {
  // getModel re-checks `ai.enabled` internally; this keeps the message the
  // renderer sees identical regardless of which layer refused.
  if (!isEnabled()) {
    throw new Error(AI_DISABLED_MESSAGE);
  }
  return getModel(modelId, {
    aiPreferences: getAiPrefs(),
    getApiKey: (providerId) => aiKeyStore.getKey(providerId)
  });
};

const pickDefaultModelId = () => {
  const aiPreferences = getAiPrefs();
  const hasApiKey = (providerId) => aiKeyStore.hasKey(providerId);
  const available = getAvailableModels({ aiPreferences, hasApiKey });
  if (available.length === 0) return null;
  const preferred = aiPreferences.defaultModel;
  if (preferred && available.some((m) => m.id === preferred)) return preferred;
  return available[0].id;
};

const assertKnownProvider = (providerId) => {
  if (!isKnownProviderId(providerId, getAiPrefs())) {
    throw new Error(`Unknown AI provider: ${providerId}`);
  }
};

/**
 * AI IPC registration.
 *
 * THE CHANNEL LIST IS THE SECURITY BOUNDARY, AND IT IS DELIBERATELY SHORT.
 *
 * preload.js has no channel allowlist, so every channel registered here is
 * reachable from any renderer code that can call `ipcRenderer.invoke`/`send`.
 * A channel with NO CALLER in packages/bruno-app/src is therefore not inert —
 * it is an entry point that nobody exercises, nobody watches, and nothing in
 * the renderer's own outbound gate protects, because a payload that never
 * passes through slices/ai.js never meets that gate at all. Six such channels
 * used to live here:
 *
 *   renderer:ai-generate-text     \  took `system` / `prompt` / `messages`
 *   renderer:ai-stream-text       /  straight from the renderer and handed
 *                                    them to generateText/streamText with NO
 *                                    redaction
 *   renderer:ai-stop-stream          existed only to abort the two above and
 *                                    the script generator
 *   renderer:ai-generate-script      the sparkle surface it served was cut
 *                                    from the renderer in the same change,
 *                                    taking script-prompts.js with it
 *   renderer:ai-autocomplete      \  ghost text. Reached generateText with
 *   renderer:ai-autocomplete-cancel/ prefix/suffix/requestContext/
 *                                    variableNames/siblingScripts, redacted
 *                                    ONLY in the main process, and had no
 *                                    caller in packages/bruno-app/src either.
 *                                    Removed with autocomplete.js,
 *                                    autocomplete-prompts.js and the
 *                                    context.js formatter they alone used.
 *
 * What ships is the chat panel (chat.js) and the Preferences pane. Chat
 * assembles its own prompt in the main process from structured context that
 * goes through context.js's outbound chokepoint — the renderer never supplies
 * a raw `system`/`prompt` string. `tests/ai/ipc-gate.spec.js` asserts the
 * registered channel list EXACTLY **and** asserts that every channel on it has
 * a caller in packages/bruno-app/src, so both an ungated passthrough and a
 * caller-less provider exit fail the suite.
 *
 * WHY THE HANDLERS ARE ALWAYS REGISTERED AND REFUSE EARLY, rather than being
 * registered conditionally on `ai.enabled`:
 *
 *  - Preferences are mutable at runtime. Registering conditionally at startup
 *    would mean enabling AI requires an app restart, and disabling it would
 *    leave the already-registered handlers in place anyway (you'd need a
 *    matching removeHandler/removeListener teardown to undo it) — so the
 *    conditional buys nothing on the disable path, which is the one that
 *    matters.
 *  - The gate is therefore evaluated per call against the CURRENT preferences.
 *    It cannot go stale, and there is no window where a handler is live but
 *    unguarded.
 *  - `renderer:get-ai-status` must answer while AI is off so the Preferences
 *    screen can render the (off) state at all. It only reads local config —
 *    it never constructs a provider or touches the network.
 *
 * The invariant that actually holds the safety property: every handler that
 * could reach the network goes through resolveModel / validateApiKeyForProvider,
 * and BOTH refuse when `ai.enabled !== true`. providers.js enforces the same
 * check independently, so the guarantee does not depend on this file alone.
 */
const registerAiIpc = (mainWindow) => {
  const broadcastStatus = (status) => {
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('main:ai-status-changed', status);
    }
  };

  // Local config read only. Safe while disabled.
  ipcMain.handle('renderer:get-ai-status', async () => buildStatus());

  /**
   * Writing and clearing a key are gated on `ai.enabled` for the same reason
   * reading is: with AI off there is no legitimate caller, and the Preferences
   * pane cannot reach these until the master switch is on. Gating them keeps
   * the rule uniform — EVERY channel below `renderer:get-ai-status` refuses
   * while the feature is off — so the asserted channel list has no exception
   * a reader has to remember.
   */
  ipcMain.handle('renderer:set-ai-api-key', async (_event, { providerId, apiKey }) => {
    if (!isEnabled()) {
      throw new Error(AI_DISABLED_MESSAGE);
    }
    assertKnownProvider(providerId);
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
      throw new Error('API key cannot be empty');
    }
    aiKeyStore.setKey(providerId, trimmed);
    clearSdkCache();
    const status = buildStatus();
    broadcastStatus(status);
    return status;
  });

  ipcMain.handle('renderer:clear-ai-api-key', async (_event, { providerId }) => {
    if (!isEnabled()) {
      throw new Error(AI_DISABLED_MESSAGE);
    }
    assertKnownProvider(providerId);
    aiKeyStore.clearKey(providerId);
    clearSdkCache();
    const status = buildStatus();
    broadcastStatus(status);
    return status;
  });

  /**
   * API keys are WRITE-ONLY across this boundary.
   *
   * This used to decrypt the stored key and hand the plaintext back to the
   * renderer so the Preferences field could be pre-filled — the one
   * network-adjacent AI handler with no `isEnabled()` gate, which meant a
   * renderer with AI switched off could still pull every configured key out of
   * the encrypted store. Decrypting a secret to populate a text input is not
   * worth that: the key then lives in renderer memory, in React state, and in
   * the DOM.
   *
   * It now returns an empty string, always. Whether a key EXISTS is already
   * reported by `renderer:get-ai-status` as `providers[id].configured`, which
   * is what the Preferences cards actually render. The edit field simply starts
   * empty — the same path both cards already take when there is no key on disk
   * — and the user re-enters a key only when they mean to change it.
   *
   * The gate is kept as well, so a disabled feature answers nothing at all.
   */
  ipcMain.handle('renderer:get-ai-api-key', async (_event, { providerId } = {}) => {
    if (!isEnabled()) {
      return '';
    }
    assertKnownProvider(providerId);
    return '';
  });

  ipcMain.handle('renderer:ai-test-provider', async (_event, { providerId }) => {
    // Explicit gate: "Test" is the one handler whose whole job is a network
    // call, so it must not work while the feature is off.
    if (!isEnabled()) {
      return { ok: false, error: AI_DISABLED_MESSAGE };
    }

    const aiPrefs = getAiPrefs();
    if (!isKnownProviderId(providerId, aiPrefs)) {
      return { ok: false, error: `Unknown provider: ${providerId}` };
    }

    const apiKey = aiKeyStore.getKey(providerId);
    // Built-in providers are useless without a key; internal endpoints are
    // routinely keyless, so only demand one where it's actually required.
    if (!apiKey && providerRequiresApiKey(providerId)) {
      return { ok: false, error: 'No API key configured' };
    }

    if (!isProviderEnabled(providerId, aiPrefs)) {
      return { ok: false, error: `${providerLabel(providerId, aiPrefs)} is disabled` };
    }

    try {
      const res = await validateApiKeyForProvider({ providerId, apiKey, aiPreferences: aiPrefs });
      if (res.ok) {
        return { ok: true };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: apiKey ? 'Invalid API key' : 'Endpoint requires an API key' };
      }
      if (res.status === 429) {
        return { ok: false, error: 'Rate limited — try again in a moment' };
      }
      return { ok: false, error: `Could not verify endpoint (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, error: err.message || 'Could not reach provider. Check your network connection.' };
    }
  });

  registerChatIpc({
    mainWindow,
    resolveModel,
    pickDefaultModelId,
    isAiEnabled: isEnabled
  });
};

module.exports = registerAiIpc;
module.exports.buildStatus = buildStatus;
module.exports.pickDefaultModelId = pickDefaultModelId;
module.exports.resolveModel = resolveModel;
