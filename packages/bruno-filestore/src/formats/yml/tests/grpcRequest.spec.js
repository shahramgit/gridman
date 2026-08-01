import parseItem from '../parseItem';
import stringifyItem from '../stringifyItem';

const buildGrpcItem = (messages) => ({
  uid: 'item-uid',
  type: 'grpc-request',
  name: 'Chat',
  seq: 1,
  tags: [],
  request: {
    url: 'grpc://localhost:50051',
    method: '/chat.Chat/Talk',
    methodType: 'bidi-streaming',
    protoPath: null,
    headers: [],
    auth: null,
    body: {
      mode: 'grpc',
      grpc: messages
    },
    script: { req: null, res: null },
    vars: { req: [], res: [] },
    assertions: [],
    tests: null,
    docs: null
  }
});

// A streaming gRPC request holds several messages. Only the first used to be written
// to the yml file, so the rest were gone the next time the request was opened.
describe('yml grpc request - messages', () => {
  it('round trips every message of a streaming request', () => {
    const item = buildGrpcItem([
      { name: 'greeting', content: '{"text":"hello"}' },
      { name: 'follow up', content: '{"text":"how are you"}' },
      { name: 'bye', content: '{"text":"bye"}' }
    ]);

    const parsed = parseItem(stringifyItem(item));

    expect(parsed.request.body.grpc).toEqual([
      { name: 'greeting', content: '{"text":"hello"}' },
      { name: 'follow up', content: '{"text":"how are you"}' },
      { name: 'bye', content: '{"text":"bye"}' }
    ]);
  });

  it('names unnamed messages by position so they stay distinguishable', () => {
    const item = buildGrpcItem([
      { name: '', content: '{"n":1}' },
      { name: '', content: '{"n":2}' }
    ]);

    const parsed = parseItem(stringifyItem(item));

    expect(parsed.request.body.grpc).toEqual([
      { name: 'message 1', content: '{"n":1}' },
      { name: 'message 2', content: '{"n":2}' }
    ]);
  });

  it('keeps an empty message body instead of dropping the message', () => {
    const item = buildGrpcItem([
      { name: 'first', content: '' },
      { name: 'second', content: '{"n":2}' }
    ]);

    const parsed = parseItem(stringifyItem(item));

    expect(parsed.request.body.grpc).toEqual([
      { name: 'first', content: '' },
      { name: 'second', content: '{"n":2}' }
    ]);
  });

  // The list shape is unreadable by older builds, so a request that has always fit the
  // single message shape keeps writing it - only streaming requests need the list. This
  // also keeps the existing yml files of single message requests byte identical.
  it('writes a single message in the scalar shape older builds can read', () => {
    const ymlString = stringifyItem(buildGrpcItem([{ name: 'message 1', content: '{"text":"hello"}' }]));

    expect(ymlString).toContain(`message: '{"text":"hello"}'`);
    expect(ymlString).not.toContain('title:');

    expect(parseItem(ymlString).request.body.grpc).toEqual([{ name: '', content: '{"text":"hello"}' }]);
  });

  it('reads the legacy single-message string shape', () => {
    const legacyYml = `info:
  name: Chat
  type: grpc
  seq: 1

grpc:
  url: grpc://localhost:50051
  method: /chat.Chat/Talk
  message: '{"text":"hello"}'
`;

    const parsed = parseItem(legacyYml);

    expect(parsed.request.body.grpc).toEqual([{ name: '', content: '{"text":"hello"}' }]);
  });
});
