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
    // Match a changed file inside the collection AND a parent directory above
    // it (a git operation invalidates by workspace root).
    const changedInsideCollection = normalized === collectionPath || normalized.startsWith(`${collectionPath}${path.sep}`);
    const collectionInsideChangedPath = collectionPath.startsWith(`${normalized}${path.sep}`);
    if (changedInsideCollection || collectionInsideChangedPath) {
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

// Drop everything cached under a collection (or workspace) path. Without
// eviction the index + per-file cache grow forever across closed collections
// and switched workspaces — entries hold full folded file contents.
const evictWorkspaceSearchForPath = (pathname) => {
  if (!pathname) {
    return;
  }
  const normalized = path.normalize(pathname);
  const isUnder = (candidate) => candidate === normalized || candidate.startsWith(`${normalized}${path.sep}`);

  for (const collectionPath of [...workspaceSearchIndex.keys()]) {
    if (isUnder(collectionPath)) {
      workspaceSearchIndex.delete(collectionPath);
    }
  }
  for (const filePath of [...workspaceSearchFileCache.keys()]) {
    if (isUnder(path.normalize(filePath))) {
      workspaceSearchFileCache.delete(filePath);
    }
  }
};

// After a rebuild, drop per-file cache entries under the collection that no
// longer exist on disk (deleted files otherwise linger in the cache forever).
const pruneWorkspaceSearchFileCache = (collectionPath, liveEntries) => {
  const normalizedCollectionPath = path.normalize(collectionPath);
  for (const filePath of [...workspaceSearchFileCache.keys()]) {
    const normalized = path.normalize(filePath);
    if (normalized === normalizedCollectionPath || normalized.startsWith(`${normalizedCollectionPath}${path.sep}`)) {
      if (!liveEntries.has(filePath)) {
        workspaceSearchFileCache.delete(filePath);
      }
    }
  }
};

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

// --- Fold worker pool ---------------------------------------------------
// Folding is the CPU-dominant cost of an index build (~97% of wall time on
// content-heavy collections, measured on the GSB workspace) and it is pure
// computation — so it runs on a small worker_threads pool, chunked to
// amortize messaging. Falls back to inline folding if workers cannot spawn.
const os = require('os');
const FOLD_POOL_SIZE = Math.max(1, Math.min(4, os.cpus().length - 1));
// Chunks flush on EITHER bound. The byte bound is what matters: fold cost
// scales with content bytes, so a count-only bound lets one 8MB chunk pin a
// single worker while the rest of the pool idles.
const FOLD_CHUNK_SIZE = 64;
const FOLD_CHUNK_BYTES = 256 * 1024;
let foldPool = null; // { workers: [], pending: Map<id, {resolve,reject}>, nextId, nextWorker } | 'unavailable'

const FOLD_POOL_IDLE_MS = 30 * 1000;

const terminateFoldPool = () => {
  if (foldPool && foldPool !== 'unavailable') {
    for (const worker of foldPool.workers) {
      worker.terminate().catch(() => {});
    }
    clearTimeout(foldPool.idleTimer);
    foldPool = null;
  }
};

const scheduleFoldPoolTeardown = (pool) => {
  clearTimeout(pool.idleTimer);
  pool.idleTimer = setTimeout(() => {
    if (foldPool === pool && pool.pending.size === 0) {
      terminateFoldPool();
    }
  }, FOLD_POOL_IDLE_MS);
  pool.idleTimer.unref?.();
};

const getFoldPool = () => {
  // Never spawn worker threads under jest: open worker handles keep the test
  // process alive after the run finishes (observed as hung jest processes).
  // Tests exercise the inline fold path, which is behavior-identical.
  if (process.env.JEST_WORKER_ID !== undefined) {
    return null;
  }
  if (foldPool) {
    return foldPool === 'unavailable' ? null : foldPool;
  }
  try {
    const { Worker } = require('node:worker_threads');
    const scriptPath = path.join(__dirname, 'workspace-search-fold-worker.js');
    const pool = { workers: [], pending: new Map(), nextId: 1, nextWorker: 0, idleTimer: null };
    for (let i = 0; i < FOLD_POOL_SIZE; i++) {
      const worker = new Worker(scriptPath);
      worker.unref(); // never keep the process alive for the pool
      worker.on('message', ({ id, results, error }) => {
        const entry = pool.pending.get(id);
        if (entry) {
          pool.pending.delete(id);
          error ? entry.reject(new Error(error)) : entry.resolve(results);
        }
      });
      worker.on('error', (err) => {
        // Fail all in-flight requests routed to this worker; callers fall
        // back to inline folding.
        for (const [id, entry] of pool.pending.entries()) {
          if (entry.workerIndex === i) {
            pool.pending.delete(id);
            entry.reject(err);
          }
        }
      });
      pool.workers.push(worker);
    }
    foldPool = pool;
    return pool;
  } catch (_err) {
    foldPool = 'unavailable';
    return null;
  }
};

const foldChunkInWorker = (pool, jobs) => new Promise((resolve, reject) => {
  const id = pool.nextId++;
  const workerIndex = pool.nextWorker;
  pool.nextWorker = (pool.nextWorker + 1) % pool.workers.length;
  pool.pending.set(id, { resolve, reject, workerIndex });
  pool.workers[workerIndex].postMessage({ id, jobs });
  // Tear the pool down after it sits idle — warm builds are bursty and the
  // threads should not linger for the rest of the session.
  scheduleFoldPoolTeardown(pool);
});

const buildWorkspaceSearchCacheEntry = async ({ workspacePath, collectionPath, pathname, format, mtimeMs, size, isFolderMeta }, perf) => {
  const r0 = perf ? performance.now() : 0;
  const content = await readSearchText(pathname);
  if (perf) {
    perf.readMs += performance.now() - r0;
    perf.bytes += content.length;
  }
  const result = isFolderMeta
    ? createWorkspaceFolderSearchResult({ workspacePath, collectionPath, pathname, content, format })
    : createWorkspaceSearchResult({ workspacePath, collectionPath, pathname, content, format });

  const f0 = perf ? performance.now() : 0;
  const fields = buildSearchFields({
    content,
    format,
    name: result.name,
    filename: result.filename,
    url: result.url
  });
  if (perf) {
    perf.foldMs += performance.now() - f0;
  }

  return assembleCacheEntry({ result, fields, mtimeMs, size, isFolderMeta });
};

// Attach a lightweight example list to the request result so search rows can
// show the "has examples" marker and expand to the examples without parsing.
const assembleCacheEntry = ({ result, fields, mtimeMs, size, isFolderMeta }) => {
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
  // Temporary perf instrumentation (GRIDMAN_PERF=1) — I/O vs CPU split of a
  // search-index build. Local to this build; safe under concurrent builds.
  const perf = process.env.GRIDMAN_PERF
    ? { t0: performance.now(), statMs: 0, readMs: 0, foldMs: 0, built: 0, cached: 0, bytes: 0 }
    : null;

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
  // Phase 1 (main thread, pooled): stat + read changed files and prepare
  // their result shells. Folding — the CPU-dominant part — is dispatched to
  // the worker pool in chunks AS reads complete, so transient memory stays
  // bounded and the fold runs on other cores while reads continue.
  const pool = getFoldPool();
  const pendingFold = [];
  let pendingFoldBytes = 0;
  const foldDispatches = [];

  const foldChunk = (chunk) => {
    const dispatch = async () => {
      let fieldsList = null;
      if (pool) {
        try {
          fieldsList = await foldChunkInWorker(pool, chunk.map((job) => ({
            content: job.content,
            format,
            name: job.result.name,
            filename: job.result.filename,
            url: job.result.url
          })));
          if (perf) {
            perf.workerChunks = (perf.workerChunks || 0) + 1;
          }
        } catch (err) {
          fieldsList = null; // worker died — fold this chunk inline below
          if (perf) {
            perf.inlineChunks = (perf.inlineChunks || 0) + 1;
            perf.workerError = err?.message;
          }
        }
      } else if (perf) {
        perf.noPool = true;
      }
      chunk.forEach((job, k) => {
        let fields = fieldsList?.[k];
        if (!fields) {
          const f0 = perf ? performance.now() : 0;
          fields = buildSearchFields({
            content: job.content,
            format,
            name: job.result.name,
            filename: job.result.filename,
            url: job.result.url
          });
          if (perf) {
            perf.foldMs += performance.now() - f0;
          }
        }
        const entry = assembleCacheEntry({
          result: job.result,
          fields,
          mtimeMs: job.mtimeMs,
          size: job.size,
          isFolderMeta: job.isFolderMeta
        });
        workspaceSearchFileCache.set(job.pathname, entry);
        built[job.index] = entry;
        job.content = null; // release the file text as soon as it is folded
      });
    };
    foldDispatches.push(dispatch());
  };

  const reader = async () => {
    while (nextFile < files.length) {
      const index = nextFile++;
      const { pathname, isFolderMeta } = files[index];
      const cacheEntry = workspaceSearchFileCache.get(pathname);
      try {
        const s0 = perf ? performance.now() : 0;
        const stat = await fs.promises.stat(pathname);
        if (perf) {
          perf.statMs += performance.now() - s0;
        }
        if (!cacheEntry || cacheEntry.mtimeMs !== stat.mtimeMs || cacheEntry.size !== stat.size) {
          if (perf) {
            perf.built += 1;
          }
          const r0 = perf ? performance.now() : 0;
          const content = await readSearchText(pathname);
          if (perf) {
            perf.readMs += performance.now() - r0;
            perf.bytes += content.length;
          }
          const result = isFolderMeta
            ? createWorkspaceFolderSearchResult({ workspacePath, collectionPath, pathname, content, format })
            : createWorkspaceSearchResult({ workspacePath, collectionPath, pathname, content, format });
          pendingFold.push({ index, pathname, isFolderMeta, mtimeMs: stat.mtimeMs, size: stat.size, content, result });
          pendingFoldBytes += content.length;
          if (pendingFold.length >= FOLD_CHUNK_SIZE || pendingFoldBytes >= FOLD_CHUNK_BYTES) {
            foldChunk(pendingFold.splice(0, pendingFold.length));
            pendingFoldBytes = 0;
          }
        } else {
          if (perf) {
            perf.cached += 1;
          }
          built[index] = cacheEntry;
        }
      } catch (_err) {
        // skip unreadable files
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WORKSPACE_SEARCH_BUILD_CONCURRENCY, files.length) }, reader)
  );
  if (pendingFold.length) {
    foldChunk(pendingFold.splice(0, pendingFold.length));
  }
  await Promise.all(foldDispatches);

  if (perf) {
    const total = performance.now() - perf.t0;
    console.warn(
      `[perf:search] ${path.basename(collectionPath)} files=${files.length} `
      + `built=${perf.built} cached=${perf.cached} bytes=${perf.bytes} `
      + `total=${total.toFixed(0)}ms stat=${perf.statMs.toFixed(0)}ms `
      + `read=${perf.readMs.toFixed(0)}ms inlineFold=${perf.foldMs.toFixed(0)}ms `
      + `wchunks=${perf.workerChunks || 0} ichunks=${perf.inlineChunks || 0}`
      + `${perf.noPool ? ' NOPOOL' : ''}${perf.workerError ? ` werr=${perf.workerError}` : ''}`
    );
  }

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
// Warm-peek: usable entries exist right now (fresh, or stale-while-
// revalidating). Lets the search match warm collections FIRST instead of
// awaiting cold builds serially in workspace order.
const hasWarmCollectionSearchIndex = (collectionPath) => {
  const existing = workspaceSearchIndex.get(collectionPath);
  return Boolean(existing?.entries?.size);
};

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
    pruneWorkspaceSearchFileCache(collectionPath, entries);
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
  hasWarmCollectionSearchIndex,
  getCollectionSearchIndex,
  invalidateWorkspaceSearchForPath,
  evictWorkspaceSearchForPath,
  createWorkspaceCollectionSearchResult,
  // exposed for eviction and tests
  buildCollectionSearchEntries,
  workspaceSearchIndex,
  workspaceSearchFileCache,
  WORKSPACE_SEARCH_INDEX_TTL_MS
};
