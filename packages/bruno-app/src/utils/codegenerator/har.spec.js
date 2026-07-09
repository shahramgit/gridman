import { buildHarRequest } from './har';

// jsdom's URL does not implement canParse (available in browsers/Electron).
if (typeof URL.canParse !== 'function') {
  URL.canParse = (url) => {
    try {
      new URL(url);
      return true;
    } catch (error) {
      return false;
    }
  };
}

describe('buildHarRequest', () => {
  const makeRequest = (overrides = {}) => ({
    method: 'POST',
    url: 'https://api.example.com/users',
    params: [],
    body: { mode: 'json', json: '{"name": "bruno"}' },
    ...overrides
  });

  it('preserves the original casing of header names', () => {
    const har = buildHarRequest({
      request: makeRequest(),
      headers: [
        { name: 'Content-Type', value: 'application/json', enabled: true },
        { name: 'X-API-Key', value: 'secret', enabled: true },
        { name: 'x-lower-key', value: 'still-lower', enabled: true },
        { name: 'Disabled-Header', value: 'nope', enabled: false }
      ]
    });

    expect(har.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-API-Key', value: 'secret' },
      { name: 'x-lower-key', value: 'still-lower' }
    ]);
  });

  it('does not duplicate content-type when it exists with different casing', () => {
    const har = buildHarRequest({
      request: makeRequest(),
      headers: [{ name: 'CONTENT-TYPE', value: 'application/json', enabled: true }]
    });

    const contentTypeHeaders = har.headers.filter((header) => header.name.toLowerCase() === 'content-type');
    expect(contentTypeHeaders).toEqual([{ name: 'CONTENT-TYPE', value: 'application/json' }]);
  });

  it('still injects a content-type header derived from the body mode when missing', () => {
    const har = buildHarRequest({
      request: makeRequest(),
      headers: [{ name: 'X-API-Key', value: 'secret', enabled: true }]
    });

    expect(har.headers).toContainEqual({ name: 'content-type', value: 'application/json' });
  });

  it('generates a cURL snippet containing mixed-case header names verbatim', () => {
    const { HTTPSnippet } = require('httpsnippet');

    const har = buildHarRequest({
      request: makeRequest(),
      headers: [
        { name: 'Content-Type', value: 'application/json', enabled: true },
        { name: 'X-API-Key', value: 'secret', enabled: true }
      ]
    });

    const curl = new HTTPSnippet(har).convert('shell', 'curl');

    expect(curl).toContain('Content-Type: application/json');
    expect(curl).toContain('X-API-Key: secret');
    expect(curl).not.toContain('x-api-key');
  });
});
