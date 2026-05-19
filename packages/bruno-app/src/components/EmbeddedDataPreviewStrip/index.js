import React, { useMemo, useState } from 'react';
import {
  findDataImageCandidates,
  formatEmbeddedMediaByteSize
} from 'utils/codemirror/embeddedMediaPreview';

const MAX_SCAN_LENGTH = 2 * 1024 * 1024;
const MAX_IMAGES = 8;

const stringifyPreviewData = (data) => {
  if (data === null || data === undefined) {
    return '';
  }
  if (typeof data === 'string') {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
};

const getEmbeddedImages = (data) => {
  const text = stringifyPreviewData(data);
  const candidates = findDataImageCandidates(text.slice(0, MAX_SCAN_LENGTH));
  const seen = new Set();

  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.dataUrl)) {
        return false;
      }
      seen.add(candidate.dataUrl);
      return true;
    })
    .slice(0, MAX_IMAGES);
};

const EmbeddedDataPreviewStrip = ({ data }) => {
  const [copiedIndex, setCopiedIndex] = useState(null);
  const images = useMemo(() => getEmbeddedImages(data), [data]);

  if (!images.length) {
    return null;
  }

  const copyImage = async (dataUrl, index) => {
    try {
      await navigator.clipboard.writeText(dataUrl);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1200);
    } catch {
      setCopiedIndex(null);
    }
  };

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-neutral-900 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-gray-500">
          Embedded images
        </div>
        <div className="text-xs text-gray-500">
          {images.length === MAX_IMAGES ? `${MAX_IMAGES}+ found` : `${images.length} found`}
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {images.map((image, index) => (
          <div key={`${image.start}-${index}`} className="min-w-[160px] max-w-[220px]">
            <button
              type="button"
              className="block w-full overflow-hidden rounded border border-gray-200 bg-white p-2 text-left shadow-sm hover:border-orange-300 dark:border-gray-700 dark:bg-neutral-800"
              onClick={() => copyImage(image.dataUrl, index)}
              title="Click to copy data URL"
            >
              <img
                src={image.dataUrl}
                alt={`Embedded image ${index + 1}`}
                className="mx-auto h-24 max-w-full object-contain"
              />
              <div className="mt-2 truncate text-xs text-gray-600 dark:text-gray-300">
                {image.mimeType}
              </div>
              <div className="text-xs text-gray-500">
                {copiedIndex === index ? 'Copied' : formatEmbeddedMediaByteSize(image.byteSize)}
              </div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default EmbeddedDataPreviewStrip;
