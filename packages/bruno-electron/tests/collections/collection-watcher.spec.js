// The watcher pulls in electron (dialog) and electron-store transitively; neither
// is exercised by the handlers under test, so stubs are enough.
jest.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'gridman', getVersion: () => '0.0.0' },
  dialog: {},
  ipcMain: { handle: jest.fn(), on: jest.fn(), emit: jest.fn() },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}));

// One shared bag so every `new Store(...)` in the process sees the same data,
// the way electron-store behaves for a given store name. The watcher builds its
// EnvironmentSecretsStore at module load, so the test has to be able to seed it
// through a second instance.
const memoryStores = {};
jest.mock('electron-store', () => {
  return class MemoryStore {
    constructor(opts = {}) {
      const name = opts.name || 'config';
      memoryStores[name] = memoryStores[name] || {};
      this.data = memoryStores[name];
    }

    get(key, defaultValue) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], this.data);
      return value === undefined ? defaultValue : value;
    }

    set(key, value) {
      const parts = key.split('.');
      let node = this.data;
      for (const part of parts.slice(0, -1)) {
        node[part] = node[part] || {};
        node = node[part];
      }
      node[parts.at(-1)] = value;
    }

    delete(key) {
      delete this.data[key];
    }
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const EnvironmentSecretsStore = require('../../src/store/env-secrets');
const collectionWatcher = require('../../src/app/collection-watcher');

const { addEnvironmentFile, changeEnvironmentFile, add, change } = collectionWatcher.__handlers;

const COLLECTION_UID = 'collection-uid';

// The watcher built its own EnvironmentSecretsStore at module load and is holding
// on to that bag object, so the reset has to empty it in place rather than swap it.
const resetMemoryStores = () => {
  Object.values(memoryStores).forEach((bag) => {
    Object.keys(bag).forEach((key) => delete bag[key]);
  });
};

const makeWin = () => {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (channel, type, payload) => sent.push({ channel, type, payload })
    }
  };
};

// The watcher only calls these two on the request paths.
const makeWatcherStub = () => ({
  addFileToProcessing: jest.fn(),
  markFileAsProcessed: jest.fn()
});

// NOT a `gridman-` prefix: hydrateRequestWithUuid flags anything under
// `<tmpdir>/gridman-` as a transient scratch request, which would silently send
// every item this spec emits down the transient path instead of the real one.
const makeYmlCollection = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bruno-watcher-${label}-`));
  fs.writeFileSync(
    path.join(dir, 'opencollection.yml'),
    ['opencollection: 1.0.0', 'info:', '  name: Test Collection', '  type: collection', ''].join('\n'),
    'utf8'
  );
  return dir;
};

const cleanup = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {}
};

describe('collection watcher — environment secret hydration', () => {
  let collectionPath;

  beforeEach(() => {
    resetMemoryStores();
    collectionPath = makeYmlCollection('env');
    fs.mkdirSync(path.join(collectionPath, 'environments'));
  });

  afterEach(() => cleanup(collectionPath));

  // A plain variable and a secret can legitimately share a name (they live on
  // separate tabs in the UI). Hydration used to match on name alone, so the
  // decrypted secret landed on whichever row came first.
  // upstream bruno #8679 (ef19c6995)
  const ENV_YML = [
    'name: Local',
    'variables:',
    '  - name: token',
    '    value: plain-not-a-secret',
    '  - name: token',
    '    secret: true',
    ''
  ].join('\n');

  const seedSecret = () => {
    const store = new EnvironmentSecretsStore();
    store.storeEnvSecrets(collectionPath, {
      name: 'Local',
      variables: [{ name: 'token', value: 'super-secret-value', secret: true }]
    });
  };

  const writeEnvFile = () => {
    const envPath = path.join(collectionPath, 'environments', 'Local.yml');
    fs.writeFileSync(envPath, ENV_YML, 'utf8');
    return envPath;
  };

  const getVariables = (win) => {
    const event = win.sent.find((e) => e.type === 'addEnvironmentFile');
    expect(event).toBeDefined();
    return event.payload.data.variables;
  };

  it('addEnvironmentFile puts the decrypted secret on the secret row, not the plain one', async () => {
    seedSecret();
    const envPath = writeEnvFile();
    const win = makeWin();

    await addEnvironmentFile(win, envPath, COLLECTION_UID, collectionPath);

    const variables = getVariables(win);
    const plain = variables.find((v) => v.name === 'token' && !v.secret);
    const secret = variables.find((v) => v.name === 'token' && v.secret);

    expect(plain.value).toBe('plain-not-a-secret');
    expect(secret.value).toBe('super-secret-value');
  });

  it('changeEnvironmentFile puts the decrypted secret on the secret row, not the plain one', async () => {
    seedSecret();
    const envPath = writeEnvFile();
    const win = makeWin();

    await changeEnvironmentFile(win, envPath, COLLECTION_UID, collectionPath);

    const variables = getVariables(win);
    const plain = variables.find((v) => v.name === 'token' && !v.secret);
    const secret = variables.find((v) => v.name === 'token' && v.secret);

    expect(plain.value).toBe('plain-not-a-secret');
    expect(secret.value).toBe('super-secret-value');
  });

  it('still hydrates a secret when no plain variable shares its name', async () => {
    seedSecret();
    const envPath = path.join(collectionPath, 'environments', 'Local.yml');
    fs.writeFileSync(envPath, ['name: Local', 'variables:', '  - name: token', '    secret: true', ''].join('\n'), 'utf8');
    const win = makeWin();

    await addEnvironmentFile(win, envPath, COLLECTION_UID, collectionPath);

    const variables = getVariables(win);
    expect(variables).toHaveLength(1);
    expect(variables[0].value).toBe('super-secret-value');
  });
});

describe('collection watcher — unparseable request files stay visible', () => {
  let collectionPath;

  beforeEach(() => {
    resetMemoryStores();
    collectionPath = makeYmlCollection('parse');
  });

  afterEach(() => cleanup(collectionPath));

  // What a git merge leaves behind when the customer resolves conflicts in-app.
  const CONFLICTED_YML = [
    '<<<<<<< HEAD',
    'name: user_info',
    'type: http',
    '=======',
    'name: user info',
    'type: http',
    '>>>>>>> origin/main',
    ''
  ].join('\n');

  const VALID_YML = ['name: user_info', 'type: http', 'seq: 1', 'url: https://example.com', 'method: GET', ''].join('\n');

  const writeRequest = (contents) => {
    const requestPath = path.join(collectionPath, 'user_info.yml');
    fs.writeFileSync(requestPath, contents, 'utf8');
    return requestPath;
  };

  // The change branch is the one that bites in practice: the file mounted fine at
  // startup and only breaks later, when a pull/merge writes conflict markers into
  // it. Logging and emitting nothing made the request disappear from the sidebar
  // with nothing left to click on. upstream bruno #8545 (81f9a4092)
  it('change emits a partial item instead of dropping the file', async () => {
    const requestPath = writeRequest(CONFLICTED_YML);
    const win = makeWin();

    await change(win, requestPath, COLLECTION_UID, collectionPath);

    const event = win.sent.find((e) => e.type === 'change');
    expect(event).toBeDefined();
    expect(event.payload.partial).toBe(true);
    expect(event.payload.loading).toBe(false);
    expect(event.payload.error?.message).toBeTruthy();
    expect(event.payload.data.type).toBe('http-request');
    expect(typeof event.payload.size).toBe('number');
    // The spec collection lives outside the transient scratch directory.
    expect(event.payload.data.isTransient).toBe(false);
  });

  // The sidebar renders from the collection index, so the partial payload's name
  // is painted onto the row. Carrying the extension renamed "user_info" to
  // "user_info.yml" the moment a merge broke the file.
  it('the partial payload names the item without its extension', async () => {
    const requestPath = writeRequest(CONFLICTED_YML);
    const win = makeWin();

    await change(win, requestPath, COLLECTION_UID, collectionPath);

    const event = win.sent.find((e) => e.type === 'change');
    expect(event.payload.data.name).toBe('user_info');
    expect(event.payload.meta.name).toBe('user_info.yml');
  });

  // A read/stat failure is chokidar racing an atomic-replace save (ENOENT) or a
  // Windows AV lock (EPERM/EBUSY) — the file is fine, we just could not look at it.
  // Emitting a partial item here would repaint a healthy row as broken.
  it('change stays silent when the file cannot be read', async () => {
    const missingPath = path.join(collectionPath, 'vanished.yml');
    const win = makeWin();

    await change(win, missingPath, COLLECTION_UID, collectionPath);

    expect(win.sent).toHaveLength(0);
  });

  it('change clears the partial flags once the file parses again', async () => {
    const requestPath = writeRequest(VALID_YML);
    const win = makeWin();

    await change(win, requestPath, COLLECTION_UID, collectionPath);

    const event = win.sent.find((e) => e.type === 'change');
    expect(event).toBeDefined();
    expect(event.payload.partial).toBe(false);
    expect(event.payload.loading).toBe(false);
    expect(event.payload.error).toBeUndefined();
  });

  it('the non-worker add branch also emits a partial item', async () => {
    const requestPath = writeRequest(CONFLICTED_YML);
    const win = makeWin();
    const watcherStub = makeWatcherStub();

    await add(win, requestPath, COLLECTION_UID, collectionPath, false, watcherStub);

    const event = win.sent.find((e) => e.type === 'addFile');
    expect(event).toBeDefined();
    expect(event.payload.partial).toBe(true);
    expect(event.payload.loading).toBe(false);
    expect(event.payload.error?.message).toBeTruthy();
    expect(event.payload.data.name).toBe('user_info');
    expect(watcherStub.markFileAsProcessed).toHaveBeenCalled();
  });
});
