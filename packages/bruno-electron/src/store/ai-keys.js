const Store = require('electron-store');
const { encryptString, decryptString } = require('../utils/encryption');

/**
 * Encrypted at-rest storage for AI provider API keys.
 *
 * Keys never land in preferences.json, never land in a collection file, and
 * are never logged — the catch blocks below deliberately log only the error
 * message and the provider id, never the value. They leave this process only
 * as an Authorization header to the provider the user configured.
 *
 * Provider ids are `openai`, `anthropic`, or `openai-compatible:<endpointId>`
 * for user-added internal endpoints.
 */
class AiKeyStore {
  constructor() {
    this.store = new Store({
      name: 'ai-keys',
      clearInvalidConfig: true
    });
  }

  // electron-store treats `.` in a path as nesting. Endpoint ids are
  // user-supplied and routinely contain dots (`llm.corp.local`) and colons
  // (the `openai-compatible:` prefix), so we read/modify/write the whole
  // `keys` map instead of addressing `keys.<providerId>` by dot-path — a
  // dotted id would otherwise be stored under a nested object and never
  // found again by getKey.
  _readAll() {
    const stored = this.store.get('keys', {});
    return stored && typeof stored === 'object' ? stored : {};
  }

  setKey(providerId, apiKey) {
    if (!providerId) return;
    if (typeof apiKey !== 'string' || !apiKey) {
      this.clearKey(providerId);
      return;
    }
    const keys = this._readAll();
    keys[providerId] = encryptString(apiKey);
    this.store.set('keys', keys);
  }

  getKey(providerId) {
    if (!providerId) return null;
    const encrypted = this._readAll()[providerId];
    if (!encrypted) return null;
    try {
      return decryptString(encrypted) || null;
    } catch (err) {
      // Message only — never the ciphertext or the value.
      console.error(`Failed to decrypt AI key for ${providerId}:`, err.message);
      return null;
    }
  }

  hasKey(providerId) {
    return Boolean(this.getKey(providerId));
  }

  clearKey(providerId) {
    if (!providerId) return;
    const keys = this._readAll();
    if (!(providerId in keys)) return;
    delete keys[providerId];
    this.store.set('keys', keys);
  }

  /**
   * Which providers have a usable key, WITHOUT returning any key material.
   * Safe to send to the renderer.
   */
  getKeyStatus() {
    const status = {};
    for (const providerId of Object.keys(this._readAll())) {
      status[providerId] = { configured: this.hasKey(providerId) };
    }
    return status;
  }
}

const aiKeyStore = new AiKeyStore();

module.exports = { aiKeyStore, AiKeyStore };
