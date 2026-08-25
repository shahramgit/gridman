import postmanToBruno from '../src/postman/postman-to-bruno.js';

/**
 * A BINARY BODY SURVIVES A POSTMAN IMPORT.
 *
 * Postman's `mode: "file"` was simply unhandled, so the body fell through as `mode: 'none'`
 * and the request arrived with no file at all — silently, because the rest of the request
 * imported fine. usebruno/bruno#8729.
 */
const collection = (body) => ({
  info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{
    name: 'Upload',
    request: {
      method: 'POST',
      header: [],
      url: { raw: 'https://api.test/upload', protocol: 'https', host: ['api', 'test'], path: ['upload'] },
      body
    }
  }]
});

describe('importing a Postman binary body', () => {
  it('keeps the file, which used to be dropped entirely', async () => {
    const out = await postmanToBruno(collection({ mode: 'file', file: { src: '/tmp/report.pdf' } }));
    const body = out.items[0].request.body;

    // This was 'none'.
    expect(body.mode).toBe('file');
    expect(body.file).toHaveLength(1);
    expect(body.file[0].filePath).toBe('/tmp/report.pdf');
    expect(body.file[0].selected).toBe(true);
  });

  it.each([
    ['/tmp/report.pdf', 'application/pdf'],
    ['/tmp/data.json', 'application/json'],
    ['/tmp/image.png', 'image/png']
  ])('infers a content type from %s', async (src, expected) => {
    const out = await postmanToBruno(collection({ mode: 'file', file: { src } }));
    expect(out.items[0].request.body.file[0].contentType).toBe(expected);
  });

  it.each([
    ['no extension', '/tmp/rawblob'],
    ['unknown extension', '/tmp/thing.zzzz'],
    ['missing src', undefined]
  ])('falls back to octet-stream for %s', async (_label, src) => {
    // RFC 2046 4.5.1 — the correct default when the type cannot be determined.
    const out = await postmanToBruno(collection({ mode: 'file', file: src ? { src } : {} }));
    expect(out.items[0].request.body.file[0].contentType).toBe('application/octet-stream');
  });

  it('does not disturb other body modes', async () => {
    const out = await postmanToBruno(collection({ mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } }));
    expect(out.items[0].request.body.mode).toBe('json');
  });
});
