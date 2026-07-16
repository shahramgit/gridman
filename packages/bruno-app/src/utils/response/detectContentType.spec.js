const { detectContentTypeFromBase64, detectStructuredTextType } = require('./index');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('detectContentTypeFromBase64 — structured text sniffing', () => {
  it('detects a JSON object without a content type', () => {
    expect(detectContentTypeFromBase64(b64('{"ok": true, "items": []}'))).toBe('application/json');
  });

  it('detects a JSON object with leading whitespace', () => {
    expect(detectContentTypeFromBase64(b64('\n  \t {"a":1}'))).toBe('application/json');
  });

  it('detects a UTF-8 BOM prefixed JSON object', () => {
    expect(detectContentTypeFromBase64(b64('﻿{"a":1}'))).toBe('application/json');
  });

  it('detects JSON arrays of objects, strings and numbers', () => {
    expect(detectContentTypeFromBase64(b64('[{"a":1}]'))).toBe('application/json');
    expect(detectContentTypeFromBase64(b64('["x","y"]'))).toBe('application/json');
    expect(detectContentTypeFromBase64(b64('[1, 2, 3]'))).toBe('application/json');
    expect(detectContentTypeFromBase64(b64('[true, null]'))).toBe('application/json');
    expect(detectContentTypeFromBase64(b64('[]'))).toBe('application/json');
    expect(detectContentTypeFromBase64(b64('[-1.5]'))).toBe('application/json');
  });

  it('does NOT flag bracketed log lines as JSON', () => {
    expect(detectContentTypeFromBase64(b64('[INFO] application started'))).toBe('text/plain');
    expect(detectContentTypeFromBase64(b64('[WARN] low disk space'))).toBe('text/plain');
  });

  it('detects XML via prolog and via tag shape', () => {
    expect(detectContentTypeFromBase64(b64('<?xml version="1.0"?><root/>'))).toBe('application/xml');
    expect(detectContentTypeFromBase64(b64('<soap:Envelope xmlns:soap="x"><soap:Body/></soap:Envelope>')))
      .toBe('application/xml');
  });

  it('detects HTML documents', () => {
    expect(detectContentTypeFromBase64(b64('<!DOCTYPE html><html><body>hi</body></html>'))).toBe('text/html');
    expect(detectContentTypeFromBase64(b64('<html lang="en"><head></head></html>'))).toBe('text/html');
  });

  it('keeps SVG detection ahead of generic XML', () => {
    expect(detectContentTypeFromBase64(b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
  });

  it('falls back to text/plain for prose', () => {
    expect(detectContentTypeFromBase64(b64('hello world, plain text here'))).toBe('text/plain');
  });

  it('still detects binary magic bytes first (pdf, png)', () => {
    expect(detectContentTypeFromBase64(Buffer.from('%PDF-1.4 rest-of-doc', 'utf8').toString('base64')))
      .toBe('application/pdf');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    expect(detectContentTypeFromBase64(png.toString('base64'))).toBe('image/png');
  });
});

describe('detectStructuredTextType edge cases', () => {
  it('returns null for a lone bracket, empty and non-text buffers', () => {
    expect(detectStructuredTextType(Buffer.from('[', 'utf8'))).toBe(null);
    expect(detectStructuredTextType(Buffer.alloc(0))).toBe(null);
    expect(detectStructuredTextType(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x01, 0x02]))).toBe(null);
  });

  it('returns null for a tag-like start with no closing tag evidence', () => {
    expect(detectStructuredTextType(Buffer.from('<3 love this API', 'utf8'))).toBe(null);
  });
});
