import { debounce } from 'lodash';

const DATA_IMAGE_PREFIX = /data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i;
const BASE64_CHARS = /^[A-Za-z0-9+/=]+$/;
const DATA_IMAGE_CANDIDATE = /data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,/ig;

const getVisibleLineRange = (editor, padding = 3) => {
  const doc = editor.getDoc();
  const scroll = editor.getScrollInfo();
  const topLine = editor.lineAtHeight(scroll.top, 'local');
  const bottomLine = editor.lineAtHeight(scroll.top + scroll.clientHeight, 'local');

  return {
    from: Math.max(0, topLine - padding),
    to: Math.min(doc.lineCount(), bottomLine + padding + 1)
  };
};

export const getDataImageMetadata = (dataUrl) => {
  if (typeof dataUrl !== 'string') {
    return null;
  }

  const prefixMatch = dataUrl.match(DATA_IMAGE_PREFIX);
  if (!prefixMatch || prefixMatch.index !== 0) {
    return null;
  }

  const prefix = prefixMatch[0];
  const mimeType = prefix.slice('data:'.length, -';base64,'.length);
  const base64 = dataUrl.slice(prefix.length);

  return {
    prefix,
    mimeType,
    byteSize: Math.floor((base64.replace(/=+$/, '').length * 3) / 4)
  };
};

export const findDataImageCandidates = (lineContent) => {
  if (typeof lineContent !== 'string' || !lineContent.includes('data:image/')) {
    return [];
  }

  const candidates = [];
  DATA_IMAGE_CANDIDATE.lastIndex = 0;

  let match;
  while ((match = DATA_IMAGE_CANDIDATE.exec(lineContent)) !== null) {
    const start = match.index;
    let end = DATA_IMAGE_CANDIDATE.lastIndex;

    while (end < lineContent.length && BASE64_CHARS.test(lineContent[end])) {
      end += 1;
    }

    const dataUrl = lineContent.slice(start, end);
    const metadata = getDataImageMetadata(dataUrl);

    if (metadata && dataUrl.length > metadata.prefix.length) {
      candidates.push({
        start,
        end,
        prefixEnd: start + metadata.prefix.length,
        dataUrl,
        ...metadata
      });
    }
  }

  return candidates;
};

export const formatEmbeddedMediaByteSize = (bytes) => {
  if (!Number.isFinite(bytes)) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const createPreview = () => {
  const preview = document.createElement('div');
  preview.className = 'CodeMirror-embedded-media-preview';
  preview.style.cssText = [
    'position: fixed',
    'display: none',
    'z-index: 10000',
    'width: min(360px, calc(100vw - 28px))',
    'max-height: min(420px, calc(100vh - 28px))',
    'padding: 10px',
    'border: 1px solid rgba(0,0,0,0.16)',
    'border-radius: 8px',
    'background: #fff',
    'box-shadow: 0 12px 32px rgba(0,0,0,0.22)',
    'color: #262626',
    'font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'font-size: 12px',
    'line-height: 1.4'
  ].join(';');
  preview.innerHTML = `
    <div class="embedded-media-preview-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
      <span class="embedded-media-preview-title" style="font-weight:600;">Image preview</span>
      <button type="button" class="embedded-media-preview-copy" style="border:1px solid rgba(0,0,0,0.14);border-radius:6px;background:#f7f7f7;color:#262626;padding:3px 8px;cursor:pointer;font:inherit;">Copy</button>
    </div>
    <img class="embedded-media-preview-image" alt="Embedded image preview" style="display:block;max-width:100%;max-height:300px;object-fit:contain;margin:0 auto;border-radius:6px;background:#f4f4f4;" />
    <div class="embedded-media-preview-meta" style="margin-top:8px;color:#666;word-break:break-word;"></div>
  `;

  document.body.appendChild(preview);
  return preview;
};

const positionPreview = (preview, event) => {
  const margin = 14;
  const rect = preview.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY + margin;

  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, event.clientX - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, event.clientY - rect.height - margin);
  }

  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
};

const showPreview = (preview, media, event) => {
  const image = preview.querySelector('.embedded-media-preview-image');
  const meta = preview.querySelector('.embedded-media-preview-meta');
  const copy = preview.querySelector('.embedded-media-preview-copy');

  image.src = media.dataUrl;
  meta.textContent = `${media.mimeType} · ${formatEmbeddedMediaByteSize(media.byteSize)}`;
  copy.onclick = async (copyEvent) => {
    copyEvent.preventDefault();
    copyEvent.stopPropagation();
    try {
      await navigator.clipboard.writeText(media.dataUrl);
      copy.textContent = 'Copied';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1200);
    } catch (e) {
      copy.textContent = 'Failed';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1200);
    }
  };

  preview.style.display = 'block';
  positionPreview(preview, event);
};

const hidePreview = (preview) => {
  preview.style.display = 'none';
};

const markDataImages = (editor, mediaById) => {
  const doc = editor.getDoc();
  const { from: fromLine, to: toLine } = getVisibleLineRange(editor, 3);

  editor.operation(() => {
    editor.getAllMarks().forEach((mark) => {
      if (mark.className !== 'CodeMirror-embedded-media') return;

      const pos = mark.find?.();
      if (!pos || (pos.to.line >= fromLine && pos.from.line < toLine)) {
        mark.clear();
      }
    });

    for (let lineNum = fromLine; lineNum < toLine; lineNum++) {
      const lineContent = doc.getLine(lineNum);
      const candidates = findDataImageCandidates(lineContent);

      candidates.forEach((candidate) => {
        const mediaId = `media-${lineNum}-${candidate.start}-${candidate.end}`;
        mediaById.set(mediaId, candidate);

        try {
          editor.markText(
            { line: lineNum, ch: candidate.start },
            { line: lineNum, ch: candidate.prefixEnd },
            {
              className: 'CodeMirror-embedded-media',
              attributes: {
                'data-embedded-media-id': mediaId,
                'title': 'Hover to preview embedded image'
              }
            }
          );
        } catch (e) {
          // Ignore stale positions if the line changes while marks are being applied.
        }
      });
    }
  });
};

export const setupEmbeddedMediaPreview = (editor) => {
  if (!editor) {
    return;
  }

  const editorWrapper = editor.getWrapperElement();
  const mediaById = new Map();
  const preview = createPreview();

  const debouncedMarkDataImages = debounce(() => {
    requestAnimationFrame(() => {
      if (!editorWrapper.offsetParent) return;
      markDataImages(editor, mediaById);
    });
  }, 150);

  const handleMouseMove = (event) => {
    if (!event.target.classList.contains('CodeMirror-embedded-media')) {
      return;
    }

    positionPreview(preview, event);
  };

  const handleMouseOver = (event) => {
    if (!event.target.classList.contains('CodeMirror-embedded-media')) {
      return;
    }

    const mediaId = event.target.getAttribute('data-embedded-media-id');
    const media = mediaById.get(mediaId);
    if (!media) {
      return;
    }

    showPreview(preview, media, event);
  };

  const handleMouseOut = (event) => {
    if (!event.target.classList.contains('CodeMirror-embedded-media')) {
      return;
    }

    if (preview.contains(event.relatedTarget)) {
      return;
    }

    hidePreview(preview);
  };

  const handlePreviewMouseLeave = () => hidePreview(preview);

  editor.on('refresh', debouncedMarkDataImages);
  editor.on('changes', debouncedMarkDataImages);
  editor.on('scroll', debouncedMarkDataImages);
  editorWrapper.addEventListener('mouseover', handleMouseOver);
  editorWrapper.addEventListener('mousemove', handleMouseMove);
  editorWrapper.addEventListener('mouseout', handleMouseOut);
  preview.addEventListener('mouseleave', handlePreviewMouseLeave);

  debouncedMarkDataImages();

  editor._destroyEmbeddedMediaPreview = () => {
    editor.off('refresh', debouncedMarkDataImages);
    editor.off('changes', debouncedMarkDataImages);
    editor.off('scroll', debouncedMarkDataImages);
    editorWrapper.removeEventListener('mouseover', handleMouseOver);
    editorWrapper.removeEventListener('mousemove', handleMouseMove);
    editorWrapper.removeEventListener('mouseout', handleMouseOut);
    preview.removeEventListener('mouseleave', handlePreviewMouseLeave);
    preview.remove();
    mediaById.clear();
  };
};
