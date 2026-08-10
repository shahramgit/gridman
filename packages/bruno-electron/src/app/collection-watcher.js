const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { invalidateSearchForPath } = require('./search-invalidation');
const {
  hasRequestExtension,
  isWSLPath,
  normalizeAndResolvePath,
  sizeInMB,
  getCollectionFormat
} = require('../utils/filesystem');
const {
  parseEnvironment,
  parseRequest,
  parseRequestViaWorker,
  parseCollection,
  parseFolder
} = require('@usebruno/filestore');

const { uuid } = require('../utils/common');
const { getRequestUid } = require('../cache/requestUids');
const { decryptStringSafe } = require('../utils/encryption');
const { setBrunoConfig } = require('../store/bruno-config');
const EnvironmentSecretsStore = require('../store/env-secrets');
const UiStateSnapshot = require('../store/ui-state-snapshot');
const { parseFileMeta, hydrateRequestWithUuid } = require('../utils/collection');
const { parseLargeRequestWithRedaction } = require('../utils/parse');
const { transformBrunoConfigAfterRead } = require('../utils/transformBrunoConfig');
const dotEnvWatcher = require('./dotenv-watcher');
const { isPathUnderActiveGitOperation, gitOperationEvents } = require('./git-operation-state');

// The one threshold every "parse this request fully vs. hand back meta only"
// guard reads — the watcher's add/change here, and the renderer:load-request /
// renderer:load-request-via-worker IPC handlers, which import it from this module.
// Keeping it in one place is what makes a sidebar click classify a file exactly
// the way the watcher's own scan does.
//
// It does NOT bound the cost of a parse, it only decides who pays it: above the
// threshold the user gets a meta-only row and an explicit "Load Request" button.
// Measured on the real GSB workspace (one file per process, 4 GB heap):
// 0.58 MB -> 1.5 s / 1.5 GB RSS, 1.12 MB -> 2.8 s / 2.1 GB, 2.33 MB -> 7.1 s / 3.5 GB,
// 2.47 MB -> fatal "JS heap out of memory". The parser costs ~1.4 GB per MB of
// input on this corpus, so 2.5 MB sits just past the point where a parse can
// exhaust a 4 GB heap. The largest .bru in that workspace is 2,590,667 bytes,
// which means this guard currently fires on nothing there.
// Raising/lowering it is a product decision — do not change the value here
// without the CTO; see the report attached to this change.
const MAX_FILE_SIZE = 2.5 * 1024 * 1024;

// The meta-only fallback is only cheap for bru. parseBruFileMeta is a regex over
// the text, but parseYmlFileMeta hands the WHOLE file to js-yaml synchronously
// (utils/collection.js) — on the browser process that is the freeze this change
// exists to remove, reintroduced on the failure path. Measured with js-yaml on
// this machine over structured request yml: 10.6 ms and 15.3 MB of heap per MB of
// input, so our shipped 50 MB example cap would mean ~530 ms blocked and ~765 MB
// allocated on the main thread just to recover a sidebar name.
// 1 MB costs ~11 ms / ~15 MB, which is below the frame budget; above it we take
// the filename instead. That loses nothing for a request written by this app —
// stringifyHttpRequest writes name/type/seq under `info:` while parseYmlFileMeta
// reads `meta:`, so it already returns null for every yml request we produce.
const MAX_SYNC_YML_META_SIZE = 1 * 1024 * 1024;

const normalizeWatcherPath = (value) =>
  path.resolve(String(value || '')).replace(/\\/g, '/').replace(/\/+$/, '');

// Size-bounded wrapper around parseFileMeta. Every caller that reaches for a
// meta-only snapshot of a file it could not fully parse must go through this.
const parseFileMetaBounded = (content, format, sizeInBytes) => {
  if (format !== 'bru' && Number(sizeInBytes) >= MAX_SYNC_YML_META_SIZE) {
    return null;
  }
  return parseFileMeta(content, format);
};

// A worker that was killed out from under us — collection close, app quit, pool
// cleanup, an OS kill — rejects without ever having judged the file: WorkerQueue's
// exit handler turns that into "Worker stopped with exit code N". That is not a
// verdict on the request, and treating it as one repaints the row from a meta-only
// payload, which in the renderer runs applyFileDataToItem and unconditionally
// clears item.draft and item.examples — i.e. throws away unsaved edits and blanks
// the loaded examples of a file that is perfectly fine.
// ERR_WORKER_OUT_OF_MEMORY is deliberately NOT transient: that IS a verdict ("no
// single heap can parse this"), and the meta-only row is the right answer for it.
const TRANSIENT_WORKER_ERROR_CODES = new Set([
  'ERR_WORKER_PATH',
  'ERR_WORKER_INIT_FAILED',
  'ERR_WORKER_INVALID_EXEC_ARGV'
]);

const isTransientWorkerFailure = (err) => {
  if (err?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return false;
  }
  if (TRANSIENT_WORKER_ERROR_CODES.has(err?.code)) {
    return true;
  }
  return /worker stopped with exit code/i.test(String(err?.message || ''));
};

// A request parse is asynchronous now, and the shared filestore WorkerQueue serves
// a busy lane in PAYLOAD-SIZE order rather than arrival order (bruno-filestore
// WorkerQueue#enqueue sorts the pending list by priority, and priority is the
// payload's size in MB). So two saves of the same file whose sizes differ can come
// back inverted — reproduced with three request payloads in one lane: a 0.90 MB
// save issued first completed AFTER a 0.30 MB save issued second.
// change() was strictly FIFO while the parse was synchronous, and the renderer
// applies a change last-write-wins over name/type/seq/request/examples, so a stale
// result landing last silently reverts the in-memory request AND its saved
// examples — and the next Ctrl+S then persists that stale copy to disk. It bites
// hardest on the large-example requests we sell, because two consecutive saves of
// one of those differ by more than enough to invert.
// Every read of a request file stamps itself here before awaiting, and a result is
// dropped if a newer read of the same path has started since.
const parseGenerations = new Map();

const beginParseGeneration = (pathname) => {
  const key = normalizeWatcherPath(pathname);
  const entry = parseGenerations.get(key) || { latest: 0, inFlight: 0 };
  entry.latest += 1;
  entry.inFlight += 1;
  parseGenerations.set(key, entry);
  return entry.latest;
};

// Call exactly once per generation, on BOTH the success and the failure path —
// a generation that never claims holds its path's entry open forever.
//
// The entry is only forgotten once nothing is in flight for that path. Deleting
// it as soon as the newest result landed restarted numbering at 1 for the next
// read, so an older read still in flight could match that fresh 1 and be treated
// as newest — the stale-overwrite this guard exists to prevent, with extra steps.
// Keeping the entry while reads are outstanding still bounds the map by files
// actually being parsed, not by the 11,387 in the real workspace.
const claimNewestParseGeneration = (pathname, generation) => {
  const key = normalizeWatcherPath(pathname);
  const entry = parseGenerations.get(key);
  if (!entry) {
    return false;
  }

  entry.inFlight -= 1;
  const isNewest = entry.latest === generation;
  if (entry.inFlight <= 0) {
    parseGenerations.delete(key);
  }
  return isNewest;
};

const isUnderPath = (childPath, parentPath) => {
  const child = normalizeWatcherPath(childPath);
  const parent = normalizeWatcherPath(parentPath);
  return child === parent || child.startsWith(`${parent}/`);
};

const environmentSecretsStore = new EnvironmentSecretsStore();

const isBrunoConfigFile = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const basename = path.basename(pathname);

  return path.normalize(dirname) === path.normalize(collectionPath) && basename === 'bruno.json';
};

const isEnvironmentsFolder = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const envDirectory = path.join(collectionPath, 'environments');

  return path.normalize(dirname) === path.normalize(envDirectory);
};

const isFolderRootFile = (pathname, collectionPath) => {
  const basename = path.basename(pathname);
  const format = getCollectionFormat(collectionPath);

  if (format === 'yml') {
    return basename === 'folder.yml';
  } else if (format === 'bru') {
    return basename === 'folder.bru';
  }

  return false;
};

const isCollectionRootFile = (pathname, collectionPath) => {
  const dirname = path.dirname(pathname);
  const basename = path.basename(pathname);

  // return if we are not at the root of the collection
  if (path.normalize(dirname) !== path.normalize(collectionPath)) {
    return false;
  }

  return basename === 'collection.bru' || basename === 'opencollection.yml';
};

const envHasSecrets = (environment = {}) => {
  const secrets = _.filter(environment.variables, (v) => v.secret);

  return secrets && secrets.length > 0;
};

// A request file that will not parse still has to reach the renderer as a partial
// item, but the only thing we know about it is its path. Name it the way the
// indexer names an unparseable request (extractRequestMeta's fallbackName: basename
// WITHOUT the extension) — our sidebar renders from the index, so a name carrying
// `.yml`/`.bru` repaints the row with the filename. upstream bruno #8545 (81f9a4092)
const buildUnparseableRequestData = (pathname) => ({
  name: path.basename(pathname, path.extname(pathname)),
  type: 'http-request'
});

const hydrateCollectionRootWithUuid = (collectionRoot) => {
  const params = _.get(collectionRoot, 'request.params', []);
  const headers = _.get(collectionRoot, 'request.headers', []);
  const requestVars = _.get(collectionRoot, 'request.vars.req', []);
  const responseVars = _.get(collectionRoot, 'request.vars.res', []);

  params.forEach((param) => (param.uid = uuid()));
  headers.forEach((header) => (header.uid = uuid()));
  requestVars.forEach((variable) => (variable.uid = uuid()));
  responseVars.forEach((variable) => (variable.uid = uuid()));

  return collectionRoot;
};

const addEnvironmentFile = async (win, pathname, collectionUid, collectionPath) => {
  try {
    const basename = path.basename(pathname);
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: basename
      }
    };

    const format = getCollectionFormat(collectionPath);
    let content = fs.readFileSync(pathname, 'utf8');

    file.data = await parseEnvironment(content, { format });

    // Extract name by removing the extension
    const ext = path.extname(basename);
    file.data.name = basename.substring(0, basename.length - ext.length);
    file.data.uid = getRequestUid(pathname);

    _.each(_.get(file, 'data.variables', []), (variable) => (variable.uid = uuid()));

    // hydrate environment variables with secrets
    if (envHasSecrets(file.data)) {
      const envSecrets = environmentSecretsStore.getEnvSecrets(collectionPath, file.data);
      _.each(envSecrets, (secret) => {
        // match on `secret` too: a plain variable may share a secret's name, and
        // without this guard the decrypted secret lands on (and clobbers) the plain
        // row — leaking it into the UI and blanking the real secret.
        // upstream bruno #8679 (ef19c6995)
        const variable = _.find(file.data.variables, (v) => v.name === secret.name && v.secret);
        if (variable && secret.value) {
          const decryptionResult = decryptStringSafe(secret.value);
          variable.value = decryptionResult.value;
        }
      });
    }

    win.webContents.send('main:collection-tree-updated', 'addEnvironmentFile', file);
  } catch (err) {
    console.error('Error processing environment file: ', err);
  }
};

const changeEnvironmentFile = async (win, pathname, collectionUid, collectionPath) => {
  try {
    const basename = path.basename(pathname);
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: basename
      }
    };

    const format = getCollectionFormat(collectionPath);
    const content = fs.readFileSync(pathname, 'utf8');

    file.data = await parseEnvironment(content, { format });

    // Extract name by removing the extension
    const ext = path.extname(basename);
    file.data.name = basename.substring(0, basename.length - ext.length);
    file.data.uid = getRequestUid(pathname);
    _.each(_.get(file, 'data.variables', []), (variable) => (variable.uid = uuid()));

    // hydrate environment variables with secrets
    if (envHasSecrets(file.data)) {
      const envSecrets = environmentSecretsStore.getEnvSecrets(collectionPath, file.data);
      _.each(envSecrets, (secret) => {
        // see addEnvironmentFile — the `secret` guard keeps a decrypted secret off a
        // plain variable that happens to share its name. upstream bruno #8679 (ef19c6995)
        const variable = _.find(file.data.variables, (v) => v.name === secret.name && v.secret);
        if (variable && secret.value) {
          const decryptionResult = decryptStringSafe(secret.value);
          variable.value = decryptionResult.value;
        }
      });
    }

    // we are reusing the addEnvironmentFile event itself
    // this is because the uid of the pathname remains the same
    // and the collection tree will be able to update the existing environment
    win.webContents.send('main:collection-tree-updated', 'addEnvironmentFile', file);
  } catch (err) {
    console.error(err);
  }
};

const unlinkEnvironmentFile = async (win, pathname, collectionUid) => {
  try {
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname)
      },
      data: {
        uid: getRequestUid(pathname),
        name: path.basename(pathname).substring(0, path.basename(pathname).length - 4)
      }
    };

    win.webContents.send('main:collection-tree-updated', 'unlinkEnvironmentFile', file);
  } catch (err) {
    console.error(err);
  }
};

// Added to a background parse's queue priority (lower = served first) so a
// user-initiated parse always jumps ahead of an initial-scan backlog.
const BACKGROUND_PARSE_PRIORITY_BOOST = 1e9;

const add = async (win, pathname, collectionUid, collectionPath, useWorkerThread, watcher, parsePriorityBoost = 0) => {
  // A git checkout/pull/merge rewrites many files at once; skip the per-file
  // storm and let the single post-operation reindex resync the collection.
  if (isPathUnderActiveGitOperation(pathname)) {
    return;
  }
  // Initial-scan adds (parsePriorityBoost > 0 <=> initialScanActive) are
  // pre-existing files, not content changes — invalidating the workspace
  // search index for each one evicted every collection's index thousands of
  // times over the first minutes after startup, so ANY search in that window
  // rebuilt serially against a perpetually-cold cache (measured 118s to
  // first results on GSB; the user-reported 'first search is slow even after
  // waiting 30 seconds').
  if (parsePriorityBoost === 0) {
    invalidateSearchForPath(pathname);
  }
  if (isBrunoConfigFile(pathname, collectionPath)) {
    try {
      const content = fs.readFileSync(pathname, 'utf8');
      let brunoConfig = JSON.parse(content);

      // Transform the config to add exists metadata for protobuf files and import paths
      brunoConfig = await transformBrunoConfigAfterRead(brunoConfig, collectionPath);

      setBrunoConfig(collectionUid, brunoConfig);

      const payload = {
        collectionUid,
        brunoConfig: brunoConfig
      };

      win.webContents.send('main:bruno-config-update', payload);
    } catch (err) {
      console.error(err);
    }
  }

  if (isEnvironmentsFolder(pathname, collectionPath)) {
    return addEnvironmentFile(win, pathname, collectionUid, collectionPath);
  }

  if (isCollectionRootFile(pathname, collectionPath)) {
    const format = getCollectionFormat(collectionPath);
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname),
        collectionRoot: true
      }
    };

    try {
      let content = fs.readFileSync(pathname, 'utf8');
      let parsed = await parseCollection(content, { format });

      let collectionRoot, brunoConfig;
      if (format === 'yml') {
        collectionRoot = parsed.collectionRoot;
        brunoConfig = parsed.brunoConfig;
      } else {
        collectionRoot = parsed;
        brunoConfig = undefined;
      }

      file.data = collectionRoot;

      hydrateCollectionRootWithUuid(file.data);
      win.webContents.send('main:collection-tree-updated', 'addFile', file);

      // in yml format, opencollection.yml also contains the bruno config
      if (format === 'yml') {
        // Transform the config to add exists metadata for protobuf files and import paths
        brunoConfig = await transformBrunoConfigAfterRead(brunoConfig, collectionPath);

        setBrunoConfig(collectionUid, brunoConfig);

        const payload = {
          collectionUid,
          brunoConfig: brunoConfig
        };

        win.webContents.send('main:bruno-config-update', payload);
      }
    } catch (err) {
      console.error(err);
    }

    return;
  }

  if (isFolderRootFile(pathname, collectionPath)) {
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname),
        folderRoot: true
      }
    };

    try {
      let format = getCollectionFormat(collectionPath);
      let content = fs.readFileSync(pathname, 'utf8');
      file.data = await parseFolder(content, { format });

      hydrateCollectionRootWithUuid(file.data);
      win.webContents.send('main:collection-tree-updated', 'addFile', file);
      return;
    } catch (err) {
      console.error(err);
      return;
    }
  }

  const format = getCollectionFormat(collectionPath);
  if (hasRequestExtension(pathname, format)) {
    watcher.addFileToProcessing(collectionUid, pathname);

    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname)
      }
    };

    const fileStats = fs.statSync(pathname);
    let content = fs.readFileSync(pathname, 'utf8');

    // If worker thread is not used, we can directly parse the file
    if (!useWorkerThread) {
      try {
        file.data = await parseRequest(content, { format });
        file.partial = false;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        win.webContents.send('main:collection-tree-updated', 'addFile', file);
      } catch (error) {
        // same partial-item emit as the worker branch below, so an unparseable file
        // is still listed. upstream bruno #8545 (81f9a4092)
        file.data = buildUnparseableRequestData(pathname);
        file.error = {
          message: error?.message
        };
        file.partial = true;
        file.loading = false;
        file.size = sizeInMB(fileStats?.size);
        hydrateRequestWithUuid(file.data, pathname);
        win.webContents.send('main:collection-tree-updated', 'addFile', file);
      } finally {
        watcher.markFileAsProcessed(win, collectionUid, pathname);
      }
      return;
    }

    try {
      file.size = sizeInMB(fileStats?.size);

      if (fileStats.size < MAX_FILE_SIZE) {
        file.data = await parseRequestViaWorker(content, {
          format,
          filename: pathname,
          priorityBoost: parsePriorityBoost
        });
        file.partial = false;
        file.loading = false;
        hydrateRequestWithUuid(file.data, pathname);
        win.webContents.send('main:collection-tree-updated', 'addFile', file);
      } else {
        // Computed here rather than above the branch: the full parse below needs
        // nothing from it, so on a yml collection the old placement ran a whole-file
        // js-yaml load on the browser process for EVERY file of the initial scan
        // (11,387 of them in the real workspace) to feed a branch almost none of
        // them take. Bounded for the same reason the fallbacks below are.
        // Null is possible for a malformed or half-written file — this used to emit
        // it straight through, and hydrateRequestWithUuid then handed the renderer
        // a `data: null` item.
        file.data = parseFileMetaBounded(content, format, fileStats?.size) || buildUnparseableRequestData(pathname);
        file.partial = true;
        file.loading = false;
        hydrateRequestWithUuid(file.data, pathname);
        win.webContents.send('main:collection-tree-updated', 'addFile', file);
      }
    } catch (error) {
      file.data = buildUnparseableRequestData(pathname);
      file.error = {
        message: error?.message
      };
      file.partial = true;
      file.loading = false;
      file.size = sizeInMB(fileStats?.size);
      hydrateRequestWithUuid(file.data, pathname);
      win.webContents.send('main:collection-tree-updated', 'addFile', file);
    } finally {
      watcher.markFileAsProcessed(win, collectionUid, pathname);
    }
  }
};

const addDirectory = async (win, pathname, collectionUid, collectionPath) => {
  if (isPathUnderActiveGitOperation(pathname)) {
    return;
  }
  const envDirectory = path.join(collectionPath, 'environments');

  if (path.normalize(pathname) === path.normalize(envDirectory)) {
    return;
  }

  let name = path.basename(pathname);
  let seq;

  const format = getCollectionFormat(collectionPath);
  const folderFilePath = path.join(pathname, `folder.${format}`);

  try {
    if (fs.existsSync(folderFilePath)) {
      let folderFileContent = fs.readFileSync(folderFilePath, 'utf8');
      let folderData = await parseFolder(folderFileContent, { format });
      name = folderData?.meta?.name || name;
      seq = folderData?.meta?.seq;
    }
  } catch (error) {
    console.error(`Error occured while parsing folder.${format} file`);
    console.error(error);
  }

  const directory = {
    meta: {
      collectionUid,
      pathname,
      name,
      seq,
      uid: getRequestUid(pathname)
    }
  };

  win.webContents.send('main:collection-tree-updated', 'addDir', directory);
};

// `watcher` is the CollectionWatcher instance; the request branch below needs it
// to bracket its (now asynchronous) parse with addFileToProcessing /
// markFileAsProcessed, the same way add() does.
const change = async (win, pathname, collectionUid, collectionPath, watcher) => {
  if (isPathUnderActiveGitOperation(pathname)) {
    return;
  }
  invalidateSearchForPath(pathname);
  if (isBrunoConfigFile(pathname, collectionPath)) {
    try {
      const content = fs.readFileSync(pathname, 'utf8');
      let brunoConfig = JSON.parse(content);

      // Transform the config to add file existence checks for protobuf files and import paths
      brunoConfig = await transformBrunoConfigAfterRead(brunoConfig, collectionPath);

      setBrunoConfig(collectionUid, brunoConfig);

      const payload = {
        collectionUid,
        brunoConfig: brunoConfig
      };

      win.webContents.send('main:bruno-config-update', payload);
    } catch (err) {
      console.error(err);
    }

    return;
  }

  if (isEnvironmentsFolder(pathname, collectionPath)) {
    return changeEnvironmentFile(win, pathname, collectionUid, collectionPath);
  }

  if (isCollectionRootFile(pathname, collectionPath)) {
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname),
        collectionRoot: true
      }
    };

    try {
      let content = fs.readFileSync(pathname, 'utf8');
      let format = getCollectionFormat(collectionPath);
      let parsed = await parseCollection(content, { format });

      let collectionRoot, brunoConfig;
      if (format === 'yml') {
        collectionRoot = parsed.collectionRoot;
        brunoConfig = parsed.brunoConfig;
      } else {
        collectionRoot = parsed;
        brunoConfig = undefined;
      }

      file.data = collectionRoot;

      hydrateCollectionRootWithUuid(file.data);
      win.webContents.send('main:collection-tree-updated', 'change', file);

      // in yml format, opencollection.yml also contains the bruno config
      if (format === 'yml') {
        // Transform the config to add exists metadata for protobuf files and import paths
        brunoConfig = await transformBrunoConfigAfterRead(brunoConfig, collectionPath);

        setBrunoConfig(collectionUid, brunoConfig);

        const payload = {
          collectionUid,
          brunoConfig: brunoConfig
        };

        win.webContents.send('main:bruno-config-update', payload);
      }
    } catch (err) {
      console.error(err);
    }

    return;
  }

  if (isFolderRootFile(pathname, collectionPath)) {
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname),
        folderRoot: true
      }
    };

    try {
      let format = getCollectionFormat(collectionPath);
      let content = fs.readFileSync(pathname, 'utf8');
      file.data = await parseFolder(content, { format });

      hydrateCollectionRootWithUuid(file.data);
      win.webContents.send('main:collection-tree-updated', 'change', file);
      return;
    } catch (err) {
      console.error(err);
      return;
    }
  }

  const format = getCollectionFormat(collectionPath);
  if (hasRequestExtension(pathname, format)) {
    const file = {
      meta: {
        collectionUid,
        pathname,
        name: path.basename(pathname)
      }
    };

    let content;
    let fileStats;
    try {
      content = fs.readFileSync(pathname, 'utf8');
      fileStats = fs.statSync(pathname);
    } catch (err) {
      // Reading is kept OUT of the parse try on purpose: a read/stat failure means
      // "could not look at the file right now", not "this request is broken".
      // chokidar routinely fires while an atomic-replace save is mid-flight (ENOENT)
      // and on Windows an AV/indexer holds a brief lock (EPERM/EBUSY) — emitting a
      // partial item for those would repaint a healthy sidebar row (name -> filename,
      // no method, no seq). Log and wait for the next event, as before.
      console.error(err);
      return;
    }

    // Bracket the parse the way add() does. It is now genuinely asynchronous, so
    // the collection can finish discovering while this file is still in flight;
    // without the bracket a save during the initial scan reports the collection
    // as fully loaded before its own item has been re-emitted.
    watcher?.addFileToProcessing?.(collectionUid, pathname);

    // Stamped against the content we just read, so "newest" means newest read of
    // the file rather than newest to come back from the queue.
    const generation = beginParseGeneration(pathname);

    try {
      if (fileStats.size >= MAX_FILE_SIZE && format === 'bru') {
        file.data = await parseLargeRequestWithRedaction(content, 'bru');
      } else {
        // Off the browser process. This parse used to run inline here on every
        // save and every external write: measured against the real workspace it
        // blocked the main thread for 1.5 s at 0.58 MB, 7.1 s at 2.33 MB, and
        // died with a fatal "JS heap out of memory" at 2.47 MB — the customer's
        // "app hangs and then exits completely". In a worker the same file costs
        // the same memory but the main thread stalls ~20 ms, and an OOM comes
        // back as a catchable ERR_WORKER_OUT_OF_MEMORY handled below.
        file.data = await parseRequestViaWorker(content, { format, filename: pathname });
      }

      // A save that was read after this one has already been (or is about to be)
      // emitted; emitting this older parse now would revert it.
      if (!claimNewestParseGeneration(pathname, generation)) {
        return;
      }

      file.partial = false;
      file.loading = false;
      file.size = sizeInMB(fileStats?.size);
      hydrateRequestWithUuid(file.data, pathname);
      win.webContents.send('main:collection-tree-updated', 'change', file);
    } catch (err) {
      // Same ordering guard as the success path: a stale failure must not repaint
      // a row that a newer read has already refreshed.
      if (!claimNewestParseGeneration(pathname, generation)) {
        return;
      }

      // The worker dying is not a verdict on the file. Emitting the partial item
      // below would hand the renderer a meta-only payload, and applyFileDataToItem
      // clears item.draft and item.examples from it — losing unsaved edits over a
      // pool shutdown. Stay silent and wait for the next event, which is exactly
      // what this code did before the parse moved off-thread.
      if (isTransientWorkerFailure(err)) {
        console.error(err);
        return;
      }

      // Emit a partial item instead of swallowing the error, so a file that stops
      // parsing mid-session keeps a row to click on instead of silently going stale.
      // In-app git operations never reach here (change() returns above on
      // isPathUnderActiveGitOperation, and reindexCollectionsUnderGitRoot re-runs the
      // indexer, which emits its own partial+error); what does reach here is an
      // external writer — the git CLI in a terminal, an editor, or a merge tool
      // leaving conflict markers behind. Mirrors the worker branch in add().
      // upstream bruno #8545 (81f9a4092)
      //
      // Meta first, filename second: the worker parse rejects with
      // ERR_WORKER_OUT_OF_MEMORY on a file too big for one heap, and that file is
      // not malformed — its meta block reads fine, so the row keeps its real name,
      // type and seq exactly like add()'s oversized branch emits. Only a file that
      // cannot even yield a meta block falls back to the filename.
      // Bounded, because the yml meta parse is a synchronous whole-file js-yaml
      // load: unbounded it puts the very freeze the worker removed back on the
      // browser process, in the failure case.
      file.data = parseFileMetaBounded(content, format, fileStats?.size) || buildUnparseableRequestData(pathname);
      file.error = {
        message: err?.message
      };
      file.partial = true;
      file.loading = false;
      file.size = sizeInMB(fileStats.size);
      hydrateRequestWithUuid(file.data, pathname);
      win.webContents.send('main:collection-tree-updated', 'change', file);
    } finally {
      watcher?.markFileAsProcessed?.(win, collectionUid, pathname);
    }
  }
};

const unlink = (win, pathname, collectionUid, collectionPath) => {
  if (isPathUnderActiveGitOperation(pathname)) {
    return;
  }
  invalidateSearchForPath(pathname);
  try {
    if (!fs.existsSync(collectionPath)) {
      return;
    }

    if (isEnvironmentsFolder(pathname, collectionPath)) {
      return unlinkEnvironmentFile(win, pathname, collectionUid);
    }

    let format;
    try {
      format = getCollectionFormat(collectionPath);
    } catch (error) {
      console.error(`Error getting collection format for: ${collectionPath}`, error);
      return;
    }
    if (hasRequestExtension(pathname, format)) {
      const basename = path.basename(pathname);
      const dirname = path.dirname(pathname);

      if (basename === 'opencollection.yml' && path.normalize(dirname) === path.normalize(collectionPath)) {
        return;
      }

      const file = {
        meta: {
          collectionUid,
          pathname,
          name: basename
        }
      };
      win.webContents.send('main:collection-tree-updated', 'unlink', file);
    }
  } catch (err) {
    console.error(`Error processing unlink event for: ${pathname}`, err);
  }
};

const unlinkDir = async (win, pathname, collectionUid, collectionPath) => {
  if (isPathUnderActiveGitOperation(pathname)) {
    return;
  }
  try {
    if (!fs.existsSync(collectionPath)) {
      return;
    }
    const envDirectory = path.join(collectionPath, 'environments');

    if (path.normalize(pathname) === path.normalize(envDirectory)) {
      return;
    }

    let format;
    try {
      format = getCollectionFormat(collectionPath);
    } catch (error) {
      console.error(`Error getting collection format for: ${collectionPath}`, error);
      return;
    }
    const folderFilePath = path.join(pathname, `folder.${format}`);

    let name = path.basename(pathname);

    if (fs.existsSync(folderFilePath)) {
      let folderFileContent = fs.readFileSync(folderFilePath, 'utf8');
      let folderData = await parseFolder(folderFileContent, { format });
      name = folderData?.meta?.name || name;
    }

    const directory = {
      meta: {
        collectionUid,
        pathname,
        name
      }
    };
    win.webContents.send('main:collection-tree-updated', 'unlinkDir', directory);
  } catch (err) {
    console.error(`Error processing unlinkDir event for: ${pathname}`, err);
  }
};

const onWatcherSetupComplete = (win, watchPath, collectionUid, watcher) => {
  // Mark discovery as complete
  watcher.completeCollectionDiscovery(win, collectionUid);

  const UiStateSnapshotStore = new UiStateSnapshot();
  const collectionsSnapshotState = UiStateSnapshotStore.getCollections();
  const collectionSnapshotState = collectionsSnapshotState?.find((c) => c?.pathname && path.normalize(c.pathname) === path.normalize(watchPath));
  win.webContents.send('main:hydrate-app-with-ui-state-snapshot', collectionSnapshotState);
};

class CollectionWatcher {
  constructor() {
    this.watchers = {};
    this.loadingStates = {};
    this.tempDirectoryMap = {};
    // watchPath -> { collectionUid, win } so a finished git operation can
    // reindex exactly the collections that live under the affected git root.
    this.watcherMeta = {};

    gitOperationEvents.on('git-operation-end', ({ gitRootPath }) => {
      this.reindexCollectionsUnderGitRoot(gitRootPath);
    });
  }

  // After a git operation rewrites the working tree, the watcher was paused, so
  // rebuild the in-memory index of each affected collection in one pass instead
  // of replaying thousands of per-file events.
  reindexCollectionsUnderGitRoot(gitRootPath) {
    // Lazy require avoids a load-order cycle between the watcher and indexer.
    const { startCollectionIndex } = require('./collection-indexer');

    // Per-file watcher events were suppressed during the git operation, so the
    // search index never saw the rewritten files — invalidate it here or
    // searches keep serving pre-pull content until the TTL.
    invalidateSearchForPath(gitRootPath);

    for (const [watchPath, meta] of Object.entries(this.watcherMeta)) {
      if (!meta?.win || meta.win.isDestroyed?.()) {
        continue;
      }
      if (!isUnderPath(watchPath, gitRootPath)) {
        continue;
      }

      // Fall back to the config captured when the watcher was created (yml
      // collections store their config in opencollection.yml, not bruno.json).
      let brunoConfig = meta.brunoConfig;
      try {
        const brunoConfigPath = path.join(watchPath, 'bruno.json');
        if (fs.existsSync(brunoConfigPath)) {
          brunoConfig = JSON.parse(fs.readFileSync(brunoConfigPath, 'utf8'));
          meta.brunoConfig = brunoConfig;
          setBrunoConfig(meta.collectionUid, brunoConfig);
          meta.win.webContents.send('main:bruno-config-update', {
            collectionUid: meta.collectionUid,
            brunoConfig
          });
        }
      } catch (error) {
        console.error('Error refreshing bruno.json after git operation:', error);
      }

      try {
        startCollectionIndex(meta.win, {
          collectionUid: meta.collectionUid,
          collectionPathname: watchPath,
          brunoConfig,
          loadSessionId: uuid()
        });
        // Reindexing rebuilds the TREE, and nothing else. An already-open
        // request renders from the renderer's own loaded-request buffer, which
        // a reindex never touches — so after a discard/pull rewrote the file,
        // the tab kept showing the pre-operation content until the app was
        // restarted. That was the reported "discard changes does nothing".
        //
        // The per-file change events that normally refresh those buffers were
        // suppressed for the whole operation (that is the point of the
        // suppression), so the renderer is told to re-read what it has open.
        meta.win.webContents.send('main:collection-reindexed-after-git', {
          collectionUid: meta.collectionUid,
          collectionPathname: watchPath
        });
      } catch (error) {
        console.error('Error reindexing collection after git operation:', error);
      }
    }
  }

  // Initialize loading state tracking for a collection
  initializeLoadingState(collectionUid) {
    if (!this.loadingStates[collectionUid]) {
      this.loadingStates[collectionUid] = {
        isDiscovering: false, // Initial discovery phase
        isProcessing: false, // Processing discovered files
        pendingFiles: new Set() // Files that need processing
      };
    }
  }

  startCollectionDiscovery(win, collectionUid) {
    this.initializeLoadingState(collectionUid);
    const state = this.loadingStates[collectionUid];

    state.isDiscovering = true;
    state.pendingFiles.clear();

    win.webContents.send('main:collection-loading-state-updated', {
      collectionUid,
      isLoading: true
    });
  }

  addFileToProcessing(collectionUid, filepath) {
    this.initializeLoadingState(collectionUid);
    const state = this.loadingStates[collectionUid];
    state.pendingFiles.add(filepath);
  }

  markFileAsProcessed(win, collectionUid, filepath) {
    if (!this.loadingStates[collectionUid]) return;

    const state = this.loadingStates[collectionUid];
    state.pendingFiles.delete(filepath);

    // If discovery is complete and no pending files, mark as not loading
    if (!state.isDiscovering && state.pendingFiles.size === 0 && state.isProcessing) {
      state.isProcessing = false;
      win.webContents.send('main:collection-loading-state-updated', {
        collectionUid,
        isLoading: false
      });
    }
  }

  completeCollectionDiscovery(win, collectionUid) {
    if (!this.loadingStates[collectionUid]) return;

    const state = this.loadingStates[collectionUid];
    state.isDiscovering = false;

    // If there are pending files, start processing phase
    if (state.pendingFiles.size > 0) {
      state.isProcessing = true;
    } else {
      // No pending files, collection is fully loaded
      win.webContents.send('main:collection-loading-state-updated', {
        collectionUid,
        isLoading: false
      });
    }
  }

  cleanupLoadingState(collectionUid) {
    delete this.loadingStates[collectionUid];
  }

  addWatcher(win, watchPath, collectionUid, brunoConfig, forcePolling = false, useWorkerThread, options = {}) {
    if (this.watchers[watchPath]) {
      this.watchers[watchPath].close();
    }

    this.watcherMeta[watchPath] = { collectionUid, win, brunoConfig };

    this.initializeLoadingState(collectionUid);

    if (!options.skipInitialLoad) {
      this.startCollectionDiscovery(win, collectionUid);
    }

    // Always ignore node_modules and .git, regardless of user config
    // This prevents infinite loops with symlinked directories (e.g., npm workspaces)
    const defaultIgnores = ['node_modules', '.git'];
    const userIgnores = brunoConfig?.ignore || [];
    const ignores = [...new Set([...defaultIgnores, ...userIgnores])];

    setTimeout(() => {
      const watcher = chokidar.watch(watchPath, {
        ignoreInitial: Boolean(options.skipInitialLoad),
        usePolling: isWSLPath(watchPath) || forcePolling ? true : false,
        ignored: (filepath) => {
          const normalizedPath = normalizeAndResolvePath(filepath);
          const relativePath = path.relative(watchPath, normalizedPath);
          const basename = path.basename(filepath);

          // Ignore .env files - handled by dotenv-watcher
          if (basename === '.env' || basename.startsWith('.env.')) {
            return true;
          }

          // Check if any path segment matches a default ignore pattern (handles symlinks)
          const pathSegments = relativePath.split(path.sep);
          if (pathSegments.some((segment) => defaultIgnores.includes(segment))) {
            return true;
          }

          return ignores.some((ignorePattern) => {
            return relativePath === ignorePattern || relativePath.startsWith(ignorePattern);
          });
        },
        persistent: true,
        ignorePermissionErrors: true,
        awaitWriteFinish: {
          stabilityThreshold: 80,
          pollInterval: 10
        },
        depth: 20,
        disableGlobbing: true
      });

      let startedNewWatcher = false;
      // During the initial scan, parses run at background priority so a
      // user-initiated parse (opening a request) queued into the same worker
      // lane is served first. Live events after 'ready' use normal priority.
      let initialScanActive = !options.skipInitialLoad;
      watcher
        .on('ready', () => {
          initialScanActive = false;
          if (!options.skipInitialLoad) {
            onWatcherSetupComplete(win, watchPath, collectionUid, this);
          }
        })
        .on('add', (pathname) => add(win, pathname, collectionUid, watchPath, useWorkerThread, this, initialScanActive ? BACKGROUND_PARSE_PRIORITY_BOOST : 0))
        .on('addDir', (pathname) => addDirectory(win, pathname, collectionUid, watchPath))
        .on('change', (pathname) => change(win, pathname, collectionUid, watchPath, this))
        .on('unlink', (pathname) => unlink(win, pathname, collectionUid, watchPath))
        .on('unlinkDir', (pathname) => unlinkDir(win, pathname, collectionUid, watchPath))
        .on('error', (error) => {
          // `EMFILE` is an error code thrown when to many files are watched at the same time see: https://github.com/usebruno/bruno/issues/627
          // `ENOSPC` stands for "Error No space" but is also thrown if the file watcher limit is reached.
          // To prevent loops `!forcePolling` is checked.
          if ((error.code === 'ENOSPC' || error.code === 'EMFILE') && !startedNewWatcher && !forcePolling) {
            // This callback is called for every file the watcher is trying to watch. To prevent a spam of messages and
            // Multiple watcher being started `startedNewWatcher` is set to prevent this.
            startedNewWatcher = true;
            watcher.close();
            console.error(
              `\nCould not start watcher for ${watchPath}:`,
              'ENOSPC: System limit for number of file watchers reached!',
              'Trying again with polling, this will be slower!\n',
              'Update your system config to allow more concurrently watched files with:',
              '"echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p"'
            );
            this.addWatcher(win, watchPath, collectionUid, brunoConfig, true, useWorkerThread, options);
          } else {
            console.error(`An error occurred in the watcher for: ${watchPath}`, error);
          }
        });

      this.watchers[watchPath] = watcher;

      dotEnvWatcher.addCollectionWatcher(win, watchPath, collectionUid);
    }, 100);
  }

  hasWatcher(watchPath) {
    return this.watchers[watchPath];
  }

  removeWatcher(watchPath, win, collectionUid) {
    if (this.watchers[watchPath]) {
      this.watchers[watchPath].close();
      this.watchers[watchPath] = null;
    }

    delete this.watcherMeta[watchPath];

    dotEnvWatcher.removeCollectionWatcher(watchPath);

    const tempDirectoryPath = this.tempDirectoryMap[watchPath];
    if (tempDirectoryPath && this.watchers[tempDirectoryPath]) {
      this.watchers[tempDirectoryPath].close();
      delete this.watchers[tempDirectoryPath];
      delete this.tempDirectoryMap[watchPath];
    }

    if (collectionUid) {
      this.cleanupLoadingState(collectionUid);
    }
  }

  getWatcherByItemPath(itemPath) {
    const paths = Object.keys(this.watchers);

    const watcherPath = paths?.find((collectionPath) => {
      const absCollectionPath = path.resolve(collectionPath);
      const absItemPath = path.resolve(itemPath);

      return absItemPath.startsWith(absCollectionPath);
    });

    return watcherPath ? this.watchers[watcherPath] : null;
  }

  unlinkItemPathInWatcher(itemPath) {
    const watcher = this.getWatcherByItemPath(itemPath);
    if (watcher) {
      watcher.unwatch(itemPath);
    }
  }

  addItemPathInWatcher(itemPath) {
    const watcher = this.getWatcherByItemPath(itemPath);
    if (watcher && !watcher?.has?.(itemPath)) {
      watcher?.add?.(itemPath);
    }
  }

  // Helper function to get collection path from temp directory metadata
  getCollectionPathFromTempDirectory(tempDirectoryPath) {
    const metadataPath = path.join(tempDirectoryPath, 'metadata.json');
    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataContent);
      if (metadata.type === 'scratch') {
        return tempDirectoryPath;
      }
      return metadata.collectionPath;
    } catch (error) {
      console.error(`Error reading metadata from temp directory ${tempDirectoryPath}:`, error);
      return null;
    }
  }

  // Add watcher for transient directory
  // The tempDirectoryPath is stored in this.tempDirectoryMap[collectionPath] so removeWatcher can clean it up
  addTempDirectoryWatcher(win, tempDirectoryPath, collectionUid, collectionPath) {
    if (this.watchers[tempDirectoryPath]) {
      this.watchers[tempDirectoryPath].close();
    }

    // Store the mapping from collectionPath to tempDirectoryPath for cleanup in removeWatcher
    this.tempDirectoryMap[collectionPath] = tempDirectoryPath;

    // Ignore metadata.json file
    const ignored = (filepath) => {
      const basename = path.basename(filepath);
      return basename === 'metadata.json';
    };

    const watcher = chokidar.watch(tempDirectoryPath, {
      ignoreInitial: true, // Don't process existing files
      usePolling: isWSLPath(tempDirectoryPath) ? true : false,
      ignored,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 10
      },
      depth: 1, // Only watch the temp directory itself, not subdirectories
      disableGlobbing: true
    });

    // Wrapper function to handle temp directory files
    const addTempFile = async (pathname) => {
      // Skip metadata.json
      if (path.basename(pathname) === 'metadata.json') {
        return;
      }

      // Get the actual collection path from metadata
      const actualCollectionPath = this.getCollectionPathFromTempDirectory(tempDirectoryPath);
      if (!actualCollectionPath) {
        console.error(`Could not determine collection path for temp directory: ${tempDirectoryPath}`);
        return;
      }

      // Use the collection format from the actual collection
      const format = getCollectionFormat(actualCollectionPath);

      // Only process request files
      if (hasRequestExtension(pathname, format)) {
        // Call the regular add function with the actual collection path
        // This will hydrate and send the file to the renderer
        await add(win, pathname, collectionUid, actualCollectionPath, false, this);
      }
    };
    const unlinkTempFile = async (pathname) => {
      // Skip metadata.json
      if (path.basename(pathname) === 'metadata.json') {
        return;
      }

      // Get the actual collection path from metadata
      const actualCollectionPath = this.getCollectionPathFromTempDirectory(tempDirectoryPath);
      if (!actualCollectionPath) {
        console.error(`Could not determine collection path for temp directory: ${tempDirectoryPath}`);
        return;
      }

      // Use the collection format from the actual collection
      const format = getCollectionFormat(actualCollectionPath);

      // Only process request files
      if (hasRequestExtension(pathname, format)) {
        // Call the regular unlink function with the actual collection path
        await unlink(win, pathname, collectionUid, actualCollectionPath);
      }
    };

    watcher
      .on('add', (pathname) => addTempFile(pathname))
      .on('unlink', (pathname) => unlinkTempFile(pathname))
      .on('error', (error) => {
        console.error(`An error occurred in the temp directory watcher for: ${tempDirectoryPath}`, error);
      });

    this.watchers[tempDirectoryPath] = watcher;
  }

  getAllWatcherPaths() {
    return Object.entries(this.watchers)
      .filter(([path, watcher]) => !!watcher)
      .map(([path, _watcher]) => path);
  }

  closeAllWatchers() {
    for (const [watchPath, watcher] of Object.entries(this.watchers)) {
      try {
        watcher?.close();
      } catch (err) {}
    }
    this.watchers = {};
    this.watcherMeta = {};
  }
}

const collectionWatcher = new CollectionWatcher();

module.exports = collectionWatcher;
// Shared with the load-request IPC handlers so a sidebar click classifies an
// oversized request exactly like this scan does, instead of parsing it inline.
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
// Same reason: a sidebar click that cannot parse the file must name the partial
// item the way this scan (and the indexer) names it, or it repaints the row with
// the filename.
module.exports.buildUnparseableRequestData = buildUnparseableRequestData;
// The load-request handlers await the same worker for the same files, so they share
// this module's ordering stamp, its transient-failure rule and its bounded meta
// fallback. Two registries would let a sidebar click and a watcher change() each
// think it was the newest read of the same path.
module.exports.beginParseGeneration = beginParseGeneration;
module.exports.claimNewestParseGeneration = claimNewestParseGeneration;
module.exports.isTransientWorkerFailure = isTransientWorkerFailure;
module.exports.parseFileMetaBounded = parseFileMetaBounded;
module.exports.MAX_SYNC_YML_META_SIZE = MAX_SYNC_YML_META_SIZE;
// The chokidar callbacks are module-level functions; the unit tests in
// tests/collections drive them through here rather than spinning up a real watcher.
module.exports.__handlers = {
  add,
  change,
  addEnvironmentFile,
  changeEnvironmentFile
};
