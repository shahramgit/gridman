const { describe, it, expect } = require('@jest/globals');

import {
  detectBase64ImageMimeType,
  getSelectionDataToolState,
  getSelectionImagePreview,
  getSelectionJwtDetails,
  isLikelyBase64
} from './selectionDataTools';

describe('selectionDataTools', () => {
  const jwt = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjMiLCJuYW1lIjoiR3JpZG1hbiJ9',
    'signature'
  ].join('.');

  it('detects likely base64 text', () => {
    expect(isLikelyBase64('SGVsbG8=')).toBe(true);
    expect(isLikelyBase64('not base64')).toBe(false);
  });

  it('decodes and encodes base64 selections', () => {
    const tools = getSelectionDataToolState('SGVsbG8gR3JpZG1hbg==');

    expect(tools.canDecodeBase64).toBe(true);
    expect(tools.decodeBase64()).toBe('Hello Gridman');
    expect(tools.byteSize).toBe(13);
    expect(getSelectionDataToolState('Hello Gridman').encodeBase64()).toBe('SGVsbG8gR3JpZG1hbg==');
  });

  it('detects data image selections', () => {
    expect(getSelectionImagePreview('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png'
    });
  });

  it('detects quoted data image selections from JSON strings', () => {
    expect(getSelectionImagePreview('"data:image/png;base64,iVBORw0KGgo="')).toEqual({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png'
    });
  });

  it('detects plain base64 image selections by magic bytes', () => {
    expect(detectBase64ImageMimeType('iVBORw0KGgo=')).toBe('image/png');
    expect(getSelectionImagePreview('iVBORw0KGgo=')).toEqual({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png'
    });
  });

  it('does not preview non-image base64 as an image', () => {
    expect(getSelectionImagePreview('SGVsbG8gR3JpZG1hbg==')).toBe(null);
  });

  it('decodes jwt selections', () => {
    const tools = getSelectionDataToolState(jwt);

    expect(tools.canDecodeJwt).toBe(true);
    expect(tools.jwt.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(tools.jwt.payload).toEqual({ sub: '123', name: 'Gridman' });
    expect(tools.decodeJwt()).toContain('"name": "Gridman"');
  });

  it('decodes bearer jwt selections', () => {
    expect(getSelectionJwtDetails(`Bearer ${jwt}`)?.payload.name).toBe('Gridman');
  });

  it('decodes and encodes url selections', () => {
    const decoded = getSelectionDataToolState('hello%20gridman%2Fapi');
    const encoded = getSelectionDataToolState('hello gridman/api');

    expect(decoded.canDecodeUrl).toBe(true);
    expect(decoded.decodeUrl()).toBe('hello gridman/api');
    expect(encoded.canDecodeUrl).toBe(false);
    expect(encoded.encodeUrl()).toBe('hello%20gridman%2Fapi');
  });
});
