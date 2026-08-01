// Mock electron before requiring axios-instance
jest.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0'
  }
}));

// Mock preferences. shouldStoreCookies is switchable so the redirect tests can exercise the
// cookie-storing path without affecting the rest of the file.
let mockShouldStoreCookies = false;
jest.mock('../../src/store/preferences', () => ({
  preferencesUtil: {
    shouldStoreCookies: () => mockShouldStoreCookies,
    shouldSendCookies: () => false,
    isSslSessionCachingEnabled: () => true
  }
}));

// Mock cookies
jest.mock('../../src/utils/cookies', () => ({
  addCookieToJar: jest.fn(),
  getCookieStringForUrl: jest.fn()
}));

// Mock proxy-util
jest.mock('../../src/utils/proxy-util', () => ({
  setupProxyAgents: jest.fn()
}));

// Mock form-data
jest.mock('../../src/utils/form-data', () => ({
  createFormData: jest.fn()
}));

const { makeAxiosInstance } = require('../../src/ipc/network/axios-instance');
const { addCookieToJar } = require('../../src/utils/cookies');

function createStubAdapter() {
  let capturedConfig = null;

  const adapter = (config) => {
    capturedConfig = config;
    return Promise.resolve({
      data: {},
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    });
  };

  adapter.getConfig = () => capturedConfig;

  return adapter;
}

describe('axios-instance: default headers', () => {
  test('setting User-Agent does not clobber the axios default Accept header', async () => {
    const stubAdapter = createStubAdapter();
    const instance = makeAxiosInstance();

    await instance({ url: 'https://api.example.com/test', method: 'get', adapter: stubAdapter });

    // axios.create() sets Accept by default; assigning a new object to defaults.headers.common
    // would nuke it. Guard against that regression.
    expect(stubAdapter.getConfig().headers['Accept']).toMatch(/application\/json/);
  });

  test('sets User-Agent header to bruno-runtime version', async () => {
    const stubAdapter = createStubAdapter();
    const instance = makeAxiosInstance();

    await instance({ url: 'https://api.example.com/test', method: 'get', adapter: stubAdapter });

    expect(stubAdapter.getConfig().headers['User-Agent']).toMatch(/^bruno-runtime\//);
  });
});

describe('axios-instance: DNS lookup behavior (GitHub #7343)', () => {
  let axiosInstance;

  beforeEach(() => {
    axiosInstance = makeAxiosInstance();
  });

  test('should set custom lookup function for localhost URLs', async () => {
    const stubAdapter = createStubAdapter();

    await axiosInstance({
      url: 'http://localhost:3000/api/test',
      method: 'get',
      adapter: stubAdapter
    });

    const config = stubAdapter.getConfig();
    expect(config.lookup).toBeDefined();
    expect(typeof config.lookup).toBe('function');
  });

  test('should set custom lookup function for 127.0.0.1 URLs', async () => {
    const stubAdapter = createStubAdapter();

    await axiosInstance({
      url: 'http://127.0.0.1:8080/api/test',
      method: 'get',
      adapter: stubAdapter
    });

    const config = stubAdapter.getConfig();
    expect(config.lookup).toBeDefined();
    expect(typeof config.lookup).toBe('function');
  });

  test('should set custom lookup function for ::1 (IPv6 localhost) URLs', async () => {
    const stubAdapter = createStubAdapter();

    await axiosInstance({
      url: 'http://[::1]:8080/api/test',
      method: 'get',
      adapter: stubAdapter
    });

    const config = stubAdapter.getConfig();
    expect(config.lookup).toBeDefined();
    expect(typeof config.lookup).toBe('function');
  });

  test('should set custom lookup function for *.localhost domains (RFC 6761)', async () => {
    const stubAdapter = createStubAdapter();

    await axiosInstance({
      url: 'http://api.localhost:3000/test',
      method: 'get',
      adapter: stubAdapter
    });

    const config = stubAdapter.getConfig();
    expect(config.lookup).toBeDefined();
    expect(typeof config.lookup).toBe('function');
  });

  test('should NOT set custom lookup for external domains', async () => {
    const stubAdapter = createStubAdapter();

    await axiosInstance({
      url: 'https://api.example.com/test',
      method: 'get',
      adapter: stubAdapter
    });

    const config = stubAdapter.getConfig();
    expect(config.lookup).toBeUndefined();
  });

  test('should NOT set custom lookup for httpbin.org', async () => {
    const stubAdapter = createStubAdapter();

    await axiosInstance({
      url: 'https://httpbin.org/get',
      method: 'get',
      adapter: stubAdapter
    });

    const config = stubAdapter.getConfig();
    expect(config.lookup).toBeUndefined();
  });

  test('should clear inherited lookup when URL changes from localhost to external domain', async () => {
    // This simulates what happens during a redirect:
    // 1. Original request to localhost sets lookup
    // 2. Redirect spreads config including lookup
    // 3. New request to external domain should clear the lookup
    const stubAdapter = createStubAdapter();
    const inheritedLookup = (_hostname, _options, callback) => {
      callback(null, '127.0.0.1', 4);
    };

    await axiosInstance({
      url: 'https://external-auth-provider.com/oauth/authorize',
      method: 'get',
      adapter: stubAdapter,
      lookup: inheritedLookup // Simulates inherited lookup from redirect
    });

    const config = stubAdapter.getConfig();
    // The lookup should be cleared for external domains
    expect(config.lookup).toBeUndefined();
  });

  test('should replace inherited lookup with a fresh one when redirecting localhost to localhost', async () => {
    // Simulates a redirect from one localhost endpoint to another:
    // the inherited lookup from the original request should be replaced
    // (not just kept) by a fresh localhost lookup function.
    const stubAdapter = createStubAdapter();
    const inheritedLookup = (_hostname, _options, callback) => {
      callback(null, '127.0.0.1', 4);
    };

    await axiosInstance({
      url: 'http://localhost:3182/redirected',
      method: 'get',
      adapter: stubAdapter,
      lookup: inheritedLookup // Simulates inherited lookup from redirect
    });

    const config = stubAdapter.getConfig();
    // Should have a lookup set for localhost, but it should be a fresh one
    expect(config.lookup).toBeDefined();
    expect(typeof config.lookup).toBe('function');
    expect(config.lookup).not.toBe(inheritedLookup);
  });
});

describe('axios-instance: redirect without a Location header (GitHub #7725)', () => {
  // Builds an adapter that rejects the first call with a redirect status, the way axios' own
  // http adapter does when validateStatus fails. Later calls resolve, so a bogus follow-up
  // request is observable as an extra invocation.
  function createRedirectAdapter({ status = 302, headers = {} } = {}) {
    const calls = [];

    const adapter = (config) => {
      calls.push(config);

      if (calls.length > 1) {
        return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config });
      }

      const error = new Error(`Request failed with status code ${status}`);
      error.config = config;
      error.response = { data: '', status, statusText: 'Found', headers, config };
      return Promise.reject(error);
    };

    adapter.getCalls = () => calls;

    return adapter;
  }

  test('rejects instead of following a 302 that carries no Location header', async () => {
    const stubAdapter = createRedirectAdapter({ status: 302, headers: {} });
    const instance = makeAxiosInstance();

    // A bare 302 (enterprise proxies return this on auth failure) is not followable.
    // Before the fix the interceptor built a redirect config with `url: undefined`.
    await expect(
      instance({ url: 'https://api.example.com/protected', method: 'get', adapter: stubAdapter })
    ).rejects.toMatchObject({ response: { status: 302 } });

    expect(stubAdapter.getCalls()).toHaveLength(1);
  });

  test('rejects a 301 with an empty-string Location header', async () => {
    const stubAdapter = createRedirectAdapter({ status: 301, headers: { location: '' } });
    const instance = makeAxiosInstance();

    await expect(
      instance({ url: 'https://api.example.com/moved', method: 'get', adapter: stubAdapter })
    ).rejects.toMatchObject({ response: { status: 301 } });

    expect(stubAdapter.getCalls()).toHaveLength(1);
  });

  test('still follows a 302 that does carry a Location header', async () => {
    const stubAdapter = createRedirectAdapter({
      status: 302,
      headers: { location: 'https://api.example.com/after-redirect' }
    });
    const instance = makeAxiosInstance();

    const response = await instance({
      url: 'https://api.example.com/protected',
      method: 'get',
      adapter: stubAdapter
    });

    expect(response.status).toEqual(200);

    const calls = stubAdapter.getCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toEqual('https://api.example.com/after-redirect');
  });

  test('attaches the timeline to the rejected response when Location is missing', async () => {
    const stubAdapter = createRedirectAdapter({ status: 302, headers: {} });
    const instance = makeAxiosInstance();

    let caught;
    try {
      await instance({ url: 'https://api.example.com/protected', method: 'get', adapter: stubAdapter });
    } catch (err) {
      caught = err;
    }

    expect(Array.isArray(caught.response.timeline)).toBe(true);
  });

  describe('with cookie storage enabled', () => {
    beforeEach(() => {
      mockShouldStoreCookies = true;
      addCookieToJar.mockClear();
    });

    afterEach(() => {
      mockShouldStoreCookies = false;
    });

    test('saves Set-Cookie from a 302 that carries no Location header', async () => {
      // The enterprise-proxy 302 that motivated the guard usually sets a session cookie the next
      // attempt needs. Rejecting above saveCookies would silently drop it — and the
      // `followRedirects: false` branch a few lines up saves cookies before rejecting, so
      // dropping here would be inconsistent on top of wrong.
      const stubAdapter = createRedirectAdapter({
        status: 302,
        headers: { 'set-cookie': ['session=abc; Path=/'] }
      });
      const instance = makeAxiosInstance();

      await expect(
        instance({ url: 'https://api.example.com/protected', method: 'get', adapter: stubAdapter })
      ).rejects.toMatchObject({ response: { status: 302 } });

      expect(addCookieToJar).toHaveBeenCalledWith('session=abc; Path=/', 'https://api.example.com/protected');
    });

    test('still saves Set-Cookie from a 302 that is followed', async () => {
      const stubAdapter = createRedirectAdapter({
        status: 302,
        headers: { 'set-cookie': ['session=abc; Path=/'], 'location': 'https://api.example.com/after-redirect' }
      });
      const instance = makeAxiosInstance();

      const response = await instance({
        url: 'https://api.example.com/protected',
        method: 'get',
        adapter: stubAdapter
      });

      expect(response.status).toEqual(200);
      expect(addCookieToJar).toHaveBeenCalledWith('session=abc; Path=/', 'https://api.example.com/protected');
    });
  });
});
