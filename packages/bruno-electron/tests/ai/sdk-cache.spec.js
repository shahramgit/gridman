/**
 * The SDK cache is bounded, and does not retain API keys as map keys.
 *
 * It used to be an unbounded Map keyed partly on the raw API key: every key
 * edit added an entry that lived for the rest of the process, and every entry
 * kept the plaintext key interned in a Map key string. A user cycling keys
 * while testing an endpoint is the ordinary way to grow it.
 */

const mockOpenaiFactory = jest.fn();
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args) => {
    mockOpenaiFactory(...args);
    const model = (id) => ({ __sdk: 'openai', id });
    model.chat = (id) => ({ __sdk: 'openai.chat', id });
    return model;
  }
}));
jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (id) => ({ __sdk: 'anthropic', id })
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

const crypto = require('node:crypto');
const { getModel, clearSdkCache, listSdkCacheKeys, hashApiKey, sdkCacheKey } = require('../../src/ipc/ai/providers');
const { ENV_PROXY_VARS } = require('../../src/ipc/ai/proxy');

const endpointsFor = (count) => Array.from({ length: count }, (_, i) => ({
  id: `ep${i}`,
  name: `Endpoint ${i}`,
  baseURL: `https://llm${i}.corp.internal/v1`,
  enabled: true,
  models: [{ id: 'm', label: 'M', modelId: 'model' }]
}));

const prefsFor = (endpoints) => ({
  enabled: true,
  providers: {},
  models: {},
  openaiCompatibleEndpoints: endpoints
});

let savedEnv;

beforeEach(() => {
  mockStoreData = {};
  mockOpenaiFactory.mockClear();
  clearSdkCache();
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

describe('sdk cache', () => {
  it('reuses an SDK for a repeated (provider, endpoint, key) tuple', () => {
    const aiPreferences = prefsFor(endpointsFor(1));
    for (let i = 0; i < 5; i += 1) {
      getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => 'same-key' });
    }
    expect(mockOpenaiFactory).toHaveBeenCalledTimes(1);
  });

  it('evicts once the bound is reached instead of growing forever', () => {
    const aiPreferences = prefsFor(endpointsFor(1));
    const rotations = 40; // comfortably past the 16-entry bound

    for (let i = 0; i < rotations; i += 1) {
      getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => `key-${i}` });
    }
    expect(mockOpenaiFactory).toHaveBeenCalledTimes(rotations);

    // The oldest keys were evicted, so asking for one rebuilds it. If the
    // cache were unbounded, every one of these would still be a hit and the
    // factory count would not move.
    const before = mockOpenaiFactory.mock.calls.length;
    getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => 'key-0' });
    expect(mockOpenaiFactory.mock.calls.length).toBe(before + 1);

    // …while the most recent key is still cached.
    const after = mockOpenaiFactory.mock.calls.length;
    getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => `key-${rotations - 1}` });
    expect(mockOpenaiFactory.mock.calls.length).toBe(after);
  });

  it('still separates SDKs that differ only by key', () => {
    const aiPreferences = prefsFor(endpointsFor(1));
    getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => 'key-a' });
    getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => 'key-b' });
    expect(mockOpenaiFactory).toHaveBeenCalledTimes(2);
    expect(mockOpenaiFactory.mock.calls.map((c) => c[0].apiKey)).toEqual(['key-a', 'key-b']);
  });

  it('still separates SDKs that differ only by base URL', () => {
    const aiPreferences = prefsFor(endpointsFor(2));
    getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => 'k' });
    getModel('openai-compatible:ep1::m', { aiPreferences, getApiKey: () => 'k' });
    expect(mockOpenaiFactory.mock.calls.map((c) => c[0].baseURL)).toEqual([
      'https://llm0.corp.internal/v1',
      'https://llm1.corp.internal/v1'
    ]);
  });
});

/**
 * "The cache does not retain API keys as map keys" was a claim in this file's
 * header and in the README, and NOTHING tested it: replacing `hashApiKey` with
 * the identity function left all 281 tests green while every plaintext key sat
 * interned in a Map key for the life of the process. These fail on that swap.
 */
describe('the API key is hashed into the cache key, never stored', () => {
  const RAW_KEY = 'sk-live-RAWKEYMUSTNOTBERETAINED';
  const DIGEST = crypto.createHash('sha256').update(RAW_KEY).digest('hex');

  it('keeps no plaintext key in the LIVE cache after a model is built', () => {
    const aiPreferences = prefsFor(endpointsFor(1));
    getModel('openai-compatible:ep0::m', { aiPreferences, getApiKey: () => RAW_KEY });

    const keys = listSdkCacheKeys();
    // Non-vacuous: the cache really has the entry we just created.
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('openai-compatible:ep0');
    expect(keys[0]).toContain('https://llm0.corp.internal/v1');

    expect(keys[0]).not.toContain(RAW_KEY);
    expect(keys[0]).toContain(DIGEST);
  });

  it('hashes rather than truncates or encodes — the digest is a real SHA-256', () => {
    expect(hashApiKey(RAW_KEY)).toBe(DIGEST);
    expect(hashApiKey(RAW_KEY)).toHaveLength(64);
    // A missing key contributes nothing rather than hashing the empty string,
    // so a keyless internal endpoint stays distinguishable from a keyed one.
    expect(hashApiKey('')).toBe('');
    expect(hashApiKey(undefined)).toBe('');
  });

  it('still distinguishes two different keys after hashing', () => {
    const a = sdkCacheKey({ providerId: 'p', apiKey: 'key-a', baseURL: 'u', proxySignature: '' });
    const b = sdkCacheKey({ providerId: 'p', apiKey: 'key-b', baseURL: 'u', proxySignature: '' });
    expect(a).not.toBe(b);
    expect(a).not.toContain('key-a');
    expect(b).not.toContain('key-b');
  });
});
