const http = require('http');

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), on: jest.fn(), getName: () => 'g', getVersion: () => '4.0.0' },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  net: {}
}));
jest.mock('electron-store', () => jest.fn().mockImplementation(() => ({ get: (_k, f) => f, set: jest.fn() })));

const { makeAxiosInstance } = require('../../src/ipc/network/axios-instance');

/**
 * CREDENTIALS MUST NOT FOLLOW A REDIRECT TO ANOTHER ORIGIN.
 *
 * We follow redirects ourselves (maxRedirects: 0), so axios's own cross-origin stripping
 * never ran, and the redirect config copied every header verbatim. Before this fix, a real
 * server on another host received `Authorization: Bearer …` and `x-api-key` in full.
 *
 * These drive real HTTP servers rather than asserting on config objects — the leak was in
 * what actually went over the wire.
 */
jest.setTimeout(20000);

const withServers = async (fn) => {
  let received = null;
  const target = http.createServer((req, res) => {
    received = req.headers; res.end('{"ok":true}');
  });
  await new Promise((r) => target.listen(0, r));
  const targetPort = target.address().port;

  const origin = http.createServer((req, res) => {
    // `toHost` decides whether this is a same-origin or cross-origin redirect.
    res.writeHead(302, { location: `http://${origin.__toHost}:${targetPort}/landed` });
    res.end();
  });
  await new Promise((r) => origin.listen(0, r));

  try {
    return await fn({ origin, targetPort, getReceived: () => received });
  } finally {
    origin.closeAllConnections?.();
    target.closeAllConnections?.();
    origin.close();
    target.close();
  }
};

const send = (instance, host, port, extraSettings) =>
  instance({
    method: 'GET',
    url: `http://${host}:${port}/start`,
    headers: {
      'authorization': 'Bearer SUPER-SECRET-TOKEN',
      'cookie': 'session=abc123',
      'x-api-key': 'sk-live-INTERNAL',
      'accept': 'application/json'
    },
    ...(extraSettings ? { settings: extraSettings } : {})
  }).catch(() => {});

describe('cross-origin redirects', () => {
  it('does not forward credentials to a different host', async () => {
    await withServers(async ({ origin, getReceived }) => {
      origin.__toHost = '127.0.0.1'; // different hostname from `localhost`
      const instance = makeAxiosInstance({ requestMaxRedirects: 5, followRedirects: true });
      await send(instance, 'localhost', origin.address().port);

      const got = getReceived();
      expect(got.authorization).toBeUndefined();
      expect(got.cookie).toBeUndefined();
      // Upstream's fix strips only authorization/proxy-authorization; this one carried too.
      expect(got['x-api-key']).toBeUndefined();
      // Non-credential headers must still travel, or we have broken the request.
      expect(got.accept).toBe('application/json');
    });
  });

  it('DOES forward them on a same-origin redirect', async () => {
    // A login flow bouncing within one host is the normal case — stripping there
    // would break it. Needs a server that redirects to ITSELF: same protocol,
    // host AND port, which two servers on different ports cannot express.
    let received = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://localhost:${server.address().port}/done` });
        return res.end();
      }
      received = req.headers;
      res.end('{"ok":true}');
    });
    await new Promise((r) => server.listen(0, r));

    const instance = makeAxiosInstance({ requestMaxRedirects: 5, followRedirects: true });
    await send(instance, 'localhost', server.address().port);

    expect(received.authorization).toBe('Bearer SUPER-SECRET-TOKEN');
    expect(received.cookie).toBe('session=abc123');
    // keepAlive is on in the agent, so an idle socket keeps close() pending.
    server.closeAllConnections?.();
    server.close();
  });

  it('treats a port change as a different origin', async () => {
    await withServers(async ({ origin, getReceived }) => {
      // Same hostname, different port. The web platform calls that a different
      // origin, and so do we — upstream's isSameOrigin agrees.
      origin.__toHost = 'localhost';
      const instance = makeAxiosInstance({ requestMaxRedirects: 5, followRedirects: true });
      await send(instance, 'localhost', origin.address().port);
      expect(getReceived().authorization).toBeUndefined();
    });
  });

  it('honours an explicit forwardAuthorizationHeader: true', async () => {
    await withServers(async ({ origin, getReceived }) => {
      origin.__toHost = '127.0.0.1';
      const instance = makeAxiosInstance({ requestMaxRedirects: 5, followRedirects: true });
      // A file written by stock Bruno can set this; we honour it rather than
      // silently overriding the user's explicit choice.
      await send(instance, 'localhost', origin.address().port, { forwardAuthorizationHeader: true });
      expect(getReceived().authorization).toBe('Bearer SUPER-SECRET-TOKEN');
    });
  });
});
