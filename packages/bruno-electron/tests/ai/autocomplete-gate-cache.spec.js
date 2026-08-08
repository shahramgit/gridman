/**
 * The autocomplete gate is read on the keystroke path.
 *
 * electron-store's `get` is a synchronous read + parse of the whole
 * preferences file (conf's `get store()`), and getPreferences() then runs the
 * migrations and a deep merge with the defaults on top. Ghost text asked that
 * question once per character typed, while a comment in the handler claimed
 * "nothing here blocks the main thread on the keystroke path".
 *
 * It is now served from a short-lived cache. The two properties that matter:
 * repeated keystrokes do not re-read the store, and toggling the feature off
 * in Preferences still takes effect immediately (savePreferences invalidates).
 *
 * The ENFORCEMENT gate — `isAiEnabled`, which providers.getModel re-checks
 * before constructing anything — is deliberately NOT cached.
 */

let mockStoreData = {};
const storeReads = { count: 0 };

jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: (key, fallback) => {
      if (key === 'preferences') storeReads.count += 1;
      return key in mockStoreData ? mockStoreData[key] : fallback;
    },
    set: (key, value) => {
      mockStoreData[key] = value;
    }
  }));
});

const {
  getPreferences,
  savePreferences,
  preferencesUtil,
  invalidateAiPreferencesCache
} = require('../../src/store/preferences');

const autocompleteOn = (enabled) => ({
  ai: { enabled: true, autocomplete: { enabled, model: '', triggerMode: 'debounced' } }
});

beforeEach(() => {
  mockStoreData = {};
  storeReads.count = 0;
  invalidateAiPreferencesCache();
});

describe('the keystroke-path gate is cached', () => {
  it('does not re-read the preferences store on every call', () => {
    mockStoreData.preferences = autocompleteOn(true);

    expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(true);
    const afterFirst = storeReads.count;
    expect(afterFirst).toBeGreaterThan(0);

    // A burst of keystrokes.
    for (let i = 0; i < 50; i += 1) {
      expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(true);
    }
    expect(storeReads.count).toBe(afterFirst);
  });

  it('is invalidated by a save, so turning it off takes effect at once', async () => {
    mockStoreData.preferences = autocompleteOn(true);
    expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(true);

    await savePreferences({
      ...getPreferences(),
      ai: { ...getPreferences().ai, enabled: true, autocomplete: { enabled: false, model: '', triggerMode: 'debounced' } }
    });

    expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(false);
  });

  it('is invalidated when the master AI switch is turned off', async () => {
    mockStoreData.preferences = autocompleteOn(true);
    expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(true);

    await savePreferences({
      ...getPreferences(),
      ai: { ...getPreferences().ai, enabled: false }
    });

    expect(preferencesUtil.isAiAutocompleteEnabled()).toBe(false);
  });
});

describe('the enforcement gate is not cached', () => {
  it('isAiEnabled re-reads the store every time', () => {
    mockStoreData.preferences = { ai: { enabled: true } };
    expect(preferencesUtil.isAiEnabled()).toBe(true);
    const afterFirst = storeReads.count;

    expect(preferencesUtil.isAiEnabled()).toBe(true);
    expect(storeReads.count).toBeGreaterThan(afterFirst);

    // And it sees a change made underneath it without any invalidation.
    mockStoreData.preferences = { ai: { enabled: false } };
    expect(preferencesUtil.isAiEnabled()).toBe(false);
  });
});
