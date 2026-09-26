import { decideInitialResponseFormat } from 'utils/response';
import { getContentType } from 'utils/common';

// Reported against 4.1.0-vasl.5: a JSON response from a national-gateway API
// opened as Raw. Its body carries a Persian message, and the body sniffer
// counted only ASCII bytes as text — Persian is two non-ASCII bytes per
// letter, so this body read as ~75% "binary" and was never recognised as JSON.
const REPORTED_BODY = '{"result":{"data":{"code":200,"msg":"درخواست با موفقیت ثبت شد"},"status":{"statusCode":200,"message":"OK"}},"status":{"statusCode":200,"message":"OK"}}';
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const formatFor = (contentType, body = REPORTED_BODY) =>
  decideInitialResponseFormat(base64(body), contentType === null ? {} : { 'content-type': contentType }, getContentType).initialFormat;

describe('initial response format', () => {
  it.each([
    [null],
    ['text/plain; charset=utf-8'],
    ['application/octet-stream']
  ])('opens the reported Persian JSON body as JSON under %s', (contentType) => {
    expect(formatFor(contentType)).toBe('json');
  });

  it.each([
    ['application/x-json'],
    ['text/x-json'],
    ['application/vnd.msb.v1'],
    ['*/*']
  ])('opens JSON as JSON when %s names no format we render', (contentType) => {
    expect(formatFor(contentType)).toBe('json');
  });

  it('still honours a header that names a real format', () => {
    expect(formatFor('text/html;charset=UTF-8', '<!doctype html><html><body>{}</body></html>')).toBe('html');
    expect(formatFor('application/json')).toBe('json');
  });

  it('leaves prose as Raw, in any script', () => {
    expect(formatFor('text/plain; charset=utf-8', 'درخواست با موفقیت ثبت شد و کد رهگیری صادر گردید')).toBe('raw');
    expect(formatFor(null, '[INFO] request accepted')).toBe('raw');
  });

  it('does not mistake binary for text', () => {
    const noise = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 131 + 7) % 256)).toString('base64');
    const result = decideInitialResponseFormat(noise, { 'content-type': 'application/octet-stream' }, getContentType);
    expect(result.initialFormat).not.toBe('json');
  });
});
