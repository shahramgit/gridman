const { describe, it, expect } = require('@jest/globals');
const interpolateVars = require('../../src/runner/interpolate-vars');

describe('interpolate-vars: interpolateVars', () => {
  it('keeps stream-backed JSON request bodies intact', () => {
    const streamPayload = {
      pipe: jest.fn(),
      path: '/tmp/allocations.json'
    };
    const request = {
      method: 'POST',
      mode: 'file',
      url: 'http://api.example/upload',
      headers: { 'content-type': 'application/json' },
      data: streamPayload
    };

    const result = interpolateVars(request, { shouldNotApply: 'value' }, null, null);
    expect(result.data).toBe(streamPayload);
  });

  it('preserves raw string body when Content-Type is multipart/mixed', () => {
    const rawMultipartBody = [
      '--TestBoundary123',
      'Content-Type: application/json',
      '',
      '{"test": true}',
      '--TestBoundary123--',
      ''
    ].join('\r\n');

    const request = {
      method: 'POST',
      mode: 'text',
      url: 'https://httpbin.dev/post',
      headers: { 'content-type': 'multipart/mixed; boundary=TestBoundary123' },
      data: rawMultipartBody
    };

    const result = interpolateVars(request, {}, null, null);
    expect(result.data).toBe(rawMultipartBody);
  });

  it('interpolates variables in raw multipart/mixed string body', () => {
    const boundary = 'CustomBoundary123';
    const rawMultipartBody = [
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Token: {{token}}',
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      '{"id": "{{id}}", "msg": "{{msg}}"}',
      `--${boundary}--`,
      ''
    ].join('\r\n');

    const request = {
      method: 'POST',
      mode: 'text',
      url: 'https://api.example/send',
      headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
      data: rawMultipartBody
    };

    const result = interpolateVars(request, { token: 'abc123', id: 42, msg: 'hello' }, null, null);
    expect(result.data).toContain('Token: abc123');
    expect(result.data).toContain('{"id": "42", "msg": "hello"}');
    expect(result.data).toContain(`--${boundary}`);
    expect(result.data).toContain(`--${boundary}--`);
  });
});

describe('interpolate-vars: api key header name sidecar', () => {
  it('interpolates apiKeyHeaderName in lockstep with interpolated header keys', () => {
    const request = {
      url: 'https://example.com',
      mode: 'none',
      headers: {
        '{{api_header_name}}': '{{api_key_value}}'
      },
      apiKeyHeaderName: '{{api_header_name}}',
      pathParams: []
    };

    interpolateVars(
      request,
      {
        api_header_name: 'X-API-Key',
        api_key_value: 'secret-key-value'
      },
      {},
      {}
    );

    expect(request.headers).toEqual({
      'X-API-Key': 'secret-key-value'
    });
    expect(request.apiKeyHeaderName).toEqual('X-API-Key');
  });
});

// The GUI (bruno-electron) and `bru run` must build the same URL from the same request. A
// `:segment` is only substituted when the matching path param row is enabled AND carries a value;
// on mere existence a disabled or blank row collapsed `/anything/:id` to `/anything/`, so the CLI
// silently hit a different endpoint than the app.
// Upstream fix: usebruno/bruno#8157 (07c734866, BRU-3246). Mirrors the cases in
// packages/bruno-electron/tests/network/interpolate-vars.spec.js.
describe('interpolate-vars: path params must be enabled and non-blank', () => {
  it('substitutes an enabled path param with a value', () => {
    const request = {
      method: 'GET',
      url: 'https://httpbin.org/anything/:test-segment',
      pathParams: [{ type: 'path', name: 'test-segment', value: 'foobar' }]
    };

    expect(interpolateVars(request, null, null, null).url).toBe('https://httpbin.org/anything/foobar');
  });

  it('keeps the colon segment when the path param value is empty', () => {
    const request = {
      method: 'POST',
      url: 'https://httpbin.org/anything/:test-segment',
      pathParams: [{ type: 'path', name: 'test-segment', value: '' }]
    };

    expect(interpolateVars(request, null, null, null).url).toBe('https://httpbin.org/anything/:test-segment');
  });

  it('keeps the colon segment when the path param value is whitespace only', () => {
    const request = {
      method: 'GET',
      url: 'https://httpbin.org/anything/:test-segment',
      pathParams: [{ type: 'path', name: 'test-segment', value: '   ' }]
    };

    expect(interpolateVars(request, null, null, null).url).toBe('https://httpbin.org/anything/:test-segment');
  });

  it('keeps the colon segment when the path param row is disabled', () => {
    const request = {
      method: 'POST',
      url: 'https://httpbin.org/anything/:test-segment',
      pathParams: [{ type: 'path', name: 'test-segment', value: 'replaced', enabled: false }]
    };

    expect(interpolateVars(request, null, null, null).url).toBe('https://httpbin.org/anything/:test-segment');
  });

  it('keeps odata style params when the matching row is disabled or blank', () => {
    const request = {
      method: 'GET',
      url: 'http://example.com/Category(\':CategoryID\')/Item(:ItemId)',
      pathParams: [
        { type: 'path', name: 'CategoryID', value: 'foobar', enabled: false },
        { type: 'path', name: 'ItemId', value: '' }
      ]
    };

    expect(interpolateVars(request, null, null, null).url).toBe(
      'http://example.com/Category(\':CategoryID\')/Item(:ItemId)'
    );
  });

  it('still substitutes a falsy but meaningful value like 0', () => {
    const request = {
      method: 'GET',
      url: 'http://example.com/item/:id',
      pathParams: [{ type: 'path', name: 'id', value: 0 }]
    };

    expect(interpolateVars(request, null, null, null).url).toBe('http://example.com/item/0');
  });
});
