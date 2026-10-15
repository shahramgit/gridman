const http = require('http');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { type2Message, messageType, provesPassword } = require('./fixtures/ntlm-messages');

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), on: jest.fn(), getName: () => 'g', getVersion: () => '4.2.1' },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false }, net: {}
}));
jest.mock('electron-store', () => jest.fn().mockImplementation(() => ({ get: (_k, fallback) => fallback, set: jest.fn() })));
jest.mock('../../src/ipc/network/cert-utils', () => ({
  getCertsAndProxyConfig: async () => ({}), buildCertsAndProxyConfig: async () => ({})
}));
jest.mock('../../../bruno-cli/src/runner/prepare-request', () => jest.fn());

const { configureRequest } = require('../../src/ipc/network');
const { completeOpenHop } = require('../../src/ipc/network/axios-instance');
const { measureResponseTime } = require('@usebruno/requests');
const { runSingleRequest } = require('../../../bruno-cli/src/runner/run-single-request');
const prepareCliRequest = require('../../../bruno-cli/src/runner/prepare-request');
const collectionPath = path.join(os.tmpdir(), 'gridman-network-regressions');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

const send = async (mode, request) => {
  if (mode === 'CLI') {
    prepareCliRequest.mockResolvedValueOnce(request);
    const result = await runSingleRequest(
      { pathname: path.join(collectionPath, 'request.bru') }, collectionPath, {}, {}, {}, {}, {},
      'quickjs', { items: [], pathname: collectionPath }, jest.fn()
    );
    return { status: result.response.status, headers: result.response.headers, duration: result.response.duration, error: result.error };
  }
  request.responseType = 'stream';
  const client = await configureRequest(null, {}, request, {}, {}, {}, collectionPath);
  let response;
  try { response = await client(request); } catch (error) {
    if (!error.response) throw error; response = error.response;
  }
  for await (const _chunk of response.data) { /* wait for the full body */ }
  completeOpenHop(response.config);
  return { status: response.status, headers: response.headers, duration: measureResponseTime(response.config.metadata), timeline: response.timeline };
};

describe.each(['Electron', 'CLI'])('%s upstream network regressions', (mode) => {
  it.each([200, 500])('times redirects and the full delayed body for status %s without leaking timing headers', async (status) => {
    let leakedHeader;
    const { server, url } = await listen((req, res) => {
      leakedHeader ||= req.headers['request-start-time'];
      if (req.url === '/redirect') return setTimeout(() => {
        res.writeHead(302, { location: '/body' }); res.end();
      }, 50);
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.write('first');
        setTimeout(() => res.end('last'), 110);
      }, 50);
    });
    try {
      const response = await send(mode, { method: 'GET', url: `${url}/redirect`, headers: {} });
      expect(response.status).toBe(status);
      expect(response.duration).toBeGreaterThanOrEqual(190);
      expect(leakedHeader).toBeUndefined();
      expect(response.headers['request-duration']).toBeUndefined();
    } finally { await close(server); }
  });

  it.each([false, true])('protects custom credentials across an origin change (explicit forwarding %s)', async (forward) => {
    let received;
    const target = await listen((req, res) => {
      received = req.headers; res.end('ok');
    });
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: `${target.url}/target` }); res.end();
    });
    try {
      const response = await send(mode, {
        method: 'GET', url: `${origin.url}/start`, settings: { forwardAuthorizationHeader: forward },
        headers: { 'Authorization': 'Bearer token', 'X-API-Key': 'key', 'X_Custom_Token': 'custom', 'Cookie': 'session=value', 'X-Trace-Id': 'trace' }
      });
      expect(response.status).toBe(200);
      expect(received['x-trace-id']).toBe('trace');
      expect(received.authorization).toBe(forward ? 'Bearer token' : undefined);
      expect(received['x-api-key']).toBe(forward ? 'key' : undefined);
      expect(received['x_custom_token']).toBe(forward ? 'custom' : undefined);
      expect(received.cookie).toBe(forward ? 'session=value' : undefined);
    } finally {
      await close(origin.server); await close(target.server);
    }
  });

  it('retains credentials on relative same-origin redirects', async () => {
    let received;
    const { server, url } = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/target' }); res.end();
      } else {
        received = req.headers; res.end('ok');
      }
    });
    try {
      const response = await send(mode, { method: 'GET', url: `${url}/start`, headers: { 'Authorization': 'Bearer token', 'X-API-Key': 'key' } });
      expect(response.status).toBe(200);
      expect(received.authorization).toBe('Bearer token');
      expect(received['x-api-key']).toBe('key');
    } finally { await close(server); }
  });

  it('does not recreate AWS credentials after stripping them on a cross-origin redirect', async () => {
    let originalHeaders, redirectedHeaders;
    const target = await listen((req, res) => {
      redirectedHeaders = req.headers; res.end('ok');
    });
    const origin = await listen((req, res) => {
      originalHeaders = req.headers; res.writeHead(302, { location: `${target.url}/target` }); res.end();
    });
    try {
      const response = await send(mode, {
        method: 'GET', url: `${origin.url}/start`, headers: {},
        awsv4config: { accessKeyId: 'EXAMPLEKEY', secretAccessKey: 'example-secret', sessionToken: 'example-session', region: 'test', service: 'execute-api' }
      });
      expect(response.status).toBe(200);
      expect(originalHeaders.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(redirectedHeaders.authorization).toBeUndefined();
      expect(redirectedHeaders['x-amz-security-token']).toBeUndefined();
    } finally {
      await close(origin.server); await close(target.server);
    }
  });

  it.each([false, true])('negotiates NTLM through the request pipeline and gates fresh credentials after redirect (%s)', async (forward) => {
    const records = [];
    const handler = (redirect) => (req, res) => {
      const type = messageType(req.headers.authorization);
      records.push({ type, url: req.url, socket: req.socket });
      if (type === 1) {
        req.socket.challenge = crypto.randomBytes(8);
        res.writeHead(401, { 'www-authenticate': type2Message(req.socket.challenge) });
      } else if (type === 3 && req.socket.challenge && provesPassword(req.headers.authorization, 'pass', req.socket.challenge)) {
        if (redirect) res.writeHead(302, { location: redirect });
        else res.writeHead(200);
      } else res.writeHead(401, { 'www-authenticate': 'NTLM' });
      res.end();
    };
    const target = await listen(handler());
    const origin = await listen(handler(`${target.url}/protected`));
    try {
      const response = await send(mode, {
        method: 'GET', url: `${origin.url}/redirect`, headers: {}, settings: { forwardAuthorizationHeader: forward },
        ntlmConfig: { username: 'user', password: 'pass', domain: 'DOMAIN' }
      });
      expect(response.status).toBe(forward ? 200 : 401);
      const originTypes = records.filter((r) => r.url === '/redirect' && r.type);
      expect(originTypes.map((r) => r.type)).toEqual([1, 3]);
      expect(originTypes[0].socket).toBe(originTypes[1].socket);
      expect(records.filter((r) => r.url === '/protected' && r.type).map((r) => r.type)).toEqual(forward ? [1, 3] : []);
    } finally {
      await close(origin.server); await close(target.server);
    }
  });
});
