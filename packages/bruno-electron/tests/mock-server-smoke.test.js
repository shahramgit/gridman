jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
jest.mock('../src/store/preferences', () => ({
  preferencesUtil: {
    isBetaFeatureEnabled: () => true,
    shouldUseCustomCaCertificate: () => false,
    shouldKeepDefaultCaCertificates: () => true,
    getCustomCaCertificateFilePath: () => null
  }
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { stringifyMockServer } = require('@usebruno/filestore');
const { getMockServerUid } = require('../src/app/mock-server/mock-server-store');
const mockServer = require('../src/app/mock-server/mock-server');

/**
 * A MOCK SERVER IS ONLY WORTH HAVING IF A REAL SOCKET ANSWERS A REAL REQUEST.
 *
 * Every other test in this port checks a piece in isolation — route keys, rule
 * matching, the store, port selection. This is the one that says the whole
 * stack agrees: a yml file on disk, through the store, through the express
 * layer, out to a client that speaks HTTP and knows nothing about any of it.
 *
 * It also pins the beta gate, which is what keeps this feature off for
 * everyone until its UI exists.
 */

let workspacePath;
const MOCK_NAME = 'smoke';

const MOCK_DOC = {
  name: MOCK_NAME,
  port: 0,
  delay: 0,
  routes: [
    {
      uid: 'r1',
      name: 'ping',
      request: { method: 'GET', url: '{{baseUrl}}/api/ping' },
      response: {
        status: 200,
        headers: [{ name: 'content-type', value: 'application/json', enabled: true }],
        body: { type: 'json', content: '{"ok":true}' }
      }
    },
    {
      uid: 'r2',
      name: 'user by id',
      request: { method: 'GET', url: '{{baseUrl}}/api/users/{{userId}}' },
      response: { status: 200, body: { type: 'json', content: '{"id":"any"}' } }
    }
  ]
};

beforeAll(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-mock-'));
  fs.mkdirSync(path.join(workspacePath, 'mocks'));
  fs.writeFileSync(
    path.join(workspacePath, 'mocks', `${MOCK_NAME}.yml`),
    stringifyMockServer(MOCK_DOC, { format: 'yml' })
  );
});

afterAll(async () => {
  await mockServer.stopAll();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

const request = (port, requestPath, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: requestPath, method }, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  req.on('error', reject);
  req.end();
});

const startSmokeServer = () => {
  const mockPath = path.join(workspacePath, 'mocks', `${MOCK_NAME}.yml`);
  return mockServer.start({
    mockServerUid: getMockServerUid(mockPath),
    serverName: MOCK_NAME,
    sourceType: 'mock',
    workspacePath,
    // 0 lets the OS pick, so a developer already running something on the
    // default gateway port does not get a flaky failure.
    port: 0
  });
};

describe('a mock server, end to end', () => {
  let port;

  it('starts and reports the port it bound', async () => {
    const started = await startSmokeServer();
    port = started?.port;
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
  }, 20000);

  it('serves the stored body, status and headers', async () => {
    const res = await request(port, '/api/ping');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.headers['content-type']).toContain('application/json');
  }, 20000);

  it('matches a templated path segment as a route param', async () => {
    // `{{userId}}` becomes `:userId`, so any id hits the same stored response.
    const res = await request(port, '/api/users/42');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: 'any' });
  }, 20000);

  it('404s a path with no stored response instead of hanging or 500ing', async () => {
    const res = await request(port, '/api/not-mocked');
    expect(res.status).toBe(404);
  }, 20000);

  it('does not answer a method it has no route for', async () => {
    const res = await request(port, '/api/ping', 'DELETE');
    expect(res.status).toBe(404);
  }, 20000);

  it('releases the port on stop', async () => {
    await mockServer.stopAll();
    await expect(request(port, '/api/ping')).rejects.toThrow();
  }, 20000);
});

describe('the beta gate', () => {
  it('refuses to start when the flag is off', async () => {
    const { preferencesUtil } = require('../src/store/preferences');
    const original = preferencesUtil.isBetaFeatureEnabled;
    preferencesUtil.isBetaFeatureEnabled = () => false;
    try {
      await expect(startSmokeServer()).rejects.toThrow(/beta/i);
    } finally {
      preferencesUtil.isBetaFeatureEnabled = original;
    }
  }, 20000);
});
