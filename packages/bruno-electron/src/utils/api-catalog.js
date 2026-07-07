/**
 * Workspace API catalog generator.
 *
 * Produces a single, self-contained, human-readable document (Markdown or
 * HTML) describing every collection -> folder -> request in a workspace.
 *
 * SECURITY: the catalog is meant for sharing/documentation, so it must NEVER
 * include secrets. Enforced exclusions:
 *   - environment files/values are never read or rendered
 *   - auth credentials are never rendered (only the auth *mode*, e.g. "bearer")
 *   - request bodies are never dumped (only the body *mode*, e.g. "json")
 *   - header/param values whose names look sensitive (authorization, token,
 *     api key, secret, cookie, password, ...) are redacted
 * Keep these rules intact when modifying this module; tests assert that
 * seeded credentials never appear in the output.
 */

const isSeqValid = (seq) => Number.isFinite(seq) && Number.isInteger(seq) && seq > 0;

const REQUEST_TYPES = new Set(['http-request', 'graphql-request', 'grpc-request', 'ws-request']);

const SENSITIVE_NAME_RE = /(authorization|api[-_]?key|token|secret|session|cookie|passwd|password|x-auth)/i;
const REDACTED_VALUE = '[redacted]';

// Conceptually mirrors the sidebar ordering: folders first, then requests,
// each group ordered by seq (when valid) and falling back to name.
const sortCatalogItems = (items = []) => {
  const bySeqThenName = (a, b) => {
    const aSeq = isSeqValid(a?.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = isSeqValid(b?.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  };

  const folders = items.filter((item) => item?.type === 'folder').sort(bySeqThenName);
  const requests = items.filter((item) => REQUEST_TYPES.has(item?.type)).sort(bySeqThenName);

  return [...folders, ...requests];
};

const redactValue = (name, value) => {
  if (SENSITIVE_NAME_RE.test(String(name || ''))) return REDACTED_VALUE;
  return value == null ? '' : String(value);
};

const getMethodLabel = (item) => {
  const method = item?.request?.method;
  if (method) return String(method).toUpperCase();
  if (item?.type === 'graphql-request') return 'GQL';
  if (item?.type === 'grpc-request') return 'GRPC';
  if (item?.type === 'ws-request') return 'WS';
  return 'REQ';
};

// Folders read off disk carry the directory basename in `name`; the display
// name (what the sidebar shows) lives in the folder root meta.
const getFolderName = (item) => item?.root?.meta?.name || item?.name || 'Untitled folder';

const getAuthMode = (item) => item?.request?.auth?.mode;
const getBodyMode = (item) => item?.request?.body?.mode;

const getTableRows = (entries = []) =>
  (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (entry.name || entry.value))
    .map((entry) => ({
      name: String(entry.name || ''),
      value: redactValue(entry.name, entry.value),
      enabled: entry.enabled !== false
    }));

/* ------------------------------- Markdown ------------------------------- */

const escapeMdCell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const mdHeading = (depth, text) => `${'#'.repeat(Math.min(depth, 6))} ${text}`;

const mdTable = (title, rows) => {
  const lines = [`**${title}**`, ''];
  lines.push('| Name | Value | Enabled |');
  lines.push('| --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${escapeMdCell(row.name)} | ${escapeMdCell(row.value)} | ${row.enabled ? 'Yes' : 'No'} |`);
  }
  return lines.join('\n');
};

const mdRequest = (item, depth) => {
  const blocks = [];
  const request = item.request || {};

  blocks.push(mdHeading(depth, `\`${getMethodLabel(item)}\` ${item.name || 'Untitled request'}`));

  if (request.url) {
    blocks.push(`**URL:** \`${String(request.url).replace(/`/g, '\\`')}\``);
  }

  const oneLiners = [];
  const authMode = getAuthMode(item);
  if (authMode && authMode !== 'none') oneLiners.push(`**Auth:** ${authMode} _(credentials not included)_`);
  const bodyMode = getBodyMode(item);
  if (bodyMode && bodyMode !== 'none') oneLiners.push(`**Body:** ${bodyMode} _(content not included)_`);
  if (oneLiners.length) blocks.push(oneLiners.join('  \n'));

  if (typeof request.docs === 'string' && request.docs.trim()) {
    blocks.push(request.docs.trim().split(/\r?\n/).map((line) => `> ${line}`).join('\n'));
  }

  const paramRows = getTableRows(request.params);
  if (paramRows.length) blocks.push(mdTable('Params', paramRows));

  const headerRows = getTableRows(request.headers);
  if (headerRows.length) blocks.push(mdTable('Headers', headerRows));

  return blocks.join('\n\n');
};

const mdItems = (items, depth) => {
  const blocks = [];
  for (const item of sortCatalogItems(items)) {
    if (item.type === 'folder') {
      blocks.push(mdHeading(depth, `📁 ${getFolderName(item)}`));
      const folderDocs = item?.root?.docs;
      if (typeof folderDocs === 'string' && folderDocs.trim()) {
        blocks.push(folderDocs.trim());
      }
      blocks.push(...mdItems(item.items || [], depth + 1));
    } else {
      blocks.push(mdRequest(item, depth));
    }
  }
  return blocks;
};

const generateMarkdownCatalog = ({ workspaceName, collections }) => {
  const blocks = [];
  blocks.push(`# ${workspaceName}`);
  blocks.push('API Catalog');

  if (!collections.length) {
    blocks.push('_This workspace has no collections._');
  }

  for (const collection of collections) {
    blocks.push(mdHeading(2, collection.name));
    const collectionDocs = collection?.root?.docs;
    if (typeof collectionDocs === 'string' && collectionDocs.trim()) {
      blocks.push(collectionDocs.trim());
    }
    const itemBlocks = mdItems(collection.items || [], 3);
    if (itemBlocks.length) {
      blocks.push(...itemBlocks);
    } else {
      blocks.push('_This collection has no requests._');
    }
  }

  return blocks.join('\n\n') + '\n';
};

/* --------------------------------- HTML --------------------------------- */

const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const METHOD_CLASSES = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  PATCH: 'patch',
  DELETE: 'delete',
  HEAD: 'head',
  OPTIONS: 'options'
};

const htmlMethodBadge = (item) => {
  const label = getMethodLabel(item);
  const cls = METHOD_CLASSES[label] || 'other';
  return `<span class="method method-${cls}">${escapeHtml(label)}</span>`;
};

const htmlTable = (title, rows) => {
  const body = rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.value)}</td><td>${row.enabled ? 'Yes' : 'No'}</td></tr>`
    )
    .join('');
  return (
    `<div class="table-block"><h5>${escapeHtml(title)}</h5>`
    + `<table><thead><tr><th>Name</th><th>Value</th><th>Enabled</th></tr></thead>`
    + `<tbody>${body}</tbody></table></div>`
  );
};

const htmlRequest = (item) => {
  const request = item.request || {};
  const parts = [];

  parts.push(`<div class="request-title">${htmlMethodBadge(item)}<span class="request-name">${escapeHtml(item.name || 'Untitled request')}</span></div>`);

  if (request.url) {
    parts.push(`<div class="request-url"><code>${escapeHtml(request.url)}</code></div>`);
  }

  const meta = [];
  const authMode = getAuthMode(item);
  if (authMode && authMode !== 'none') meta.push(`<span class="meta-item">Auth: <strong>${escapeHtml(authMode)}</strong> (credentials not included)</span>`);
  const bodyMode = getBodyMode(item);
  if (bodyMode && bodyMode !== 'none') meta.push(`<span class="meta-item">Body: <strong>${escapeHtml(bodyMode)}</strong> (content not included)</span>`);
  if (meta.length) parts.push(`<div class="request-meta">${meta.join('')}</div>`);

  if (typeof request.docs === 'string' && request.docs.trim()) {
    parts.push(`<div class="docs">${escapeHtml(request.docs.trim())}</div>`);
  }

  const paramRows = getTableRows(request.params);
  if (paramRows.length) parts.push(htmlTable('Params', paramRows));

  const headerRows = getTableRows(request.headers);
  if (headerRows.length) parts.push(htmlTable('Headers', headerRows));

  return `<div class="request">${parts.join('')}</div>`;
};

const htmlItems = (items) => {
  const parts = [];
  for (const item of sortCatalogItems(items)) {
    if (item.type === 'folder') {
      const folderDocs = item?.root?.docs;
      const docsHtml
        = typeof folderDocs === 'string' && folderDocs.trim()
          ? `<div class="docs">${escapeHtml(folderDocs.trim())}</div>`
          : '';
      parts.push(
        `<details class="folder" open><summary>📁 ${escapeHtml(getFolderName(item))}</summary>`
        + `<div class="folder-body">${docsHtml}${htmlItems(item.items || [])}</div></details>`
      );
    } else {
      parts.push(htmlRequest(item));
    }
  }
  return parts.join('');
};

// Minimal inline styles only — the exported file must stay fully
// self-contained (no external stylesheets, scripts, fonts or images).
const HTML_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 2rem; background: #f7f7f8; color: #1f2328; }
  .container { max-width: 900px; margin: 0 auto; }
  h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
  .subtitle { color: #57606a; margin-bottom: 2rem; }
  .collection { background: #ffffff; border: 1px solid #d8dee4; border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; }
  .collection > h2 { margin: 0 0 0.75rem; font-size: 1.25rem; border-bottom: 1px solid #eaeef2; padding-bottom: 0.5rem; }
  details.folder { margin: 0.75rem 0; border-left: 2px solid #d8dee4; padding-left: 0.75rem; }
  details.folder > summary { cursor: pointer; font-weight: 600; padding: 0.25rem 0; }
  .folder-body { padding: 0.25rem 0 0.25rem 0.5rem; }
  .request { padding: 0.75rem 0; border-bottom: 1px dashed #eaeef2; }
  .request:last-child { border-bottom: none; }
  .request-title { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
  .request-url { margin-top: 0.35rem; }
  .request-url code { background: #f6f8fa; border: 1px solid #eaeef2; border-radius: 4px; padding: 0.15rem 0.4rem; font-size: 0.85rem; word-break: break-all; }
  .request-meta { margin-top: 0.35rem; font-size: 0.85rem; color: #57606a; display: flex; gap: 1rem; flex-wrap: wrap; }
  .docs { margin-top: 0.5rem; padding: 0.5rem 0.75rem; background: #f6f8fa; border-left: 3px solid #d0d7de; white-space: pre-wrap; font-size: 0.9rem; }
  .table-block { margin-top: 0.5rem; }
  .table-block h5 { margin: 0.5rem 0 0.25rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: #57606a; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border: 1px solid #d8dee4; padding: 0.3rem 0.6rem; text-align: left; word-break: break-word; }
  th { background: #f6f8fa; }
  .method { display: inline-block; min-width: 3.2rem; text-align: center; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em; color: #ffffff; }
  .method-get { background: #16a34a; }
  .method-post { background: #d97706; }
  .method-put { background: #2563eb; }
  .method-patch { background: #7c3aed; }
  .method-delete { background: #dc2626; }
  .method-head { background: #0d9488; }
  .method-options { background: #64748b; }
  .method-other { background: #475569; }
  .empty { color: #57606a; font-style: italic; }
`;

const generateHtmlCatalog = ({ workspaceName, collections }) => {
  const sections = collections.map((collection) => {
    const collectionDocs = collection?.root?.docs;
    const docsHtml
      = typeof collectionDocs === 'string' && collectionDocs.trim()
        ? `<div class="docs">${escapeHtml(collectionDocs.trim())}</div>`
        : '';
    const itemsHtml = htmlItems(collection.items || []);
    const bodyHtml = itemsHtml || '<p class="empty">This collection has no requests.</p>';
    return `<section class="collection"><h2>${escapeHtml(collection.name)}</h2>${docsHtml}${bodyHtml}</section>`;
  });

  const body = sections.length ? sections.join('') : '<p class="empty">This workspace has no collections.</p>';

  return (
    '<!DOCTYPE html>\n'
    + '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${escapeHtml(workspaceName)} — API Catalog</title>\n`
    + `<style>${HTML_STYLES}</style>\n</head>\n<body>\n`
    + `<div class="container">\n<h1>${escapeHtml(workspaceName)}</h1>\n`
    + '<p class="subtitle">API Catalog</p>\n'
    + body
    + '\n</div>\n</body>\n</html>\n'
  );
};

/**
 * @param {object} options
 * @param {string} options.workspaceName
 * @param {Array<{name: string, root?: object, items: Array}>} options.collections
 * @param {'md'|'html'} options.format
 * @returns {string}
 */
const generateApiCatalog = ({ workspaceName, collections = [], format = 'md' }) => {
  const name = workspaceName || 'Untitled Workspace';
  if (format === 'html') {
    return generateHtmlCatalog({ workspaceName: name, collections });
  }
  if (format === 'md') {
    return generateMarkdownCatalog({ workspaceName: name, collections });
  }
  throw new Error(`Unsupported catalog format: ${format}`);
};

module.exports = {
  generateApiCatalog,
  sortCatalogItems
};
