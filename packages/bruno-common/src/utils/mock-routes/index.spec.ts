import { extractMockRoutePath, getMockResponseRouteKey } from './index';

/**
 * Ported verbatim from upstream's url spec alongside the two functions
 * themselves, so the route normalization a mock server depends on is pinned to
 * the same behaviour theirs has.
 */

describe('extractMockRoutePath', () => {
  it('strips hosts and variables from mock endpoint urls', () => {
    expect(extractMockRoutePath('{{baseUrl}}/breeds')).toBe('/breeds');
    expect(extractMockRoutePath('google.com/test')).toBe('/test');
    expect(extractMockRoutePath('https://api.example.com/v1/users')).toBe('/v1/users');
    expect(extractMockRoutePath('localhost:8080/api')).toBe('/api');
    expect(extractMockRoutePath('pets')).toBe('/pets');
    expect(extractMockRoutePath('{{baseUrl}}/users/:userId')).toBe('/users/:userId');
  });

  it('falls back to path when absolute URL has a templated host', () => {
    expect(extractMockRoutePath('https://{{host}}/v1/items')).toBe('/v1/items');
  });

  it('keeps `{{var}}` intact when preserveTemplateVars is set', () => {
    expect(extractMockRoutePath('{{baseUrl}}/users/{{userId}}', { preserveTemplateVars: true }))
      .toBe('/users/{{userId}}');
    expect(extractMockRoutePath('https://api.example.com/v1/{{resource}}', { preserveTemplateVars: true }))
      .toBe('/v1/{{resource}}');
  });
});

describe('getMockResponseRouteKey', () => {
  it('builds method + normalized path + status keys', () => {
    expect(getMockResponseRouteKey({
      request: { method: 'get', url: 'https://api.example.com/users' },
      response: { status: 200 }
    })).toBe('GET /users::200');
  });
});

/**
 * Cases upstream's four do not reach.
 *
 * This function decides which stored response an incoming request is served,
 * so a normalization difference is not cosmetic — it is the wrong body, or a
 * 404 where a mock exists. The real collections these run against are
 * `{{baseUrl}}/...` throughout with query strings on nearly every request.
 */
describe('extractMockRoutePath — the shapes real collections use', () => {
  it.each([
    ['{{baseUrl}}/api/v1/users', '/api/v1/users'],
    ['{{baseUrl}}/api/v1/users?page=2&size=50', '/api/v1/users'],
    ['https://api.example.internal/v1/users?q=x#frag', '/v1/users'],
    ['api.example.internal/v1/users', '/v1/users'],
    ['localhost:3000/health', '/health'],
    ['127.0.0.1:8080/health', '/health'],
    ['{{baseUrl}}', '/'],
    ['', '/'],
    ['{{baseUrl}}/api//v1///users', '/api/v1/users'],
    ['{{baseUrl}}/api/v1/users/', '/api/v1/users']
  ])('%s -> %s', (input, expected) => {
    expect(extractMockRoutePath(input)).toBe(expected);
  });

  it('turns path variables into express params so a route can match many ids', () => {
    expect(extractMockRoutePath('{{baseUrl}}/users/{{userId}}/orders/{{orderId}}'))
      .toBe('/users/:userId/orders/:orderId');
  });

  it('keeps a percent-encoded template var readable when preserving', () => {
    // The URL bar encodes braces; the persisted form has to read back as the
    // user typed it or the settings screen shows mojibake.
    expect(extractMockRoutePath('{{baseUrl}}/users/%7B%7BuserId%7D%7D', { preserveTemplateVars: true }))
      .toBe('/users/{{userId}}');
  });

  it('does not throw on values that are not strings', () => {
    expect(extractMockRoutePath(null)).toBe('/');
    expect(extractMockRoutePath(undefined)).toBe('/');
    expect(extractMockRoutePath(42)).toBe('/42');
  });
});

describe('getMockResponseRouteKey — two responses collide only when they should', () => {
  const key = (method: string, url: string, status?: number) =>
    getMockResponseRouteKey({ request: { method, url }, response: status === undefined ? null : { status } });

  it('separates the same path by method and by status', () => {
    expect(key('GET', '{{baseUrl}}/users', 200)).not.toBe(key('POST', '{{baseUrl}}/users', 200));
    expect(key('GET', '{{baseUrl}}/users', 200)).not.toBe(key('GET', '{{baseUrl}}/users', 404));
  });

  it('collapses URLs that differ only in host, query, or trailing slash', () => {
    const canonical = key('GET', '{{baseUrl}}/users', 200);
    expect(key('get', 'https://api.example.internal/users?page=1', 200)).toBe(canonical);
    expect(key('GET', '{{host}}/users/', 200)).toBe(canonical);
  });

  it('defaults a missing method and status rather than producing an unmatchable key', () => {
    expect(key(undefined as unknown as string, '{{baseUrl}}/users')).toBe('GET /users::200');
  });
});
