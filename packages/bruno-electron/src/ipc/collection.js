const _ = require('lodash');
const fs = require('fs');
const fsExtra = require('fs-extra');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const extractZip = require('extract-zip');
const AdmZip = require('adm-zip');
const { ipcMain, shell, dialog, app } = require('electron');
const {
  parseRequest,
  stringifyRequest,
  parseRequestViaWorker,
  stringifyRequestViaWorker,
  parseCollection,
  stringifyCollection,
  parseFolder,
  stringifyFolder,
  stringifyEnvironment,
  parseEnvironment,
  DEFAULT_COLLECTION_FORMAT
} = require('@usebruno/filestore');
const { dotenvToJson } = require('@usebruno/lang');
const { utils } = require('@usebruno/common');
const brunoConverters = require('@usebruno/converters');
const { postmanToBruno } = brunoConverters;
const { cookiesStore } = require('../store/cookies');
const { parseLargeRequestWithRedaction, isRequestTooExpensiveToParse } = require('../utils/parse');
const { wsClient } = require('../ipc/network/ws-event-handlers');
const { hasSubDirectories } = require('../utils/filesystem');
const { transformProxyConfig } = require('@usebruno/requests');

const {
  DEFAULT_GITIGNORE,
  writeFile,
  hasBruExtension,
  isDirectory,
  createDirectory,
  sanitizeName,
  isWSLPath,
  safeToRename,
  isWindowsOS,
  hasRequestExtension,
  getCollectionFormat,
  isValidCollectionDirectory,
  searchForRequestFiles,
  validateName,
  getCollectionStats,
  sizeInMB,
  safeWriteFileSync,
  movePathWithRetry,
  copyPath,
  removePath,
  getPaths,
  winLongPath,
  normalizeAndResolvePath,
  generateUniqueName,
  isDotEnvFile,
  isValidDotEnvFilename,
  isReusableDeletedCollectionDirectory,
  isBrunoConfigFile,
  isBruEnvironmentConfig,
  isCollectionRootBruFile,
  scanForBrunoFiles
} = require('../utils/filesystem');
const { openCollectionsByPathname, registerScratchCollectionPath, isScratchCollectionPath } = require('../app/collections');
const { moveToAppTrash } = require('../utils/app-trash');
const { generateUidBasedOnHash, stringifyJson, safeStringifyJSON, safeParseJSON } = require('../utils/common');
const { getRequestUid, moveRequestUid, deleteRequestUid, syncExampleUidsCache } = require('../cache/requestUids');
const { deleteCookiesForDomain, getDomainsWithCookies, addCookieForDomain, modifyCookieForDomain, parseCookieString, createCookieString, deleteCookie } = require('../utils/cookies');
const EnvironmentSecretsStore = require('../store/env-secrets');
const CollectionSecurityStore = require('../store/collection-security');
const UiStateSnapshotStore = require('../store/ui-state-snapshot');
const interpolateVars = require('./network/interpolate-vars');
const { interpolateString } = require('./network/interpolate-string');
const { getEnvVars, getTreePathFromCollectionToItem, mergeVars, parseBruFileMeta, parseFileMeta, hydrateRequestWithUuid, transformRequestToSaveToFilesystem } = require('../utils/collection');
const { getProcessEnvVars } = require('../store/process-env');
const { getOAuth2TokenUsingAuthorizationCode, getOAuth2TokenUsingClientCredentials, getOAuth2TokenUsingPasswordCredentials, getOAuth2TokenUsingImplicitGrant, refreshOauth2Token } = require('../utils/oauth2');
const { getCertsAndProxyConfig } = require('./network/cert-utils');
const collectionWatcher = require('../app/collection-watcher');
const { startCollectionIndex, promoteCollectionIndex, cancelCollectionIndex } = require('../app/collection-indexer');
const { transformBrunoConfigBeforeSave } = require('../utils/transformBrunoConfig');
const { REQUEST_TYPES } = require('../utils/constants');
const { cancelOAuth2AuthorizationRequest, isOauth2AuthorizationRequestInProgress } = require('../utils/oauth2-protocol-handler');
const { findUniqueFolderName } = require('../utils/collection-import');
const { migrateCollectionToYml } = require('../utils/collection-migration');
const { withWatchReleased } = require('../app/watch-release');
const { readCollectionItemsFromDisk, readFolderForExport, writeItemsIntoFolder } = require('./collection-export-import');
const { saveSpecAndUpdateMetadata, cleanupSpecFilesForCollection } = require('./openapi-sync');
const {
  addCollectionToWorkspace,
  getWorkspaceCollectionsDir,
  getWorkspaceUid,
  isWorkspaceCollectionPath,
  readWorkspaceConfig,
  resolveAndFilterWorkspaceCollections
} = require('../utils/workspace-config');

const environmentSecretsStore = new EnvironmentSecretsStore();
const collectionSecurityStore = new CollectionSecurityStore();
const uiStateSnapshotStore = new UiStateSnapshotStore();

// Size and file count limits to determine whether a collection hydrates lazily (metadata index only,
// requests load on demand) instead of eagerly (index + full initial scan). Every collection is indexed
// either way (sidebar unification Phase 2). Keep the file threshold intentionally low: moderately large
// nested API collections are where recursive Redux tree mounting and initial watcher events start
// causing visible sidebar lag.
const MAX_COLLECTION_SIZE_IN_MB = 20;
const MAX_SINGLE_FILE_SIZE_IN_COLLECTION_IN_MB = 5;
const MAX_COLLECTION_FILES_COUNT = 100;
const INDEXED_COLLECTION_WATCHER_ATTACH_DELAY_MS = 3000;

// The watcher's partial-parse threshold. A sidebar click must classify a file
// exactly like the watcher's own scan does, so both read the same constant — and
// name an unparseable file the same way, since the sidebar renders from the index
// and a name carrying the extension repaints the row.
const {
  buildUnparseableRequestData,
  beginParseGeneration,
  claimNewestParseGeneration,
  isTransientWorkerFailure,
  parseFileMetaBounded
} = collectionWatcher;

const shouldUseIndexedCollectionLoad = ({ size, filesCount, maxFileSize }) => (
  (size > MAX_COLLECTION_SIZE_IN_MB)
  || (filesCount > MAX_COLLECTION_FILES_COUNT)
  || (maxFileSize > MAX_SINGLE_FILE_SIZE_IN_COLLECTION_IN_MB)
);

const REQUEST_FILE_TYPE_BY_FORMAT = {
  bru: '.bru',
  yml: '.yml'
};

const getRequestFilenameForFormat = (filename, format) => {
  const baseName = path.basename(String(filename || '').trim(), path.extname(String(filename || '').trim()));
  const ext = REQUEST_FILE_TYPE_BY_FORMAT[format] || '.bru';
  return `${baseName}${ext}`;
};

const assertPathInside = (rootPathname, targetPathname, message = 'Path must stay inside the collection') => {
  const root = normalizeAndResolvePath(rootPathname) || path.resolve(rootPathname);
  const target = fs.existsSync(targetPathname)
    ? (normalizeAndResolvePath(targetPathname) || path.resolve(targetPathname))
    : path.resolve(targetPathname);

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(message);
  }

  return target;
};

const assertCollectionItemPath = ({ collectionPathname, itemPathname }) => {
  const itemPath = assertPathInside(collectionPathname, itemPathname, 'Item path must stay inside the collection');
  if (itemPath === (normalizeAndResolvePath(collectionPathname) || path.resolve(collectionPathname))) {
    throw new Error('Collection root cannot be used as an item path');
  }
  return itemPath;
};

const getItemKindFromPath = (pathname, collectionPathname) => {
  if (!fs.existsSync(pathname)) {
    throw new Error(`path: ${pathname} does not exist`);
  }

  if (isDirectory(pathname)) {
    return 'folder';
  }

  const format = getCollectionFormat(collectionPathname);
  if (!hasRequestExtension(pathname, format)) {
    throw new Error(`path: ${pathname} is not a valid request file`);
  }

  return 'request';
};

/**
 * The request type ('http-request', 'graphql-request', …) for a file.
 *
 * Reads the META BLOCK only. This used to full-parse the file to look at one
 * word, on the browser process, on the rename / move / delete paths — the same
 * class of freeze that took the request watcher off the main thread. Measured
 * on the real workspace: a 1,096 KB request costs 3,081 ms to parse and 0.1 ms
 * to read the meta of, for an identical answer; the largest files in that
 * workspace (2.5 MB) can exhaust the heap outright.
 *
 * A file whose meta cannot be read still falls back to 'http-request', exactly
 * as it did when a parse failure landed in the catch below.
 */
/**
 * A failure the user can act on, from a parse error they cannot read.
 *
 * The one shape that actually reaches this in the reported workspace is a request whose
 * payload sits in a block the redactor does not cover (`body:multipart-form`, `body:file`,
 * `body:form-urlencoded`), so the grammar receives the whole file and needs roughly 1.4 GB
 * of heap per MB of it. Saying "out of memory" tells the user nothing they can do; naming
 * the cause does.
 */
const describeLoadFailure = (error) => {
  const code = error?.code;
  const message = String(error?.message || '');
  if (code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory|heap/i.test(message)) {
    return 'This request needs more memory to parse than Gridman can give it. That happens when '
      + 'the bulk of the file sits in a body Gridman cannot summarise while parsing — a '
      + 'multipart-form, file, or form-urlencoded body. Splitting the large value out of the '
      + 'request, or storing it as a saved example instead, makes the request open normally.';
  }
  return message
    ? `This request could not be parsed: ${message}`
    : 'This request could not be parsed.';
};

const getRequestTypeFromPath = (pathname, collectionPathname) => {
  const format = getCollectionFormat(collectionPathname);
  try {
    const data = fs.readFileSync(pathname, 'utf8');
    return parseFileMeta(data, format)?.type || 'http-request';
  } catch (_err) {
    return 'http-request';
  }
};

const updateFolderMeta = async ({ folderPathname, name, seq, collectionPathname }) => {
  const format = getCollectionFormat(collectionPathname);
  const folderFilePath = path.join(folderPathname, `folder.${format}`);
  let folderFileJsonContent;

  if (fs.existsSync(folderFilePath)) {
    const oldFolderFileContent = await fs.promises.readFile(folderFilePath, 'utf8');
    folderFileJsonContent = await parseFolder(oldFolderFileContent, { format });
  } else {
    folderFileJsonContent = { meta: {} };
  }

  folderFileJsonContent.meta = folderFileJsonContent.meta || {};
  if (name) {
    folderFileJsonContent.meta.name = name;
  }
  if (seq) {
    folderFileJsonContent.meta.seq = seq;
  }

  const folderFileContent = await stringifyFolder(folderFileJsonContent, { format });
  await writeFile(folderFilePath, folderFileContent);
};

const cloneRequestByPath = async ({ sourcePathname, targetPathname, newName, collectionPathname }) => {
  const format = getCollectionFormat(collectionPathname);
  if (!hasRequestExtension(sourcePathname, format)) {
    throw new Error(`path: ${sourcePathname} is not a valid request file`);
  }
  if (fs.existsSync(targetPathname)) {
    throw new Error(`path: ${targetPathname} already exists`);
  }

  const data = await fs.promises.readFile(sourcePathname, 'utf8');
  // Off the browser process for the same reason as rename: cloning a large
  // example-heavy request otherwise blocks the whole window on the parse.
  const jsonData = await parseRequestViaWorker(data, { format });
  jsonData.name = newName;
  const content = await stringifyRequestViaWorker(jsonData, { format });
  await writeFile(targetPathname, content);
  return targetPathname;
};

const cloneFolderByPath = async ({ sourcePathname, targetPathname, newName, collectionPathname }) => {
  if (!isDirectory(sourcePathname)) {
    throw new Error(`path: ${sourcePathname} is not a folder`);
  }
  if (fs.existsSync(targetPathname)) {
    throw new Error(`folder: ${targetPathname} already exists`);
  }

  await fsExtra.copy(sourcePathname, targetPathname, { errorOnExist: true });
  await updateFolderMeta({ folderPathname: targetPathname, name: newName, collectionPathname });
  return targetPathname;
};

const createFolderByPath = async ({ parentPathname, collectionPathname, folderName, directoryName }) => {
  const parentPath = assertPathInside(collectionPathname, parentPathname, 'Parent path must stay inside the collection');
  if (!fs.existsSync(parentPath) || !isDirectory(parentPath)) {
    throw new Error('Parent folder does not exist');
  }

  const format = getCollectionFormat(collectionPathname);
  const targetPathname = path.join(parentPath, sanitizeName(directoryName || folderName));
  assertPathInside(collectionPathname, targetPathname);
  if (fs.existsSync(targetPathname)) {
    throw new Error('The directory already exists');
  }

  const siblingCount = fs.readdirSync(parentPath).filter((name) => {
    const siblingPath = path.join(parentPath, name);
    return isDirectory(siblingPath) || hasRequestExtension(siblingPath, format);
  }).length;

  fs.mkdirSync(targetPathname);
  const folderFilePath = path.join(targetPathname, `folder.${format}`);
  const content = await stringifyFolder({
    meta: {
      name: folderName,
      seq: siblingCount + 1
    },
    request: {
      auth: {
        mode: 'inherit'
      }
    }
  }, { format });
  await writeFile(folderFilePath, content);
  return targetPathname;
};

// Disk-level paste/move helpers (extracted for unit testing).
const {
  resolveUniqueTargetPathname,
  applyDisplayNameSuffix,
  convertFolderBetweenFormats,
  pasteFolderByPath,
  pasteRequestByPath
} = require('./collection-paste-move');

const moveItemByPath = async ({ sourcePathname, targetPathname, sourceCollectionPathname, targetCollectionPathname, watcher }) => {
  if (!fs.existsSync(winLongPath(sourcePathname))) {
    throw new Error(`path: ${sourcePathname} does not exist`);
  }
  if (fs.existsSync(winLongPath(targetPathname))) {
    throw new Error(`path: ${targetPathname} already exists`);
  }

  const sourceKind = getItemKindFromPath(sourcePathname, sourceCollectionPathname);
  const normalizedSourcePathname = path.resolve(sourcePathname);
  const normalizedTargetPathname = path.resolve(targetPathname);
  if (
    sourceKind === 'folder'
    && (
      normalizedTargetPathname === normalizedSourcePathname
      || normalizedTargetPathname.startsWith(`${normalizedSourcePathname}${path.sep}`)
    )
  ) {
    throw new Error('Cannot move a folder inside itself');
  }

  const sourceFormat = getCollectionFormat(sourceCollectionPathname);
  const targetFormat = getCollectionFormat(targetCollectionPathname);

  const pathnamesBefore = await getPaths(sourcePathname);

  if (sourceKind === 'folder' && sourceFormat !== targetFormat) {
    const movedPairs = await convertFolderBetweenFormats({
      sourcePathname,
      targetPathname,
      sourceFormat,
      targetFormat
    });
    await removePath(sourcePathname);
    for (const [before, after] of movedPairs) {
      moveRequestUid(before, after);
    }
    return targetPathname;
  }

  if (sourceKind === 'request' && sourceFormat !== targetFormat) {
    const sourceContent = await fs.promises.readFile(sourcePathname, 'utf8');
    const parsedRequest = parseRequest(sourceContent, { format: sourceFormat });

    // Converting formats REWRITES the request and then deletes the original, so
    // anything the target format cannot carry is gone for good. Blocks written
    // by a newer Bruno survive a .bru round trip only because we keep them
    // verbatim; the yml serializers have no equivalent. Refuse the move rather
    // than silently drop them — before the parser learned to tolerate unknown
    // blocks this failed loudly by throwing, and it must keep failing loudly.
    const unknownBlocks = Array.isArray(parsedRequest?.unknownBlocks) ? parsedRequest.unknownBlocks : [];
    if (unknownBlocks.length) {
      const blockNames = unknownBlocks.map((block) => block?.name).filter(Boolean).join(', ');
      throw new Error(
        `"${path.basename(sourcePathname)}" contains blocks this version of Gridman does not understand`
        + `${blockNames ? ` (${blockNames})` : ''}. Converting it to ${targetFormat} would delete them, `
        + 'so the move was cancelled. Move it without changing format, or open it in the app that wrote it.'
      );
    }

    const finalContent = stringifyRequest(parsedRequest, { format: targetFormat });

    await writeFile(targetPathname, finalContent);
    await removePath(sourcePathname);
  } else {
    await withWatchReleased(watcher, { sourcePathname, targetPathname }, () =>
      movePathWithRetry(sourcePathname, targetPathname));
  }

  const pathnamesAfter = pathnamesBefore?.map((p) => p?.replace(sourcePathname, targetPathname));
  pathnamesAfter?.forEach((_, index) => {
    moveRequestUid(pathnamesBefore[index], pathnamesAfter[index]);
  });

  return targetPathname;
};

const addIndexedCollectionWatcherAfterIdle = (watcher, mainWindow, collectionPath, collectionUid, brunoConfig, useWorkerThread) => {
  setTimeout(() => {
    watcher.addWatcher(mainWindow, collectionPath, collectionUid, brunoConfig, false, useWorkerThread, {
      skipInitialLoad: true
    });
  }, INDEXED_COLLECTION_WATCHER_ATTACH_DELAY_MS);
};

// Sidebar unification Phase 2: every collection gets a metadata index (the
// renderer always renders the indexed sidebar). Collection size only decides
// HOW the tree hydrates afterwards:
//   - small collections (eager): once the index is ready, the watcher runs its
//     classic initial scan — fully parsed addFile/addDir events hydrate the
//     tree and loadedRequestsByPath, so data-dependent features are instant,
//     exactly like the classic loader behaved.
//   - large collections (lazy): the watcher attaches after an idle delay with
//     the initial scan skipped; requests hydrate on demand (unchanged).
// Running the eager scan only after index-ready keeps the indexer's
// uids/parents authoritative; hydration upserts then match nodes by uid.
// Eager initial scans are expensive: chokidar replays every file as a fully
// PARSED addFile event, and measured on the GSB workspace that is ~160s of
// parse CPU across 87 small collections (2.6k example-heavy files). Two
// protections keep startup responsive:
//  - parses run on the filestore worker thread, never the main process
//  - attaches are staggered (one every EAGER_ATTACH_GAP_MS), so startup is
//    not 87 simultaneous directory scans + IPC bursts. Until a collection
//    hydrates, every feature already works through the lazy/index paths.
const EAGER_ATTACH_GAP_MS = 250;
// Startup pipeline ordering: the search-index warm, the collection-index
// warm, and eager hydration all read the entire workspace. Racing them
// multiplied the warm's wall time ~10x (8-15s alone vs 2+ minutes measured
// on GSB), which is exactly the window where a user's first search is slow.
// Eager hydration is the most deferrable of the three (every feature works
// through the lazy/index paths until it lands), so its attach queue waits
// for the search warm — bounded so a wedged warm can never stall hydration.
const EAGER_ATTACH_WARM_WAIT_CAP_MS = 45 * 1000;
let searchWarmGate = null; // Promise | null — set when a workspace warm starts
const setSearchWarmGate = (promise) => {
  const bounded = Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, EAGER_ATTACH_WARM_WAIT_CAP_MS))
  ]);
  searchWarmGate = bounded;
  bounded.finally(() => {
    if (searchWarmGate === bounded) {
      searchWarmGate = null;
    }
    drainEagerAttachQueue();
  });
};
const eagerAttachQueue = [];
let eagerAttachTimer = null;
const drainEagerAttachQueue = () => {
  if (eagerAttachTimer || searchWarmGate) {
    return;
  }
  const next = eagerAttachQueue.shift();
  if (!next) {
    return;
  }
  try {
    next();
  } catch (_err) {
    // an attach failure must not stall the rest of the queue
  }
  eagerAttachTimer = setTimeout(() => {
    eagerAttachTimer = null;
    drainEagerAttachQueue();
  }, EAGER_ATTACH_GAP_MS);
};

const startIndexedCollectionLoad = (watcher, mainWindow, { collectionUid, collectionPathname, brunoConfig, loadSessionId, lazyHydration }) => {
  const attachEagerWatcher = () => {
    eagerAttachQueue.push(() => {
      watcher.addWatcher(mainWindow, collectionPathname, collectionUid, brunoConfig, false, true);
    });
    drainEagerAttachQueue();
  };

  startCollectionIndex(mainWindow, {
    collectionUid,
    collectionPathname,
    brunoConfig,
    loadSessionId,
    onReady: () => {
      if (lazyHydration) {
        addIndexedCollectionWatcherAfterIdle(
          watcher,
          mainWindow,
          collectionPathname,
          collectionUid,
          brunoConfig,
          lazyHydration
        );
      } else {
        attachEagerWatcher();
      }
    },
    onFailed: () => {
      if (!lazyHydration) {
        // Indexing failed on a small collection: still load it the classic way
        // (the renderer falls back to the recursive tree when the index is
        // marked failed), so the collection is never left empty and unwatched.
        attachEagerWatcher();
      }
    }
  });
};

// Get the base directory for transient request files (stored in app data directory)
const getTransientDirectoryBase = () => {
  return path.join(app.getPath('userData'), 'tmp', 'transient');
};

// Get the prefix used for transient collection directories
const getTransientCollectionPrefix = () => {
  return path.join(getTransientDirectoryBase(), 'gridman-');
};

// Get the prefix used for scratch collection directories
const getTransientScratchPrefix = () => {
  return path.join(getTransientDirectoryBase(), 'gridman-scratch-');
};

// Check if a path is within the transient directory
const isTransientPath = (filePath) => {
  const transientBase = getTransientDirectoryBase();
  return filePath.startsWith(transientBase + path.sep) || filePath.startsWith(transientBase);
};

const envHasSecrets = (environment = {}) => {
  const secrets = _.filter(environment.variables, (v) => v.secret);

  return secrets && secrets.length > 0;
};

const findCollectionPathByItemPath = (filePath) => {
  const parts = filePath.split(path.sep);
  const index = parts.findIndex((part) => part.startsWith('gridman-') || part.startsWith('bruno-'));

  if (isTransientPath(filePath) && index !== -1) {
    const transientDirPath = parts.slice(0, index + 1).join(path.sep);
    const metadataPath = path.join(transientDirPath, 'metadata.json');
    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataContent);

      if (metadata.type === 'scratch') {
        return transientDirPath;
      }

      if (metadata.collectionPath) {
        return metadata.collectionPath;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  const allCollectionPaths = collectionWatcher.getAllWatcherPaths();

  // Find the collection path that contains this file
  // Sort by length descending to find the most specific (deepest) match first
  const sortedPaths = allCollectionPaths.sort((a, b) => b.length - a.length);

  // Normalize the file path for comparison. path.normalize only handles
  // separators and ./.. — it does NOT normalize Unicode form, so a Persian (or
  // any non-ASCII) collection whose renderer-built path is NFC never matched a
  // watcher path the filesystem reports as NFD (macOS), and save-as failed with
  // "Collection not found for the given pathname". Compare in NFC; return the
  // original path so downstream fs reads use the real on-disk form.
  const normalizedFilePath = path.normalize(filePath).normalize('NFC');

  for (const collectionPath of sortedPaths) {
    const normalizedCollectionPath = path.normalize(collectionPath).normalize('NFC');
    if (normalizedFilePath.startsWith(normalizedCollectionPath + path.sep) || normalizedFilePath === normalizedCollectionPath) {
      return collectionPath;
    }
  }

  // Fallback: the target collection may be registered/indexed but not yet
  // WATCHED. Collections are now watched lazily (eager/after-idle), so a
  // save-as / new-request into a collection that was never opened this session
  // matched no active watcher and failed with "Collection not found for the
  // given pathname". Walk up from the item's directory to the nearest
  // collection root marker (bruno.json / opencollection.yml); this still proves
  // the path is inside a real collection, independent of watcher state.
  let dir = path.dirname(filePath);
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    if (isValidCollectionDirectory(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
};

const validatePathIsInsideCollection = (filePath) => {
  const collectionPath = findCollectionPathByItemPath(filePath);

  if (!collectionPath) {
    throw new Error(`Path: ${filePath} should be inside a collection`);
  }
};

const isWorkspaceCollectionPathAllowed = (workspacePath, collectionPath) => {
  return Boolean(workspacePath) && isWorkspaceCollectionPath(workspacePath, collectionPath);
};

const getWorkspaceCollectionLocation = (workspacePath) => {
  if (!workspacePath) {
    throw new Error('An active workspace is required.');
  }

  const collectionsDir = getWorkspaceCollectionsDir(workspacePath);
  fsExtra.ensureDirSync(collectionsDir);
  return collectionsDir;
};

const getUniqueCollectionCopyTarget = async (workspacePath, sourcePath) => {
  const collectionsDir = getWorkspaceCollectionLocation(workspacePath);
  const baseName = sanitizeName(path.basename(sourcePath)) || 'collection';
  const uniqueName = fs.existsSync(path.join(collectionsDir, baseName))
    ? await findUniqueFolderName(baseName, collectionsDir)
    : baseName;
  return path.join(collectionsDir, sanitizeName(uniqueName));
};

const hasCollectionConfigFile = (collectionPath) => {
  return fs.existsSync(path.join(collectionPath, 'opencollection.yml')) || fs.existsSync(path.join(collectionPath, 'bruno.json'));
};

const workspaceSearchJobs = new Map();
const WORKSPACE_SEARCH_BATCH_SIZE = 25;
const WORKSPACE_SEARCH_RESULT_LIMIT = 250;

const WORKSPACE_SEARCH_DEFAULT_SCOPES = {
  collections: true,
  names: true,
  url: true,
  headers: true,
  body: true,
  examples: true
};

const {
  matchSearchFields,
  boundSnippetSource,
  createSearchSnippet
} = require('../utils/workspace-search-match');
const {
  getCollectionSearchIndex,
  hasWarmCollectionSearchIndex,
  evictWorkspaceSearchForPath,
  createWorkspaceCollectionSearchResult
} = require('./workspace-search-index');

const SNIPPET_FIELDS = new Set(['headers', 'body', 'examples']);

const matchWorkspaceSearchEntry = (entry, job) => {
  const match = matchSearchFields(entry, {
    scopes: job.scopes,
    foldedQueryCi: job.foldedQueryCi,
    foldedQueryCs: job.foldedQueryCs,
    matchCase: job.matchCase
  });
  if (!match) {
    return null;
  }

  const { field } = match;
  // A file past the index cap was only indexed up to it, so a miss inside that
  // file is not proof there is nothing to find. Carry the flag on every result
  // from such a file rather than letting the cap look like an empty search.
  const indexTruncated = entry.truncated ? { indexTruncated: true } : null;
  if (SNIPPET_FIELDS.has(field)) {
    // Fold-and-find only a window around the match, not the whole field.
    const { source, truncatedStart } = boundSnippetSource(entry, field, job);
    const snippet = createSearchSnippet(
      source,
      job.query,
      job.matchCase ? { caseSensitive: true } : {},
      { truncatedStart }
    );
    return { matchField: field, matchText: snippet || entry.raw[field].slice(0, 100), ...indexTruncated };
  }
  return { matchField: field, matchText: String(entry.raw[field]), ...indexTruncated };
};

const sendWorkspaceSearchBatch = (event, job, force = false) => {
  if (!job.results.length) {
    return;
  }

  if (!force && job.results.length < WORKSPACE_SEARCH_BATCH_SIZE) {
    return;
  }

  const results = job.results.splice(0, job.results.length);
  event.sender.send('main:workspace-collection-search-batch', {
    searchSessionId: job.searchSessionId,
    results
  });
};

// Warm all collection indexes in the background (called when the search box
// is focused) so the first keystroke matches against an already-built index.
const warmWorkspaceSearch = async (workspacePath, collectionPaths = []) => {
  for (const collectionPath of collectionPaths) {
    if (!isWorkspaceCollectionPathAllowed(workspacePath, collectionPath) || !isDirectory(collectionPath)) {
      continue;
    }
    try {
      await getCollectionSearchIndex(workspacePath, collectionPath);
    } catch (_err) {
      // best-effort warm-up
    }
  }
};

const matchWorkspaceSearchCollectionIndex = (event, job, indexEntries) => {
  for (const cacheEntry of indexEntries.values()) {
    if (job.cancelled || job.totalResults >= job.limit) {
      return;
    }

    const match = matchWorkspaceSearchEntry(cacheEntry, job);
    if (match) {
      job.results.push({ ...cacheEntry.result, ...match });
      job.totalResults += 1;
      sendWorkspaceSearchBatch(event, job);
    }
  }
};

const startWorkspaceCollectionSearch = async (event, {
  searchSessionId,
  workspacePath,
  collectionPaths = [],
  query,
  limit = WORKSPACE_SEARCH_RESULT_LIMIT,
  options = {}
}) => {
  for (const job of workspaceSearchJobs.values()) {
    job.cancelled = true;
  }
  workspaceSearchJobs.clear();

  const trimmedQuery = String(query || '').trim();
  const matchCase = Boolean(options.matchCase);
  const scopes = { ...WORKSPACE_SEARCH_DEFAULT_SCOPES, ...(options.scopes || {}) };
  const job = {
    searchSessionId,
    cancelled: false,
    results: [],
    totalResults: 0,
    limit: Math.min(Math.max(Number(limit) || WORKSPACE_SEARCH_RESULT_LIMIT, 1), 500),
    query: trimmedQuery,
    matchCase,
    scopes,
    foldedQueryCi: utils.foldSearchText(trimmedQuery),
    foldedQueryCs: utils.foldSearchText(trimmedQuery, { caseSensitive: true })
  };
  workspaceSearchJobs.set(searchSessionId, job);

  event.sender.send('main:workspace-collection-search-started', { searchSessionId });

  const searchesFileContent = scopes.names || scopes.url || scopes.headers || scopes.body || scopes.examples;

  if (!trimmedQuery || trimmedQuery.length < 2 || !workspacePath || !collectionPaths.length
    || (!searchesFileContent && !scopes.collections)) {
    event.sender.send('main:workspace-collection-search-ready', {
      searchSessionId,
      totalResults: 0
    });
    workspaceSearchJobs.delete(searchSessionId);
    return;
  }

  try {
    // Two passes: collections whose search index is already warm answer
    // first (results in milliseconds), cold ones build after. Previously the
    // loop awaited builds serially in workspace order, so one cold
    // collection blocked results from every warm collection behind it — a
    // narrow query during the startup warm took 2+ minutes to first result.
    const eligiblePaths = collectionPaths.filter(
      (collectionPath) => isWorkspaceCollectionPathAllowed(workspacePath, collectionPath) && isDirectory(collectionPath)
    );
    const orderedPaths = [
      ...eligiblePaths.filter((collectionPath) => hasWarmCollectionSearchIndex(collectionPath)),
      ...eligiblePaths.filter((collectionPath) => !hasWarmCollectionSearchIndex(collectionPath))
    ];
    for (const collectionPath of orderedPaths) {
      if (job.cancelled || job.totalResults >= job.limit) {
        break;
      }

      if (scopes.collections) {
        const collectionName = path.basename(collectionPath);
        const foldedName = utils.foldSearchText(collectionName);
        const ciMatch = foldedName.includes(job.foldedQueryCi);
        const matched = ciMatch && (!matchCase
          || utils.foldSearchText(collectionName, { caseSensitive: true }).includes(job.foldedQueryCs));
        if (matched) {
          job.results.push({
            ...createWorkspaceCollectionSearchResult({ workspacePath, collectionPath }),
            matchField: 'name',
            matchText: collectionName
          });
          job.totalResults += 1;
          sendWorkspaceSearchBatch(event, job);
        }
      }

      if (searchesFileContent) {
        const index = await getCollectionSearchIndex(workspacePath, collectionPath);
        if (job.cancelled) {
          break;
        }
        matchWorkspaceSearchCollectionIndex(event, job, index.entries);
      }
    }

    sendWorkspaceSearchBatch(event, job, true);

    if (!job.cancelled) {
      event.sender.send('main:workspace-collection-search-ready', {
        searchSessionId,
        totalResults: job.totalResults,
        limit: job.limit
      });
    }
  } catch (err) {
    if (!job.cancelled) {
      event.sender.send('main:workspace-collection-search-failed', {
        searchSessionId,
        error: err?.message || 'Workspace search failed'
      });
    }
  } finally {
    if (workspaceSearchJobs.get(searchSessionId) === job) {
      workspaceSearchJobs.delete(searchSessionId);
    }
  }
};

const prepareWorkspaceConfigForClient = (workspaceConfig, workspacePath) => {
  const remoteWorkspaceName = workspaceConfig.name;

  return {
    ...workspaceConfig,
    // See ipc/workspace.js: the carried name wins, the directory is a fallback.
    name: workspaceConfig.name || path.basename(workspacePath),
    remoteWorkspaceName,
    collections: resolveAndFilterWorkspaceCollections(workspacePath, workspaceConfig.collections)
  };
};

const broadcastWorkspaceConfig = (mainWindow, workspacePath) => {
  if (!workspacePath || !mainWindow) {
    return;
  }

  const workspaceConfig = readWorkspaceConfig(workspacePath);
  mainWindow.webContents.send(
    'main:workspace-config-updated',
    workspacePath,
    getWorkspaceUid(workspacePath),
    prepareWorkspaceConfigForClient(workspaceConfig, workspacePath)
  );
};

const registerCollectionInWorkspace = async (mainWindow, workspacePath, collectionPath, collectionName) => {
  if (!workspacePath || !collectionPath) {
    return;
  }

  if (!isWorkspaceCollectionPathAllowed(workspacePath, collectionPath)) {
    throw new Error('Imported collections must be inside the workspace collections folder.');
  }

  await addCollectionToWorkspace(workspacePath, {
    name: collectionName || path.basename(collectionPath),
    path: collectionPath
  });
  broadcastWorkspaceConfig(mainWindow, workspacePath);
};

const registerRendererEventHandlers = (mainWindow, watcher) => {
  // create collection
  ipcMain.handle(
    'renderer:create-collection',
    async (event, collectionName, collectionFolderName, collectionLocation, options = {}) => {
      try {
        const format = options.format || DEFAULT_COLLECTION_FORMAT;
        collectionFolderName = sanitizeName(collectionFolderName);
        const targetLocation = getWorkspaceCollectionLocation(options.workspaceId);
        const dirPath = path.join(targetLocation, collectionFolderName);

        if (!isWorkspaceCollectionPathAllowed(options.workspaceId, dirPath)) {
          throw new Error('Workspace collections must be created inside the workspace collections folder.');
        }

        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath);

          if (files.length > 0 && hasCollectionConfigFile(dirPath)) {
            await openCollectionsByPathname(mainWindow, watcher, [dirPath], { workspacePath: options.workspaceId });
            return {
              openedExistingCollection: true,
              path: dirPath
            };
          }

          if (files.length > 0 && !isReusableDeletedCollectionDirectory(dirPath)) {
            throw new Error(`collection: ${dirPath} already exists and is not empty`);
          }
        }

        if (!validateName(path.basename(dirPath))) {
          throw new Error(`collection: invalid pathname - ${dirPath}`);
        }

        if (!fs.existsSync(dirPath)) {
          await createDirectory(dirPath);
        }

        const uid = generateUidBasedOnHash(dirPath);
        let brunoConfig = {
          version: '1',
          name: collectionName,
          type: 'collection',
          ignore: ['node_modules', '.git']
        };

        if (format === 'yml') {
          const collectionRoot = {
            meta: {
              name: collectionName
            }
          };
          // For YAML collections, set opencollection instead of version
          brunoConfig = {
            opencollection: '1.0.0',
            name: collectionName,
            type: 'collection',
            ignore: ['node_modules', '.git']
          };
          const content = stringifyCollection(collectionRoot, brunoConfig, { format });
          await writeFile(path.join(dirPath, 'opencollection.yml'), content);
        } else if (format === 'bru') {
          const content = await stringifyJson(brunoConfig);
          await writeFile(path.join(dirPath, 'bruno.json'), content);
        } else {
          throw new Error(`Invalid format: ${format}`);
        }

        await writeFile(path.join(dirPath, '.gitignore'), DEFAULT_GITIGNORE);

        const { size, filesCount } = await getCollectionStats(dirPath);
        brunoConfig.size = size;
        brunoConfig.filesCount = filesCount;

        mainWindow.webContents.send('main:collection-opened', dirPath, uid, brunoConfig, options.workspaceId);
        ipcMain.emit('main:collection-opened', mainWindow, dirPath, uid, brunoConfig, options.workspaceId);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  );
  // clone collection
  ipcMain.handle(
    'renderer:clone-collection',
    async (event, collectionName, collectionFolderName, collectionLocation, previousPath) => {
      collectionFolderName = sanitizeName(collectionFolderName);
      const dirPath = path.join(collectionLocation, collectionFolderName);
      if (fs.existsSync(dirPath)) {
        throw new Error(`collection: ${dirPath} already exists`);
      }

      if (!validateName(path.basename(dirPath))) {
        throw new Error(`collection: invalid pathname - ${dirPath}`);
      }

      // create dir
      await createDirectory(dirPath);
      const uid = generateUidBasedOnHash(dirPath);
      const format = getCollectionFormat(previousPath);
      let brunoConfig;

      if (format === 'yml') {
        const configFilePath = path.join(previousPath, 'opencollection.yml');
        const content = fs.readFileSync(configFilePath, 'utf8');
        const {
          brunoConfig: parsedBrunoConfig,
          collectionRoot
        } = parseCollection(content, { format });

        brunoConfig = parsedBrunoConfig;
        brunoConfig.name = collectionName;

        const newContent = stringifyCollection(collectionRoot, brunoConfig, { format });
        await writeFile(path.join(dirPath, 'opencollection.yml'), newContent);
      } else if (format === 'bru') {
        const configFilePath = path.join(previousPath, 'bruno.json');
        const content = fs.readFileSync(configFilePath, 'utf8');
        brunoConfig = JSON.parse(content);
        brunoConfig.name = collectionName;
        const newContent = await stringifyJson(brunoConfig);
        await writeFile(path.join(dirPath, 'bruno.json'), newContent);
      } else {
        throw new Error(`Invalid collectionformat: ${format}`);
      }

      // Now copy all the files matching the collection's filetype along with the dir
      const files = searchForRequestFiles(previousPath);

      for (const sourceFilePath of files) {
        const relativePath = path.relative(previousPath, sourceFilePath);
        const newFilePath = path.join(dirPath, relativePath);

        // skip if the file is opencollection.yml or bruno.json at the root of the collection
        const isRootConfigFile = (path.basename(sourceFilePath) === 'opencollection.yml' || path.basename(sourceFilePath) === 'bruno.json')
          && path.dirname(sourceFilePath) === previousPath;

        if (isRootConfigFile) {
          continue;
        }

        // handle dir of files
        fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
        // copy each files
        fs.copyFileSync(sourceFilePath, newFilePath);
      }

      const { size, filesCount } = await getCollectionStats(dirPath);
      brunoConfig.size = size;
      brunoConfig.filesCount = filesCount;

      mainWindow.webContents.send('main:collection-opened', dirPath, uid, brunoConfig);
      ipcMain.emit('main:collection-opened', mainWindow, dirPath, uid, brunoConfig);
    }
  );
  // rename collection
  ipcMain.handle('renderer:rename-collection', async (event, newName, collectionPathname) => {
    try {
      const format = getCollectionFormat(collectionPathname);

      if (format === 'yml') {
        const configFilePath = path.join(collectionPathname, 'opencollection.yml');
        const content = fs.readFileSync(configFilePath, 'utf8');
        const {
          brunoConfig,
          collectionRoot
        } = parseCollection(content, { format: 'yml' });

        brunoConfig.name = newName;

        const newContent = stringifyCollection(collectionRoot, brunoConfig, { format: 'yml' });
        await writeFile(path.join(collectionPathname, 'opencollection.yml'), newContent);
      } else if (format === 'bru') {
        const configFilePath = path.join(collectionPathname, 'bruno.json');
        const content = fs.readFileSync(configFilePath, 'utf8');
        const brunoConfig = JSON.parse(content);
        brunoConfig.name = newName;
        const newContent = await stringifyJson(brunoConfig);
        await writeFile(path.join(collectionPathname, 'bruno.json'), newContent);
      } else {
        throw new Error(`Invalid format: ${format}`);
      }

      mainWindow.webContents.send('main:collection-renamed', {
        collectionPathname,
        newName
      });
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:save-folder-root', async (event, folder) => {
    try {
      const { name: folderName, root: folderRoot = {}, folderPathname, collectionPathname } = folder;

      const format = getCollectionFormat(collectionPathname);
      const folderFilePath = path.join(folderPathname, `folder.${format}`);

      if (!folderRoot.meta) {
        folderRoot.meta = {
          name: folderName
        };
      }

      const content = await stringifyFolder(folderRoot, { format });
      await writeFile(folderFilePath, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // save collection root
  ipcMain.handle('renderer:save-collection-root', async (event, collectionPathname, collectionRoot, brunoConfig) => {
    try {
      const format = getCollectionFormat(collectionPathname);
      const filename = format === 'yml' ? 'opencollection.yml' : 'collection.bru';
      const content = await stringifyCollection(collectionRoot, brunoConfig, { format });

      await writeFile(path.join(collectionPathname, filename), content);
    } catch (error) {
      console.error('Error in save-collection-root:', error);
      return Promise.reject(error);
    }
  });

  // new request
  ipcMain.handle('renderer:new-request', async (event, pathname, request) => {
    try {
      if (fs.existsSync(pathname)) {
        throw new Error(`A request named "${path.basename(pathname)}" already exists in this folder`);
      }

      const collectionPath = findCollectionPathByItemPath(pathname);
      if (!collectionPath) {
        throw new Error('Collection not found for the given pathname');
      }
      const format = getCollectionFormat(collectionPath);

      // For the actual filename part, we want to be strict
      const baseFilename = request?.filename?.replace(`.${format}`, '');
      if (!validateName(baseFilename)) {
        throw new Error(`${request.filename} is not a valid filename`);
      }
      validatePathIsInsideCollection(pathname);

      const content = await stringifyRequestViaWorker(request, { format });
      await writeFile(pathname, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // save request
  ipcMain.handle('renderer:save-request', async (event, pathname, request, format) => {
    try {
      if (!fs.existsSync(pathname)) {
        throw new Error(`path: ${pathname} does not exist`);
      }

      // Sync example UIDs cache to maintain consistency when examples are added/deleted/reordered
      syncExampleUidsCache(pathname, request.examples);

      const content = await stringifyRequestViaWorker(request, { format });
      await writeFile(pathname, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:save-transient-request', async (event, { sourcePathname, targetDirname, targetFilename, request, format, sourceFormat }) => {
    try {
      if (!fs.existsSync(sourcePathname)) {
        throw new Error(`Source path: ${sourcePathname} does not exist`);
      }

      if (!fs.existsSync(targetDirname)) {
        throw new Error(`Target directory: ${targetDirname} does not exist`);
      }

      validatePathIsInsideCollection(targetDirname);

      const collectionPath = findCollectionPathByItemPath(targetDirname);
      if (!collectionPath) {
        throw new Error('Could not determine collection for target directory');
      }
      const targetFormat = getCollectionFormat(collectionPath);

      const filename = targetFilename || path.basename(sourcePathname);
      const filenameWithoutExt = filename.replace(/\.(bru|yml)$/, '');
      const finalFilename = `${filenameWithoutExt}.${targetFormat}`;
      const targetPathname = path.join(targetDirname, finalFilename);

      if (fs.existsSync(targetPathname)) {
        throw new Error(`A file with the name "${finalFilename}" already exists in the target location`);
      }

      const actualSourceFormat = sourceFormat || 'yml';
      const needsConversion = actualSourceFormat !== targetFormat;

      let finalContent;
      if (needsConversion) {
        const { parseRequest, stringifyRequest } = require('@usebruno/filestore');
        const sourceContent = await fs.promises.readFile(sourcePathname, 'utf8');
        const parsedRequest = parseRequest(sourceContent, { format: actualSourceFormat });
        const mergedRequest = { ...parsedRequest, ...request };
        syncExampleUidsCache(sourcePathname, mergedRequest.examples);
        finalContent = stringifyRequest(mergedRequest, { format: targetFormat });
      } else {
        syncExampleUidsCache(sourcePathname, request.examples);
        finalContent = await stringifyRequestViaWorker(request, { format: targetFormat });
      }

      await writeFile(targetPathname, finalContent);
      return { newPathname: targetPathname };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // save multiple requests
  ipcMain.handle('renderer:save-multiple-requests', async (event, requestsToSave) => {
    try {
      for (let r of requestsToSave) {
        const request = r.item;
        const pathname = r.pathname;

        if (!fs.existsSync(pathname)) {
          throw new Error(`path: ${pathname} does not exist`);
        }

        const content = await stringifyRequestViaWorker(request, { format: r.format });
        await writeFile(pathname, content);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Helper: Parse file content based on scope type
  const parseFileByType = async (fileContent, scopeType, format) => {
    switch (scopeType) {
      case 'request':
        return await parseRequestViaWorker(fileContent, { format });
      case 'folder':
        return parseFolder(fileContent, { format });
      case 'collection':
        return parseCollection(fileContent, { format });
      default:
        throw new Error(`Invalid scope type: ${scopeType}`);
    }
  };

  const stringifyByType = async (data, scopeType, collectionRoot, format) => {
    switch (scopeType) {
      case 'request':
        return await stringifyRequestViaWorker(data, { format });
      case 'folder':
        return stringifyFolder(data, { format });
      case 'collection':
        return stringifyCollection(collectionRoot, data, { format });
      default:
        throw new Error(`Invalid scope type: ${scopeType}`);
    }
  };

  // Helper: Update or create variable in array
  const updateOrCreateVariable = (variables, variable) => {
    const existingVar = variables.find((v) => v.name === variable.name);

    if (existingVar) {
      // Update existing variable
      return variables.map((v) => (v.name === variable.name ? variable : v));
    }

    // Create new variable
    return [...variables, variable];
  };

  // update variable in request/folder/collection file
  ipcMain.handle('renderer:update-variable-in-file', async (event, pathname, variable, scopeType, collectionRoot, format) => {
    try {
      if (!fs.existsSync(pathname)) {
        throw new Error(`path: ${pathname} does not exist`);
      }

      // Read and parse the file
      const fileContent = fs.readFileSync(pathname, 'utf8');
      const parsedData = await parseFileByType(fileContent, scopeType, format);

      // Update the specific variable or create it if it doesn't exist
      const varsPath = 'request.vars.req';
      const variables = _.get(parsedData, varsPath, []);
      const updatedVariables = updateOrCreateVariable(variables, variable);

      _.set(parsedData, varsPath, updatedVariables);

      const content = await stringifyByType(parsedData, scopeType, collectionRoot, format);
      await writeFile(pathname, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // create environment
  ipcMain.handle('renderer:create-environment', async (event, collectionPathname, name, variables, color) => {
    try {
      const envDirPath = path.join(collectionPathname, 'environments');
      if (!fs.existsSync(envDirPath)) {
        await createDirectory(envDirPath);
      }

      const format = getCollectionFormat(collectionPathname);

      // Get existing environment files to generate unique name
      const existingFiles = fs.existsSync(envDirPath) ? fs.readdirSync(envDirPath) : [];
      const existingEnvNames = existingFiles
        .filter((file) => file.endsWith(`.${format}`))
        .map((file) => path.basename(file, `.${format}`));

      // Generate unique name based on existing environment files
      const sanitizedName = sanitizeName(name);
      const uniqueName = generateUniqueName(sanitizedName, (name) => existingEnvNames.includes(name));

      const envFilePath = path.join(envDirPath, `${uniqueName}.${format}`);

      const environment = {
        name: uniqueName,
        variables: variables || [],
        color
      };

      if (envHasSecrets(environment)) {
        environmentSecretsStore.storeEnvSecrets(collectionPathname, environment);
      }

      const content = await stringifyEnvironment(environment, { format });

      await writeFile(envFilePath, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // save environment
  ipcMain.handle('renderer:save-environment', async (event, collectionPathname, environment) => {
    try {
      const envDirPath = path.join(collectionPathname, 'environments');
      if (!fs.existsSync(envDirPath)) {
        await createDirectory(envDirPath);
      }

      const format = getCollectionFormat(collectionPathname);
      // Determine filetype from collection
      const envFilePath = path.join(envDirPath, `${environment.name}.${format}`);

      if (!fs.existsSync(envFilePath)) {
        throw new Error(`environment: ${envFilePath} does not exist`);
      }

      if (envHasSecrets(environment)) {
        environmentSecretsStore.storeEnvSecrets(collectionPathname, environment);
      }

      const content = await stringifyEnvironment(environment, { format });
      await writeFile(envFilePath, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // rename environment
  ipcMain.handle('renderer:rename-environment', async (event, collectionPathname, environmentName, newName) => {
    try {
      const format = getCollectionFormat(collectionPathname);
      const envDirPath = path.join(collectionPathname, 'environments');
      const envFilePath = path.join(envDirPath, `${environmentName}.${format}`);

      if (!fs.existsSync(envFilePath)) {
        throw new Error(`environment: ${envFilePath} does not exist`);
      }

      const newEnvFilePath = path.join(envDirPath, `${newName}.${format}`);
      if (!safeToRename(envFilePath, newEnvFilePath)) {
        throw new Error(`environment: ${newEnvFilePath} already exists`);
      }

      moveRequestUid(envFilePath, newEnvFilePath);
      fs.renameSync(envFilePath, newEnvFilePath);

      environmentSecretsStore.renameEnvironment(collectionPathname, environmentName, newName);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // delete environment
  ipcMain.handle('renderer:delete-environment', async (event, collectionPathname, environmentName) => {
    try {
      const format = getCollectionFormat(collectionPathname);
      const envDirPath = path.join(collectionPathname, 'environments');
      const envFilePath = path.join(envDirPath, `${environmentName}.${format}`);
      if (!fs.existsSync(envFilePath)) {
        throw new Error(`environment: ${envFilePath} does not exist`);
      }

      await moveToAppTrash(envFilePath, { type: 'environment', collectionPathname });

      environmentSecretsStore.deleteEnvironment(collectionPathname, environmentName);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Save .env file variables for collection
  ipcMain.handle('renderer:save-dotenv-variables', async (event, collectionPathname, variables, filename = '.env') => {
    try {
      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(collectionPathname, filename);
      const content = utils.jsonToDotenv(variables);
      await writeFile(dotEnvPath, content);

      return { success: true };
    } catch (error) {
      console.error('Error saving .env file:', error);
      return Promise.reject(error);
    }
  });

  // Save .env file raw content for collection
  ipcMain.handle('renderer:save-dotenv-raw', async (event, collectionPathname, content, filename = '.env') => {
    try {
      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(collectionPathname, filename);
      await writeFile(dotEnvPath, content);
      return { success: true };
    } catch (error) {
      console.error('Error saving .env file:', error);
      return Promise.reject(error);
    }
  });

  // Create .env file for collection
  ipcMain.handle('renderer:create-dotenv-file', async (event, collectionPathname, filename = '.env') => {
    try {
      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(collectionPathname, filename);

      if (fs.existsSync(dotEnvPath)) {
        throw new Error(`${filename} file already exists`);
      }

      await writeFile(dotEnvPath, '');

      return { success: true, filename };
    } catch (error) {
      console.error('Error creating .env file:', error);
      return Promise.reject(error);
    }
  });

  // Delete .env file for collection
  ipcMain.handle('renderer:delete-dotenv-file', async (event, collectionPathname, filename = '.env') => {
    try {
      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(collectionPathname, filename);

      if (!fs.existsSync(dotEnvPath)) {
        throw new Error(`${filename} file does not exist`);
      }

      fs.unlinkSync(dotEnvPath);

      return { success: true };
    } catch (error) {
      console.error('Error deleting .env file:', error);
      return Promise.reject(error);
    }
  });

  // update environment color
  ipcMain.handle('renderer:update-environment-color', async (event, collectionPathname, environmentName, color) => {
    try {
      const format = getCollectionFormat(collectionPathname);
      const envDirPath = path.join(collectionPathname, 'environments');
      const envFilePath = path.join(envDirPath, `${environmentName}.${format}`);

      if (!fs.existsSync(envFilePath)) {
        throw new Error(`environment: ${envFilePath} does not exist`);
      }

      // Read, update color, and write back to file
      const fileContent = fs.readFileSync(envFilePath, 'utf8');
      const environment = parseEnvironment(fileContent, { format });
      environment.color = color;
      const updatedContent = stringifyEnvironment(environment, { format });
      fs.writeFileSync(envFilePath, updatedContent, 'utf8');
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Generic environment export handler
  ipcMain.handle('renderer:export-environment', async (event, { environments, environmentType, filePath, exportFormat = 'folder' }) => {
    try {
      const { app } = require('electron');
      const appVersion = app?.getVersion() || '2.0.0';

      // For single environments and folder exports, include info in each environment
      const environmentWithInfo = (environment) => ({
        name: environment.name,
        variables: environment.variables,
        color: environment.color ?? undefined,
        info: {
          type: 'bruno-environment',
          exportedAt: new Date().toISOString(),
          exportedUsing: `Bruno/v${appVersion}`
        }
      });

      if (exportFormat === 'folder') {
        // separate environment json files in folder
        const baseFolderName = `bruno-${environmentType}-environments`;
        const uniqueFolderName = generateUniqueName(baseFolderName, (name) => fs.existsSync(path.join(filePath, name)));
        const exportPath = path.join(filePath, uniqueFolderName);

        fs.mkdirSync(exportPath, { recursive: true });

        for (const environment of environments) {
          const baseFileName = environment.name ? `${environment.name.replace(/[^a-zA-Z0-9-_]/g, '_')}` : 'environment';
          const uniqueFileName = generateUniqueName(baseFileName, (name) => fs.existsSync(path.join(exportPath, `${name}.json`)));
          const fullPath = path.join(exportPath, `${uniqueFileName}.json`);

          const cleanEnv = environmentWithInfo(environment);
          const jsonContent = JSON.stringify(cleanEnv, null, 2);
          await fs.promises.writeFile(fullPath, jsonContent, 'utf8');
        }
      } else if (exportFormat === 'single-file') {
        // all environments in a single file with top-level info and environments array
        const baseFileName = `bruno-${environmentType}-environments`;
        const uniqueFileName = generateUniqueName(baseFileName, (name) => fs.existsSync(path.join(filePath, `${name}.json`)));
        const fullPath = path.join(filePath, `${uniqueFileName}.json`);

        const exportData = {
          info: {
            type: 'bruno-environment',
            exportedAt: new Date().toISOString(),
            exportedUsing: `Bruno/v${appVersion}`
          },
          environments
        };

        const jsonContent = JSON.stringify(exportData, null, 2);
        await fs.promises.writeFile(fullPath, jsonContent, 'utf8');
      } else if (exportFormat === 'single-object') {
        // single environment json file
        if (environments.length !== 1) {
          throw new Error('Single object export requires exactly one environment');
        }

        const environment = environments[0];
        const baseFileName = environment.name ? `${environment.name.replace(/[^a-zA-Z0-9-_]/g, '_')}` : 'environment';
        const uniqueFileName = generateUniqueName(baseFileName, (name) => fs.existsSync(path.join(filePath, `${name}.json`)));
        const fullPath = path.join(filePath, `${uniqueFileName}.json`);
        const jsonContent = JSON.stringify(environmentWithInfo(environment), null, 2);
        await fs.promises.writeFile(fullPath, jsonContent, 'utf8');
      } else {
        throw new Error(`Unsupported export format: ${exportFormat}`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // rename item
  ipcMain.handle('renderer:rename-item-name', async (event, { itemPath, newName, collectionPathname }) => {
    try {
      if (!fs.existsSync(itemPath)) {
        throw new Error(`path: ${itemPath} does not exist`);
      }

      if (isDirectory(itemPath)) {
        const format = getCollectionFormat(collectionPathname);
        const folderFilePath = path.join(itemPath, `folder.${format}`);
        let folderFileJsonContent;
        if (fs.existsSync(folderFilePath)) {
          const oldFolderFileContent = await fs.promises.readFile(folderFilePath, 'utf8');
          folderFileJsonContent = await parseFolder(oldFolderFileContent, { format });
          folderFileJsonContent.meta.name = newName;
        } else {
          folderFileJsonContent = {
            meta: {
              name: newName
            }
          };
        }

        const folderFileContent = await stringifyFolder(folderFileJsonContent, { format });
        await writeFile(folderFilePath, folderFileContent);

        return;
      }

      const format = getCollectionFormat(collectionPathname);
      if (!hasRequestExtension(itemPath, format)) {
        throw new Error(`path: ${itemPath} is not a valid request file`);
      }

      // Parse and serialise OFF the browser process. A rename only edits the
      // meta name, but the round-trip still costs a full parse of the file —
      // 3,081 ms on a real 1,096 KB request in the reported workspace, and a
      // fatal heap exhaustion past ~2.5 MB. That block IS the reported
      // "pressing rename does nothing, then it applies minutes later with an
      // error": the work was queued behind a frozen main thread.
      const data = await fs.promises.readFile(itemPath, 'utf8');
      const jsonData = await parseRequestViaWorker(data, { format });
      jsonData.name = newName;
      const content = await stringifyRequestViaWorker(jsonData, { format });
      await writeFile(itemPath, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // rename item
  ipcMain.handle('renderer:rename-item-filename', async (event, { oldPath, newPath, newName, newFilename, collectionPathname }) => {
    const tempDir = path.join(os.tmpdir(), `temp-folder-${Date.now()}`);
    const isWindowsOSAndNotWSLPathAndItemHasSubDirectories = isDirectory(oldPath) && isWindowsOS() && !isWSLPath(oldPath) && hasSubDirectories(oldPath);
    try {
      // Check if the old path exists
      if (!fs.existsSync(oldPath)) {
        throw new Error(`path: ${oldPath} does not exist`);
      }

      if (!safeToRename(oldPath, newPath)) {
        throw new Error(`path: ${newPath} already exists`);
      }

      const format = getCollectionFormat(collectionPathname);

      if (isDirectory(oldPath)) {
        const folderFilePath = path.join(oldPath, `folder.${format}`);
        let folderFileJsonContent;
        if (fs.existsSync(folderFilePath)) {
          const oldFolderFileContent = await fs.promises.readFile(folderFilePath, 'utf8');
          folderFileJsonContent = await parseFolder(oldFolderFileContent, { format });
          folderFileJsonContent.meta.name = newName;
        } else {
          folderFileJsonContent = {
            meta: {
              name: newName
            }
          };
        }

        const folderFileContent = await stringifyFolder(folderFileJsonContent, { format });
        await writeFile(folderFilePath, folderFileContent);

        const requestFilesAtSource = await searchForRequestFiles(oldPath, collectionPathname);

        for (let requestFile of requestFilesAtSource) {
          const newRequestFilePath = requestFile.replace(oldPath, newPath);
          moveRequestUid(requestFile, newRequestFilePath);
        }

        /**
         * If it is windows OS
         * And it is not a WSL path (meaning it is not running in WSL (linux pathtype))
         * And it has sub directories
         * Only then we need to use the temp dir approach to rename the folder
         *
         * Windows OS would sometimes throw error when renaming a folder with sub directories
         * This is an alternative approach to avoid that error
         */
        if (isWindowsOSAndNotWSLPathAndItemHasSubDirectories) {
          await fsExtra.copy(oldPath, tempDir);
          await fsExtra.remove(oldPath);
          await fsExtra.move(tempDir, newPath, { overwrite: true });
          await fsExtra.remove(tempDir);
        } else {
          await fs.renameSync(oldPath, newPath);
        }

        return newPath;
      }

      if (!hasRequestExtension(oldPath, format)) {
        throw new Error(`path: ${oldPath} is not a valid request file`);
      }

      if (!validateName(newFilename)) {
        throw new Error(`path: ${newFilename} is not a valid filename`);
      }

      // update name in file and save new copy, then delete old copy
      // Parse and serialise OFF the browser process. A rename only edits the
      // meta name, but the round-trip still costs a full parse of the file —
      // 3,081 ms on a real 1,096 KB request in the reported workspace, and a
      // fatal heap exhaustion past ~2.5 MB. That block IS the reported
      // "pressing rename does nothing, then it applies minutes later with an
      // error": the work was queued behind a frozen main thread.
      const data = await fs.promises.readFile(oldPath, 'utf8');
      const jsonData = await parseRequestViaWorker(data, { format });
      jsonData.name = newName;
      moveRequestUid(oldPath, newPath);

      const content = await stringifyRequestViaWorker(jsonData, { format });
      await fs.promises.unlink(oldPath);
      await writeFile(newPath, content);

      return newPath;
    } catch (error) {
      // in case the rename file operations fails, and we see that the temp dir exists
      // and the old path does not exist, we need to restore the data from the temp dir to the old path
      if (isWindowsOSAndNotWSLPathAndItemHasSubDirectories) {
        if (fsExtra.pathExistsSync(tempDir) && !fsExtra.pathExistsSync(oldPath)) {
          try {
            await fsExtra.copy(tempDir, oldPath);
            await fsExtra.remove(tempDir);
          } catch (err) {
            console.error('Failed to restore data to the old path:', err);
          }
        }
      }

      return Promise.reject(error);
    }
  });

  // new folder
  ipcMain.handle('renderer:new-folder', async (event, { pathname, folderData, format }) => {
    const resolvedFolderName = sanitizeName(path.basename(pathname));
    pathname = path.join(path.dirname(pathname), resolvedFolderName);
    try {
      if (!fs.existsSync(pathname)) {
        fs.mkdirSync(pathname);
        const folderFilePath = path.join(pathname, `folder.${format}`);
        const content = await stringifyFolder(folderData, { format });
        await writeFile(folderFilePath, content);
      } else {
        return Promise.reject(new Error('The directory already exists'));
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // delete file/folder
  ipcMain.handle('renderer:delete-item', async (event, pathname, type, collectionPathname) => {
    try {
      if (type === 'folder') {
        if (!fs.existsSync(pathname)) {
          return Promise.reject(new Error('The directory does not exist'));
        }

        // delete the request uid mappings
        const requestFilesAtSource = await searchForRequestFiles(pathname, collectionPathname);
        for (let requestFile of requestFilesAtSource) {
          deleteRequestUid(requestFile);
        }

        await moveToAppTrash(pathname, { type: 'folder', collectionPathname });
      } else if (['http-request', 'graphql-request', 'grpc-request', 'ws-request'].includes(type)) {
        if (!fs.existsSync(pathname)) {
          return Promise.reject(new Error('The file does not exist'));
        }

        deleteRequestUid(pathname);

        await moveToAppTrash(pathname, { type: 'request', collectionPathname });
      } else {
        return Promise.reject();
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Delete transient request files by their absolute paths
  // This is a simpler handler specifically for cleaning up transient requests
  // tempDirectory: the collection's temp directory path to validate files belong to this collection
  ipcMain.handle('renderer:delete-transient-requests', async (event, filePaths, tempDirectory) => {
    const gridmanTempPrefix = getTransientCollectionPrefix();
    const results = { deleted: [], skipped: [], errors: [] };

    // Validate tempDirectory is within Gridman transient directory
    const normalizedTempDir = tempDirectory ? path.normalize(tempDirectory) : null;
    if (!normalizedTempDir || !normalizedTempDir.startsWith(gridmanTempPrefix)) {
      return { deleted: [], skipped: filePaths.map((p) => ({ path: p, reason: 'Invalid temp directory' })), errors: [] };
    }

    for (const filePath of filePaths) {
      try {
        // Safety check: only delete files within the collection's temp directory
        const normalizedPath = path.normalize(filePath);
        if (!normalizedPath.startsWith(normalizedTempDir + path.sep) && normalizedPath !== normalizedTempDir) {
          results.skipped.push({ path: filePath, reason: 'Not in collection temp directory' });
          continue;
        }

        // Check if file exists before trying to delete
        if (!fs.existsSync(filePath)) {
          results.skipped.push({ path: filePath, reason: 'File does not exist' });
          continue;
        }

        // Delete the file and its UID mapping
        deleteRequestUid(filePath);
        fs.unlinkSync(filePath);
        results.deleted.push(filePath);
      } catch (error) {
        results.errors.push({ path: filePath, error: error.message });
      }
    }

    return results;
  });

  ipcMain.handle('renderer:open-collection', async (event, options = {}) => {
    if (watcher && mainWindow) {
      const workspacePath = options.workspaceId;
      const collectionsDir = getWorkspaceCollectionLocation(workspacePath);
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory', 'multiSelections'],
        title: 'Import Collection',
        buttonLabel: 'Import Collection'
      });

      if (canceled || !filePaths?.length) {
        return [];
      }

      const importedPaths = [];
      for (const filePath of [...new Set(filePaths)]) {
        const sourcePath = path.resolve(filePath);
        if (!isDirectory(sourcePath)) {
          continue;
        }
        if (!hasCollectionConfigFile(sourcePath)) {
          throw new Error(`Invalid collection: ${sourcePath}`);
        }

        const targetPath = isWorkspaceCollectionPathAllowed(workspacePath, sourcePath)
          ? sourcePath
          : await getUniqueCollectionCopyTarget(workspacePath, sourcePath);

        if (targetPath !== sourcePath) {
          await fsExtra.copy(sourcePath, targetPath, {
            overwrite: false,
            errorOnExist: true,
            filter: (src) => path.basename(src) !== '.git'
          });
        }

        if (!isWorkspaceCollectionPathAllowed(workspacePath, targetPath)) {
          throw new Error('Imported collections must be copied into the workspace collections folder.');
        }

        await openCollectionsByPathname(mainWindow, watcher, [targetPath], { workspacePath });
        await registerCollectionInWorkspace(mainWindow, workspacePath, targetPath, path.basename(targetPath));
        importedPaths.push(targetPath);
      }

      return importedPaths;
    }
  });

  ipcMain.handle('renderer:open-multiple-collections', async (e, collectionPaths, options = {}) => {
    if (watcher && mainWindow) {
      if (options.workspacePath) {
        const outsideCollection = collectionPaths.find((collectionPath) => !isWorkspaceCollectionPathAllowed(options.workspacePath, collectionPath));
        if (outsideCollection) {
          throw new Error('Workspace collections must be inside the workspace collections folder.');
        }
      }

      await openCollectionsByPathname(mainWindow, watcher, collectionPaths, { workspacePath: options.workspacePath });
      if (options.workspacePath) {
        const { setCollectionWorkspace } = require('../store/process-env');
        const { generateUidBasedOnHash } = require('../utils/common');
        for (const collectionPath of collectionPaths) {
          const collectionUid = generateUidBasedOnHash(collectionPath);
          setCollectionWorkspace(collectionUid, options.workspacePath);
        }
      }
    }
  });

  ipcMain.handle('renderer:start-workspace-collection-search', async (event, options = {}) => {
    startWorkspaceCollectionSearch(event, options);
    return true;
  });

  // Pre-build the search index in the background (called when the search box is
  // focused) so the first keystroke matches an already-warm index.
  ipcMain.handle('renderer:warm-workspace-search', async (event, { workspacePath, collectionPaths = [] } = {}) => {
    if (workspacePath) {
      const warmPromise = warmWorkspaceSearch(workspacePath, collectionPaths);
      // Defer eager-hydration attaches until the warm finishes (bounded) so
      // the two full-workspace reads do not race each other on disk/CPU.
      setSearchWarmGate(warmPromise);
      // Resolve when the warm actually completes so the renderer can chain
      // the collection-index warm after it (and log an honest duration).
      await warmPromise.catch(() => {});
    }
    return true;
  });

  ipcMain.handle('renderer:set-collection-workspace', (event, collectionUid, workspacePath) => {
    if (workspacePath) {
      const { setCollectionWorkspace } = require('../store/process-env');
      setCollectionWorkspace(collectionUid, workspacePath);
    }
  });

  ipcMain.handle('renderer:remove-collection', async (event, collectionPath, collectionUid, workspacePath, options = {}) => {
    if (watcher && mainWindow) {
      watcher.removeWatcher(collectionPath, mainWindow, collectionUid);
      cancelCollectionIndex(collectionUid);

      if (wsClient) {
        wsClient.closeForCollection(collectionUid);
      }
    }

    // Clean up
    const { clearCollectionWorkspace } = require('../store/process-env');
    clearCollectionWorkspace(collectionUid);
    // Search caches hold folded file contents; free them with the collection.
    evictWorkspaceSearchForPath(collectionPath);

    const shouldDeleteCollectionFiles = Boolean(workspacePath) && isWorkspaceCollectionPathAllowed(workspacePath, collectionPath);

    if (workspacePath) {
      try {
        const { removeCollectionFromWorkspace } = require('../utils/workspace-config');
        await removeCollectionFromWorkspace(workspacePath, collectionPath);
      } catch (error) {
        console.error('Error removing collection from workspace.yml:', error);
      }
    }

    if (shouldDeleteCollectionFiles && fs.existsSync(collectionPath)) {
      await moveToAppTrash(collectionPath, { type: 'collection' });
    }

    // Clean up AppData spec files for this collection
    try {
      cleanupSpecFilesForCollection(collectionPath);
    } catch (error) {
      console.error('Error cleaning up spec files for removed collection:', error);
    }
  });

  ipcMain.handle('renderer:import-collection', async (_, collection, collectionLocation, options = {}) => {
    const format = options.format || DEFAULT_COLLECTION_FORMAT;
    const rawOpenAPISpec = options.rawOpenAPISpec;
    const targetCollectionLocation = getWorkspaceCollectionLocation(options.workspaceId);
    let collections = Array.isArray(collection) ? collection : [collection];
    let completedImports = 0;
    let failedImports = 0;
    let successfulImports = [];

    for (let coll of collections) {
      try {
        // Sending a "started" and "ended" event to renderer to start and stop the spinner.
        mainWindow.webContents.send('main:collection-import-started', coll.uid);

        let collectionName = sanitizeName(coll.name);
        let collectionPath = path.join(targetCollectionLocation, collectionName);

        // Auto-rename if collection already exists
        if (fs.existsSync(collectionPath)) {
          const uniqueName = await findUniqueFolderName(coll.name, targetCollectionLocation);
          collectionName = sanitizeName(uniqueName);
          collectionPath = path.join(targetCollectionLocation, collectionName);
          coll.name = uniqueName;
        }

        const getFilenameWithFormat = (item, format) => {
          if (item?.filename) {
            const ext = path.extname(item.filename);
            if (ext === '.bru' || ext === '.yml') {
              return item.filename.replace(ext, `.${format}`);
            }
            return item.filename;
          }
          return `${item.name}.${format}`;
        };

        // Recursive function to parse the collection items and create files/folders
        const parseCollectionItems = async (items = [], currentPath) => {
          await Promise.all(items.map(async (item) => {
            if (['http-request', 'graphql-request', 'grpc-request', 'ws-request'].includes(item.type)) {
              let sanitizedFilename = sanitizeName(getFilenameWithFormat(item, format));
              const content = await stringifyRequestViaWorker(item, { format });
              const filePath = path.join(currentPath, sanitizedFilename);
              safeWriteFileSync(filePath, content);
            }
            if (item.type === 'folder') {
              let sanitizedFolderName = sanitizeName(item?.filename || item?.name);
              const folderPath = path.join(currentPath, sanitizedFolderName);
              fs.mkdirSync(folderPath, { recursive: true });

              if (item?.root?.meta?.name) {
                const folderFilePath = path.join(folderPath, `folder.${format}`);
                item.root.meta.seq = item.seq;
                const folderContent = await stringifyFolder(item.root, { format });
                safeWriteFileSync(folderFilePath, folderContent);
              }

              if (item.items && item.items.length) {
                await parseCollectionItems(item.items, folderPath);
              }
            }
            // Handle items of type 'js'
            if (item.type === 'js') {
              let sanitizedFilename = sanitizeName(item?.filename || `${item.name}.js`);
              const filePath = path.join(currentPath, sanitizedFilename);
              safeWriteFileSync(filePath, item.fileContent);
            }
          }));
        };

        const parseEnvironments = async (environments = [], collectionPath) => {
          const envDirPath = path.join(collectionPath, 'environments');
          if (!fs.existsSync(envDirPath)) {
            fs.mkdirSync(envDirPath);
          }

          await Promise.all(environments.map(async (env) => {
            const content = await stringifyEnvironment(env, { format });
            let sanitizedEnvFilename = sanitizeName(`${env.name}.${format}`);
            const filePath = path.join(envDirPath, sanitizedEnvFilename);
            safeWriteFileSync(filePath, content);
          }));
        };

        const getBrunoJsonConfig = (collection) => {
          let brunoConfig = collection.brunoConfig;

          if (!brunoConfig) {
            brunoConfig = {
              version: '1',
              name: collection.name,
              type: 'collection',
              ignore: ['node_modules', '.git']
            };
          }
          if (brunoConfig.proxy) {
            brunoConfig.proxy = transformProxyConfig(brunoConfig.proxy);
          }
          return brunoConfig;
        };

        await createDirectory(collectionPath);

        const uid = generateUidBasedOnHash(collectionPath);
        const brunoConfig = getBrunoJsonConfig(coll);

        // Convert absolute local file paths to collection-relative (git-shareable)
        if (Array.isArray(brunoConfig.openapi)) {
          for (const entry of brunoConfig.openapi) {
            if (entry.sourceUrl && path.isAbsolute(entry.sourceUrl)) {
              entry.sourceUrl = path.relative(collectionPath, entry.sourceUrl);
            }
          }
        }

        if (format === 'yml') {
          brunoConfig.opencollection = '1.0.0';
          const collectionContent = await stringifyCollection(coll.root, brunoConfig, { format });
          await writeFile(path.join(collectionPath, 'opencollection.yml'), collectionContent);
        } else if (format === 'bru') {
          const stringifiedBrunoConfig = await stringifyJson(brunoConfig);
          await writeFile(path.join(collectionPath, 'bruno.json'), stringifiedBrunoConfig);

          const collectionContent = await stringifyCollection(coll.root, brunoConfig, { format });
          await writeFile(path.join(collectionPath, 'collection.bru'), collectionContent);
        } else {
          throw new Error(`Invalid format: ${format}`);
        }

        // create folder and files based on collection
        await parseCollectionItems(coll.items, collectionPath);
        await parseEnvironments(coll.environments, collectionPath);

        // Save OpenAPI spec file for sync support
        if (rawOpenAPISpec && brunoConfig.openapi?.length) {
          const specContent = typeof rawOpenAPISpec === 'string'
            ? rawOpenAPISpec
            : JSON.stringify(rawOpenAPISpec, null, 2);
          await saveSpecAndUpdateMetadata({ collectionPath, specContent });
        }

        const { size, filesCount } = await getCollectionStats(collectionPath);
        brunoConfig.size = size;
        brunoConfig.filesCount = filesCount;

        mainWindow.webContents.send('main:collection-opened', collectionPath, uid, brunoConfig, options.workspaceId);
        ipcMain.emit('main:collection-opened', mainWindow, collectionPath, uid, brunoConfig, options.workspaceId);

        await registerCollectionInWorkspace(mainWindow, options.workspaceId, collectionPath, coll.name);

        mainWindow.webContents.send('main:collection-import-ended', coll.uid);

        successfulImports.push({
          path: collectionPath,
          name: coll.name
        });
        // Increment completed imports
        completedImports++;
      } catch (error) {
        mainWindow.webContents.send('main:collection-import-failed', coll.uid, {
          message: `Error ${error.message}`
        });
        console.error(`Failed to import collection: ${coll.name}, Error: ${error.message}`);

        // Increment failed imports
        failedImports++;

        // Continue with next collection instead of breaking
        continue;
      }
    }

    // Send final status when all collections have been processed (either succeeded or failed)
    if ((completedImports + failedImports) === collections.length) {
      mainWindow.webContents.send('main:all-collections-import-ended', {
        message: `Import completed. ${completedImports} collections imported successfully, ${failedImports} failed.`,
        status: {
          total: collections.length,
          succeeded: completedImports,
          failed: failedImports
        }
      });
    }

    return {
      success: {
        count: completedImports,
        items: successfulImports
      }
    };
  });

  ipcMain.handle('renderer:clone-folder', async (event, itemFolder, collectionPath, collectionPathname) => {
    try {
      if (fs.existsSync(collectionPath)) {
        throw new Error(`folder: ${collectionPath} already exists`);
      }

      const format = getCollectionFormat(collectionPathname);

      // Recursive function to parse the folder and create files/folders
      const parseCollectionItems = (items = [], currentPath) => {
        items.forEach(async (item) => {
          if (['http-request', 'graphql-request', 'grpc-request'].includes(item.type)) {
            const content = await stringifyRequestViaWorker(item, { format });

            // Use the correct file extension based on target format
            const baseName = path.parse(item.filename).name;
            const newFilename = format === 'yml' ? `${baseName}.yml` : `${baseName}.bru`;
            const filePath = path.join(currentPath, newFilename);

            safeWriteFileSync(filePath, content);
          }
          if (item.type === 'folder') {
            const folderPath = path.join(currentPath, item.filename);
            fs.mkdirSync(folderPath);

            // If folder has a root element, then I should write its folder file
            if (item.root) {
              const folderContent = await stringifyFolder(item.root, { format });
              folderContent.name = item.name;
              if (folderContent) {
                const folderFilePath = path.join(folderPath, `folder.${format}`);
                safeWriteFileSync(folderFilePath, folderContent);
              }
            }

            if (item.items && item.items.length) {
              parseCollectionItems(item.items, folderPath);
            }
          }
        });
      };

      await createDirectory(collectionPath);

      // If initial folder has a root element, then I should write its folder file
      if (itemFolder.root) {
        const folderContent = await stringifyFolder(itemFolder.root, { format });
        if (folderContent) {
          const folderFilePath = path.join(collectionPath, `folder.${format}`);
          safeWriteFileSync(folderFilePath, folderContent);
        }
      }

      // create folder and files based on another folder
      await parseCollectionItems(itemFolder.items, collectionPath);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:clone-collection-item-by-path', async (event, { sourcePathname, collectionPathname, newName, newFilename }) => {
    try {
      const sourcePath = assertCollectionItemPath({ collectionPathname, itemPathname: sourcePathname });
      const kind = getItemKindFromPath(sourcePath, collectionPathname);
      const parentDirname = path.dirname(sourcePath);
      assertPathInside(collectionPathname, parentDirname);

      if (kind === 'folder') {
        const targetPathname = path.join(parentDirname, sanitizeName(newFilename || newName));
        assertPathInside(collectionPathname, targetPathname);
        await cloneFolderByPath({
          sourcePathname: sourcePath,
          targetPathname,
          newName,
          collectionPathname
        });
        return {
          pathname: targetPathname,
          type: 'folder'
        };
      }

      const format = getCollectionFormat(collectionPathname);
      const targetFilename = getRequestFilenameForFormat(newFilename || newName, format);
      const targetPathname = path.join(parentDirname, targetFilename);
      assertPathInside(collectionPathname, targetPathname);
      await cloneRequestByPath({
        sourcePathname: sourcePath,
        targetPathname,
        newName,
        collectionPathname
      });
      return {
        pathname: targetPathname,
        type: getRequestTypeFromPath(targetPathname, collectionPathname)
      };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Disk-level paste for copy/paste in the sidebar. The source item is read
  // straight from disk (never from the renderer's hydrated tree), so
  // index-only children of lazily hydrated collections paste correctly and
  // cross-collection pastes convert formats when needed.
  ipcMain.handle('renderer:paste-item-by-path', async (event, { sourcePathname, sourceCollectionPathname, targetDirname, targetCollectionPathname }) => {
    try {
      const sourcePath = assertCollectionItemPath({ collectionPathname: sourceCollectionPathname, itemPathname: sourcePathname });
      const targetDir = assertPathInside(targetCollectionPathname, targetDirname, 'Target path must stay inside the collection');
      if (!fs.existsSync(targetDir) || !isDirectory(targetDir)) {
        throw new Error('Target folder does not exist');
      }

      const sourceFormat = getCollectionFormat(sourceCollectionPathname);
      const targetFormat = getCollectionFormat(targetCollectionPathname);
      const kind = getItemKindFromPath(sourcePath, sourceCollectionPathname);

      const result = kind === 'folder'
        ? await pasteFolderByPath({ sourcePathname: sourcePath, targetDirname: targetDir, sourceFormat, targetFormat })
        : await pasteRequestByPath({ sourcePathname: sourcePath, targetDirname: targetDir, sourceFormat, targetFormat });

      assertPathInside(targetCollectionPathname, result.pathname);
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:new-collection-folder-by-path', async (event, { parentPathname, collectionPathname, folderName, directoryName }) => {
    try {
      const targetPathname = await createFolderByPath({
        parentPathname,
        collectionPathname,
        folderName,
        directoryName
      });
      return {
        pathname: targetPathname,
        type: 'folder'
      };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:rename-collection-item-by-path', async (event, { sourcePathname, collectionPathname, newName, newFilename }) => {
    try {
      const oldPath = assertCollectionItemPath({ collectionPathname, itemPathname: sourcePathname });
      const kind = getItemKindFromPath(oldPath, collectionPathname);

      if (!newFilename) {
        if (kind === 'folder') {
          await updateFolderMeta({ folderPathname: oldPath, name: newName, collectionPathname });
        } else {
          const format = getCollectionFormat(collectionPathname);
          const data = await fs.promises.readFile(oldPath, 'utf8');
          // The write already went through the worker; the read did not, which
          // left the expensive half on the browser process.
          const jsonData = await parseRequestViaWorker(data, { format });
          jsonData.name = newName;
          const content = await stringifyRequestViaWorker(jsonData, { format });
          await writeFile(oldPath, content);
        }
        return {
          pathname: oldPath,
          type: kind === 'folder' ? 'folder' : getRequestTypeFromPath(oldPath, collectionPathname)
        };
      }

      const format = getCollectionFormat(collectionPathname);
      const targetBasename = kind === 'folder'
        ? sanitizeName(newFilename)
        : getRequestFilenameForFormat(newFilename, format);
      const newPath = path.join(path.dirname(oldPath), targetBasename);
      assertPathInside(collectionPathname, newPath);

      if (!safeToRename(oldPath, newPath)) {
        throw new Error(`path: ${newPath} already exists`);
      }

      if (kind === 'folder') {
        // Enumerate while the files still live at the old path, but remap the
        // uids only once the move succeeded: a failed move used to leave every
        // uid pointing at a path that does not exist.
        const requestFilesAtSource = await searchForRequestFiles(oldPath, collectionPathname);

        // See app/watch-release.js: on Windows our own watcher holds the
        // directory open and the OS refuses to move it.
        await withWatchReleased(watcher, { sourcePathname: oldPath, targetPathname: newPath }, () =>
          movePathWithRetry(oldPath, newPath));
        requestFilesAtSource.forEach((requestFile) => {
          const newRequestFilePath = requestFile.replace(oldPath, newPath);
          moveRequestUid(requestFile, newRequestFilePath);
        });
        await updateFolderMeta({ folderPathname: newPath, name: newName, collectionPathname });
        return {
          pathname: newPath,
          type: 'folder'
        };
      }

      const data = await fs.promises.readFile(oldPath, 'utf8');
      const jsonData = await parseRequestViaWorker(data, { format });
      jsonData.name = newName;
      const content = await stringifyRequestViaWorker(jsonData, { format });
      await writeFile(newPath, content);
      await fs.promises.unlink(oldPath);
      moveRequestUid(oldPath, newPath);
      return {
        pathname: newPath,
        type: getRequestTypeFromPath(newPath, collectionPathname)
      };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:delete-collection-item-by-path', async (event, { sourcePathname, collectionPathname, type }) => {
    try {
      const sourcePath = assertCollectionItemPath({ collectionPathname, itemPathname: sourcePathname });
      const kind = type === 'folder' || isDirectory(sourcePath) ? 'folder' : 'request';

      if (kind === 'folder') {
        // Enumerate before the move, drop the uids after it: a delete that
        // fails (Windows lock) must leave the item exactly as it was, still
        // addressable by its uid.
        const requestFilesAtSource = await searchForRequestFiles(sourcePath, collectionPathname);
        await moveToAppTrash(sourcePath, { type: 'folder', collectionPathname });
        requestFilesAtSource.forEach((requestFile) => deleteRequestUid(requestFile));
        return {
          pathname: sourcePath,
          type: 'folder'
        };
      }

      if (!fs.existsSync(sourcePath)) {
        throw new Error('The file does not exist');
      }
      const requestType = getRequestTypeFromPath(sourcePath, collectionPathname);
      await moveToAppTrash(sourcePath, { type: 'request', collectionPathname });
      deleteRequestUid(sourcePath);
      return {
        pathname: sourcePath,
        type: requestType
      };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:move-collection-item-by-path', async (event, {
    sourcePathname,
    targetPathname,
    sourceCollectionPathname,
    targetCollectionPathname,
    dropType
  }) => {
    try {
      const sourcePath = assertCollectionItemPath({ collectionPathname: sourceCollectionPathname, itemPathname: sourcePathname });
      const targetPath = assertPathInside(targetCollectionPathname, targetPathname, 'Target path must stay inside the collection');
      const sourceKind = getItemKindFromPath(sourcePath, sourceCollectionPathname);
      const targetIsCollectionRoot = path.normalize(targetPath) === path.normalize(targetCollectionPathname);
      const targetKind = targetIsCollectionRoot ? 'folder' : getItemKindFromPath(targetPath, targetCollectionPathname);

      if (!dropType) {
        throw new Error('Drop type is required');
      }

      let targetDirname = dropType === 'inside' && targetKind === 'folder'
        ? targetPath
        : path.dirname(targetPath);
      assertPathInside(targetCollectionPathname, targetDirname);

      const sourceFormat = getCollectionFormat(sourceCollectionPathname);
      const targetFormat = getCollectionFormat(targetCollectionPathname);
      const sourceBasename = path.basename(sourcePath);
      const targetBasename = sourceKind === 'request' && sourceFormat !== targetFormat
        ? getRequestFilenameForFormat(sourceBasename, targetFormat)
        : sourceBasename;
      let finalPathname = path.join(targetDirname, targetBasename);
      assertPathInside(targetCollectionPathname, finalPathname);

      if (path.normalize(finalPathname) === path.normalize(sourcePath)) {
        return {
          pathname: sourcePath,
          type: sourceKind === 'folder' ? 'folder' : getRequestTypeFromPath(sourcePath, sourceCollectionPathname),
          skipped: true
        };
      }

      // Target already has an entry with this filename: auto-rename the moved
      // item ("name copy", "name copy 2", ...) instead of failing the move.
      let renameSuffix = '';
      if (fs.existsSync(winLongPath(finalPathname))) {
        const uniqueTarget = resolveUniqueTargetPathname({
          targetDirname,
          basename: targetBasename,
          isFolder: sourceKind === 'folder'
        });
        finalPathname = uniqueTarget.pathname;
        renameSuffix = uniqueTarget.suffix;
        assertPathInside(targetCollectionPathname, finalPathname);
      }

      await moveItemByPath({
        sourcePathname: sourcePath,
        targetPathname: finalPathname,
        sourceCollectionPathname,
        targetCollectionPathname,
        watcher
      });

      let renamedDisplayName = null;
      if (renameSuffix) {
        renamedDisplayName = await applyDisplayNameSuffix({
          pathname: finalPathname,
          kind: sourceKind,
          suffix: renameSuffix,
          format: targetFormat
        });
      }

      return {
        pathname: finalPathname,
        type: sourceKind === 'folder' ? 'folder' : getRequestTypeFromPath(finalPathname, targetCollectionPathname),
        ...(renamedDisplayName ? { name: renamedDisplayName } : {})
      };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Renderer perf telemetry mirrored into the terminal (see
  // bruno-app utils/common/perfLogger.js).
  ipcMain.handle('renderer:perf-log', (event, line) => {
    console.log(line);
  });

  ipcMain.handle('renderer:refresh-collection-index', async (event, { collectionUid, collectionPathname, brunoConfig, loadSessionId, priority = false }) => {
    try {
      // A refresh while a build is already pending/running never restarts
      // it: priority refreshes (search filter, retry row) move the queued
      // job to the front; background refreshes (the startup warm racing a
      // freshly created collection's own index build) are a no-op. A
      // cancel+restart here reset the renderer index mid-flight — wiping
      // filtered rows during a search, and racing request-creation flows.
      if (promoteCollectionIndex(collectionUid)) {
        return { promoted: priority };
      }
      startCollectionIndex(mainWindow, {
        collectionUid,
        collectionPathname,
        brunoConfig,
        loadSessionId,
        priority
      });
      return {
        loadSessionId
      };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Returns filesystem creation time per pathname so the sidebar can offer a
  // "sort by created" option (the .bru format itself has no created field).
  // Falls back to ctime/mtime where birthtime isn't tracked (some Linux FS).
  ipcMain.handle('renderer:get-items-created-times', async (event, pathnames = []) => {
    const result = {};
    for (const pathname of pathnames) {
      try {
        const stat = fs.statSync(winLongPath(pathname));
        const birth = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : 0;
        result[pathname] = birth || stat.ctimeMs || stat.mtimeMs || 0;
      } catch (_) {
        result[pathname] = 0;
      }
    }
    return result;
  });

  ipcMain.handle('renderer:resequence-items', async (event, itemsToResequence, collectionPathname) => {
    try {
      const format = getCollectionFormat(collectionPathname);

      for (let item of itemsToResequence) {
        if (item?.type === 'folder') {
          const folderRootPath = path.join(item.pathname, `folder.${format}`);
          let folderJsonData = {
            meta: {
              name: path.basename(item.pathname),
              seq: item.seq
            }
          };
          if (fs.existsSync(folderRootPath)) {
            const folderContent = fs.readFileSync(folderRootPath, 'utf8');
            folderJsonData = await parseFolder(folderContent, { format });
            if (!folderJsonData?.meta) {
              folderJsonData.meta = {
                name: path.basename(item.pathname),
                seq: item.seq
              };
            }
            if (folderJsonData?.meta?.seq === item.seq) {
              continue;
            }
            folderJsonData.meta.seq = item.seq;
          }
          const content = await stringifyFolder(folderJsonData, { format });
          await writeFile(folderRootPath, content);
        } else if (REQUEST_TYPES.includes(item?.type)) {
          if (fs.existsSync(item.pathname)) {
            // Resequence only changes order: read the existing request and
            // update its seq, instead of rebuilding it from the bare
            // {pathname,type,seq} payload (which has no request data and would
            // throw / wipe the file).
            const existingContent = fs.readFileSync(item.pathname, 'utf8');
            const parsed = await parseRequest(existingContent, { format });
            if (Number(parsed?.seq) === Number(item.seq)) {
              continue;
            }
            parsed.seq = item.seq;
            const content = await stringifyRequest(parsed, { format });
            await writeFile(item.pathname, content);
          }
        }
      }
      return true;
    } catch (error) {
      console.error('Error in resequence-items:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:move-file-item', async (event, itemPath, destinationPath) => {
    try {
      const itemContent = fs.readFileSync(itemPath, 'utf8');
      const newItemPath = path.join(destinationPath, path.basename(itemPath));

      moveRequestUid(itemPath, newItemPath);

      fs.unlinkSync(itemPath);
      safeWriteFileSync(newItemPath, itemContent);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:move-item', async (event, { targetDirname, sourcePathname }) => {
    try {
      if (fs.existsSync(targetDirname)) {
        const sourceDirname = path.dirname(sourcePathname);
        const pathnamesBefore = await getPaths(sourcePathname);
        const pathnamesAfter = pathnamesBefore?.map((p) => p?.replace(sourceDirname, targetDirname));
        await copyPath(sourcePathname, targetDirname);
        await removePath(sourcePathname);
        // move the request uids of the previous file/folders to the new file/folder items
        pathnamesAfter?.forEach((_, index) => {
          moveRequestUid(pathnamesBefore[index], pathnamesAfter[index]);
        });
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:move-item-cross-format', async (event, { targetDirname, sourcePathname, sourceFormat, targetFormat }) => {
    try {
      if (!fs.existsSync(sourcePathname)) {
        throw new Error(`Source path: ${sourcePathname} does not exist`);
      }
      if (!fs.existsSync(targetDirname)) {
        throw new Error(`Target directory: ${targetDirname} does not exist`);
      }

      const sourceBasename = path.basename(sourcePathname);
      const filenameWithoutExt = sourceBasename.replace(/\.(bru|yml|yaml)$/, '');
      const targetExt = targetFormat === 'yml' ? 'yml' : 'bru';
      const targetFilename = `${filenameWithoutExt}.${targetExt}`;
      const targetPathname = path.join(targetDirname, targetFilename);

      if (fs.existsSync(targetPathname)) {
        throw new Error(`A file with the name "${targetFilename}" already exists in the target location`);
      }

      const sourceContent = await fs.promises.readFile(sourcePathname, 'utf8');
      const parsedRequest = parseRequest(sourceContent, { format: sourceFormat });
      const finalContent = stringifyRequest(parsedRequest, { format: targetFormat });

      await writeFile(targetPathname, finalContent);
      await removePath(sourcePathname);

      moveRequestUid(sourcePathname, targetPathname);

      return { newPathname: targetPathname };
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:move-folder-item', async (event, folderPath, destinationPath) => {
    try {
      const folderName = path.basename(folderPath);
      const newFolderPath = path.join(destinationPath, folderName);

      if (!fs.existsSync(folderPath)) {
        throw new Error(`folder: ${folderPath} does not exist`);
      }

      if (fs.existsSync(newFolderPath)) {
        throw new Error(`folder: ${newFolderPath} already exists`);
      }

      const requestFilesAtSource = await searchForRequestFiles(folderPath);

      for (let requestFile of requestFilesAtSource) {
        const newRequestFilePath = requestFile.replace(folderPath, newFolderPath);
        moveRequestUid(requestFile, newRequestFilePath);
      }

      fs.renameSync(folderPath, newFolderPath);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:update-bruno-config', async (event, brunoConfig, collectionPath, collectionRoot) => {
    try {
      const transformedBrunoConfig = transformBrunoConfigBeforeSave(brunoConfig);
      const format = getCollectionFormat(collectionPath);

      if (format === 'bru') {
        const brunoConfigPath = path.join(collectionPath, 'bruno.json');
        const content = await stringifyJson(transformedBrunoConfig);
        await writeFile(brunoConfigPath, content);
      } else if (format === 'yml') {
        // opencollection.yml holds both the config AND the collection root, so a
        // config-only save rewrites the whole file. The renderer passes
        // `collection.root`, which is empty until the root is hydrated — and we
        // hydrate lazily, so that window stays open for the whole session on a
        // collection whose settings were never opened. Recover the root from disk
        // instead of writing an empty one over request defaults/docs/scripts.
        // upstream bruno #8424 (acc74745d)
        // `_.isEmpty` and not just a null check: an un-hydrated collection reaches us
        // as `{}` just as often as it does `undefined`.
        let rootToWrite = collectionRoot;
        if (_.isEmpty(rootToWrite)) {
          const ocYmlPath = path.join(collectionPath, 'opencollection.yml');
          if (fs.existsSync(ocYmlPath)) {
            try {
              const existing = fs.readFileSync(ocYmlPath, 'utf8');
              rootToWrite = parseCollection(existing, { format }).collectionRoot;
            } catch (e) {
              rootToWrite = collectionRoot;
            }
          }
        }

        const content = await stringifyCollection(rootToWrite, transformedBrunoConfig, { format });
        await writeFile(path.join(collectionPath, 'opencollection.yml'), content);
      } else {
        throw new Error(`Invalid collection format: ${format}`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // Convert a .bru collection to the .yml (opencollection) format.
  //
  // The work itself lives in utils/collection-migration.js; this handler owns
  // the electron-facing half: the cancel registry, the throttled progress
  // channel, and detaching the collection afterwards. See that module's header
  // for why this is two phases with a commit point and why nothing is ever
  // unlinked.
  const activeYmlMigrations = new Map();

  ipcMain.handle('renderer:migrate-collection-to-yml', async (event, { collectionPathname, collectionUid, migrationUid } = {}) => {
    try {
      if (!collectionPathname || !migrationUid) {
        throw new Error('collectionPathname and migrationUid are required');
      }

      const normalizedCollectionPathname = path.resolve(collectionPathname);
      for (const migration of activeYmlMigrations.values()) {
        if (migration.collectionPathname === normalizedCollectionPathname) {
          throw new Error('A migration is already running for this collection.');
        }
      }

      const migration = { collectionPathname: normalizedCollectionPathname, cancelled: false };
      activeYmlMigrations.set(migrationUid, migration);

      try {
        const result = await migrateCollectionToYml({
          collectionPathname: normalizedCollectionPathname,
          shouldCancel: () => migration.cancelled,
          onProgress: (progress) => {
            // Best-effort, same as every other main->renderer progress channel:
            // the window can go away mid-run and that must not stop the work.
            try {
              if (mainWindow && !mainWindow.isDestroyed?.() && mainWindow.webContents) {
                mainWindow.webContents.send('main:collection-yml-migration-progress', {
                  migrationUid,
                  collectionPathname: normalizedCollectionPathname,
                  ...progress
                });
              }
            } catch (_error) {
              // window closing
            }
          }
        });

        if (result.status === 'migrated') {
          // The collection on disk is a different format now, and the watcher and
          // the index were both built for the old one. Detach them so neither
          // keeps reporting a tree that no longer exists; the renderer tells the
          // user to reopen the collection. Reloading it in place would mean
          // rewriting the renderer's item tree from under the user, which is not
          // this change's to do.
          try {
            if (watcher && mainWindow) {
              watcher.removeWatcher(normalizedCollectionPathname, mainWindow, collectionUid);
            }
            if (collectionUid) {
              cancelCollectionIndex(collectionUid);
            }
          } catch (error) {
            console.error('Error detaching migrated collection:', error);
          }
        }

        return result;
      } finally {
        activeYmlMigrations.delete(migrationUid);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:cancel-collection-yml-migration', async (event, { migrationUid } = {}) => {
    const migration = activeYmlMigrations.get(migrationUid);
    if (!migration) {
      return false;
    }
    // Only phase 1 reads this. Once the commit starts the run is deliberately
    // uncancellable — see the commit-point comment in collection-migration.js.
    migration.cancelled = true;
    return true;
  });

  ipcMain.handle('renderer:open-devtools', async () => {
    mainWindow.webContents.openDevTools();
  });

  ipcMain.handle('renderer:load-gql-schema-file', async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile']
      });
      if (filePaths.length === 0) {
        return;
      }

      const jsonData = fs.readFileSync(filePaths[0], 'utf8');
      return safeParseJSON(jsonData);
    } catch (err) {
      return Promise.reject(new Error('Failed to load GraphQL schema file'));
    }
  });

  const updateCookiesAndNotify = async () => {
    const domainsWithCookies = await getDomainsWithCookies();
    mainWindow.webContents.send(
      'main:cookies-update',
      safeParseJSON(safeStringifyJSON(domainsWithCookies))
    );
    cookiesStore.saveCookieJar();
  };

  // Delete all cookies for a domain
  ipcMain.handle('renderer:delete-cookies-for-domain', async (event, domain) => {
    try {
      await deleteCookiesForDomain(domain);
      await updateCookiesAndNotify();
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:delete-cookie', async (event, domain, path, cookieKey) => {
    try {
      await deleteCookie(domain, path, cookieKey);
      await updateCookiesAndNotify();
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // add cookie
  ipcMain.handle('renderer:add-cookie', async (event, domain, cookie) => {
    try {
      await addCookieForDomain(domain, cookie);
      await updateCookiesAndNotify();
    } catch (error) {
      return Promise.reject(error);
    }
  });

  // modify cookie
  ipcMain.handle('renderer:modify-cookie', async (event, domain, oldCookie, cookie) => {
    try {
      await modifyCookieForDomain(domain, oldCookie, cookie);
      await updateCookiesAndNotify();
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:get-parsed-cookie', async (event, cookieStr) => {
    try {
      return parseCookieString(cookieStr);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:create-cookie-string', async (event, cookie) => {
    try {
      return createCookieString(cookie);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:save-collection-security-config', async (event, collectionPath, securityConfig) => {
    try {
      collectionSecurityStore.setSecurityConfigForCollection(collectionPath, {
        jsSandboxMode: securityConfig.jsSandboxMode
      });
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:get-collection-security-config', async (event, collectionPath) => {
    try {
      return collectionSecurityStore.getSecurityConfigForCollection(collectionPath);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:update-ui-state-snapshot', (event, { type, data }) => {
    try {
      uiStateSnapshotStore.update({ type, data });
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('renderer:fetch-oauth2-credentials', async (event, { itemUid, request, collection }) => {
    try {
      if (request.oauth2) {
        let requestCopy = _.cloneDeep(request);
        const { uid: collectionUid, pathname: collectionPath, runtimeVariables, environments = [], activeEnvironmentUid } = collection;
        const environment = _.find(environments, (e) => e.uid === activeEnvironmentUid);
        const envVars = getEnvVars(environment);
        const processEnvVars = getProcessEnvVars(collectionUid);
        const partialItem = { uid: itemUid };
        const requestTreePath = getTreePathFromCollectionToItem(collection, partialItem);
        mergeVars(collection, requestCopy, requestTreePath);
        const globalEnvironmentVariables = collection.globalEnvironmentVariables;
        const promptVariables = collection.promptVariables;
        interpolateVars(requestCopy, envVars, runtimeVariables, processEnvVars);
        const { oauth2: { grantType, accessTokenUrl, refreshTokenUrl }, collectionVariables, folderVariables, requestVariables } = requestCopy || {};

        // For OAuth2 token requests, use accessTokenUrl for cert/proxy config instead of main request URL
        let certsAndProxyConfigForTokenUrl = null;
        let certsAndProxyConfigForRefreshUrl = null;

        if (accessTokenUrl && grantType !== 'implicit') {
          const interpolatedTokenUrl = interpolateString(accessTokenUrl, {
            globalEnvironmentVariables,
            collectionVariables,
            envVars,
            folderVariables,
            requestVariables,
            runtimeVariables,
            processEnvVars,
            promptVariables
          });
          let tokenRequestForConfig = { ...requestCopy, url: interpolatedTokenUrl };
          certsAndProxyConfigForTokenUrl = await getCertsAndProxyConfig({
            collectionUid,
            collection,
            request: tokenRequestForConfig,
            envVars,
            runtimeVariables,
            processEnvVars,
            collectionPath,
            globalEnvironmentVariables
          });
        }

        // For refresh token requests, use refreshTokenUrl if available, otherwise accessTokenUrl
        const tokenUrlForRefresh = refreshTokenUrl || accessTokenUrl;
        if (tokenUrlForRefresh && grantType !== 'implicit') {
          const interpolatedRefreshUrl = interpolateString(tokenUrlForRefresh, {
            globalEnvironmentVariables,
            collectionVariables,
            envVars,
            folderVariables,
            requestVariables,
            runtimeVariables,
            processEnvVars,
            promptVariables
          });
          let refreshRequestForConfig = { ...requestCopy, url: interpolatedRefreshUrl };
          certsAndProxyConfigForRefreshUrl = await getCertsAndProxyConfig({
            collectionUid,
            collection,
            request: refreshRequestForConfig,
            envVars,
            runtimeVariables,
            processEnvVars,
            collectionPath,
            globalEnvironmentVariables
          });
        }

        const handleOAuth2Response = (response) => {
          if (response.error && !response.debugInfo) {
            throw new Error(response.error);
          }
          return response;
        };

        switch (grantType) {
          case 'authorization_code':
            interpolateVars(requestCopy, envVars, runtimeVariables, processEnvVars);
            return await getOAuth2TokenUsingAuthorizationCode({
              request: requestCopy,
              collectionUid,
              forceFetch: true,
              certsAndProxyConfigForTokenUrl,
              certsAndProxyConfigForRefreshUrl
            }).then(handleOAuth2Response);

          case 'client_credentials':
            interpolateVars(requestCopy, envVars, runtimeVariables, processEnvVars);
            return await getOAuth2TokenUsingClientCredentials({
              request: requestCopy,
              collectionUid,
              forceFetch: true,
              certsAndProxyConfigForTokenUrl,
              certsAndProxyConfigForRefreshUrl
            }).then(handleOAuth2Response);

          case 'password':
            interpolateVars(requestCopy, envVars, runtimeVariables, processEnvVars);
            return await getOAuth2TokenUsingPasswordCredentials({
              request: requestCopy,
              collectionUid,
              forceFetch: true,
              certsAndProxyConfigForTokenUrl,
              certsAndProxyConfigForRefreshUrl
            }).then(handleOAuth2Response);

          case 'implicit':
            interpolateVars(requestCopy, envVars, runtimeVariables, processEnvVars);
            return await getOAuth2TokenUsingImplicitGrant({
              request: requestCopy,
              collectionUid,
              forceFetch: true
            }).then(handleOAuth2Response);

          default:
            return {
              error: `Unsupported grant type: ${grantType}`,
              credentials: null,
              url: null,
              collectionUid,
              credentialsId: null
            };
        }
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:refresh-oauth2-credentials', async (event, { itemUid, request, collection }) => {
    try {
      if (request.oauth2) {
        let requestCopy = _.cloneDeep(request);
        const { uid: collectionUid, pathname: collectionPath, runtimeVariables, environments = [], activeEnvironmentUid } = collection;
        const environment = _.find(environments, (e) => e.uid === activeEnvironmentUid);
        const envVars = getEnvVars(environment);
        const processEnvVars = getProcessEnvVars(collectionUid);
        const partialItem = { uid: itemUid };
        const requestTreePath = getTreePathFromCollectionToItem(collection, partialItem);
        mergeVars(collection, requestCopy, requestTreePath);
        interpolateVars(requestCopy, envVars, runtimeVariables, processEnvVars);
        const globalEnvironmentVariables = collection.globalEnvironmentVariables;

        const certsAndProxyConfig = await getCertsAndProxyConfig({
          collectionUid,
          collection,
          request: requestCopy,
          envVars,
          runtimeVariables,
          processEnvVars,
          collectionPath,
          globalEnvironmentVariables
        });

        let { credentials, url, credentialsId, debugInfo } = await refreshOauth2Token({ requestCopy, collectionUid, certsAndProxyConfig });
        return { credentials, url, collectionUid, credentialsId, debugInfo };
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:cancel-oauth2-authorization-request', async () => {
    try {
      const cancelled = cancelOAuth2AuthorizationRequest();
      return { success: true, cancelled };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('renderer:is-oauth2-authorization-request-in-progress', () => {
    return isOauth2AuthorizationRequestInProgress();
  });

  // todo: could be removed
  ipcMain.handle('renderer:load-request-via-worker', async (event, { collectionUid, pathname }) => {
    let fileStats;
    try {
      fileStats = fs.statSync(pathname);
      if (hasBruExtension(pathname)) {
        const file = {
          meta: {
            collectionUid,
            pathname,
            name: path.basename(pathname),
            source: 'load-request'
          }
        };
        let bruContent = fs.readFileSync(pathname, 'utf8');
        const metaJson = parseBruFileMeta(bruContent);
        // Requests too expensive to parse stay meta-only, exactly like the
        // watcher's scan classifies them: parsing one inline froze the app when
        // the user clicked it in the sidebar. The UI offers "Load Request"
        // instead. Cost is post-redaction bytes, not file size — see utils/parse.js.
        if (isRequestTooExpensiveToParse(bruContent, fileStats?.size, 'bru')) {
          // parseBruFileMeta returns null for a .bru with no meta block or one
          // caught half-written; the same fallback as renderer:load-request
          // keeps a null out of the tree the renderer builds from this.
          file.data = metaJson || buildUnparseableRequestData(pathname);
          file.partial = true;
          file.loading = false;
          file.size = sizeInMB(fileStats?.size);
          hydrateRequestWithUuid(file.data, pathname);
          mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
          return;
        }
        file.data = metaJson;
        file.loading = true;
        file.partial = true;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
        file.data = await parseRequestViaWorker(bruContent, { format: 'bru' });
        file.partial = false;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
      }
    } catch (error) {
      if (hasBruExtension(pathname)) {
        const file = {
          meta: {
            collectionUid,
            pathname,
            name: path.basename(pathname),
            source: 'load-request'
          }
        };
        let bruContent = fs.readFileSync(pathname, 'utf8');
        const metaJson = parseBruFileMeta(bruContent);
        file.data = metaJson;
        file.partial = true;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
      }
      return Promise.reject(error);
    }
  });

  // todo: could be removed
  ipcMain.handle('renderer:load-request', async (event, { collectionUid, pathname }) => {
    let fileStats;
    // Stays undefined if we never got as far as reading the file, so the catch can
    // tell "this parse was superseded" from "we failed before there was a parse".
    let generation;
    try {
      fileStats = fs.statSync(pathname);
      if (hasRequestExtension(pathname)) {
        const file = {
          meta: {
            collectionUid,
            pathname,
            name: path.basename(pathname)
          }
        };
        let bruContent = fs.readFileSync(pathname, 'utf8');
        const format = hasBruExtension(pathname) ? 'bru' : 'yml';
        // Shares the watcher's registry: this handler and the watcher's change()
        // parse the same files through the same size-ordered worker queue, so a
        // click whose parse is overtaken by a save (or by a second click) must be
        // dropped rather than emitted on top of the newer content.
        generation = beginParseGeneration(pathname);
        // This parse is synchronous and runs on the browser process, so a
        // single sidebar click on an expensive request froze (and could kill)
        // the app. Past the parse budget, hand back the same meta-only snapshot
        // the watcher produces so the UI shows its "not loaded" card. The budget
        // is measured in post-redaction bytes, not file size — see utils/parse.js.
        if (isRequestTooExpensiveToParse(bruContent, fileStats?.size, format)) {
          // A meta parse can still come back null on a malformed file; never
          // hydrate null (that was the "Cannot set properties of null" crash).
          // Bounded: this branch only runs on files past the parse budget, and the
          // yml meta parse is a synchronous whole-file js-yaml load — the very
          // freeze the size guard above exists to avoid, on the browser process.
          file.data = parseFileMetaBounded(bruContent, format, fileStats?.size) || buildUnparseableRequestData(pathname);
          // Synchronous, so this always wins — the call is here to release the
          // stamp taken above rather than leave an entry behind for every
          // oversized request the user clicks.
          claimNewestParseGeneration(pathname, generation);
          file.partial = true;
          file.loading = false;
          file.size = sizeInMB(fileStats?.size);
          hydrateRequestWithUuid(file.data, pathname);
          mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
          return safeParseJSON(safeStringifyJSON(file));
        }
        const metaJson = parseBruFileMeta(bruContent);
        // parseBruFileMeta is a partial (meta-only) parse; it returns null for
        // a .yml request. Only emit the partial snapshot when it parsed —
        // otherwise fall straight through to the format-aware full parse below.
        if (metaJson) {
          file.data = metaJson;
          file.loading = true;
          file.partial = true;
          file.size = sizeInMB(fileStats?.size);
          hydrateRequestWithUuid(file.data, pathname);
          mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
        }
        // Off the browser process. Every sidebar click lands here, and this parse
        // used to run inline on the main thread: measured against the real
        // workspace it froze the app for 1.5 s at 0.58 MB, 7.1 s at 2.33 MB, and
        // killed it outright with a fatal "JS heap out of memory" at 2.47 MB —
        // the customer's "app hangs and then exits completely". The worker costs
        // the same memory but stalls the main thread ~20 ms, and an OOM comes back
        // as a catchable ERR_WORKER_OUT_OF_MEMORY instead of aborting the process.
        file.data = await parseRequestViaWorker(bruContent, { format, filename: pathname });

        // Superseded while we were in the queue. The renderer feeds this return
        // value straight into collectionAddFileEvent (loadRequest in
        // slices/collections/actions.js), which is last-write-wins over
        // request/examples — returning it now would undo whatever wrote the file.
        // Resolving with nothing leaves the item as the newer read left it; the
        // callers already guard on `loadedFile?.data`.
        if (!claimNewestParseGeneration(pathname, generation)) {
          return;
        }

        file.partial = false;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
        return safeParseJSON(safeStringifyJSON(file));
      }
    } catch (error) {
      // The worker being torn down (collection close, app quit, pool cleanup) says
      // nothing about the file. Falling through would emit a meta-only payload, and
      // applyFileDataToItem in the renderer unconditionally sets `item.draft = null`
      // and `item.examples = file.data.examples` — so a pooled worker dying would
      // throw away the user's unsaved draft and blank the loaded examples of a file
      // that parses perfectly well. Reject and emit nothing, which is what this
      // handler did before the parse moved off-thread.
      // An OOM is not transient: that file really is too big for one heap, and the
      // meta-only row is the right answer for it.
      // Claim FIRST, on every exit from this catch: a generation that returns
      // without claiming holds its path's entry open, and the entry is what keeps
      // the next read's numbering from colliding with a read still in flight.
      const isNewestRead = generation === undefined || claimNewestParseGeneration(pathname, generation);

      if (isTransientWorkerFailure(error)) {
        return Promise.reject(error);
      }
      // A stale failure must not repaint a row a newer read has already refreshed.
      if (!isNewestRead) {
        return;
      }
      if (hasRequestExtension(pathname)) {
        const file = {
          meta: {
            collectionUid,
            pathname,
            name: path.basename(pathname)
          }
        };
        let bruContent = fs.readFileSync(pathname, 'utf8');
        const format = hasBruExtension(pathname) ? 'bru' : 'yml';
        // Meta-only on purpose. Retrying the full parse here re-ran it ON THE MAIN
        // THREAD, which is exactly the crash the worker above exists to avoid: the
        // most likely way to land in this catch is now ERR_WORKER_OUT_OF_MEMORY on
        // a file no single heap can parse, and parsing it again inline turned that
        // recoverable error straight back into a dead app.
        // The meta parse can still be null for a malformed/partially-written file —
        // never hydrate null (that was the "Cannot set properties of null" crash),
        // and never drop the item either, or the request loses its sidebar row.
        // Bounded, because parseFileMeta is only cheap for bru: for yml it is a
        // synchronous whole-file js-yaml load on the browser process, i.e. the same
        // freeze the worker above exists to remove, reintroduced on the failure path.
        file.data = parseFileMetaBounded(bruContent, format, fileStats?.size) || buildUnparseableRequestData(pathname);
        file.error = {
          message: error?.message
        };
        file.partial = true;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
        return safeParseJSON(safeStringifyJSON(file));
      }
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:load-large-request', async (event, { collectionUid, pathname }) => {
    let fileStats;
    if (!hasRequestExtension(pathname)) {
      return;
    }

    // The redacting parser is bru-only string surgery; in a yml collection this
    // handler used to bail out here, so the "Load Request" button did nothing
    // at all. yml goes through the regular parser instead.
    const format = hasBruExtension(pathname) ? 'bru' : 'yml';

    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname),
        source: 'load-request'
      }
    };

    try {
      fileStats = fs.statSync(pathname);

      const bruContent = fs.readFileSync(pathname, 'utf8');
      const metaJson = parseFileMeta(bruContent, format);

      file.data = metaJson;
      file.partial = false;
      file.loading = true;
      file.size = sizeInMB(fileStats?.size);
      hydrateRequestWithUuid(file.data, pathname);
      await mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);

      try {
        const parsedData = format === 'bru'
          ? await parseLargeRequestWithRedaction(bruContent, 'bru')
          : await parseRequest(bruContent, { format });

        file.data = parsedData;
        file.loading = false;
        file.partial = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        await mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
      } catch (parseError) {
        file.data = metaJson;
        file.partial = true;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        // Say WHY. Without this the payload went back with no error, the card
        // fell through to its generic "too large" text, and pressing the button
        // looked like it did nothing at all — the reported "Load Request does
        // nothing". Only the toast carried the failure, and it said nothing
        // actionable either.
        file.error = { message: describeLoadFailure(parseError) };
        hydrateRequestWithUuid(file.data, pathname);
        await mainWindow.webContents.send('main:collection-tree-updated', 'addFile', file);
        throw new Error(file.error.message);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:mount-collection', async (event, { collectionUid, collectionPathname, brunoConfig, loadSessionId }) => {
    let tempDirectoryPath = null;
    try {
      // Ensure the transient base directory exists
      const transientBase = getTransientDirectoryBase();
      if (!fs.existsSync(transientBase)) {
        fs.mkdirSync(transientBase, { recursive: true });
      }
      tempDirectoryPath = fs.mkdtempSync(getTransientCollectionPrefix());
      const metadata = {
        collectionPath: collectionPathname
      };
      fs.writeFileSync(path.join(tempDirectoryPath, 'metadata.json'), JSON.stringify(metadata));
    } catch (error) {
      throw error;
    }
    const {
      size,
      filesCount,
      maxFileSize
    } = await getCollectionStats(collectionPathname);

    const shouldLoadCollectionAsync = shouldUseIndexedCollectionLoad({ size, filesCount, maxFileSize });

    // Always index; size only decides eager vs lazy hydration.
    startIndexedCollectionLoad(watcher, mainWindow, {
      collectionUid,
      collectionPathname,
      brunoConfig,
      loadSessionId,
      lazyHydration: shouldLoadCollectionAsync
    });

    // Add watcher for transient directory
    watcher.addTempDirectoryWatcher(mainWindow, tempDirectoryPath, collectionUid, collectionPathname);

    // The UI snapshot is otherwise only delivered from onWatcherSetupComplete,
    // which runs exclusively on the eager path — so on a large collection
    // (which is every large collection: >100 files goes lazy) nothing was ever
    // restored, not the open folders and not even the selected environment.
    // Returning it from mount reaches both paths and arrives before the first
    // render instead of after a watcher scan.
    const uiState = uiStateSnapshotStore.getCollections()
      ?.find((entry) => entry?.pathname && path.normalize(entry.pathname) === path.normalize(collectionPathname)) || null;

    return {
      tempDirectoryPath,
      indexed: true,
      lazyHydration: shouldLoadCollectionAsync,
      loadSessionId,
      uiState
    };
  });

  ipcMain.handle('renderer:cancel-collection-index', async (event, { collectionUid, loadSessionId }) => {
    cancelCollectionIndex(collectionUid, loadSessionId);
    return true;
  });

  ipcMain.handle('renderer:mount-workspace-scratch', async (event, { workspaceUid, workspacePath }) => {
    try {
      // Ensure the transient base directory exists
      const transientBase = getTransientDirectoryBase();
      if (!fs.existsSync(transientBase)) {
        fs.mkdirSync(transientBase, { recursive: true });
      }
      const tempDirectoryPath = fs.mkdtempSync(getTransientScratchPrefix());
      registerScratchCollectionPath(tempDirectoryPath);

      const collectionRoot = {
        meta: {
          name: 'Scratch'
        }
      };

      const brunoConfig = {
        opencollection: '1.0.0',
        name: 'Scratch',
        type: 'collection',
        ignore: ['node_modules', '.git']
      };

      const content = stringifyCollection(collectionRoot, brunoConfig, { format: 'yml' });
      await writeFile(path.join(tempDirectoryPath, 'opencollection.yml'), content);

      const metadata = {
        workspaceUid,
        workspacePath,
        type: 'scratch'
      };
      fs.writeFileSync(path.join(tempDirectoryPath, 'metadata.json'), JSON.stringify(metadata));

      return tempDirectoryPath;
    } catch (error) {
      console.error('Error mounting workspace scratch collection:', error);
      throw error;
    }
  });

  ipcMain.handle('renderer:add-collection-watcher', async (event, { collectionPath, collectionUid, brunoConfig }) => {
    if (!watcher || !mainWindow) {
      throw new Error('Watcher or mainWindow not available');
    }

    try {
      // Workspace scratch collections stay on the classic non-indexed load
      // path: they are transient, tiny, and never rendered in the collections
      // sidebar (their requests open as transient tabs), so building an index
      // for them adds churn without any renderer benefit.
      if (isScratchCollectionPath(collectionPath)) {
        watcher.addWatcher(mainWindow, collectionPath, collectionUid, brunoConfig, false, false);
        return { success: true };
      }

      const { size, filesCount, maxFileSize } = await getCollectionStats(collectionPath);

      const shouldLoadCollectionAsync = shouldUseIndexedCollectionLoad({ size, filesCount, maxFileSize });
      const loadSessionId = generateUidBasedOnHash(`${collectionUid}:${collectionPath}:${Date.now()}`);

      // Always index; size only decides eager vs lazy hydration.
      startIndexedCollectionLoad(watcher, mainWindow, {
        collectionUid,
        collectionPathname: collectionPath,
        brunoConfig,
        loadSessionId,
        lazyHydration: shouldLoadCollectionAsync
      });

      return { success: true };
    } catch (error) {
      console.error('Error adding collection watcher:', error);
      throw error;
    }
  });

  ipcMain.handle('renderer:save-scratch-request', async (event, { sourcePathname, targetDirname, targetFilename, request }) => {
    try {
      if (!fs.existsSync(sourcePathname)) {
        throw new Error(`Source path: ${sourcePathname} does not exist`);
      }

      if (!fs.existsSync(targetDirname)) {
        throw new Error(`Target directory: ${targetDirname} does not exist`);
      }

      validatePathIsInsideCollection(targetDirname);

      const collectionPath = findCollectionPathByItemPath(targetDirname);
      if (!collectionPath) {
        throw new Error('Could not determine collection for target directory');
      }
      const format = getCollectionFormat(collectionPath);

      const filename = targetFilename || path.basename(sourcePathname);
      const filenameWithoutExt = filename.replace(/\.(bru|yml)$/, '');
      const finalFilename = `${filenameWithoutExt}.${format}`;
      const targetPathname = path.join(targetDirname, finalFilename);

      if (fs.existsSync(targetPathname)) {
        throw new Error(`A file with the name "${finalFilename}" already exists in the target location`);
      }

      const content = await stringifyRequestViaWorker(request, { format });

      await writeFile(targetPathname, content);

      if (request.examples) {
        syncExampleUidsCache(collectionPath, request.examples);
      }

      return { newPathname: targetPathname };
    } catch (error) {
      console.error('Error saving scratch request:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:show-in-folder', async (event, filePath) => {
    try {
      if (!filePath) {
        throw new Error('File path is required');
      }
      shell.showItemInFolder(filePath);
    } catch (error) {
      console.error('Error in show-in-folder: ', error);
      throw error;
    }
  });

  // Implement the Postman to Bruno conversion handler
  ipcMain.handle('renderer:convert-postman-to-bruno', async (event, postmanCollection) => {
    try {
      // Convert Postman collection to Bruno format
      const brunoCollection = await postmanToBruno(postmanCollection, { useWorkers: true });

      return brunoCollection;
    } catch (error) {
      console.error('Error converting Postman to Bruno:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:get-collection-json', async (event, collectionPath) => {
    let variables = {};
    let name = '';
    const getBruFilesRecursively = async (dir) => {
      const getFilesInOrder = async (dir) => {
        let bruJsons = [];

        const traverse = async (currentPath) => {
          const filesInCurrentDir = fs.readdirSync(currentPath);

          if (currentPath.includes('node_modules')) {
            return;
          }

          for (const file of filesInCurrentDir) {
            const filePath = path.join(currentPath, file);
            const stats = fs.lstatSync(filePath);

            if (stats.isDirectory() && !filePath.startsWith('.git') && !filePath.startsWith('node_modules')) {
              await traverse(filePath);
            }
          }

          const currentDirBruJsons = [];
          for (const file of filesInCurrentDir) {
            const filePath = path.join(currentPath, file);
            const stats = fs.lstatSync(filePath);

            if (isBrunoConfigFile(filePath, collectionPath)) {
              try {
                const content = fs.readFileSync(filePath, 'utf8');
                const brunoConfig = JSON.parse(content);

                name = brunoConfig?.name;
              } catch (err) {
                console.error(err);
              }
            }

            if (isDotEnvFile(filePath, collectionPath)) {
              try {
                const content = fs.readFileSync(filePath, 'utf8');
                const jsonData = dotenvToJson(content);
                variables = {
                  ...variables,
                  processEnvVariables: {
                    ...process.env,
                    ...jsonData
                  }
                };
                continue;
              } catch (err) {
                console.error(err);
              }
            }

            if (isBruEnvironmentConfig(filePath, collectionPath)) {
              try {
                let bruContent = fs.readFileSync(filePath, 'utf8');
                const environmentFilepathBasename = path.basename(filePath);
                const environmentName = environmentFilepathBasename.substring(0, environmentFilepathBasename.length - 4);
                let data = await parseEnvironment(bruContent);
                variables = {
                  ...variables,
                  envVariables: {
                    ...(variables?.envVariables || {}),
                    [path.basename(filePath)]: data.variables
                  }
                };
                continue;
              } catch (err) {
                console.error(err);
              }
            }

            if (isCollectionRootBruFile(filePath, collectionPath)) {
              try {
                let bruContent = fs.readFileSync(filePath, 'utf8');
                let data = await parseCollection(bruContent);
                // TODO
                continue;
              } catch (err) {
                console.error(err);
              }
            }
            if (!stats.isDirectory() && path.extname(filePath) === '.bru' && file !== 'folder.bru') {
              const bruContent = fs.readFileSync(filePath, 'utf8');
              const bruJson = parseRequest(bruContent, { format: 'bru' });

              currentDirBruJsons.push({
                ...bruJson
              });
            }
          }

          bruJsons = bruJsons.concat(currentDirBruJsons);
        };

        await traverse(dir);
        return bruJsons;
      };

      const orderedFiles = await getFilesInOrder(dir);
      return orderedFiles;
    };

    const files = await getBruFilesRecursively(collectionPath);
    return { name, files, ...variables };
  });

  ipcMain.handle('renderer:export-collection-zip', async (event, collectionPath, collectionName) => {
    try {
      if (!collectionPath || !fs.existsSync(collectionPath)) {
        throw new Error('Collection path does not exist');
      }

      const defaultFileName = `${sanitizeName(collectionName)}.zip`;
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Collection as ZIP',
        defaultPath: defaultFileName,
        filters: [{ name: 'Zip Files', extensions: ['zip'] }]
      });

      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }

      const ignoredDirectories = ['node_modules', '.git'];

      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
          resolve();
        });

        archive.on('error', (err) => {
          reject(err);
        });

        archive.pipe(output);

        const addDirectoryToArchive = (dirPath, archivePath) => {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const entryArchivePath = archivePath ? path.join(archivePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
              if (!ignoredDirectories.includes(entry.name)) {
                addDirectoryToArchive(fullPath, entryArchivePath);
              }
            } else {
              archive.file(fullPath, { name: entryArchivePath });
            }
          }
        };

        addDirectoryToArchive(collectionPath, '');
        archive.finalize();
      });

      return { success: true, filePath };
    } catch (error) {
      throw error;
    }
  });

  // Reads a full collection from disk into a hydrated collection object.
  // The renderer's redux store only lazily loads request bodies (warm index),
  // so single-file YAML/Postman exports built from redux produced an almost
  // empty (~1kb) file. This reads every request/folder/environment off disk so
  // the converters have the complete collection.
  ipcMain.handle('renderer:read-collection-for-export', async (event, collectionPathname) => {
    if (!collectionPathname || !fs.existsSync(collectionPathname)) {
      throw new Error('Collection path does not exist');
    }

    let brunoConfig = null;
    const brunoJsonPath = path.join(collectionPathname, 'bruno.json');
    if (fs.existsSync(brunoJsonPath)) {
      brunoConfig = safeParseJSON(fs.readFileSync(brunoJsonPath, 'utf8'));
    }

    let root = {};
    for (const [fileName, format] of [['collection.bru', 'bru'], ['opencollection.yml', 'yml']]) {
      const rootPath = path.join(collectionPathname, fileName);
      if (fs.existsSync(rootPath)) {
        try {
          root = parseCollection(fs.readFileSync(rootPath, 'utf8'), { format });
        } catch (err) {
          console.warn('[export] failed to parse collection root', rootPath, err?.message);
        }
        break;
      }
    }

    const environments = [];
    const envDir = path.join(collectionPathname, 'environments');
    if (fs.existsSync(envDir)) {
      for (const fileName of fs.readdirSync(envDir)) {
        if (!hasRequestExtension(fileName)) continue;
        try {
          const format = hasBruExtension(fileName) ? 'bru' : 'yml';
          environments.push(parseEnvironment(fs.readFileSync(path.join(envDir, fileName), 'utf8'), { format }));
        } catch (err) {
          console.warn('[export] failed to parse environment', fileName, err?.message);
        }
      }
    }

    const name
      = brunoConfig?.name || root?.meta?.name || path.basename(collectionPathname);

    return safeParseJSON(
      safeStringifyJSON({
        uid: generateUidBasedOnHash(collectionPathname),
        name,
        pathname: collectionPathname,
        type: 'collection',
        brunoConfig,
        root,
        environments,
        items: readCollectionItemsFromDisk(collectionPathname)
      })
    );
  });

  // Reads a folder subtree from disk into a collection-shaped object so the
  // renderer can hand it to the existing single-file exporters.
  ipcMain.handle('renderer:read-folder-for-export', async (event, { folderPathname, collectionPathname }) => {
    if (!collectionPathname || !fs.existsSync(collectionPathname)) {
      throw new Error('Collection path does not exist');
    }

    const folderPath = assertCollectionItemPath({ collectionPathname, itemPathname: folderPathname });
    if (!isDirectory(folderPath)) {
      throw new Error('Folder path must be a directory inside the collection');
    }

    return safeParseJSON(safeStringifyJSON(readFolderForExport({ folderPathname: folderPath })));
  });

  // Writes imported (bruno-shaped) items into an existing folder of an open
  // collection instead of creating a new collection.
  ipcMain.handle('renderer:import-into-folder', async (event, { items, targetDirectory, collectionPathname }) => {
    if (!collectionPathname || !fs.existsSync(collectionPathname)) {
      throw new Error('Collection path does not exist');
    }

    const targetPath = assertPathInside(collectionPathname, targetDirectory, 'Target directory must stay inside the collection');
    if (!fs.existsSync(targetPath) || !isDirectory(targetPath)) {
      throw new Error('Target directory does not exist');
    }

    const format = getCollectionFormat(collectionPathname);
    await writeItemsIntoFolder({
      items: Array.isArray(items) ? items : [],
      targetDirectory: targetPath,
      format
    });

    return { success: true };
  });

  ipcMain.handle('renderer:is-bruno-collection-zip', async (event, zipFilePath) => {
    try {
      const zip = new AdmZip(zipFilePath);
      const entries = zip.getEntries().map((e) => e.entryName);

      return entries.some(
        (name) =>
          name === 'bruno.json'
          || name === 'opencollection.yml'
          || /^[^/]+\/bruno\.json$/.test(name)
          || /^[^/]+\/opencollection\.yml$/.test(name)
      );
    } catch {
      return false;
    }
  });

  ipcMain.handle('renderer:import-collection-zip', async (event, zipFilePath, collectionLocation, options = {}) => {
    try {
      if (!fs.existsSync(zipFilePath)) {
        throw new Error('ZIP file does not exist');
      }

      const targetCollectionLocation = getWorkspaceCollectionLocation(options.workspaceId);

      const tempDir = path.join(os.tmpdir(), `bruno_zip_import_${Date.now()}`);
      await fsExtra.ensureDir(tempDir);

      // Validates that no symlinks point outside the base directory
      const validateNoExternalSymlinks = (dir, baseDir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const stat = fs.lstatSync(fullPath);

          if (stat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(fullPath);
            const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
            if (!resolvedTarget.startsWith(baseDir + path.sep) && resolvedTarget !== baseDir) {
              throw new Error(`Security error: Symlink "${entry.name}" points outside extraction directory`);
            }
          }

          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            validateNoExternalSymlinks(fullPath, baseDir);
          }
        }
      };

      try {
        await extractZip(zipFilePath, { dir: tempDir });

        validateNoExternalSymlinks(tempDir, tempDir);

        const extractedItems = fs.readdirSync(tempDir);
        let collectionDir = tempDir;

        if (extractedItems.length === 1) {
          const singleItem = path.join(tempDir, extractedItems[0]);
          const singleItemStat = fs.lstatSync(singleItem);
          if (singleItemStat.isDirectory() && !singleItemStat.isSymbolicLink()) {
            collectionDir = singleItem;
          }
        }

        const brunoJsonPath = path.join(collectionDir, 'bruno.json');
        const openCollectionYmlPath = path.join(collectionDir, 'opencollection.yml');

        if (!fs.existsSync(brunoJsonPath) && !fs.existsSync(openCollectionYmlPath)) {
          throw new Error('Invalid collection: Neither bruno.json nor opencollection.yml found in the ZIP file');
        }

        // Ensure config files are not symlinks
        if (fs.existsSync(brunoJsonPath) && fs.lstatSync(brunoJsonPath).isSymbolicLink()) {
          throw new Error('Security error: bruno.json cannot be a symbolic link');
        }
        if (fs.existsSync(openCollectionYmlPath) && fs.lstatSync(openCollectionYmlPath).isSymbolicLink()) {
          throw new Error('Security error: opencollection.yml cannot be a symbolic link');
        }

        let collectionName = 'Imported Collection';
        let brunoConfig = { name: collectionName, version: '1', type: 'collection', ignore: ['node_modules', '.git'] };
        if (fs.existsSync(openCollectionYmlPath)) {
          try {
            const content = fs.readFileSync(openCollectionYmlPath, 'utf8');
            const parsed = parseCollection(content, { format: 'yml' });
            brunoConfig = parsed.brunoConfig || brunoConfig;
            collectionName = brunoConfig.name || collectionName;
          } catch (e) {
            console.error(`Error parsing opencollection.yml at ${openCollectionYmlPath}:`, e);
          }
        } else if (fs.existsSync(brunoJsonPath)) {
          try {
            brunoConfig = JSON.parse(fs.readFileSync(brunoJsonPath, 'utf8'));
            collectionName = brunoConfig.name || collectionName;
          } catch (e) {
            console.error(`Error parsing bruno.json at ${brunoJsonPath}:`, e);
          }
        }

        let sanitizedName = sanitizeName(collectionName);
        if (!sanitizedName) {
          sanitizedName = `untitled-${Date.now()}`;
        }
        let finalCollectionPath = path.join(targetCollectionLocation, sanitizedName);
        let counter = 1;
        while (fs.existsSync(finalCollectionPath)) {
          finalCollectionPath = path.join(targetCollectionLocation, `${sanitizedName} (${counter})`);
          counter++;
        }

        await fsExtra.move(collectionDir, finalCollectionPath);
        await fsExtra.remove(path.join(finalCollectionPath, '.git')).catch(() => {});
        if (tempDir !== collectionDir) {
          await fsExtra.remove(tempDir).catch(() => { });
        }

        const uid = generateUidBasedOnHash(finalCollectionPath);
        const { size, filesCount } = await getCollectionStats(finalCollectionPath);
        brunoConfig.size = size;
        brunoConfig.filesCount = filesCount;

        mainWindow.webContents.send('main:collection-opened', finalCollectionPath, uid, brunoConfig, options.workspaceId);
        ipcMain.emit('main:collection-opened', mainWindow, finalCollectionPath, uid, brunoConfig, options.workspaceId);

        await registerCollectionInWorkspace(mainWindow, options.workspaceId, finalCollectionPath, collectionName);

        return finalCollectionPath;
      } catch (error) {
        await fsExtra.remove(tempDir).catch(() => { });
        throw error;
      }
    } catch (error) {
      throw error;
    }
  });
};

const registerMainEventHandlers = (mainWindow, watcher) => {
  ipcMain.on('main:open-collection', () => {
    if (mainWindow) {
      mainWindow.webContents.send('main:display-error', 'Use Import Collection from an active workspace so Gridman can copy it into that workspace.');
    }
  });

  ipcMain.on('main:open-docs', () => {
    const docsURL = 'https://github.com/shahramgit/gridman#readme';
    shell.openExternal(docsURL);
  });

  ipcMain.on('main:collection-opened', async (win, pathname, uid, brunoConfig) => {
    app.addRecentDocument(pathname);
  });

  ipcMain.handle('renderer:scan-for-bruno-files', (event, dir) => {
    try {
      return scanForBrunoFiles(dir);
    } catch (error) {
      throw new Error(error.message);
    }
  });

  // The app listen for this event and allows the user to save unsaved requests before closing the app
  ipcMain.on('main:start-quit-flow', () => {
    mainWindow.webContents.send('main:start-quit-flow');
  });

  ipcMain.handle('main:complete-quit-flow', () => {
    mainWindow.destroy();
  });

  ipcMain.handle('main:force-quit', () => {
    process.exit();
  });
};

const registerCollectionsIpc = (mainWindow, watcher) => {
  registerRendererEventHandlers(mainWindow, watcher);
  registerMainEventHandlers(mainWindow, watcher);
};

module.exports = registerCollectionsIpc;
