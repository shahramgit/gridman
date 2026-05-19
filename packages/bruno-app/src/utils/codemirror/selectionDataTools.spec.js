const { describe, it, expect } = require('@jest/globals');

import {
  detectBase64ImageMimeType,
  getSelectionDataToolState,
  getSelectionImagePreview,
  isLikelyBase64
} from './selectionDataTools';

describe('selectionDataTools', () => {
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
});
