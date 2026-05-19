const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

const normalizeBase64 = (value) => String(value || '').replace(/\s+/g, '');
const normalizeSelectedToken = (value) => {
  let token = String(value || '').trim();

  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith('\'') && token.endsWith('\''))
    || (token.startsWith('`') && token.endsWith('`'))
  ) {
    token = token.slice(1, -1);
  }

  return token.replace(/[,;]+$/, '');
};

export const isLikelyBase64 = (value) => {
  const normalized = normalizeBase64(value);
  if (normalized.length < 8 || normalized.length % 4 !== 0) {
    return false;
  }
  return BASE64_RE.test(normalized);
};

const decodeBase64Bytes = (base64) => {
  const normalized = normalizeBase64(base64);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
};

const encodeUtf8ToBase64 = (value) => {
  return btoa(unescape(encodeURIComponent(value)));
};

const decodeBase64ToText = (base64) => {
  const normalized = normalizeBase64(base64);
  const binary = atob(normalized);
  try {
    return decodeURIComponent(escape(binary));
  } catch (e) {
    return binary;
  }
};

export const detectBase64ImageMimeType = (base64) => {
  try {
    const bytes = decodeBase64Bytes(base64);
    const textHead = decodeBase64ToText(base64).slice(0, 256).trimStart().toLowerCase();

    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return 'image/webp';
    if (textHead.startsWith('<svg') || textHead.includes('<svg ')) return 'image/svg+xml';
  } catch (e) {
    return null;
  }

  return null;
};

export const getSelectionImagePreview = (selection) => {
  const trimmed = normalizeSelectedToken(selection);
  const dataImageMatch = trimmed.match(DATA_IMAGE_RE);

  if (dataImageMatch) {
    return {
      dataUrl: `data:${dataImageMatch[1]};base64,${normalizeBase64(dataImageMatch[2])}`,
      mimeType: dataImageMatch[1]
    };
  }

  if (!isLikelyBase64(trimmed)) {
    return null;
  }

  const mimeType = detectBase64ImageMimeType(trimmed);
  if (!mimeType) {
    return null;
  }

  return {
    dataUrl: `data:${mimeType};base64,${normalizeBase64(trimmed)}`,
    mimeType
  };
};

export const getSelectionDataToolState = (selection) => {
  const raw = String(selection || '');
  const trimmed = normalizeSelectedToken(raw);
  const imagePreview = getSelectionImagePreview(trimmed);
  const base64Source = trimmed.match(DATA_IMAGE_RE)?.[2] || trimmed;
  const canDecodeBase64 = isLikelyBase64(base64Source);
  const decodedBytes = canDecodeBase64 ? decodeBase64Bytes(base64Source) : null;

  return {
    raw,
    trimmed,
    imagePreview,
    canDecodeBase64,
    canEncodeBase64: raw.length > 0,
    byteSize: decodedBytes?.length || 0,
    base64Source,
    decodeBase64: () => decodeBase64ToText(base64Source),
    encodeBase64: () => encodeUtf8ToBase64(raw)
  };
};

const createMenu = () => {
  const menu = document.createElement('div');
  menu.className = 'CodeMirror-selection-data-tools-menu';
  menu.style.cssText = [
    'position: fixed',
    'display: none',
    'z-index: 10001',
    'min-width: 190px',
    'padding: 5px',
    'border: 1px solid rgba(0,0,0,0.16)',
    'border-radius: 8px',
    'background: #fff',
    'box-shadow: 0 12px 28px rgba(0,0,0,0.2)',
    'font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'font-size: 13px',
    'color: #262626'
  ].join(';');
  document.body.appendChild(menu);
  return menu;
};

const createImagePreview = () => {
  const preview = document.createElement('div');
  preview.className = 'CodeMirror-selection-data-tools-preview';
  preview.style.cssText = [
    'position: fixed',
    'display: none',
    'z-index: 10002',
    'width: min(440px, calc(100vw - 32px))',
    'max-height: min(520px, calc(100vh - 32px))',
    'padding: 12px',
    'border: 1px solid rgba(0,0,0,0.16)',
    'border-radius: 8px',
    'background: #fff',
    'box-shadow: 0 16px 40px rgba(0,0,0,0.25)',
    'color: #262626'
  ].join(';');
  preview.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
      <strong style="font-size:13px;">Selected image</strong>
      <button type="button" data-close style="border:1px solid rgba(0,0,0,0.14);border-radius:6px;background:#f7f7f7;padding:3px 8px;cursor:pointer;">Close</button>
    </div>
    <img alt="Selected base64 image preview" style="display:block;max-width:100%;max-height:390px;object-fit:contain;margin:0 auto;border-radius:6px;background:#f4f4f4;" />
    <div data-meta style="margin-top:8px;color:#666;font-size:12px;"></div>
  `;
  document.body.appendChild(preview);
  return preview;
};

const createInspectorModal = () => {
  const backdrop = document.createElement('div');
  backdrop.className = 'CodeMirror-selection-data-tools-inspector';
  backdrop.style.cssText = [
    'position: fixed',
    'display: none',
    'inset: 0',
    'z-index: 10003',
    'background: rgba(0,0,0,0.28)',
    'align-items: center',
    'justify-content: center',
    'font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'color: #262626'
  ].join(';');

  const modal = document.createElement('div');
  modal.style.cssText = [
    'width: min(720px, calc(100vw - 32px))',
    'max-height: min(760px, calc(100vh - 32px))',
    'overflow: auto',
    'border: 1px solid rgba(0,0,0,0.16)',
    'border-radius: 10px',
    'background: #fff',
    'box-shadow: 0 24px 70px rgba(0,0,0,0.28)'
  ].join(';');
  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,0.1);">
      <div>
        <strong style="display:block;font-size:15px;">Inspect selection</strong>
        <span data-summary style="display:block;margin-top:3px;color:#666;font-size:12px;"></span>
      </div>
      <button type="button" data-close style="border:1px solid rgba(0,0,0,0.14);border-radius:6px;background:#f7f7f7;padding:5px 10px;cursor:pointer;">Close</button>
    </div>
    <div data-body style="padding:16px;display:flex;flex-direction:column;gap:14px;"></div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return backdrop;
};

const positionElement = (element, event) => {
  const margin = 12;
  const rect = element.getBoundingClientRect();
  let left = event.clientX;
  let top = event.clientY;

  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }

  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
};

const writeClipboard = async (text) => {
  await navigator.clipboard.writeText(text);
};

const formatByteSize = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getSelectionType = (tools) => {
  if (tools.imagePreview && tools.trimmed.match(DATA_IMAGE_RE)) return 'Data URL image';
  if (tools.imagePreview) return 'Base64 image';
  if (tools.canDecodeBase64) return 'Base64';
  return 'Plain text';
};

const addMenuButton = (menu, label, onClick) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = [
    'display:block',
    'width:100%',
    'border:0',
    'border-radius:6px',
    'background:transparent',
    'padding:7px 9px',
    'text-align:left',
    'cursor:pointer',
    'font:inherit',
    'color:inherit'
  ].join(';');
  button.addEventListener('mouseenter', () => {
    button.style.background = '#f3f3f3';
  });
  button.addEventListener('mouseleave', () => {
    button.style.background = 'transparent';
  });
  button.addEventListener('click', async () => {
    await onClick();
    menu.style.display = 'none';
  });
  menu.appendChild(button);
};

const showImagePreview = (preview, imagePreview, event) => {
  preview.querySelector('img').src = imagePreview.dataUrl;
  preview.querySelector('[data-meta]').textContent = imagePreview.mimeType;
  preview.style.display = 'block';
  positionElement(preview, event);
};

const createInspectorButton = (label, onClick, primary = false) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = [
    'border:1px solid rgba(0,0,0,0.12)',
    'border-radius:7px',
    `background:${primary ? '#d97706' : '#fff7ed'}`,
    `color:${primary ? '#fff' : '#c2410c'}`,
    'padding:7px 10px',
    'cursor:pointer',
    'font:inherit',
    'font-size:13px'
  ].join(';');
  button.addEventListener('click', onClick);
  return button;
};

const createInspectorSection = (title, value, { rows = 4 } = {}) => {
  const section = document.createElement('section');
  section.style.cssText = 'display:flex;flex-direction:column;gap:7px;';

  const label = document.createElement('div');
  label.textContent = title;
  label.style.cssText = 'font-weight:700;font-size:12px;text-transform:uppercase;color:#777;letter-spacing:.04em;';

  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  textarea.rows = rows;
  textarea.value = value || '';
  textarea.style.cssText = [
    'width:100%',
    'box-sizing:border-box',
    'resize:vertical',
    'border:1px solid rgba(0,0,0,0.14)',
    'border-radius:8px',
    'background:#fafafa',
    'padding:10px',
    'font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    'font-size:12px',
    'line-height:1.45',
    'color:#2b2b2b'
  ].join(';');

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  actions.appendChild(createInspectorButton(`Copy ${title.toLowerCase()}`, async () => writeClipboard(value || '')));

  section.appendChild(label);
  section.appendChild(textarea);
  section.appendChild(actions);
  return { section, actions };
};

const showInspectorModal = ({ inspector, tools, canReplace, replaceSelection }) => {
  const body = inspector.querySelector('[data-body]');
  const summary = inspector.querySelector('[data-summary]');
  body.innerHTML = '';

  const type = getSelectionType(tools);
  const mimeText = tools.imagePreview?.mimeType ? ` · ${tools.imagePreview.mimeType}` : '';
  const sizeText = tools.byteSize ? ` · ${formatByteSize(tools.byteSize)}` : '';
  summary.textContent = `${type}${mimeText}${sizeText}`;

  const meta = document.createElement('div');
  meta.style.cssText = [
    'display:grid',
    'grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))',
    'gap:8px',
    'font-size:13px'
  ].join(';');
  [
    ['Type', type],
    ['MIME', tools.imagePreview?.mimeType || '-'],
    ['Decoded size', tools.byteSize ? formatByteSize(tools.byteSize) : '-']
  ].forEach(([label, value]) => {
    const item = document.createElement('div');
    item.style.cssText = 'border:1px solid rgba(0,0,0,0.1);border-radius:8px;padding:9px;background:#fafafa;';
    item.innerHTML = `<div style="font-size:11px;text-transform:uppercase;color:#777;font-weight:700;margin-bottom:3px;"></div><div style="font-weight:600;"></div>`;
    item.children[0].textContent = label;
    item.children[1].textContent = value;
    meta.appendChild(item);
  });
  body.appendChild(meta);

  if (tools.imagePreview) {
    const imageSection = document.createElement('section');
    imageSection.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const imageLabel = document.createElement('div');
    imageLabel.textContent = 'Image preview';
    imageLabel.style.cssText = 'font-weight:700;font-size:12px;text-transform:uppercase;color:#777;letter-spacing:.04em;';
    const image = document.createElement('img');
    image.alt = 'Selected base64 image preview';
    image.src = tools.imagePreview.dataUrl;
    image.style.cssText = [
      'display:block',
      'max-width:100%',
      'max-height:320px',
      'object-fit:contain',
      'margin:0 auto',
      'border:1px solid rgba(0,0,0,0.08)',
      'border-radius:8px',
      'background:#f4f4f4'
    ].join(';');
    imageSection.appendChild(imageLabel);
    imageSection.appendChild(image);
    body.appendChild(imageSection);
  }

  const original = createInspectorSection('Original', tools.raw, { rows: 5 });
  original.actions.appendChild(createInspectorButton('Copy as Base64', async () => writeClipboard(tools.encodeBase64())));
  if (canReplace) {
    original.actions.appendChild(createInspectorButton('Replace with Base64', () => replaceSelection(tools.encodeBase64())));
  }
  body.appendChild(original.section);

  if (tools.canDecodeBase64) {
    const decodedValue = tools.decodeBase64();
    const decoded = createInspectorSection('Decoded', decodedValue, { rows: 5 });
    if (canReplace) {
      decoded.actions.appendChild(createInspectorButton('Replace with decoded', () => replaceSelection(decodedValue), true));
    }
    body.appendChild(decoded.section);
  }

  inspector.style.display = 'flex';
};

const renderSelectionMenu = ({
  menu,
  preview,
  inspector,
  event,
  selection,
  canReplace,
  replaceSelection
}) => {
  const tools = getSelectionDataToolState(selection);
  if (!tools.canDecodeBase64 && !tools.canEncodeBase64 && !tools.imagePreview) {
    menu.style.display = 'none';
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  menu.innerHTML = '';

  addMenuButton(menu, 'Inspect selection', () => showInspectorModal({
    inspector,
    tools,
    canReplace,
    replaceSelection
  }));
  if (tools.imagePreview) {
    addMenuButton(menu, 'Preview as image', () => showImagePreview(preview, tools.imagePreview, event));
  }
  addMenuButton(menu, 'Copy selection', async () => writeClipboard(tools.raw));
  if (tools.canDecodeBase64) {
    addMenuButton(menu, 'Copy decoded Base64', async () => writeClipboard(tools.decodeBase64()));
    if (canReplace) {
      addMenuButton(menu, 'Replace with decoded Base64', () => replaceSelection(tools.decodeBase64()));
    }
  }
  if (tools.canEncodeBase64) {
    addMenuButton(menu, 'Copy as Base64', async () => writeClipboard(tools.encodeBase64()));
    if (canReplace) {
      addMenuButton(menu, 'Replace with Base64', () => replaceSelection(tools.encodeBase64()));
    }
  }

  menu.style.display = 'block';
  positionElement(menu, event);
  return true;
};

export const setupSelectionDataTools = (editor) => {
  if (!editor) {
    return;
  }

  const wrapper = editor.getWrapperElement();
  const menu = createMenu();
  const preview = createImagePreview();
  const inspector = createInspectorModal();

  const hideMenu = () => {
    menu.style.display = 'none';
  };
  const hidePreview = () => {
    preview.style.display = 'none';
  };
  const hideInspector = () => {
    inspector.style.display = 'none';
  };

  const handleContextMenu = (event) => {
    const selection = editor.getSelection();
    if (!selection || !selection.trim()) {
      hideMenu();
      return;
    }

    renderSelectionMenu({
      menu,
      preview,
      inspector,
      event,
      selection,
      canReplace: !editor.getOption('readOnly'),
      replaceSelection: (value) => editor.replaceSelection(value, 'around')
    });
  };

  const handleDocumentClick = (event) => {
    if (!menu.contains(event.target) && !preview.contains(event.target) && !inspector.contains(event.target)) {
      hideMenu();
      hidePreview();
    }
  };

  wrapper.addEventListener('contextmenu', handleContextMenu);
  document.addEventListener('click', handleDocumentClick);
  preview.querySelector('[data-close]').addEventListener('click', hidePreview);
  inspector.querySelector('[data-close]').addEventListener('click', hideInspector);
  inspector.addEventListener('click', (event) => {
    if (event.target === inspector) hideInspector();
  });

  editor._destroySelectionDataTools = () => {
    wrapper.removeEventListener('contextmenu', handleContextMenu);
    document.removeEventListener('click', handleDocumentClick);
    menu.remove();
    preview.remove();
    inspector.remove();
  };
};

const isTextInput = (target) => {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
};

const getInputSelection = (target) => {
  if (!isTextInput(target)) {
    return null;
  }

  if (typeof target.selectionStart !== 'number' || typeof target.selectionEnd !== 'number') {
    return null;
  }

  if (target.selectionStart === target.selectionEnd) {
    return null;
  }

  return {
    selection: target.value.slice(target.selectionStart, target.selectionEnd),
    canReplace: !target.readOnly && !target.disabled,
    replaceSelection: (value) => {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const nextValue = `${target.value.slice(0, start)}${value}${target.value.slice(end)}`;
      target.value = nextValue;
      target.setSelectionRange(start, start + value.length);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
};

const getSelectionContext = (event) => {
  const targetInput = isTextInput(event.target) ? event.target : event.target?.closest?.('input, textarea');
  const input = targetInput || (isTextInput(document.activeElement) ? document.activeElement : null);
  const inputSelection = getInputSelection(input);

  if (inputSelection?.selection?.trim()) {
    return inputSelection;
  }

  const selectedText = window.getSelection?.().toString();
  if (selectedText?.trim()) {
    return {
      selection: selectedText,
      canReplace: false,
      replaceSelection: () => {}
    };
  }

  return null;
};

export const setupGlobalSelectionDataTools = () => {
  const menu = createMenu();
  const preview = createImagePreview();
  const inspector = createInspectorModal();

  const hideMenu = () => {
    menu.style.display = 'none';
  };
  const hidePreview = () => {
    preview.style.display = 'none';
  };
  const hideInspector = () => {
    inspector.style.display = 'none';
  };

  const handleContextMenu = (event) => {
    if (event.target?.closest?.('.CodeMirror')) {
      return;
    }

    const selectionContext = getSelectionContext(event);
    if (!selectionContext?.selection?.trim()) {
      hideMenu();
      return;
    }

    renderSelectionMenu({
      menu,
      preview,
      inspector,
      event,
      selection: selectionContext.selection,
      canReplace: selectionContext.canReplace,
      replaceSelection: selectionContext.replaceSelection
    });
  };

  const handleDocumentClick = (event) => {
    if (!menu.contains(event.target) && !preview.contains(event.target) && !inspector.contains(event.target)) {
      hideMenu();
      hidePreview();
    }
  };

  document.addEventListener('contextmenu', handleContextMenu, true);
  document.addEventListener('click', handleDocumentClick);
  preview.querySelector('[data-close]').addEventListener('click', hidePreview);
  inspector.querySelector('[data-close]').addEventListener('click', hideInspector);
  inspector.addEventListener('click', (event) => {
    if (event.target === inspector) hideInspector();
  });

  return () => {
    document.removeEventListener('contextmenu', handleContextMenu, true);
    document.removeEventListener('click', handleDocumentClick);
    menu.remove();
    preview.remove();
    inspector.remove();
  };
};
