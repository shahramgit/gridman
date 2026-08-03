// The IPC module pulls in electron and electron-store transitively; the handler
// under test only touches ipcMain.handle and mainWindow.webContents.send.
const mockIpcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'gridman', getVersion: () => '0.0.0', on: jest.fn(), whenReady: () => Promise.resolve() },
  dialog: {},
  BrowserWindow: class {},
  ipcMain: {
    handle: jest.fn((channel, handler) => {
      mockIpcHandlers[channel] = handler;
    }),
    on: jest.fn(),
    emit: jest.fn(),
    removeHandler: jest.fn()
  },
  shell: {},
  net: {},
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

// src/utils/constants.js is authored as ESM and there is no babel transform for
// this package's jest run, so it cannot be required from a CJS spec.
jest.mock('../../src/utils/constants', () => ({
  REQUEST_TYPES: ['http-request', 'graphql-request', 'grpc-request', 'ws-request']
}));

// Same reason as the watcher ordering spec: the test needs to control WHEN each
// parse settles, and mocking the pooled worker keeps this suite off worker threads
// (the shared filestore pool has no exported shutdown).
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

const registerCollectionsIpc = require('../../src/ipc/collection');
const { MAX_SYNC_YML_META_SIZE } = require('../../src/app/collection-watcher');

const COLLECTION_UID = 'collection-uid';

// Snapshot on send. This handler emits the SAME `file` object twice (a "loading"
// placeholder, then the parsed one), and keeping references would let the second
// emit rewrite what the first one looked like — electron structured-clones it.
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

let win;
let loadRequest;

beforeAll(() => {
  win = makeWin();
  registerCollectionsIpc(win, { addFileToProcessing: jest.fn(), markFileAsProcessed: jest.fn() });
  loadRequest = mockIpcHandlers['renderer:load-request'];
  expect(typeof loadRequest).toBe('function');
});

beforeEach(() => {
  win.sent.length = 0;
  mockWorkerParses.length = 0;
  yaml.load.mockClear();
});

const makeTempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `bruno-load-request-${label}-`));

const cleanup = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {}
};

const buildBru = (name, filler) =>
  ['meta {', `  name: ${name}`, '  type: http', '  seq: 1', '}', '', 'get {', '  url: https://example.com', '}', '', 'docs {', `  ${filler}`, '}', ''].join('\n');

const parsedRequest = (name, exampleNames) => ({
  type: 'http-request',
  name,
  seq: 1,
  request: { method: 'GET', url: 'https://example.com', params: [], headers: [], auth: { mode: 'none' }, body: { mode: 'none' } },
  examples: exampleNames.map((exampleName) => ({ name: exampleName, response: { status: 200 } }))
});

// Anything the handler emits or returns is fed to applyFileDataToItem in the
// renderer, which unconditionally does `item.draft = null` and
// `item.examples = file.data.examples`. So a meta-only payload is not a harmless
// "we could not load it" signal — it destroys unsaved work and blanks the loaded
// examples of the large-example requests this product sells.
describe('renderer:load-request — a dying worker must not destroy the open draft', () => {
  let dir;
  let requestPath;

  beforeEach(() => {
    dir = makeTempDir('worker');
    requestPath = path.join(dir, 'user_info.bru');
    fs.writeFileSync(requestPath, buildBru('user_info', 'payload'), 'utf8');
  });

  afterEach(() => cleanup(dir));

  // A pooled worker terminated during collection close or app quit says nothing
  // about the file — it usually parses perfectly well on the next attempt.
  it('rejects instead of emitting a meta-only payload', async () => {
    const pending = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });
    const rejection = expect(pending).rejects.toThrow(/Worker stopped with exit code/);
    mockWorkerParses[0].reject(new Error('Worker stopped with exit code 1'));
    await rejection;

    // Only the pre-parse "loading" placeholder; nothing that would clear the draft
    // and replace the examples.
    const finals = win.sent.filter((e) => e.payload.loading === false);
    expect(finals).toHaveLength(0);
  });

  // The opposite guard: an OOM IS a verdict on the file, and the meta-only row with
  // its real name is the right answer for it.
  it('still returns a partial item when the worker runs out of memory', async () => {
    const pending = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });
    const oom = new Error('Worker terminated due to reaching memory limit: JS heap out of memory');
    oom.code = 'ERR_WORKER_OUT_OF_MEMORY';
    mockWorkerParses[0].reject(oom);
    const file = await pending;

    expect(file.partial).toBe(true);
    expect(file.loading).toBe(false);
    expect(file.data.name).toBe('user_info');
    expect(file.error.message).toMatch(/heap out of memory/);
  });

  it('still returns a partial item for a real parse error', async () => {
    const pending = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));
    const file = await pending;

    expect(file.partial).toBe(true);
    expect(file.error.message).toBe('Unexpected token at line 4');
  });
});

// This handler and the watcher's change() await the same size-ordered queue for the
// same files, so a click can be overtaken exactly the way a save can. Its return
// value goes straight into collectionAddFileEvent, which is last-write-wins.
describe('renderer:load-request — an overtaken click must not revert newer content', () => {
  let dir;
  let requestPath;

  beforeEach(() => {
    dir = makeTempDir('order');
    requestPath = path.join(dir, 'user_info.bru');
  });

  afterEach(() => cleanup(dir));

  it('drops the older read when it resolves after the newer one', async () => {
    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(4096)), 'utf8');
    const older = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });

    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const newer = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });

    expect(mockWorkerParses).toHaveLength(2);
    mockWorkerParses[1].resolve(parsedRequest('user_info', ['kept-example']));
    mockWorkerParses[0].resolve(parsedRequest('user_info', ['kept-example', 'deleted-example']));

    const [olderFile, newerFile] = await Promise.all([older, newer]);

    // Nothing for the renderer to apply from the superseded read.
    expect(olderFile).toBeUndefined();
    expect(newerFile.data.examples.map((e) => e.name)).toEqual(['kept-example']);

    const finals = win.sent.filter((e) => e.payload.loading === false && e.payload.partial === false);
    expect(finals).toHaveLength(1);
    expect(finals[0].payload.data.examples.map((e) => e.name)).toEqual(['kept-example']);
  });

  it('returns the file for a read that nothing overtook', async () => {
    fs.writeFileSync(requestPath, buildBru('user_info', 'z'.repeat(16)), 'utf8');
    const pending = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });
    mockWorkerParses[0].resolve(parsedRequest('user_info', ['kept-example']));
    const file = await pending;

    expect(file.partial).toBe(false);
    expect(file.data.examples.map((e) => e.name)).toEqual(['kept-example']);
  });
});

// parseFileMeta is only cheap for bru. For yml it is a synchronous js-yaml load of
// the WHOLE file on the browser process — the exact freeze the worker above exists
// to remove, put back in the failure path.
describe('renderer:load-request — the yml meta fallback is size bounded', () => {
  let dir;
  let requestPath;

  beforeEach(() => {
    dir = makeTempDir('yml');
    requestPath = path.join(dir, 'user_info.yml');
  });

  afterEach(() => cleanup(dir));

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

    const pending = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));
    const file = await pending;

    expect(yamlLoadedTheWholeFile(content)).toBe(false);
    // Still a visible row, named the way the indexer names an unparseable request.
    expect(file.partial).toBe(true);
    expect(file.data.name).toBe('user_info');
  });

  it('still runs the meta parse for a file below the bound', async () => {
    const content = buildYml(64 * 1024);
    fs.writeFileSync(requestPath, content, 'utf8');

    const pending = loadRequest({}, { collectionUid: COLLECTION_UID, pathname: requestPath });
    mockWorkerParses[0].reject(new Error('Unexpected token at line 4'));
    await pending;

    expect(yamlLoadedTheWholeFile(content)).toBe(true);
  });
});
