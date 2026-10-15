import http from 'node:http';
import { createSendRequest, buildScriptedEntry } from './send-request';
import { getSentHeaders, applySentHeadersToRequest } from '../network/sent-headers';

describe('scripted request sent headers', () => {
  it.each([200, 500])('records transport-added headers and the response timeline for status %s', async (status) => {
    const entries: any[] = [];
    const server = http.createServer((_request, response) => {
      response.writeHead(status, { 'x-response': 'value' }); response.end('body');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const send = createSendRequest(undefined, { onComplete: (entry) => entries.push(entry) });
      await send({ url: `http://127.0.0.1:${address.port}/test`, headers: { 'x-custom': 'authored' } }).catch(() => {});
      expect(entries).toHaveLength(1);
      expect(entries[0].response.statusCode).toBe(status);
      expect(entries[0].response.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'requestHeader', message: expect.stringMatching(/^Host: 127\.0\.0\.1:/i) }),
        expect.objectContaining({ type: 'requestHeader', message: 'x-custom: authored' }),
        expect.objectContaining({ type: 'responseHeader', message: 'x-response: value' })
      ]));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('redacts injected proxy credentials and preserves authored header casing', () => {
    const sentHeaders = getSentHeaders({ _header: 'GET / HTTP/1.1\r\nProxy-Authorization: Basic secret\r\nUser-Agent: transport\r\nHost: api.test\r\n\r\n' } as any);
    expect(sentHeaders['Proxy-Authorization']).toBe('************');
    const request = { headers: { 'user-agent': 'authored' } };
    applySentHeadersToRequest(request, { sentHeaders });
    expect(request.headers).toEqual({ 'user-agent': 'authored', 'Host': 'api.test', 'Proxy-Authorization': '************' });
  });

  it('preserves a nested runRequest network timeline', () => {
    const timeline = [{ type: 'requestHeader', message: 'Host: api.test' }];
    const entry = buildScriptedEntry({ request: {}, response: { status: 200, timeline }, error: null, startedAt: 1, completedAt: 2 });
    expect(entry.response?.timeline).toBe(timeline);
  });
});
