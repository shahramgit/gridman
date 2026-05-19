const { describe, it, expect } = require('@jest/globals');

import { findDataImageCandidates, getDataImageMetadata } from './embeddedMediaPreview';

describe('embeddedMediaPreview', () => {
  it('finds embedded data image URLs inside text', () => {
    const line = 'avatar: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="';

    expect(findDataImageCandidates(line)).toEqual([
      expect.objectContaining({
        start: 9,
        prefixEnd: 31,
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
        mimeType: 'image/png'
      })
    ]);
  });

  it('ignores non-image data URLs', () => {
    const line = 'payload: "data:application/pdf;base64,JVBERi0xLjQK"';

    expect(findDataImageCandidates(line)).toEqual([]);
  });

  it('returns image metadata for supported data image URLs', () => {
    expect(getDataImageMetadata('data:image/webp;base64,AAAA')).toEqual({
      prefix: 'data:image/webp;base64,',
      mimeType: 'image/webp',
      byteSize: 3
    });
  });
});
