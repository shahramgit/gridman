import {
  escapeJsonString,
  getEpochDateDetails,
  getJsonStringLiteral,
  getSelectionDigests,
  getUnicodeReport,
  getUrlBreakdown
} from './selectionInspectors';

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const JWT_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const URL_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

const normalizeBase64 = (value) => String(value || '').replace(/\s+/g, '');
const normalizeBase64Url = (value) => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return `${normalized}${'='.repeat(paddingLength)}`;
};

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

const normalizeJwtToken = (value) => {
  const token = normalizeSelectedToken(value);
  return token.replace(/^Bearer\s+/i, '');
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

const decodeBase64UrlToText = (base64Url) => {
  return decodeBase64ToText(normalizeBase64Url(base64Url));
};

const safeJsonParse = (value) => {
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
};

const formatJson = (value) => {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  return parsed ? JSON.stringify(parsed, null, 2) : String(value || '');
};

const decodeUrlSelection = (value) => {
  const trimmed = normalizeSelectedToken(value);
  if (!URL_ENCODED_RE.test(trimmed)) {
    return null;
  }

  try {
    return decodeURIComponent(trimmed.replace(/\+/g, ' '));
  } catch (e) {
    return null;
  }
};

const encodeUrlSelection = (value) => encodeURIComponent(String(value || ''));

export const getSelectionJwtDetails = (selection) => {
  const token = normalizeJwtToken(selection);
  const parts = token.split('.');

  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts.every((part) => JWT_SEGMENT_RE.test(part))) {
    return null;
  }

  try {
    const headerText = decodeBase64UrlToText(parts[0]);
    const payloadText = decodeBase64UrlToText(parts[1]);
    const header = safeJsonParse(headerText);
    const payload = safeJsonParse(payloadText);

    if (!header || !payload) {
      return null;
    }

    return {
      token,
      header,
      payload,
      signature: parts[2],
      headerText: formatJson(header),
      payloadText: formatJson(payload),
      decodedText: formatJson({ header, payload })
    };
  } catch (e) {
    return null;
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
  const jwt = getSelectionJwtDetails(raw);
  const decodedUrl = decodeUrlSelection(raw);
  const epochDate = getEpochDateDetails(raw);
  const jsonStringValue = getJsonStringLiteral(raw);
  const urlBreakdown = getUrlBreakdown(raw);
  const unicode = getUnicodeReport(raw);

  return {
    raw,
    trimmed,
    imagePreview,
    jwt,
    canDecodeJwt: Boolean(jwt),
    canDecodeUrl: decodedUrl !== null,
    canEncodeUrl: raw.length > 0,
    canDecodeBase64,
    canEncodeBase64: raw.length > 0,
    byteSize: decodedBytes?.length || 0,
    base64Source,
    epochDate,
    urlBreakdown,
    unicode,
    canUnescapeJsonString: jsonStringValue !== null,
    decodeJwt: () => jwt?.decodedText || '',
    decodeUrl: () => decodedUrl || '',
    encodeUrl: () => encodeUrlSelection(raw),
    decodeBase64: () => decodeBase64ToText(base64Source),
    encodeBase64: () => encodeUtf8ToBase64(raw),
    escapeJsonString: () => escapeJsonString(raw),
    unescapeJsonString: () => jsonStringValue ?? '',
    computeDigests: () => getSelectionDigests(raw)
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
  if (tools.canDecodeJwt) return 'JWT';
  if (tools.imagePreview && tools.trimmed.match(DATA_IMAGE_RE)) return 'Data URL image';
  if (tools.imagePreview) return 'Base64 image';
  if (tools.epochDate?.kind === 'epoch') return 'Epoch timestamp';
  if (tools.epochDate?.kind === 'date') return 'ISO-8601 date';
  if (tools.urlBreakdown) return 'URL';
  if (tools.canDecodeBase64) return 'Base64';
  if (tools.canDecodeUrl) return 'URL encoded';
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

const SECTION_LABEL_CSS = 'font-weight:700;font-size:12px;text-transform:uppercase;color:#777;letter-spacing:.04em;';

const createLabeledSection = (title) => {
  const section = document.createElement('section');
  section.style.cssText = 'display:flex;flex-direction:column;gap:7px;';

  const label = document.createElement('div');
  label.textContent = title;
  label.style.cssText = SECTION_LABEL_CSS;
  section.appendChild(label);

  return section;
};

const createKeyValueGrid = (pairs) => {
  const grid = document.createElement('div');
  grid.style.cssText = [
    'display:grid',
    'grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))',
    'gap:8px',
    'font-size:13px'
  ].join(';');

  pairs.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.style.cssText = 'border:1px solid rgba(0,0,0,0.1);border-radius:8px;padding:9px;background:#fafafa;';
    item.innerHTML = `<div style="font-size:11px;text-transform:uppercase;color:#777;font-weight:700;margin-bottom:3px;"></div><div style="font-weight:600;word-break:break-all;"></div>`;
    item.children[0].textContent = label;
    item.children[1].textContent = value;
    grid.appendChild(item);
  });

  return grid;
};

const createEpochSection = (epochDate) => {
  const section = createLabeledSection(epochDate.kind === 'epoch' ? 'Epoch to date' : 'Date to epoch');

  epochDate.interpretations.forEach((interpretation) => {
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid rgba(0,0,0,0.1);border-radius:8px;padding:10px;background:#fafafa;display:flex;flex-direction:column;gap:6px;';

    const heading = document.createElement('div');
    heading.textContent = interpretation.label;
    heading.style.cssText = 'font-size:11px;text-transform:uppercase;color:#777;font-weight:700;';
    card.appendChild(heading);

    const rows = epochDate.kind === 'epoch'
      ? [
          ['Local', interpretation.local],
          ['UTC', interpretation.utc],
          ['ISO', interpretation.iso]
        ]
      : [
          ['Epoch seconds', String(interpretation.epochSeconds)],
          ['Epoch millis', String(interpretation.epochMillis)],
          ['Local', interpretation.local],
          ['UTC', interpretation.utc]
        ];

    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:12px;';
      row.innerHTML = `<span style="min-width:96px;color:#777;"></span><span style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;word-break:break-all;"></span>`;
      row.children[0].textContent = label;
      row.children[1].textContent = value;
      card.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;';
    if (epochDate.kind === 'epoch') {
      actions.appendChild(createInspectorButton('Copy ISO', async () => writeClipboard(interpretation.iso), true));
    } else {
      actions.appendChild(createInspectorButton('Copy epoch seconds', async () => writeClipboard(String(interpretation.epochSeconds)), true));
      actions.appendChild(createInspectorButton('Copy epoch millis', async () => writeClipboard(String(interpretation.epochMillis))));
    }
    card.appendChild(actions);

    section.appendChild(card);
  });

  return section;
};

const createUrlBreakdownSection = (urlBreakdown) => {
  const section = createLabeledSection('URL breakdown');

  section.appendChild(createKeyValueGrid([
    ['Scheme', urlBreakdown.scheme],
    ['Host', urlBreakdown.host],
    ['Port', urlBreakdown.port ? `${urlBreakdown.port}${urlBreakdown.isDefaultPort ? ' (default)' : ''}` : '-'],
    ['Path', urlBreakdown.path || '/'],
    ...(urlBreakdown.hash ? [['Fragment', urlBreakdown.hash]] : [])
  ]));

  if (urlBreakdown.params.length) {
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
    const header = document.createElement('tr');
    ['Query param', 'Decoded value'].forEach((text) => {
      const th = document.createElement('th');
      th.textContent = text;
      th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.14);color:#777;font-size:11px;text-transform:uppercase;';
      header.appendChild(th);
    });
    table.appendChild(header);

    urlBreakdown.params.forEach(({ key, value }) => {
      const row = document.createElement('tr');
      [key, value].forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        td.style.cssText = 'padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.06);font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;word-break:break-all;vertical-align:top;';
        row.appendChild(td);
      });
      table.appendChild(row);
    });

    section.appendChild(table);
  }

  return section;
};

const createUnicodeSection = ({ unicode, canReplace, replaceSelection }) => {
  const section = createLabeledSection('Unicode inspector');

  const invisibleSummary = unicode.hasInvisibles
    ? unicode.invisibles.map(({ name, count }) => `${name.split(' ')[0]} × ${count}`).join(', ')
    : 'None';

  section.appendChild(createKeyValueGrid([
    ['Code points', String(unicode.codePointCount)],
    ['UTF-16 units', String(unicode.utf16Length)],
    ['Normalization', unicode.normalizationForm],
    ['Invisible chars', invisibleSummary]
  ]));

  if (unicode.hasInvisibles) {
    const warning = document.createElement('div');
    warning.style.cssText = 'font-size:12px;color:#c2410c;background:#fff7ed;border:1px solid rgba(194,65,12,0.25);border-radius:8px;padding:8px 10px;';
    warning.textContent = unicode.invisibles.map(({ name, count }) => `${count}× ${name}`).join(' · ');
    section.appendChild(warning);
  }

  if (!unicode.isNFC) {
    const nfcSection = createInspectorSection('NFC normalized', unicode.nfc, { rows: 3 });
    section.appendChild(nfcSection.section);
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  actions.appendChild(createInspectorButton('Copy NFC normalized', async () => writeClipboard(unicode.nfc), !unicode.isNFC));
  if (canReplace && !unicode.isNFC) {
    actions.appendChild(createInspectorButton('Replace with NFC normalized', () => replaceSelection(unicode.nfc)));
  }
  section.appendChild(actions);

  return section;
};

const createDigestsSection = (tools) => {
  const details = document.createElement('details');
  details.style.cssText = 'border:1px solid rgba(0,0,0,0.1);border-radius:8px;background:#fafafa;';

  const summary = document.createElement('summary');
  summary.textContent = 'Hash digests (md5 · sha1 · sha256)';
  summary.style.cssText = `cursor:pointer;padding:10px;${SECTION_LABEL_CSS}`;
  details.appendChild(summary);

  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px;';
  details.appendChild(content);

  let computed = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || computed) {
      return;
    }
    computed = true;
    content.textContent = 'Computing…';

    const digests = await tools.computeDigests();
    content.innerHTML = '';

    [['md5', digests.md5], ['sha1', digests.sha1], ['sha256', digests.sha256]].forEach(([name, value]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;';

      const label = document.createElement('span');
      label.textContent = name;
      label.style.cssText = 'min-width:52px;font-size:11px;text-transform:uppercase;color:#777;font-weight:700;';

      const output = document.createElement('input');
      output.type = 'text';
      output.readOnly = true;
      output.value = value || 'unavailable (Web Crypto missing)';
      output.style.cssText = [
        'flex:1',
        'min-width:0',
        'border:1px solid rgba(0,0,0,0.14)',
        'border-radius:6px',
        'background:#fff',
        'padding:6px 8px',
        'font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        'font-size:12px',
        'color:#2b2b2b'
      ].join(';');

      row.appendChild(label);
      row.appendChild(output);
      if (value) {
        row.appendChild(createInspectorButton('Copy', async () => writeClipboard(value)));
      }
      content.appendChild(row);
    });
  });

  return details;
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
    ['Decoded size', tools.byteSize ? formatByteSize(tools.byteSize) : '-'],
    ['URL encoded', tools.canDecodeUrl ? 'Yes' : 'No']
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
  original.actions.appendChild(createInspectorButton('Copy URL encoded', async () => writeClipboard(tools.encodeUrl())));
  if (canReplace) {
    original.actions.appendChild(createInspectorButton('Replace with URL encoded', () => replaceSelection(tools.encodeUrl())));
  }
  original.actions.appendChild(createInspectorButton('Copy as Base64', async () => writeClipboard(tools.encodeBase64())));
  if (canReplace) {
    original.actions.appendChild(createInspectorButton('Replace with Base64', () => replaceSelection(tools.encodeBase64())));
  }
  original.actions.appendChild(createInspectorButton('Copy as JSON string', async () => writeClipboard(tools.escapeJsonString())));
  body.appendChild(original.section);

  if (tools.canDecodeJwt) {
    const jwtHeader = createInspectorSection('JWT header', tools.jwt.headerText, { rows: 5 });
    body.appendChild(jwtHeader.section);

    const jwtPayload = createInspectorSection('JWT payload', tools.jwt.payloadText, { rows: 7 });
    jwtPayload.actions.appendChild(createInspectorButton('Copy decoded JWT', async () => writeClipboard(tools.decodeJwt()), true));
    body.appendChild(jwtPayload.section);
  }

  if (tools.canDecodeUrl) {
    const decodedUrl = tools.decodeUrl();
    const decoded = createInspectorSection('URL decoded', decodedUrl, { rows: 4 });
    if (canReplace) {
      decoded.actions.appendChild(createInspectorButton('Replace with URL decoded', () => replaceSelection(decodedUrl), true));
    }
    body.appendChild(decoded.section);
  }

  if (tools.canDecodeBase64) {
    const decodedValue = tools.decodeBase64();
    const decoded = createInspectorSection('Decoded', decodedValue, { rows: 5 });
    if (canReplace) {
      decoded.actions.appendChild(createInspectorButton('Replace with decoded', () => replaceSelection(decodedValue), true));
    }
    body.appendChild(decoded.section);
  }

  if (tools.epochDate) {
    body.appendChild(createEpochSection(tools.epochDate));
  }

  if (tools.canUnescapeJsonString) {
    const unescapedValue = tools.unescapeJsonString();
    const unescaped = createInspectorSection('JSON unescaped', unescapedValue, { rows: 4 });
    if (canReplace) {
      unescaped.actions.appendChild(createInspectorButton('Replace with unescaped', () => replaceSelection(unescapedValue), true));
    }
    body.appendChild(unescaped.section);
  }

  if (tools.urlBreakdown) {
    body.appendChild(createUrlBreakdownSection(tools.urlBreakdown));
  }

  if (tools.unicode?.interesting) {
    body.appendChild(createUnicodeSection({ unicode: tools.unicode, canReplace, replaceSelection }));
  }

  body.appendChild(createDigestsSection(tools));

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
  if (
    !tools.canDecodeJwt
    && !tools.canDecodeUrl
    && !tools.canEncodeUrl
    && !tools.canDecodeBase64
    && !tools.canEncodeBase64
    && !tools.imagePreview
  ) {
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
  if (tools.canDecodeJwt) {
    addMenuButton(menu, 'Copy decoded JWT', async () => writeClipboard(tools.decodeJwt()));
  }
  if (tools.canDecodeUrl) {
    addMenuButton(menu, 'Copy URL decoded', async () => writeClipboard(tools.decodeUrl()));
    if (canReplace) {
      addMenuButton(menu, 'Replace with URL decoded', () => replaceSelection(tools.decodeUrl()));
    }
  }
  if (tools.canEncodeUrl) {
    addMenuButton(menu, 'Copy URL encoded', async () => writeClipboard(tools.encodeUrl()));
    if (canReplace) {
      addMenuButton(menu, 'Replace with URL encoded', () => replaceSelection(tools.encodeUrl()));
    }
  }
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
  if (tools.epochDate?.kind === 'epoch') {
    addMenuButton(menu, 'Copy as ISO date', async () => writeClipboard(tools.epochDate.interpretations[0].iso));
  }
  if (tools.epochDate?.kind === 'date') {
    addMenuButton(menu, 'Copy as epoch millis', async () => writeClipboard(String(tools.epochDate.interpretations[0].epochMillis)));
  }
  if (tools.canUnescapeJsonString) {
    addMenuButton(menu, 'Copy JSON unescaped', async () => writeClipboard(tools.unescapeJsonString()));
    if (canReplace) {
      addMenuButton(menu, 'Replace with JSON unescaped', () => replaceSelection(tools.unescapeJsonString()));
    }
  }
  if (tools.unicode?.interesting && !tools.unicode.isNFC) {
    addMenuButton(menu, 'Copy NFC normalized', async () => writeClipboard(tools.unicode.nfc));
    if (canReplace) {
      addMenuButton(menu, 'Replace with NFC normalized', () => replaceSelection(tools.unicode.nfc));
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
