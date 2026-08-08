const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same mechanism as tests/ai/proxy.spec.js: drive the real preferences store
// through a fake electron-store rather than stubbing its accessors, so these
// exercise the same read path the app uses.
let mockStoreData = {};
jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: (key, fallback) => (key in mockStoreData ? mockStoreData[key] : fallback),
    set: (key, value) => {
      mockStoreData[key] = value;
    }
  }));
});

const { resolveAiTls } = require('../../src/ipc/ai/tls');

/**
 * The bug these cover: an AI request went out on undici's own defaults, so an
 * internal endpoint behind a private CA failed with "unable to verify the first
 * certificate" while the same host worked in a request tab, which builds an
 * https agent from the app's TLS preferences.
 *
 * The property that matters most here is the LAST test: a user who configured
 * nothing must keep undici's default trust store untouched, because handing
 * undici a `ca` array replaces it rather than adding to it.
 */
describe('resolveAiTls', () => {
  const ENDPOINT_ID = 'endpoint-internal';
  const PROVIDER_ID = `openai-compatible:${ENDPOINT_ID}`;

  let tmpDir;
  let caPath;

  const setPreferences = ({ endpoint = {}, request = {} } = {}) => {
    mockStoreData.preferences = {
      request: { sslVerification: true, customCaCertificate: { enabled: false, filePath: null }, ...request },
      ai: {
        openaiCompatibleEndpoints: [
          { id: ENDPOINT_ID, name: 'Internal', baseURL: 'https://llm.internal/v1', ...endpoint }
        ]
      }
    };
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-ai-tls-'));
    caPath = path.join(tmpDir, 'internal-ca.pem');
    // Shape only — nothing here is parsed by resolveAiTls, which hands the bytes
    // straight to undici.
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockStoreData = {};
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('leaves undici alone when the user configured nothing', () => {
    setPreferences();
    const { options } = resolveAiTls(PROVIDER_ID);
    // null, NOT `{ rejectUnauthorized: true }` — building any options here would
    // mean replacing the default trust store for users with no cert problem.
    expect(options).toBeNull();
  });

  it('trusts the endpoint CA file when one is selected', () => {
    setPreferences({ endpoint: { caCertFilePath: caPath } });
    const { options } = resolveAiTls(PROVIDER_ID);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca.some((entry) => String(entry).includes('not-a-real-cert'))).toBe(true);
  });

  it('keeps verification on for OTHER endpoints when one allows self-signed', () => {
    mockStoreData.preferences = {
      request: { sslVerification: true, customCaCertificate: { enabled: false, filePath: null } },
      ai: {
        openaiCompatibleEndpoints: [
          { id: 'lax', baseURL: 'https://lax.internal/v1', allowSelfSigned: true },
          { id: 'strict', baseURL: 'https://strict.internal/v1' }
        ]
      }
    };

    expect(resolveAiTls('openai-compatible:lax').options).toEqual({ rejectUnauthorized: false });
    // The whole point of scoping it per endpoint: the neighbour is unaffected.
    expect(resolveAiTls('openai-compatible:strict').options).toBeNull();
  });

  it('never lets a hosted provider skip verification', () => {
    // An endpoint id that collides with a hosted provider name must not be able
    // to reach across and weaken it.
    mockStoreData.preferences = {
      request: { sslVerification: true, customCaCertificate: { enabled: false, filePath: null } },
      ai: {
        openaiCompatibleEndpoints: [{ id: 'openai', baseURL: 'https://x/v1', allowSelfSigned: true }]
      }
    };

    expect(resolveAiTls('openai').options).toBeNull();
    expect(resolveAiTls('anthropic').options).toBeNull();
  });

  it('honours the app-wide sslVerification switch', () => {
    setPreferences({ request: { sslVerification: false } });
    expect(resolveAiTls(PROVIDER_ID).options).toEqual({ rejectUnauthorized: false });
    // Including for the hosted providers, which is the user's existing app-wide
    // choice rather than anything this module introduced.
    expect(resolveAiTls('openai').options).toEqual({ rejectUnauthorized: false });
  });

  it('refuses loudly when the selected CA file cannot be read', () => {
    setPreferences({ endpoint: { caCertFilePath: path.join(tmpDir, 'missing.pem') } });
    // Falling back to the default trust store would look like it worked for
    // public hosts and fail confusingly for theirs.
    expect(() => resolveAiTls(PROVIDER_ID)).toThrow(/could not be read/);
  });

  it('rebuilds the cache signature when the CA file is replaced', () => {
    setPreferences({ endpoint: { caCertFilePath: caPath } });
    const before = resolveAiTls(PROVIDER_ID).signature;

    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nrotated-cert-with-different-length\n-----END CERTIFICATE-----\n');
    const after = resolveAiTls(PROVIDER_ID).signature;

    // Otherwise a rotated cert would need an app restart to take effect.
    expect(after).not.toBe(before);
  });

  it('falls back to app-wide settings when preferences cannot be read', () => {
    // Break the store itself rather than spying on the module's exported
    // `getPreferences`: tls.js captures that reference at require time, so a
    // spy on the export never reaches it and the test would pass without
    // exercising anything.
    Object.defineProperty(mockStoreData, 'preferences', {
      configurable: true,
      get() {
        throw new Error('preferences unavailable');
      }
    });

    // No endpoint overrides are found, so nothing is weakened — a preferences
    // failure must never be the reason verification gets skipped.
    expect(resolveAiTls(PROVIDER_ID).options).toBeNull();
  });
});
