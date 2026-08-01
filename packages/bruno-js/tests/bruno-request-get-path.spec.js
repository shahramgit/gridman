const BrunoRequest = require('../src/bruno-request');

// req.getPath() interpolates path params itself, so it has to apply the same rule as the
// interpolate-vars used to build the URL that is actually sent (bruno-electron and bruno-cli):
// substitute only when the row is enabled AND carries a value. On a plain truthiness check a
// disabled row was substituted (a path the request never hits) while a legitimate `0` was not.
// Upstream fix: usebruno/bruno#8157 (07c734866, BRU-3246).
describe('BrunoRequest.getPath: path params must be enabled and non-blank', () => {
  const makeReq = (pathParams) =>
    new BrunoRequest({
      url: 'https://httpbin.org/anything/:id',
      method: 'GET',
      headers: {},
      pathParams
    });

  it('substitutes an enabled path param with a value', () => {
    expect(makeReq([{ type: 'path', name: 'id', value: 'foobar' }]).getPath()).toBe('/anything/foobar');
  });

  it('substitutes an explicitly enabled path param', () => {
    expect(makeReq([{ type: 'path', name: 'id', value: 'foobar', enabled: true }]).getPath()).toBe(
      '/anything/foobar'
    );
  });

  it('keeps the colon segment when the row is disabled', () => {
    expect(makeReq([{ type: 'path', name: 'id', value: 'foobar', enabled: false }]).getPath()).toBe('/anything/:id');
  });

  it('keeps the colon segment when the value is empty', () => {
    expect(makeReq([{ type: 'path', name: 'id', value: '' }]).getPath()).toBe('/anything/:id');
  });

  it('keeps the colon segment when the value is whitespace only', () => {
    expect(makeReq([{ type: 'path', name: 'id', value: '   ' }]).getPath()).toBe('/anything/:id');
  });

  it('keeps the colon segment when there is no matching row', () => {
    expect(makeReq([{ type: 'path', name: 'other', value: 'foobar' }]).getPath()).toBe('/anything/:id');
  });

  it('substitutes a falsy but meaningful value like 0', () => {
    expect(makeReq([{ type: 'path', name: 'id', value: 0 }]).getPath()).toBe('/anything/0');
  });

  it('leaves the path alone when the request has no path params', () => {
    expect(makeReq(undefined).getPath()).toBe('/anything/:id');
  });
});
