import parseItem from '../parseItem';
import stringifyItem from '../stringifyItem';

const buildWsItem = (messages) => ({
  uid: 'item-uid',
  type: 'ws-request',
  name: 'Feed',
  seq: 1,
  tags: [],
  request: {
    url: 'wss://example.com/feed',
    headers: [],
    auth: null,
    body: {
      mode: 'ws',
      ws: messages
    },
    script: { req: null, res: null },
    vars: { req: [], res: [] },
    assertions: [],
    tests: null,
    docs: null
  },
  settings: { timeout: 0, keepAliveInterval: 0 }
});

// A WebSocket request holds several messages. Only the first used to be written to the
// yml file, so the rest were gone the next time the request was opened.
describe('yml websocket request - messages', () => {
  it('round trips every message of a multi message request', () => {
    const item = buildWsItem([
      { name: 'subscribe', type: 'json', content: '{"op":"subscribe"}' },
      { name: 'ping', type: 'text', content: 'ping' },
      { name: 'unsubscribe', type: 'json', content: '{"op":"unsubscribe"}' }
    ]);

    const parsed = parseItem(stringifyItem(item));

    expect(parsed.request.body.ws).toEqual([
      { name: 'subscribe', type: 'json', content: '{"op":"subscribe"}' },
      { name: 'ping', type: 'text', content: 'ping' },
      { name: 'unsubscribe', type: 'json', content: '{"op":"unsubscribe"}' }
    ]);
  });

  it('names unnamed messages by position so they stay distinguishable', () => {
    const item = buildWsItem([
      { name: '', type: 'json', content: '{"n":1}' },
      { name: '', type: 'json', content: '{"n":2}' }
    ]);

    const parsed = parseItem(stringifyItem(item));

    expect(parsed.request.body.ws).toEqual([
      { name: 'message 1', type: 'json', content: '{"n":1}' },
      { name: 'message 2', type: 'json', content: '{"n":2}' }
    ]);
  });

  it('keeps an empty message instead of dropping it from a multi message request', () => {
    const item = buildWsItem([
      { name: 'first', type: 'text', content: '' },
      { name: 'second', type: 'json', content: '{"n":2}' }
    ]);

    const parsed = parseItem(stringifyItem(item));

    expect(parsed.request.body.ws).toEqual([
      { name: 'first', type: 'text', content: '' },
      { name: 'second', type: 'json', content: '{"n":2}' }
    ]);
  });

  // The list shape is unreadable by older builds, so a request that has always fit the
  // single message shape keeps writing it - only multi message requests need the list.
  it('writes a single message in the scalar shape older builds can read', () => {
    const ymlString = stringifyItem(buildWsItem([{ name: 'message 1', type: 'json', content: '{"op":"ping"}' }]));

    expect(ymlString).toContain('message:');
    expect(ymlString).not.toContain('title:');
    expect(ymlString).toMatch(/message:\n\s+type: json\n\s+data:/);

    expect(parseItem(ymlString).request.body.ws).toEqual([
      { name: '', type: 'json', content: '{"op":"ping"}' }
    ]);
  });

  it('reads the single message shape written by earlier versions', () => {
    const legacyYml = `info:
  name: Feed
  type: websocket
  seq: 1

websocket:
  url: wss://example.com/feed
  message:
    type: json
    data: '{"op":"ping"}'
`;

    expect(parseItem(legacyYml).request.body.ws).toEqual([
      { name: '', type: 'json', content: '{"op":"ping"}' }
    ]);
  });
});
