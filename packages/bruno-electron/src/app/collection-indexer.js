const fs = require('fs/promises');
const path = require('path');
const { parseFolder } = require('@usebruno/filestore');
const { hasRequestExtension, getCollectionFormat, normalizeAndResolvePath } = require('../utils/filesystem');
const { getRequestUid } = require('../cache/requestUids');

const BATCH_SIZE = 750;
const PROGRESS_INTERVAL_MS = 250;
const MAX_ACTIVE_INDEXERS = 1;
const activeJobs = new Map();
const queuedJobs = [];
let activeIndexers = 0;

const shouldSkipEntry = (name, relativePath, ignores = []) => {
  if (!name || name === '.' || name === '..') {
    return true;
  }

  if (name === '.git' || name === 'node_modules' || name === 'environments') {
    return true;
  }

  if (name === '.env' || name.startsWith('.env.')) {
    return true;
  }

  return ignores.some((ignorePattern) => relativePath === ignorePattern || relativePath.startsWith(`${ignorePattern}${path.sep}`));
};

const isCollectionMetadataFile = (name, dirname, collectionPathname, format) => {
  if (name === `folder.${format}`) {
    return true;
  }

  if (path.normalize(dirname) !== path.normalize(collectionPathname)) {
    return false;
  }

  return name === 'collection.bru' || name === 'opencollection.yml' || name === 'bruno.json';
};

const safeReadText = async (pathname) => {
  try {
    return await fs.readFile(pathname, 'utf8');
  } catch (_err) {
    return null;
  }
};

const cleanMetaValue = (value) => {
  if (!value) {
    return '';
  }

  return String(value).trim().replace(/^['"]|['"]$/g, '');
};

const extractLineValue = (content, key) => {
  const match = content.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  return cleanMetaValue(match?.[1]);
};

const extractBruType = (content) => {
  const metaBlock = content.match(/meta\s*\{([\s\S]*?)\n\}/);
  if (metaBlock?.[1]) {
    return extractLineValue(metaBlock[1], 'type');
  }
  return '';
};

const normalizeRequestType = (type) => {
  const normalizedType = cleanMetaValue(type).toLowerCase();
  const typeMap = {
    http: 'http-request',
    graphql: 'graphql-request',
    grpc: 'grpc-request',
    ws: 'ws-request',
    websocket: 'ws-request'
  };

  return typeMap[normalizedType] || normalizedType || 'http-request';
};

// Cheap example detection from raw content (no full parse), so indexed rows
// can show an "has examples" indicator without hydrating the request.
const countExamples = (content, format) => {
  if (!content) {
    return 0;
  }
  if (format === 'bru') {
    return (content.match(/(^|\n)example\s*\{/g) || []).length;
  }
  // yml: a non-empty `examples:` list
  if (/(^|\n)examples:\s*\[\s*\]/.test(content)) {
    return 0;
  }
  return /(^|\n)examples:\s*(\n\s+-|\[)/.test(content) ? 1 : 0;
};

const extractBruMethod = (content) => {
  const blockMatch = content.match(/^\s*(get|post|put|delete|patch|head|options|trace)\s*\{/im);
  if (blockMatch?.[1]) {
    return blockMatch[1].toUpperCase();
  }

  return extractLineValue(content, 'method').toUpperCase();
};

const readFolderMeta = async (pathname, format) => {
  const folderFilePath = path.join(pathname, `folder.${format}`);
  const content = await safeReadText(folderFilePath);

  if (!content) {
    return {};
  }

  try {
    const folderData = await parseFolder(content, { format });
    return {
      name: folderData?.meta?.name,
      seq: folderData?.meta?.seq
    };
  } catch (_err) {
    return {};
  }
};

const extractRequestMeta = async (pathname, format) => {
  const content = await safeReadText(pathname);
  const fallbackName = path.basename(pathname, path.extname(pathname));

  if (!content) {
    return {
      name: fallbackName,
      type: 'http-request',
      method: '',
      url: ''
    };
  }

  try {
    const parsed = {
      name: extractLineValue(content, 'name'),
      type: format === 'bru' ? extractBruType(content) : extractLineValue(content, 'type'),
      seq: Number(extractLineValue(content, 'seq')) || undefined,
      request: {
        method: format === 'bru' ? extractBruMethod(content) : extractLineValue(content, 'method').toUpperCase(),
        url: extractLineValue(content, 'url')
      }
    };
    return {
      name: parsed.name || fallbackName,
      type: normalizeRequestType(parsed.type),
      seq: parsed.seq,
      tags: parsed.tags || [],
      method: parsed.request?.method || parsed.method || '',
      url: parsed.request?.url || parsed.url || '',
      exampleCount: countExamples(content, format)
    };
  } catch (_err) {
    return {
      name: fallbackName,
      type: 'http-request',
      method: '',
      url: '',
      error: true
    };
  }
};

const sendBatch = (win, job, force = false) => {
  if (!job.batch.length) {
    return;
  }

  const now = Date.now();
  if (!force && job.batch.length < BATCH_SIZE && now - job.lastProgressAt < PROGRESS_INTERVAL_MS) {
    return;
  }

  const nodes = job.batch.splice(0, job.batch.length);
  job.lastProgressAt = now;
  win.webContents.send('main:collection-index-batch', {
    collectionUid: job.collectionUid,
    loadSessionId: job.loadSessionId,
    nodes,
    totalScanned: job.totalScanned
  });
};

const scanDirectory = async (win, job, dirname, parentUid, depth) => {
  if (job.cancelled) {
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(dirname, { withFileTypes: true });
  } catch (_err) {
    return;
  }

  for (const entry of entries) {
    if (job.cancelled) {
      return;
    }

    const pathname = path.join(dirname, entry.name);
    const normalizedPath = normalizeAndResolvePath(pathname);
    const relativePath = path.relative(job.collectionPathname, normalizedPath);

    if (shouldSkipEntry(entry.name, relativePath, job.ignores)) {
      continue;
    }

    if (entry.isDirectory()) {
      const folderMeta = await readFolderMeta(pathname, job.format);
      const uid = getRequestUid(pathname);
      job.batch.push({
        uid,
        name: folderMeta.name || entry.name,
        filename: entry.name,
        type: 'folder',
        pathname,
        parentUid,
        depth,
        seq: folderMeta.seq,
        childrenCount: 0
      });
      job.totalScanned += 1;
      sendBatch(win, job);
      await scanDirectory(win, job, pathname, uid, depth + 1);
      continue;
    }

    if (entry.isFile() && !isCollectionMetadataFile(entry.name, dirname, job.collectionPathname, job.format) && hasRequestExtension(pathname, job.format)) {
      const requestMeta = await extractRequestMeta(pathname, job.format);
      job.batch.push({
        uid: getRequestUid(pathname),
        name: requestMeta.name,
        filename: entry.name,
        type: requestMeta.type,
        pathname,
        parentUid,
        depth,
        seq: requestMeta.seq,
        tags: requestMeta.tags,
        method: requestMeta.method,
        url: requestMeta.url,
        exampleCount: requestMeta.exampleCount || 0,
        partial: true,
        loading: false,
        error: requestMeta.error
      });
      job.totalScanned += 1;
      sendBatch(win, job);
    }
  }
};

const cancelCollectionIndex = (collectionUid, loadSessionId) => {
  const job = activeJobs.get(collectionUid);
  if (job) {
    if (loadSessionId && job.loadSessionId !== loadSessionId) {
      return;
    }

    job.cancelled = true;
    activeJobs.delete(collectionUid);
  }

  for (let i = queuedJobs.length - 1; i >= 0; i -= 1) {
    const queued = queuedJobs[i];
    if (queued.collectionUid === collectionUid && (!loadSessionId || queued.loadSessionId === loadSessionId)) {
      queued.cancelled = true;
      queuedJobs.splice(i, 1);
      queued.win.webContents.send('main:collection-index-cancelled', {
        collectionUid,
        loadSessionId: queued.loadSessionId
      });
    }
  }
};

const runCollectionIndex = async (win, job) => {
  activeIndexers += 1;
  activeJobs.set(job.collectionUid, job);

  try {
    await scanDirectory(win, job, job.collectionPathname, null, 0);
    sendBatch(win, job, true);

    if (job.cancelled) {
      win.webContents.send('main:collection-index-cancelled', {
        collectionUid: job.collectionUid,
        loadSessionId: job.loadSessionId
      });
      return;
    }

    win.webContents.send('main:collection-index-ready', {
      collectionUid: job.collectionUid,
      loadSessionId: job.loadSessionId,
      totalNodes: job.totalScanned
    });
    if (typeof job.onReady === 'function') {
      job.onReady();
    }
  } catch (err) {
    win.webContents.send('main:collection-index-failed', {
      collectionUid: job.collectionUid,
      loadSessionId: job.loadSessionId,
      error: err?.message || 'Failed to index collection'
    });
  } finally {
    if (activeJobs.get(job.collectionUid)?.loadSessionId === job.loadSessionId) {
      activeJobs.delete(job.collectionUid);
    }
    activeIndexers = Math.max(0, activeIndexers - 1);
    runNextQueuedIndex();
  }
};

const runNextQueuedIndex = () => {
  if (activeIndexers >= MAX_ACTIVE_INDEXERS) {
    return;
  }

  const next = queuedJobs.shift();
  if (!next) {
    return;
  }

  if (next.cancelled) {
    runNextQueuedIndex();
    return;
  }

  runCollectionIndex(next.win, next);
};

const startCollectionIndex = async (win, { collectionUid, collectionPathname, brunoConfig, loadSessionId, onReady }) => {
  cancelCollectionIndex(collectionUid);

  const job = {
    win,
    collectionUid,
    collectionPathname,
    loadSessionId,
    format: getCollectionFormat(collectionPathname),
    ignores: brunoConfig?.ignore || [],
    batch: [],
    totalScanned: 0,
    lastProgressAt: 0,
    cancelled: false,
    onReady
  };

  win.webContents.send('main:collection-index-started', {
    collectionUid,
    collectionPathname,
    loadSessionId
  });

  queuedJobs.push(job);
  runNextQueuedIndex();
};

module.exports = {
  startCollectionIndex,
  cancelCollectionIndex
};
