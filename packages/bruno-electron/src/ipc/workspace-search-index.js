const fs = require('fs');
const path = require('path');
const { buildSearchFields } = require('../utils/workspace-search-match');
const { hasRequestExtension, getCollectionFormat } = require('../utils/filesystem');
const { generateUidBasedOnHash } = require('../utils/common');
const { getRequestUid } = require('../cache/requestUids');

// In-memory search cache: pathname -> { mtimeMs, size, isFolderMeta, result,
// folded: {...}, raw: {...} }.
const workspaceSearchFileCache = new Map();

// Warm per-collection index: collectionPath -> { builtAt, format, building,
// generation, entries: Map<pathname, cacheEntry> }. Building (readdir + stat +
// read + fold over every request file) is the expensive pass; we do it once and
// then match in memory. Within the TTL, searches never touch the filesystem,
// which is what makes typing feel instant on large collections (GSB has ~11.5k
// files; statting them per keystroke was the 5-6s cost). The index is
// invalidated on file changes via invalidateWorkspaceSearchForPath (wired from
// the collection watcher) and falls back to a TTL rebuild.
const workspaceSearchIndex = new Map();
const WORKSPACE_SEARCH_INDEX_TTL_MS = 60 * 1000;

const invalidateWorkspaceSearchForPath = (pathname) => {
  if (!pathname) {
    return;
  }
  const normalized = path.normalize(pathname);
  for (const [collectionPath, index] of workspaceSearchIndex.entries()) {
    if (normalized === collectionPath || normalized.startsWith(`${collectionPath}${path.sep}`)) {
      // Force a rebuild on the next search; drop the changed file's cache.
      // The generation bump lets a build already in flight detect that it
      // raced this invalidation and mark its own result stale.
      index.builtAt = 0;
      index.generation = (index.generation || 0) + 1;
      workspaceSearchFileCache.delete(normalized);
    }
  }
};

// Let the collection watcher invalidate search caches on file changes.
require('../app/search-invalidation').setSearchInvalidator(invalidateWorkspaceSearchForPath);

const cleanSearchMetaValue = (value) => {
  if (!value) {
    return '';
  }

  return String(value).trim().replace(/^['"]|['"]$/g, '');
};

const extractSearchLineValue = (content, key) => {
  const match = content.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  return cleanSearchMetaValue(match?.[1]);
};

const extractSearchBruType = (content) => {
  const metaBlock = content.match(/meta\s*\{([\s\S]*?)\n\}/);
  if (metaBlock?.[1]) {
    return extractSearchLineValue(metaBlock[1], 'type');
  }
  return '';
};

const extractSearchBruMethod = (content) => {
  const blockMatch = content.match(/^\s*(get|post|put|delete|patch|head|options|trace)\s*\{/im);
  if (blockMatch?.[1]) {
    return blockMatch[1].toUpperCase();
  }

  return extractSearchLineValue(content, 'method').toUpperCase();
};

const normalizeSearchRequestType = (type) => {
  const normalizedType = cleanSearchMetaValue(type).toLowerCase();
  const typeMap = {
    http: 'http-request',
    graphql: 'graphql-request',
    grpc: 'grpc-request',
    ws: 'ws-request',
    websocket: 'ws-request'
  };

  return typeMap[normalizedType] || normalizedType || 'http-request';
};

const shouldSkipWorkspaceSearchEntry = (name) => {
  return !name
    || name === '.'
    || name === '..'
    || name === '.git'
    || name === 'node_modules'
    || name === 'environments'
    || name === '.env'
    || name.startsWith('.env.');
};

const isWorkspaceSearchCollectionMetadataFile = (name, dirname, collectionPath) => {
  return path.normalize(dirname) === path.normalize(collectionPath)
    && (name === 'collection.bru' || name === 'opencollection.yml' || name === 'bruno.json');
};

const readSearchText = async (pathname) => {
  try {
    return await fs.promises.readFile(pathname, 'utf8');
  } catch (_err) {
    return '';
  }
};

const toPortableRelativePath = (basePath, pathname) => {
  return path.relative(basePath, pathname).split(path.sep).join('/');
};

const createWorkspaceSearchResult = ({ workspacePath, collectionPath, pathname, content, format }) => {
  const fallbackName = path.basename(pathname, path.extname(pathname));
  const name = extractSearchLineValue(content, 'name') || fallbackName;
  const type = format === 'bru'
    ? extractSearchBruType(content)
    : extractSearchLineValue(content, 'type');

  const method = format === 'bru'
    ? extractSearchBruMethod(content)
    : extractSearchLineValue(content, 'method').toUpperCase();

  return {
    uid: getRequestUid(pathname),
    collectionUid: generateUidBasedOnHash(collectionPath),
    collectionPathname: collectionPath,
    collectionName: path.basename(collectionPath),
    pathname,
    relativePath: toPortableRelativePath(workspacePath, pathname),
    collectionRelativePath: toPortableRelativePath(collectionPath, pathname),
    parentCollectionRelativePath: toPortableRelativePath(collectionPath, path.dirname(pathname)),
    name,
    filename: path.basename(pathname),
    type: normalizeSearchRequestType(type),
    method,
    url: extractSearchLineValue(content, 'url')
  };
};

const createWorkspaceFolderSearchResult = ({ workspacePath, collectionPath, pathname, content, format }) => {
  const folderPathname = path.dirname(pathname);
  const fallbackName = path.basename(folderPathname);

  return {
    uid: getRequestUid(folderPathname),
    collectionUid: generateUidBasedOnHash(collectionPath),
    collectionPathname: collectionPath,
    collectionName: path.basename(collectionPath),
    pathname: folderPathname,
    relativePath: toPortableRelativePath(workspacePath, folderPathname),
    collectionRelativePath: toPortableRelativePath(collectionPath, folderPathname),
    parentCollectionRelativePath: toPortableRelativePath(collectionPath, path.dirname(folderPathname)),
    name: extractSearchLineValue(content, 'name') || fallbackName,
    filename: path.basename(folderPathname),
    type: 'folder',
    method: '',
    url: '',
    seq: Number(extractSearchLineValue(content, 'seq')) || undefined,
    fileFormat: format
  };
};

const createWorkspaceCollectionSearchResult = ({ workspacePath, collectionPath }) => {
  return {
    uid: generateUidBasedOnHash(collectionPath),
    collectionUid: generateUidBasedOnHash(collectionPath),
    collectionPathname: collectionPath,
    collectionName: path.basename(collectionPath),
    pathname: collectionPath,
    relativePath: toPortableRelativePath(workspacePath, collectionPath),
    collectionRelativePath: '',
    parentCollectionRelativePath: '',
    name: path.basename(collectionPath),
    filename: path.basename(collectionPath),
    type: 'collection',
    method: '',
    url: ''
  };
};

const buildWorkspaceSearchCacheEntry = async ({ workspacePath, collectionPath, pathname, format, mtimeMs, size, isFolderMeta }) => {
  const content = await readSearchText(pathname);
  const result = isFolderMeta
    ? createWorkspaceFolderSearchResult({ workspacePath, collectionPath, pathname, content, format })
    : createWorkspaceSearchResult({ workspacePath, collectionPath, pathname, content, format });

  const fields = buildSearchFields({
    content,
    format,
    name: result.name,
    filename: result.filename,
    url: result.url
  });

  // Attach a lightweight example list to the request result so search rows can
  // show the "has examples" marker and expand to the examples without parsing.
  const exampleEntries = fields.exampleEntries || [];
  if (!isFolderMeta && exampleEntries.length) {
    result.exampleCount = exampleEntries.length;
    result.examples = exampleEntries.slice(0, 100).map((entry) => ({ name: entry.name, index: entry.index }));
  }

  return {
    mtimeMs,
    size,
    isFolderMeta,
    result,
    raw: fields.raw,
    folded: fields.folded,
    exampleEntries
  };
};

// Walk a collection once, (re)building cache entries for changed files, and
// return a Map<pathname, cacheEntry>. This is the expensive pass. The readdir
// walk is quick; the per-file stat/read/fold is done with a small worker pool
// (serial stats were the multi-second cost on ~11.5k-file collections).
const WORKSPACE_SEARCH_BUILD_CONCURRENCY = 32;

const buildCollectionSearchEntries = async (workspacePath, collectionPath, format) => {
  const files = [];

  const walk = async (dirname) => {
    let dirents;
    try {
      dirents = await fs.promises.readdir(dirname, { withFileTypes: true });
    } catch (_err) {
      return;
    }

    for (const dirent of dirents) {
      if (shouldSkipWorkspaceSearchEntry(dirent.name)) {
        continue;
      }
      const pathname = path.join(dirname, dirent.name);
      if (dirent.isDirectory()) {
        await walk(pathname);
        continue;
      }
      if (!dirent.isFile() || !hasRequestExtension(pathname, format)) {
        continue;
      }
      if (isWorkspaceSearchCollectionMetadataFile(dirent.name, dirname, collectionPath)) {
        continue;
      }
      files.push({ pathname, isFolderMeta: dirent.name === `folder.${format}` });
    }
  };

  await walk(collectionPath);

  // Stat/build in parallel, but keep walk order deterministic in the result.
  const built = new Array(files.length);
  let nextFile = 0;
  const worker = async () => {
    while (nextFile < files.length) {
      const index = nextFile++;
      const { pathname, isFolderMeta } = files[index];
      let cacheEntry = workspaceSearchFileCache.get(pathname);
      try {
        const stat = await fs.promises.stat(pathname);
        if (!cacheEntry || cacheEntry.mtimeMs !== stat.mtimeMs || cacheEntry.size !== stat.size) {
          cacheEntry = await buildWorkspaceSearchCacheEntry({
            workspacePath,
            collectionPath,
            pathname,
            format,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            isFolderMeta
          });
          workspaceSearchFileCache.set(pathname, cacheEntry);
        }
        built[index] = cacheEntry;
      } catch (_err) {
        // skip unreadable files
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WORKSPACE_SEARCH_BUILD_CONCURRENCY, files.length) }, worker)
  );

  const entries = new Map();
  for (let i = 0; i < files.length; i++) {
    if (built[i]) {
      entries.set(files[i].pathname, built[i]);
    }
  }
  return entries;
};

// Return the warm index for a collection, building (or rebuilding when stale)
// as needed. Concurrent callers coalesce on the in-flight build promise.
// Stale-while-revalidate: when a previous build exists, its entries are served
// immediately and the rebuild runs in the background — a keystroke never waits
// on a full collection walk (that inline wait was the search lag on large
// workspaces). Only the very first build (no entries yet) is awaited.
const getCollectionSearchIndex = async (workspacePath, collectionPath) => {
  const existing = workspaceSearchIndex.get(collectionPath);
  if (existing && !existing.building && (Date.now() - existing.builtAt) < WORKSPACE_SEARCH_INDEX_TTL_MS) {
    return existing;
  }
  if (existing?.building) {
    // Serve stale entries while the rebuild is in flight.
    return existing.entries?.size ? existing : existing.building;
  }

  const format = getCollectionFormat(collectionPath);
  const startGeneration = existing?.generation || 0;
  const buildPromise = (async () => {
    const entries = await buildCollectionSearchEntries(workspacePath, collectionPath, format);
    const current = workspaceSearchIndex.get(collectionPath);
    const generation = current?.generation ?? startGeneration;
    const built = {
      // If an invalidation raced the walk, keep the result usable but stale
      // so the next search kicks another rebuild.
      builtAt: generation === startGeneration ? Date.now() : 0,
      format,
      entries,
      building: null,
      generation
    };
    workspaceSearchIndex.set(collectionPath, built);
    return built;
  })();
  // A rejected build must not wedge the collection: clear the in-flight
  // marker so the next search retries.
  buildPromise.catch(() => {
    const current = workspaceSearchIndex.get(collectionPath);
    if (current?.building === buildPromise) {
      current.building = null;
    }
  });

  const placeholder = {
    builtAt: existing?.builtAt || 0,
    format,
    entries: existing?.entries || new Map(),
    building: buildPromise,
    generation: startGeneration
  };
  workspaceSearchIndex.set(collectionPath, placeholder);

  // Stale-while-revalidate: previous entries exist -> use them now.
  return placeholder.entries.size ? placeholder : buildPromise;
};

module.exports = {
  getCollectionSearchIndex,
  invalidateWorkspaceSearchForPath,
  createWorkspaceCollectionSearchResult,
  // exposed for eviction and tests
  buildCollectionSearchEntries,
  workspaceSearchIndex,
  workspaceSearchFileCache,
  WORKSPACE_SEARCH_INDEX_TTL_MS
};
