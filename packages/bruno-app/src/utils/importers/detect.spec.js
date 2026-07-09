import { detectCollectionFormat, parseRawCollectionText } from './detect';

describe('parseRawCollectionText', () => {
  it('parses JSON text', () => {
    expect(parseRawCollectionText('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses YAML text', () => {
    expect(parseRawCollectionText('openapi: 3.0.0\ninfo:\n  title: x')).toEqual({
      openapi: '3.0.0',
      info: { title: 'x' }
    });
  });

  it('returns XML content as raw text', () => {
    const wsdl = '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"></wsdl:definitions>';
    expect(parseRawCollectionText(wsdl)).toBe(wsdl);
  });

  it('throws on empty content', () => {
    expect(() => parseRawCollectionText('   ')).toThrow('Content is empty');
  });

  it('throws on non-JSON/YAML content', () => {
    expect(() => parseRawCollectionText('just some words: [unbalanced')).toThrow(
      'ensure it is valid JSON or YAML'
    );
  });
});

describe('detectCollectionFormat', () => {
  it('detects a Postman collection', () => {
    const data = {
      info: {
        name: 'My Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: []
    };
    expect(detectCollectionFormat(data)).toBe('postman');
  });

  it('detects an OpenAPI spec', () => {
    expect(detectCollectionFormat({ openapi: '3.0.0', info: { title: 'x' }, paths: {} })).toBe('openapi');
  });

  it('detects an Insomnia export', () => {
    expect(detectCollectionFormat({ _type: 'export', __export_format: 4, resources: [] })).toBe('insomnia');
  });

  it('detects a WSDL document from raw text', () => {
    const wsdl = '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"></wsdl:definitions>';
    expect(detectCollectionFormat(wsdl)).toBe('wsdl');
  });

  it('returns null for unrecognized content', () => {
    expect(detectCollectionFormat({ hello: 'world' })).toBe(null);
  });
});
