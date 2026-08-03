// The watcher pulls in electron (dialog) and electron-store transitively; neither
// is exercised by the handlers under test, so stubs are enough.
jest.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'gridman', getVersion: () => '0.0.0' },
  dialog: {},
  ipcMain: { handle: jest.fn(), on: jest.fn(), emit: jest.fn() },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}));

jest.mock('electron-store', () => {
  return class MemoryStore {
    constructor() {
      this.data = {};
    }

    get(key, defaultValue) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], this.data);
      return value === undefined ? defaultValue : value;
    }

    set() {}
    delete() {}
  };
});

// The point of this spec is WHEN a parse resolves relative to its siblings, so the
// real pooled worker is replaced by deferreds the test settles by hand. That also
// keeps the suite off worker threads entirely — the shared filestore pool has no
// exported shutdown, so a spec that touches it leaves a live thread behind.
const mockWorkerParses = [];
jest.mock('@usebruno/filestore', () => {
  const actual = jest.requireActual('@usebruno/filestore');
  return {
    ...actual,
    parseRequestViaWorker: jest.fn(
      (content, options) =>
        new Promise((resolve, reject) => {
          mockWorkerParses.push({ content, options, resolve, reject });
        })
    )
  };
});

// parseYmlFileMeta reaches for js-yaml lazily (utils/collection.js), so the module
// registry is the only place to observe whether the whole file was handed to it.
jest.mock('js-yaml', () => {
  const actual = jest.requireActual('js-yaml');
  return { ...actual, load: jest.fn((...args) => actual.load(...args)) };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const collectionWatcher = require('../../src/app/collection-watcher');
const { add, change } = collectionWatcher.__handlers;
const { MAX_SYNC_YML_META_SIZE, MAX_FILE_SIZE } = collectionWatcher;

const COLLECTION_UID = 'collection-uid';

// Snapshot on send, the way electron structure-clones an IPC payload, so a later
// emit that reuses the same `file` object cannot rewrite an earlier recorded one.
const makeWin = () => {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (channel, type, payload) => sent.push({ channel, type, payload: JSON.parse(JSON.stringify(payload)) })
    }
  };
};

const makeWatcherStub = () => ({
  addFileToProcessing: jest.fn(),
  markFileAsProcessed: jest.fn()
});

// NOT a `gridman-` prefix: hydrateRequestWithUuid flags anything under
// `<tmpdir>/gridman-` as a transient scratch request.
const makeCollection = (format) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bruno-parse-order-${format}-`));
  if (format === 'yml') {
    fs.writeFileSync(
      path.join(dir, 'opencollection.yml'),
      ['opencollection: 1.0.0', 'info:', '  name: Test Collection', '  type: collection', ''].join('\n'),
      'utf8'
    );
  } else {
    fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify({ version: '1', name: 'Test Collection', type: 'collection' }), 'utf8');
  }
  return dir;
};

const cleanup = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {}
};

// The GSB shape: a request whose bytes are almost all saved response examples, so
// two consecutive saves of the same file differ in size by enough to invert in a
// queue that serves by payload size.
const buildBru = (name, filler) =>
  [
    'meta {',
    `  name: ${name}`,
    '  type: http',
    '  seq: 1',
    '}',
    '',
    'get {',
    '  url: https://example.com',
    '}',
    '',
    'docs {',
    `  ${filler}`,
    '}',
    ''
  ].join('\n');

const parsedRequest = (name, exampleNames) => ({
  type: 'http-request',
  name,
  seq: 1,
  request: { method: 'GET', url: 'https://example.com', params: [], headers: [], auth: { mode: 'none' }, body: { mode: 'none' } },
  examples: exampleNames.map((exampleName) => ({ name: exampleName, response: { status: 200 } }))
});

beforeEach(() => {
  mockWorkerParses.length = 0;
  yaml.load.mockClear();
});

// The filestore WorkerQueue sorts its pending list by payload size, so once a lane
// is busy results come back in size order rather than event order: reproduced with
// real request payloads in one lane, a 0.90 MB save issued first resolved AFTER a
// 0.30 MB save issued second. change() was strictly FIFO while the parse was
// synchronous, and the renderer applies a change last-write-wins over
// name/type/seq/request/examples — so the older parse landing last reverts the
// in-memory request AND its examples, and the next Ctrl+S persists the stale copy.
describe('collection watcher — an overtaken parse must not revert a newer save', () => {
  let collectionPath;
  let requestPath;

  beforeEach(() => {
    collectionPath = makeCollection('bru');
    requestPath = path.join(collectionPath, 'user_info.bru');
  });

  afterEach(() => cleanup(collectionPath));

  it('drops the older parse when it resolves after the newer one', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    // Save #1: the bigger file, so the queue serves it last.
    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(4096)), 'utf8');
    const older = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);

    // Save #2: the user deleted an example, so this write is smaller and jumps it.
    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const newer = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);

    expect(mockWorkerParses).toHaveLength(2);

    // Invert them exactly the way the size-ordered queue does.
    mockWorkerParses[1].resolve(parsedRequest('user_info', ['kept-example']));
    mockWorkerParses[0].resolve(parsedRequest('user_info', ['kept-example', 'deleted-example']));

    await Promise.all([older, newer]);

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.data.examples.map((e) => e.name)).toEqual(['kept-example']);
    // Both parses still have to unwind the processing bracket, or the collection
    // never reports itself as loaded.
    expect(watcherStub.markFileAsProcessed).toHaveBeenCalledTimes(2);
  });

  // The guard is on which READ is newest, not on which result arrives first, so an
  // overtaken save is dropped either way — the file on disk already moved past it,
  // and skipping the doomed repaint is the point.
  it('keeps the newest content when the parses resolve in order too', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(4096)), 'utf8');
    const older = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const newer = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);

    mockWorkerParses[0].resolve(parsedRequest('user_info', ['kept-example', 'deleted-example']));
    mockWorkerParses[1].resolve(parsedRequest('user_info', ['kept-example']));

    await Promise.all([older, newer]);

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.data.examples.map((e) => e.name)).toEqual(['kept-example']);
  });

  // The guard must not swallow the ordinary case: one save, one repaint.
  it('emits a save that nothing overtook', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const pending = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[0].resolve(parsedRequest('user_info', ['kept-example']));
    await pending;

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.partial).toBe(false);
    expect(changes[0].payload.data.examples.map((e) => e.name)).toEqual(['kept-example']);
  });

  // Two saves in a row that are NOT overlapping must both repaint — otherwise the
  // stamp would be leaking state between events for the same path.
  it('emits both of two saves that do not overlap', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(4096)), 'utf8');
    const first = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[0].resolve(parsedRequest('user_info', ['kept-example', 'deleted-example']));
    await first;

    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const second = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[1].resolve(parsedRequest('user_info', ['kept-example']));
    await second;

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(2);
    expect(changes[1].payload.data.examples.map((e) => e.name)).toEqual(['kept-example']);
  });

  // A stale FAILURE is just as destructive as a stale success — it repaints the row
  // from a meta-only payload, which clears the item's examples in the renderer.
  it('drops an older parse failure that lands after a newer success', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(4096)), 'utf8');
    const older = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const newer = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);

    mockWorkerParses[1].resolve(parsedRequest('user_info', ['kept-example']));
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));

    await Promise.all([older, newer]);

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.partial).toBe(false);
    expect(changes[0].payload.data.examples.map((e) => e.name)).toEqual(['kept-example']);
  });
});

// A pooled worker terminated during collection close or app quit rejects with
// "Worker stopped with exit code N". That says nothing about the file, but the
// partial payload it used to produce reaches applyFileDataToItem in the renderer,
// which unconditionally clears item.draft and sets item.examples from the payload —
// so a lifecycle event silently threw away unsaved work on a file that is fine.
describe('collection watcher — a dying worker is not a verdict on the file', () => {
  let collectionPath;
  let requestPath;

  beforeEach(() => {
    collectionPath = makeCollection('bru');
    requestPath = path.join(collectionPath, 'user_info.bru');
    fs.writeFileSync(requestPath, buildBru('user_info', 'payload'), 'utf8');
  });

  afterEach(() => cleanup(collectionPath));

  it('emits nothing when the worker is torn down mid-parse', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    const pending = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[0].reject(new Error('Worker stopped with exit code 1'));
    await pending;

    expect(win.sent).toHaveLength(0);
    expect(watcherStub.markFileAsProcessed).toHaveBeenCalledTimes(1);
  });

  // The opposite guard: an OOM IS a verdict — that file cannot be parsed in one
  // heap — so it must keep producing the meta-only row with a real name.
  it('still emits a partial item when the worker runs out of memory', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    const pending = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    const oom = new Error('Worker terminated due to reaching memory limit: JS heap out of memory');
    oom.code = 'ERR_WORKER_OUT_OF_MEMORY';
    mockWorkerParses[0].reject(oom);
    await pending;

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.partial).toBe(true);
    expect(changes[0].payload.data.name).toBe('user_info');
    expect(changes[0].payload.error.message).toMatch(/heap out of memory/);
  });

  // A genuinely malformed file still has to keep its sidebar row.
  it('still emits a partial item for a real parse error', async () => {
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    const pending = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));
    await pending;

    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.partial).toBe(true);
    expect(changes[0].payload.error.message).toBe('Unexpected token at line 4');
  });
});

// parseFileMeta is only cheap for bru. For yml it is a synchronous js-yaml load of
// the WHOLE file on the browser process — measured at 10.6 ms and 15.3 MB of heap
// per MB of input, so at our shipped 50 MB example cap that is ~530 ms blocked and
// ~765 MB allocated, in the failure path of the very code that exists to keep big
// parses off the main thread.
describe('collection watcher — the yml meta fallback is size bounded', () => {
  let collectionPath;
  let requestPath;

  beforeEach(() => {
    collectionPath = makeCollection('yml');
    requestPath = path.join(collectionPath, 'user_info.yml');
  });

  afterEach(() => cleanup(collectionPath));

  const buildYml = (targetBytes) => {
    const head = ['meta:', '  name: user_info', '  type: http', '  seq: 1', '', 'examples:'].join('\n') + '\n';
    const chunk = (i) => [`  - name: example_${i}`, '    response:', '      status: 200', `      body: "${'z'.repeat(120)}"`, ''].join('\n');
    let out = head;
    let i = 0;
    while (Buffer.byteLength(out, 'utf8') < targetBytes) {
      out += chunk(i++);
    }
    return out;
  };

  const yamlLoadedTheWholeFile = (content) =>
    yaml.load.mock.calls.some(([doc]) => typeof doc === 'string' && doc.length === content.length);

  it('does not hand a file above the bound to js-yaml on the main thread', async () => {
    const content = buildYml(MAX_SYNC_YML_META_SIZE + 128 * 1024);
    fs.writeFileSync(requestPath, content, 'utf8');
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    const pending = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));
    await pending;

    expect(yamlLoadedTheWholeFile(content)).toBe(false);
    // Still a visible row, named the way the indexer names an unparseable request.
    const changes = win.sent.filter((e) => e.type === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload.data.name).toBe('user_info');
  });

  // The bound must not become "never recover a name": below it the fallback still
  // reads the file's own meta block.
  it('still runs the meta parse for a file below the bound', async () => {
    const content = buildYml(64 * 1024);
    fs.writeFileSync(requestPath, content, 'utf8');
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    const pending = change(win, requestPath, COLLECTION_UID, collectionPath, watcherStub);
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));
    await pending;

    expect(yamlLoadedTheWholeFile(content)).toBe(true);
  });

  // add()'s oversized branch is the same defect on the discovery path: the meta
  // parse used to be hoisted above the branch, so a yml collection ran a whole-file
  // js-yaml load on the browser process for EVERY file of the initial scan to feed
  // a branch almost none of them take.
  it('does not hand an oversized file to js-yaml when the scan classifies it', async () => {
    // The `info:` block is where the yml request format actually carries the name;
    // parseYmlFileMeta reads `meta:`, so it returns null for a file this app wrote —
    // which used to be emitted as `data: null` straight into the renderer.
    const head = ['info:', '  name: user_info', '  type: http', '  seq: 1', '', 'examples:'].join('\n') + '\n';
    const chunk = (i) => [`  - name: example_${i}`, '    response:', '      status: 200', `      body: "${'z'.repeat(120)}"`, ''].join('\n');
    let content = head;
    let i = 0;
    while (Buffer.byteLength(content, 'utf8') <= MAX_FILE_SIZE) {
      content += chunk(i++);
    }
    fs.writeFileSync(requestPath, content, 'utf8');
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    await add(win, requestPath, COLLECTION_UID, collectionPath, true, watcherStub, 0);

    expect(yamlLoadedTheWholeFile(content)).toBe(false);
    const adds = win.sent.filter((e) => e.type === 'addFile');
    expect(adds).toHaveLength(1);
    expect(adds[0].payload.partial).toBe(true);
    expect(adds[0].payload.data).not.toBeNull();
    expect(adds[0].payload.data.name).toBe('user_info');
  });
});
