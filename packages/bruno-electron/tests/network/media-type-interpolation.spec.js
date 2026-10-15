const electronInterpolate = require('../../src/ipc/network/interpolate-vars');
const cliInterpolate = require('../../../bruno-cli/src/runner/interpolate-vars');

describe.each([['Electron', electronInterpolate], ['CLI', cliInterpolate]])('%s media type interpolation', (_mode, interpolate) => {
  it.each(['application/x-www-form-urlencoded; charset=UTF-8', 'Application/X-WWW-Form-Urlencoded'])('interpolates encoded form fields and raw text under %s', (contentType) => {
    const request = { method: 'POST', url: 'http://example.test', headers: { 'content-type': contentType }, data: [{ name: 'token', value: '{{token}}' }] };
    expect(interpolate(request, { token: 'value' }).data[0].value).toBe('value');
    request.data = 'token={{token}}';
    expect(interpolate(request, { token: 'value' }).data).toBe('token=value');
  });

  it('interpolates multiline multipart fields when a boundary contains json', () => {
    const request = { method: 'POST', url: 'http://example.test', headers: { 'content-type': 'Multipart/Form-Data; boundary=json' }, data: [{ name: 'note', value: '{{note}}' }] };
    expect(interpolate(request, { note: 'first\nsecond' }).data[0].value).toBe('first\nsecond');
  });

  it('recognizes mixed-case JSON and keeps Buffer bodies intact', () => {
    const request = { method: 'POST', url: 'http://example.test', headers: { 'content-type': 'Application/JSON' }, data: { note: '{{note}}' } };
    expect(interpolate(request, { note: 'value' }).data).toEqual({ note: 'value' });
    const body = Buffer.from('{{note}}');
    request.data = body;
    expect(interpolate(request, { note: 'value' }).data).toBe(body);
  });
});
