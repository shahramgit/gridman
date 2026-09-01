// Exercises utils/collection-migration.js end to end against real fixtures on a
// real temp filesystem: no filesystem mock, no injected trash, no injected
// converter. What the migration writes is read back off disk and re-parsed here,
// and the "originals moved to Trash" claim is checked by reading the trash entry
// meta.json and payload that app-trash actually wrote.

const os = require('os');
const path = require('path');
const fs = require('fs');

// app-trash writes under app.getPath('userData'), so the whole suite gets its own
// userData directory and asserts against what really lands in it. The `mock`
// prefix is what lets jest.mock's factory close over it.
const mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-migration-userdata-'));
const USER_DATA_DIR = mockUserDataDir;

jest.mock('electron', () => ({
  app: {
    getPath: (name) => (name === 'userData' ? mockUserDataDir : require('os').tmpdir()),
    getName: () => 'gridman',
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  dialog: {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: () => {}, on: () => {}, emit: () => {} }
}));

// The filestore worker pool has no exported shutdown, so a single call leaves a
// live worker thread behind and jest never exits. Nothing in this file is about
// threading — the migration's use of the worker lane is a performance property,
// not a correctness one — so both worker entry points are routed to the
// identical synchronous parser/serializer. The worker path itself is covered by
// request-parse-ordering.spec.js.
// collection-migration.js does `const { moveToAppTrash } = require('./app-trash')`
// at module load, so the reference is captured before any spy can replace it —
// jest.spyOn on the module object does nothing. Mock the module itself and let
// one test opt a single path into failing.
let mockTrashFailureFor = null;
jest.mock('../../src/utils/app-trash', () => {
  const actual = jest.requireActual('../../src/utils/app-trash');
  return {
    ...actual,
    moveToAppTrash: async (pathname, options) => {
      if (mockTrashFailureFor && require('path').resolve(pathname) === require('path').resolve(mockTrashFailureFor)) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return actual.moveToAppTrash(pathname, options);
    }
  };
});

jest.mock('@usebruno/filestore', () => {
  const actual = jest.requireActual('@usebruno/filestore');
  return {
    ...actual,
    parseRequestViaWorker: async (content, options) => actual.parseRequest(content, { format: options?.format }),
    stringifyRequestViaWorker: async (request, options) => actual.stringifyRequest(request, { format: options?.format })
  };
});

const { parseRequest, parseFolder, parseEnvironment, parseCollection } = require('@usebruno/filestore');
const {
  compareSemantic,
  normalizeForComparison,
  planCollectionYmlMigration,
  convertEntryToYml,
  verifyConvertedEntry,
  migrateCollectionToYml
} = require('../../src/utils/collection-migration');

// --- fixtures ---------------------------------------------------------------

// NFC: a single pre-composed sequence. The workspace this ships for is full of
// Persian names in both normalizations, and they must survive verbatim.
const PERSIAN_FOLDER = 'پوشهٔ فارسی';
const PERSIAN_REQUEST = 'درخواست کاربران';

const BRUNO_JSON = {
  version: '1',
  name: 'GSB Sample',
  type: 'collection',
  ignore: ['node_modules', '.git'],
  presets: {
    requestType: 'http',
    requestUrl: 'https://api.example.test'
  },
  proxy: {
    inherit: false,
    config: {
      protocol: 'http',
      hostname: 'proxy.internal',
      port: '8080',
      auth: { username: 'proxyuser', password: 'proxypass' },
      bypassProxy: 'localhost'
    }
  }
};

const COLLECTION_BRU = `headers {
  x-collection: gsb
}

auth {
  mode: none
}

script:pre-request {
  console.log('collection pre-request');
}

docs {
  مستندات مجموعه
}
`;

const FOLDER_BRU = `meta {
  name: ${PERSIAN_FOLDER}
  seq: 2
}

headers {
  x-folder: yes
}

auth {
  mode: none
}

script:pre-request {
  console.log('folder pre-request');
}

docs {
  مستندات پوشه
}
`;

const REQUEST_BRU = `meta {
  name: ${PERSIAN_REQUEST}
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/api/v1/کاربران
  body: json
  auth: bearer
}

headers {
  Content-Type: application/json
  ~X-Disabled: nope
}

auth:bearer {
  token: {{token}}
}

body:json {
  {
    "name": "علی"
  }
}

script:pre-request {
  console.log("pre");
}

tests {
  test("ok", function() {
    expect(res.getStatus()).to.equal(200);
  });
}

vars:pre-request {
  foo: bar
}

assert {
  res.status: 200
  res.body.total: gt 5
}

docs {
  مستندات درخواست
}
`;

// A request carrying saved response examples — the thing this product sells and
// the thing upstream's unlink-everything migration would silently mangle.
const REQUEST_WITH_EXAMPLES_BRU = `meta {
  name: With Examples
  type: http
  seq: 2
}

get {
  url: https://api.example.test/items
  body: none
  auth: none
}

example {
  name: نمونهٔ موفق
  description: پاسخ نمونه

  request: {
    url: https://api.example.test/items?page=1
    method: get
    mode: none
    headers: {
      accept: "application/json"
    }
  }

  response: {
    status: {
      code: 200
      text: OK
    }

    body: {
      type: json
      content: '''
        {
          "items": [
            { "id": 1, "name": "یک" }
          ]
        }
      '''
    }
  }
}

example {
  name: Not Found

  request: {
    url: https://api.example.test/items/999
    method: get
    mode: none
  }

  response: {
    status: {
      code: 404
      text: Not Found
    }

    body: {
      type: text
      content: '''
        missing
      '''
    }
  }
}
`;

const ENVIRONMENT_BRU = `vars {
  baseUrl: https://api.example.test
  ~unused: nope
}

vars:secret [
  token
]
`;

// The evidence-backed failure case. The .bru parser keeps an `auth:basic` block
// even when the active mode is something else (Bruno's UI keeps those
// credentials around when you switch modes); the yml writer only ever writes the
// ACTIVE mode, so the stored username/password are dropped. Verified against the
// repo's own fixture corpus: 13 of 442 real .bru files hit exactly this.
const REQUEST_THAT_LOSES_DATA_BRU = `meta {
  name: Inactive Basic Auth
  type: http
  seq: 3
}

get {
  url: https://api.example.test/keep-me
  body: none
  auth: none
}

auth:basic {
  username: bruno
  password: do-not-lose-me
}
`;

// A request written by a NEWER Bruno: `app` is a block this version's .bru
// parser keeps verbatim (unknownBlocks) so a .bru round trip preserves it. The
// yml writer has no such escape hatch, so converting deletes it.
const REQUEST_WITH_UNKNOWN_BLOCK_BRU = `meta {
  name: From A Newer Bruno
  type: http
  seq: 4
}

get {
  url: https://api.example.test/newer
  body: none
  auth: none
}

app {
  enabled: true
  code: '''
    <div>hello</div>
  '''
}
`;

// --- helpers ----------------------------------------------------------------

const writeFixture = (root, relativePath, content) => {
  const pathname = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, content, 'utf8');
  return pathname;
};

// Symlinks are listed as themselves and never followed: some of these fixtures
// link to a DIRECTORY, and descending into it (or reading it as a file) would
// blow up rather than record what the tree looks like.
const listFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const pathname = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(pathname);
      } else {
        out.push(path.relative(root, pathname));
      }
    }
  };
  walk(root);
  return out.sort();
};

const snapshotTree = (root) => {
  const snapshot = {};
  for (const relativePath of listFiles(root)) {
    const pathname = path.join(root, relativePath);
    snapshot[relativePath] = fs.lstatSync(pathname).isSymbolicLink()
      ? `symlink -> ${fs.readlinkSync(pathname)}`
      : fs.readFileSync(pathname, 'utf8');
  }
  return snapshot;
};

// Scoped to one collection: every test gets its own temp collection, and they
// all share one userData/trash, so an unfiltered read would see other tests'
// entries.
const readTrashEntries = (collectionPathname) => {
  const trashRoot = path.join(USER_DATA_DIR, 'trash');
  if (!fs.existsSync(trashRoot)) {
    return [];
  }
  return fs
    .readdirSync(trashRoot)
    .map((entryId) => {
      const entryDir = path.join(trashRoot, entryId);
      const meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'meta.json'), 'utf8'));
      return {
        ...meta,
        payloadPathname: path.join(entryDir, 'payload', meta.basename)
      };
    })
    .filter((entry) => entry.collectionPathname === collectionPathname);
};

const buildCollection = ({ withFailingFile = false, extraFiles = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-migration-'));

  writeFixture(root, 'bruno.json', JSON.stringify(BRUNO_JSON, null, 2));
  writeFixture(root, 'collection.bru', COLLECTION_BRU);
  writeFixture(root, path.join(PERSIAN_FOLDER, 'folder.bru'), FOLDER_BRU);
  writeFixture(root, path.join(PERSIAN_FOLDER, `${PERSIAN_REQUEST}.bru`), REQUEST_BRU);
  writeFixture(root, 'with-examples.bru', REQUEST_WITH_EXAMPLES_BRU);
  writeFixture(root, path.join('environments', 'محیط تست.bru'), ENVIRONMENT_BRU);

  if (withFailingFile) {
    writeFixture(root, path.join(PERSIAN_FOLDER, 'zz-inactive-basic-auth.bru'), REQUEST_THAT_LOSES_DATA_BRU);
  }

  for (const [relativePath, content] of Object.entries(extraFiles)) {
    writeFixture(root, relativePath, content);
  }

  return root;
};

describe('collection .bru -> .yml migration', () => {
  const createdRoots = [];

  const collection = (options) => {
    const root = buildCollection(options);
    createdRoots.push(root);
    return root;
  };

  afterAll(() => {
    for (const root of createdRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  });

  describe('semantic comparison', () => {
    it('accepts values the yml format spells out but bru leaves implicit', () => {
      expect(compareSemantic({ settings: {} }, { settings: { encodeUrl: true, timeout: 0, maxRedirects: 5 } })).toEqual([]);
      expect(compareSemantic({ request: {} }, { request: { auth: { mode: 'none' } } })).toEqual([]);
      expect(compareSemantic({ docs: '' }, { docs: null })).toEqual([]);
      expect(compareSemantic({ request: { headers: [] } }, {})).toEqual([]);
      // Regenerated ids are not content.
      expect(compareSemantic({ uid: 'a', name: 'x' }, { uid: 'b', name: 'x' })).toEqual([]);
      // `200` and `eq 200` are the same assertion (bruno-js defaults to `eq`).
      expect(
        compareSemantic(
          { request: { assertions: [{ name: 'res.status', value: '200' }] } },
          { request: { assertions: [{ name: 'res.status', value: 'eq 200' }] } }
        )
      ).toEqual([]);
      // toOpenCollectionScripts trims code before writing it.
      expect(compareSemantic({ request: { tests: 'expect(1).to.eql(1);\n' } }, { request: { tests: 'expect(1).to.eql(1);' } }))
        .toEqual([]);
    });

    // Without these the tolerances above would be a hole big enough to drive the
    // whole migration through: they are what stops "normalize until equal".
    it('still reports a real change at each tolerated path', () => {
      // a NON-default settings value is compared, not waved through
      // (`name` is only here so the whole comparison does not collapse to the
      // root path once the default-valued side empties out)
      expect(compareSemantic({ name: 'x', settings: { timeout: 30 } }, { name: 'x', settings: { timeout: 0 } })).toEqual([
        { path: 'settings', expected: '{"timeout":30}', actual: 'absent' }
      ]);
      expect(compareSemantic({ name: 'x', settings: { timeout: 0 } }, { name: 'x', settings: { timeout: 30 } })).toEqual([
        { path: 'settings', expected: 'absent', actual: '{"timeout":30}' }
      ]);
      // a non-default value on both sides is compared value-to-value
      expect(compareSemantic({ settings: { timeout: 30 } }, { settings: { timeout: 45 } })).toEqual([
        { path: 'settings.timeout', expected: '30', actual: '45' }
      ]);
      // 'none' and 'inherit' do not mean the same thing, in either direction
      expect(
        compareSemantic({ name: 'x', request: { auth: { mode: 'inherit' } } }, { name: 'x', request: { auth: { mode: 'none' } } })
      ).toEqual([{ path: 'request', expected: '{"auth":{"mode":"inherit"}}', actual: 'absent' }]);
      expect(
        compareSemantic({ name: 'x', request: { auth: { mode: 'none' } } }, { name: 'x', request: { auth: { mode: 'inherit' } } })
      ).toEqual([{ path: 'request', expected: 'absent', actual: '{"auth":{"mode":"inherit"}}' }]);
      // and an inactive auth block sitting next to mode "none" is still content
      expect(
        compareSemantic(
          { name: 'x', request: { auth: { mode: 'none', basic: { username: 'u', password: 'p' } } } },
          { name: 'x', request: { auth: { mode: 'none' } } }
        )
      ).toEqual([{ path: 'request', expected: '{"auth":{"basic":{"password":"p","username":"u"}}}', actual: 'absent' }]);
      // only a leading `eq ` is equated, never another operator
      expect(
        compareSemantic(
          { request: { assertions: [{ name: 'res.status', value: 'gt 200' }] } },
          { request: { assertions: [{ name: 'res.status', value: 'eq 200' }] } }
        )
      ).toEqual([{ path: 'request.assertions[0].value', expected: 'gt 200', actual: '200' }]);
      // trimming is trailing whitespace only, not a rewrite of the code
      expect(compareSemantic({ request: { tests: 'a();\nb();' } }, { request: { tests: 'a();' } })).toHaveLength(1);
      // a dropped list entry is a length change, not something a containment
      // check would let through
      expect(
        compareSemantic(
          { request: { headers: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] } },
          { request: { headers: [{ name: 'a', value: '1' }] } }
        )
      ).toEqual([{ path: 'request.headers', expected: '2 entries', actual: '1 entries' }]);
      // ...and so is an invented one
      expect(
        compareSemantic(
          { request: { headers: [{ name: 'a', value: '1' }] } },
          { request: { headers: [{ name: 'a', value: '1' }, { name: 'x', value: 'y' }] } }
        )
      ).toEqual([{ path: 'request.headers', expected: '1 entries', actual: '2 entries' }]);
      // a changed value anywhere
      expect(compareSemantic({ request: { url: 'https://a' } }, { request: { url: 'https://b' } })).toEqual([
        { path: 'request.url', expected: 'https://a', actual: 'https://b' }
      ]);
    });

    it('keeps Persian text intact through normalization', () => {
      expect(normalizeForComparison({ name: PERSIAN_REQUEST })).toEqual({ name: PERSIAN_REQUEST });
      expect(compareSemantic({ name: PERSIAN_REQUEST }, { name: PERSIAN_REQUEST })).toEqual([]);
      // NFC and NFD are different bytes and must not compare equal
      // U+06C0 (heh with hamza above) is the Persian character that actually has
      // two normalizations, and macOS and Windows disagree about which one ends
      // up in a filename. The comparator must not quietly equate them.
      const nfc = 'صفحۀ'.normalize('NFC');
      const nfd = 'صفحۀ'.normalize('NFD');
      expect(nfc).not.toBe(nfd);
      expect(compareSemantic({ name: nfc }, { name: nfd })).toHaveLength(1);
    });
  });

  describe('planning', () => {
    it('classifies every .bru file in the collection', () => {
      const root = collection();
      const plan = planCollectionYmlMigration(root);

      const byKind = plan.entries.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] || []).concat(entry.relativePath);
        return acc;
      }, {});

      expect(byKind.request.sort()).toEqual(
        ['with-examples.bru', path.join(PERSIAN_FOLDER, `${PERSIAN_REQUEST}.bru`)].sort()
      );
      expect(byKind.folder).toEqual([path.join(PERSIAN_FOLDER, 'folder.bru')]);
      expect(byKind.environment).toEqual([path.join('environments', 'محیط تست.bru')]);
      expect(plan.collectionRootPathname).toBe(path.join(root, 'collection.bru'));
      expect(plan.blockers).toEqual([]);
    });

    it('refuses a collection that is already yml', () => {
      const root = collection();
      fs.writeFileSync(path.join(root, 'opencollection.yml'), 'opencollection: 1.0.0\n');
      expect(() => planCollectionYmlMigration(root)).toThrow(/already in the .yml/);
    });
  });

  describe('a clean migration', () => {
    let root;
    let result;

    beforeAll(async () => {
      root = buildCollection();
      createdRoots.push(root);
      result = await migrateCollectionToYml({ collectionPathname: root });
    });

    it('reports success for every file plus the collection root', () => {
      expect(result.status).toBe('migrated');
      expect(result.converted).toBe(5);
      expect(result.notTrashed).toEqual([]);
    });

    it('leaves a pure yml tree on disk', () => {
      const files = listFiles(root);
      expect(files.filter((file) => file.endsWith('.bru'))).toEqual([]);
      expect(files).toContain('opencollection.yml');
      expect(files).not.toContain('bruno.json');
      expect(files).toContain('with-examples.yml');
      expect(files).toContain(path.join(PERSIAN_FOLDER, 'folder.yml'));
      expect(files).toContain(path.join(PERSIAN_FOLDER, `${PERSIAN_REQUEST}.yml`));
      expect(files).toContain(path.join('environments', 'محیط تست.yml'));
    });

    it('preserves the request content, Persian names included', () => {
      const parsed = parseRequest(
        fs.readFileSync(path.join(root, PERSIAN_FOLDER, `${PERSIAN_REQUEST}.yml`), 'utf8'),
        { format: 'yml' }
      );

      expect(parsed.name).toBe(PERSIAN_REQUEST);
      expect(parsed.seq).toBe(1);
      expect(parsed.request.url).toBe('{{baseUrl}}/api/v1/کاربران');
      expect(parsed.request.method).toBe('POST');
      expect(parsed.request.body.json).toContain('علی');
      expect(parsed.request.auth.mode).toBe('bearer');
      expect(parsed.request.auth.bearer.token).toBe('{{token}}');
      expect(parsed.request.headers.find((h) => h.name === 'X-Disabled').enabled).toBe(false);
      expect(parsed.request.vars.req[0]).toMatchObject({ name: 'foo', value: 'bar' });
      expect(parsed.request.docs).toBe('مستندات درخواست');
    });

    it('preserves saved response examples', () => {
      const parsed = parseRequest(fs.readFileSync(path.join(root, 'with-examples.yml'), 'utf8'), { format: 'yml' });

      expect(parsed.examples).toHaveLength(2);
      expect(parsed.examples[0].name).toBe('نمونهٔ موفق');
      expect(parsed.examples[0].response.status).toBe(200);
      expect(parsed.examples[0].response.body.content).toContain('"name": "یک"');
      expect(parsed.examples[1].name).toBe('Not Found');
      expect(parsed.examples[1].response.status).toBe(404);
    });

    it('preserves the folder root and the environment', () => {
      const folder = parseFolder(fs.readFileSync(path.join(root, PERSIAN_FOLDER, 'folder.yml'), 'utf8'), { format: 'yml' });
      expect(folder.meta.name).toBe(PERSIAN_FOLDER);
      expect(folder.meta.seq).toBe(2);
      expect(folder.request.headers[0]).toMatchObject({ name: 'x-folder', value: 'yes' });
      expect(folder.docs).toBe('مستندات پوشه');

      const environment = parseEnvironment(
        fs.readFileSync(path.join(root, 'environments', 'محیط تست.yml'), 'utf8'),
        { format: 'yml' }
      );
      expect(environment.variables.find((v) => v.name === 'baseUrl').value).toBe('https://api.example.test');
      expect(environment.variables.find((v) => v.name === 'unused').enabled).toBe(false);
      expect(environment.variables.find((v) => v.name === 'token').secret).toBe(true);
    });

    it('carries bruno.json config and the collection root into opencollection.yml', () => {
      const parsed = parseCollection(fs.readFileSync(path.join(root, 'opencollection.yml'), 'utf8'), { format: 'yml' });

      expect(parsed.brunoConfig.name).toBe(BRUNO_JSON.name);
      expect(parsed.brunoConfig.ignore).toEqual(BRUNO_JSON.ignore);
      expect(parsed.brunoConfig.presets).toEqual({ requestType: 'http', requestUrl: 'https://api.example.test' });
      expect(parsed.brunoConfig.proxy).toEqual(BRUNO_JSON.proxy);
      expect(parsed.collectionRoot.request.headers[0]).toMatchObject({ name: 'x-collection', value: 'gsb' });
      expect(parsed.collectionRoot.docs).toBe('مستندات مجموعه');
    });

    it('moves every original into the app Trash, restorable, rather than deleting it', () => {
      const entries = readTrashEntries(root);
      const originals = entries.map((entry) => entry.originalPathname).sort();

      expect(originals).toEqual(
        [
          path.join(root, 'bruno.json'),
          path.join(root, 'collection.bru'),
          path.join(root, 'with-examples.bru'),
          path.join(root, PERSIAN_FOLDER, 'folder.bru'),
          path.join(root, PERSIAN_FOLDER, `${PERSIAN_REQUEST}.bru`),
          path.join(root, 'environments', 'محیط تست.bru')
        ].sort()
      );

      for (const entry of entries) {
        expect(fs.existsSync(entry.payloadPathname)).toBe(true);
        expect(entry.collectionPathname).toBe(root);
      }

      // the payload really is the user's original file, byte for byte
      const requestEntry = entries.find((entry) => entry.basename === `${PERSIAN_REQUEST}.bru`);
      expect(fs.readFileSync(requestEntry.payloadPathname, 'utf8')).toBe(REQUEST_BRU);
      expect(requestEntry.type).toBe('request');
      expect(entries.find((entry) => entry.basename === 'folder.bru').type).toBe('folder');
      expect(entries.find((entry) => entry.basename === 'محیط تست.bru').type).toBe('environment');
    });
  });

  describe('a file that does not survive conversion', () => {
    it('aborts and leaves the collection byte-for-byte untouched', async () => {
      const root = collection({ withFailingFile: true });
      const before = snapshotTree(root);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      expect(result.failedRelativePath).toBe(path.join(PERSIAN_FOLDER, 'zz-inactive-basic-auth.bru'));
      // it names what would have been lost
      expect(result.differences.some((difference) => difference.expected.includes('do-not-lose-me'))).toBe(true);
      expect(result.reason).toContain('zz-inactive-basic-auth.bru');

      // nothing written, nothing removed, nothing trashed
      expect(snapshotTree(root)).toEqual(before);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(readTrashEntries(root)).toEqual([]);
    });

    it('removes the .yml files it had already written before the failure', async () => {
      const root = collection({ withFailingFile: true });
      // The failing file sorts last inside the Persian folder, so several files
      // are converted (and their .yml written) before the abort — this is the
      // rollback, not a lucky "nothing had happened yet".
      const plan = planCollectionYmlMigration(root);
      const failingIndex = plan.entries.findIndex((entry) => entry.relativePath.includes('zz-inactive-basic-auth'));
      expect(failingIndex).toBeGreaterThan(0);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      for (const entry of plan.entries) {
        expect(fs.existsSync(entry.targetPathname)).toBe(false);
        expect(fs.existsSync(entry.sourcePathname)).toBe(true);
      }
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'bruno.json'))).toBe(true);
    });

    it('aborts when bruno.json holds config opencollection.yml cannot carry', async () => {
      const root = collection();
      // `scripts.flow` decides whether pre-request scripts run sandwich or
      // sequential (prepare-request.js reads brunoConfig.scripts.flow), and
      // stringifyYmlCollection only carries scripts.additionalContextRoots — so
      // migrating would quietly change how every script in the collection runs.
      const brunoConfigPathname = path.join(root, 'bruno.json');
      fs.writeFileSync(
        brunoConfigPathname,
        JSON.stringify({ ...BRUNO_JSON, scripts: { flow: 'sequential' } }, null, 2),
        'utf8'
      );
      const before = snapshotTree(root);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      expect(result.failedRelativePath).toBe('collection.bru');
      expect(result.differences.some((difference) => difference.path.startsWith('brunoConfig.scripts'))).toBe(true);
      expect(snapshotTree(root)).toEqual(before);
      expect(readTrashEntries(root)).toEqual([]);
    });

    it('refuses to convert a symlinked .bru rather than leaving it behind', async () => {
      const root = collection();
      const outside = path.join(os.tmpdir(), `gridman-migration-outside-${Date.now()}.bru`);
      fs.writeFileSync(outside, REQUEST_BRU, 'utf8');
      fs.symlinkSync(outside, path.join(root, 'linked.bru'));
      const before = snapshotTree(root);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      expect(result.blockers.map((blocker) => blocker.pathname)).toEqual([path.join(root, 'linked.bru')]);
      expect(snapshotTree(root)).toEqual(before);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(readTrashEntries(root)).toEqual([]);

      fs.rmSync(outside, { force: true });
    });

    // A Dirent for a symlinked directory answers false to BOTH isDirectory()
    // and isFile(), and its name does not end in .bru — so a walk that only
    // asks those two questions skips it in complete silence: no descent, no
    // blocker, no mention. The requests behind it are never converted, and
    // writing opencollection.yml then makes them invisible to the app. The run
    // would report a clean migration over requests it had just orphaned.
    it('refuses a collection whose requests live behind a symlinked directory', async () => {
      const root = collection();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-migration-linked-'));
      fs.writeFileSync(path.join(outsideDir, 'behind-the-link.bru'), REQUEST_BRU, 'utf8');
      fs.symlinkSync(outsideDir, path.join(root, 'linked-folder'));
      const before = snapshotTree(root);

      // the plan names the link instead of quietly leaving its requests out
      const plan = planCollectionYmlMigration(root);
      expect(plan.blockers.map((blocker) => blocker.pathname)).toEqual([path.join(root, 'linked-folder')]);
      expect(plan.entries.some((entry) => entry.relativePath.includes('behind-the-link'))).toBe(false);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      expect(result.reason).toContain('linked-folder');
      // nothing converted, and above all no opencollection.yml: the format flip
      // is what would have orphaned the request behind the link
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(false);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(snapshotTree(root)).toEqual(before);
      expect(readTrashEntries(root)).toEqual([]);
      expect(fs.readFileSync(path.join(outsideDir, 'behind-the-link.bru'), 'utf8')).toBe(REQUEST_BRU);

      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    // The refusal is scoped to links that could be hiding requests: a link to
    // an ordinary file is never converted, never moved, and is as valid after
    // the format flip as before it. Refusing over a linked .env would make the
    // feature unusable on collections that convert perfectly well.
    it('migrates a collection that only links to a file it would never convert', async () => {
      const root = collection();
      const outside = path.join(os.tmpdir(), `gridman-migration-shared-env-${Date.now()}`);
      fs.writeFileSync(outside, 'SHARED=1\n', 'utf8');
      fs.symlinkSync(outside, path.join(root, '.env'));

      const plan = planCollectionYmlMigration(root);
      expect(plan.blockers).toEqual([]);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('migrated');
      expect(listFiles(root).filter((file) => file.endsWith('.bru'))).toEqual([]);
      // the link is still a link, still pointing at the same file
      expect(fs.readlinkSync(path.join(root, '.env'))).toBe(outside);
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('SHARED=1\n');

      fs.rmSync(outside, { force: true });
    });

    // The .bru parser keeps blocks written by a newer Bruno verbatim so a .bru
    // round trip preserves them; the yml writer drops them. Converting is
    // therefore a silent data loss, and this refusal is the only thing standing
    // in front of it.
    it('refuses a request carrying blocks this version does not understand', async () => {
      const root = collection({ extraFiles: { 'zz-from-a-newer-bruno.bru': REQUEST_WITH_UNKNOWN_BLOCK_BRU } });
      // it really is a block this parser keeps rather than one it understands
      const parsed = parseRequest(REQUEST_WITH_UNKNOWN_BLOCK_BRU, { format: 'bru' });
      expect(parsed.unknownBlocks.map((block) => block.name)).toContain('app');
      const before = snapshotTree(root);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      expect(result.reason).toContain('zz-from-a-newer-bruno.bru');
      expect(result.reason).toMatch(/does not understand/i);
      expect(result.reason).toContain('app');
      // and the refusal rolls the run back: nothing written, nothing trashed
      expect(snapshotTree(root)).toEqual(before);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(readTrashEntries(root)).toEqual([]);
    });

    it('refuses to overwrite a .yml file that is already there', async () => {
      const root = collection({ extraFiles: { 'with-examples.yml': 'info:\n  name: mine\n' } });
      const before = snapshotTree(root);

      const result = await migrateCollectionToYml({ collectionPathname: root });

      expect(result.status).toBe('aborted');
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].reason).toContain('with-examples.yml');
      expect(snapshotTree(root)).toEqual(before);
      expect(readTrashEntries(root)).toEqual([]);
    });
  });

  describe('an original that cannot be moved to Trash', () => {
    // The commit is the point of no return: once ANY original has moved, the
    // .yml files are the only copies in the tree. A later failure must leave
    // them alone and report — never "clean up" by rolling them back.
    it('keeps every converted file and reports the ones left on disk', async () => {
      const root = collection();
      const environmentsDir = path.join(root, 'environments');
      const environmentBru = path.join(environmentsDir, 'محیط تست.bru');

      // A read-only directory is what a Windows lock or a restricted share looks
      // like from here: the file is readable, but it cannot be moved out. It has
      // to become read-only only once the commit starts, or phase 1 would fail
      // writing the .yml into it and abort long before the interesting path —
      // so the real progress callback is used as the timing hook.
      // chmod does not restrict a DIRECTORY on Windows — Node only toggles the
      // read-only attribute, and on files at that — so the original simulation
      // did nothing there and notTrashed came back empty. Refusing the one path
      // at the trash module is the same failure on every platform, and it is
      // the dependency whose failure this test is about.
      mockTrashFailureFor = environmentBru;

      let result;
      try {
        result = await migrateCollectionToYml({ collectionPathname: root });
      } finally {
        mockTrashFailureFor = null;
      }

      expect(result.status).toBe('migrated');
      expect(result.notTrashed.map((entry) => entry.pathname)).toEqual([environmentBru]);

      // the original is still there — nothing of the user's was destroyed
      expect(fs.existsSync(environmentBru)).toBe(true);
      expect(fs.readFileSync(environmentBru, 'utf8')).toBe(ENVIRONMENT_BRU);

      // ...and the converted tree survived intact
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(true);
      expect(fs.existsSync(path.join(environmentsDir, 'محیط تست.yml'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'with-examples.yml'))).toBe(true);
      expect(fs.existsSync(path.join(root, PERSIAN_FOLDER, `${PERSIAN_REQUEST}.yml`))).toBe(true);
    });
  });

  // The plan is taken once, up front. On 11,387 files phase 1 runs for minutes,
  // and the collection is a git-backed directory other tools write to: the app
  // itself saves requests, the collection watcher fires, someone runs git pull.
  // A .bru that is not in the plan is never converted, and writing
  // opencollection.yml turns the whole collection into a yml one — so that file
  // is orphaned exactly like the symlink case, inside a run that reports a
  // clean migration. There is no lock to take, so the tree is re-walked
  // immediately before the commit.
  describe('a collection that changes while it is being converted', () => {
    // shouldCancel is consulted once per entry and is never throttled, which
    // makes it the one deterministic "we are between two files" hook.
    const migrateAndInterfereAfter = (root, entriesConverted, interfere) => {
      let checks = 0;
      let fired = false;
      const promise = migrateCollectionToYml({
        collectionPathname: root,
        shouldCancel: () => {
          if (++checks === entriesConverted + 1) {
            fired = true;
            interfere();
          }
          return false;
        }
      });
      return promise.then((result) => ({ result, fired }));
    };

    it('refuses to flip the format when a .bru appeared after the scan', async () => {
      const root = collection();
      const addedPathname = path.join(root, PERSIAN_FOLDER, 'added-after-the-scan.bru');

      const { result, fired } = await migrateAndInterfereAfter(root, 2, () => {
        fs.writeFileSync(addedPathname, REQUEST_BRU, 'utf8');
      });
      expect(fired).toBe(true);

      expect(result.status).toBe('aborted');
      expect(result.treeChanges).toEqual([
        {
          pathname: addedPathname,
          relativePath: path.join(PERSIAN_FOLDER, 'added-after-the-scan.bru'),
          change: 'added'
        }
      ]);
      expect(result.reason).toContain('added-after-the-scan.bru');

      // the format was NOT flipped, so nothing is orphaned...
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(false);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(fs.existsSync(path.join(root, 'bruno.json'))).toBe(true);
      expect(readTrashEntries(root)).toEqual([]);
      // ...and the new request is still there, in the format the app can read
      expect(fs.readFileSync(addedPathname, 'utf8')).toBe(REQUEST_BRU);
    });

    it('refuses to flip the format when a .bru was edited after it was converted', async () => {
      const root = collection();
      const editedPathname = path.join(root, 'with-examples.bru');
      const editedContent = `${REQUEST_WITH_EXAMPLES_BRU}\ndocs {\n  edited while the migration was running\n}\n`;
      let ymlWasAlreadyWritten = null;

      const { result, fired } = await migrateAndInterfereAfter(root, 2, () => {
        // by now this file's .yml has been written and verified, so the edit
        // makes that .yml stale: committing would move the only copy of the
        // edit into the Trash and leave the pre-edit content in its place.
        ymlWasAlreadyWritten = fs.existsSync(path.join(root, 'with-examples.yml'));
        fs.writeFileSync(editedPathname, editedContent, 'utf8');
      });
      expect(fired).toBe(true);
      expect(ymlWasAlreadyWritten).toBe(true);

      expect(result.status).toBe('aborted');
      expect(result.treeChanges.map((change) => [change.relativePath, change.change])).toEqual([
        ['with-examples.bru', 'modified']
      ]);

      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(false);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(readTrashEntries(root)).toEqual([]);
      // the edit is intact and still the only copy
      expect(fs.readFileSync(editedPathname, 'utf8')).toBe(editedContent);
    });

    it('refuses when a symlink appeared after the scan', async () => {
      const root = collection();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-migration-late-link-'));
      fs.writeFileSync(path.join(outsideDir, 'behind-the-link.bru'), REQUEST_BRU, 'utf8');

      const { result, fired } = await migrateAndInterfereAfter(root, 2, () => {
        fs.symlinkSync(outsideDir, path.join(root, 'late-linked-folder'));
      });
      expect(fired).toBe(true);

      expect(result.status).toBe('aborted');
      expect(result.blockers.map((blocker) => blocker.pathname)).toEqual([path.join(root, 'late-linked-folder')]);
      expect(result.reason).toContain('late-linked-folder');
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(false);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(readTrashEntries(root)).toEqual([]);

      fs.rmSync(path.join(root, 'late-linked-folder'), { force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('still migrates a collection that nothing touched', async () => {
      // The re-scan must not turn every migration into an abort: the same run
      // with no interference at all still commits.
      const root = collection();
      const { result } = await migrateAndInterfereAfter(root, 2, () => {});

      expect(result.status).toBe('migrated');
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(true);
      expect(listFiles(root).filter((file) => file.endsWith('.bru'))).toEqual([]);
    });
  });

  describe('verification', () => {
    // The verification exists to catch a file that did not land the way it was
    // built — a short write, a mangled encoding, a file that never arrived. It
    // can only do that by reading the file back off disk; re-parsing the string
    // it just serialized would verify the migration against itself.
    it('compares against the file on disk, not the string it just built', async () => {
      const root = collection();
      const entry = {
        kind: 'request',
        sourcePathname: path.join(root, 'with-examples.bru'),
        targetPathname: path.join(root, 'with-examples.yml')
      };
      const converted = await convertEntryToYml(entry);
      fs.writeFileSync(entry.targetPathname, converted.content, 'utf8');
      expect(await verifyConvertedEntry(entry, converted)).toEqual([]);

      // Now the FILE holds a different request while `converted.content` is
      // still the perfect conversion. A verification that re-parsed
      // converted.content would call this clean and let the commit trash the
      // original.
      const otherEntry = {
        kind: 'request',
        sourcePathname: path.join(root, PERSIAN_FOLDER, `${PERSIAN_REQUEST}.bru`),
        targetPathname: path.join(root, PERSIAN_FOLDER, `${PERSIAN_REQUEST}.yml`)
      };
      const other = await convertEntryToYml(otherEntry);
      fs.writeFileSync(entry.targetPathname, other.content, 'utf8');

      const differences = await verifyConvertedEntry(entry, converted);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.some((difference) => difference.expected.includes('With Examples'))).toBe(true);
    });
  });

  describe('cancellation', () => {
    it('leaves a consistent tree when cancelled mid-conversion', async () => {
      const root = collection();
      const before = snapshotTree(root);

      // shouldCancel is consulted once per file, so this cancels on the third
      // one — i.e. after two .yml files have already been written and verified.
      // A cancel before any work happened would not exercise the rollback.
      let checks = 0;
      const result = await migrateCollectionToYml({
        collectionPathname: root,
        shouldCancel: () => ++checks > 2
      });
      expect(checks).toBeGreaterThan(2);

      expect(result.status).toBe('cancelled');
      expect(snapshotTree(root)).toEqual(before);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(readTrashEntries(root)).toEqual([]);
    });

    // The last window in which cancelling is still free: every file has been
    // converted and verified, the collection root has been built — and nothing
    // has moved yet. A run that stopped consulting shouldCancel after the file
    // loop would convert the whole collection here anyway, minutes after the
    // user pressed Cancel, and the first thing they would see is their .bru
    // files in the Trash.
    it('honours a cancel that arrives after the last file but before the commit', async () => {
      const root = collection();
      const before = snapshotTree(root);
      const plan = planCollectionYmlMigration(root);

      // false for all `entries.length` per-file checks and for the check that
      // guards building the collection root, true only for the last one.
      let checks = 0;
      const result = await migrateCollectionToYml({
        collectionPathname: root,
        shouldCancel: () => ++checks > plan.entries.length + 1
      });

      expect(checks).toBe(plan.entries.length + 2);
      expect(result.status).toBe('cancelled');
      expect(snapshotTree(root)).toEqual(before);
      expect(listFiles(root).filter((file) => file.endsWith('.yml'))).toEqual([]);
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(false);
      expect(readTrashEntries(root)).toEqual([]);
    });
  });

  describe('progress reporting', () => {
    it('reports scanning, converting and committing with a total to render against', async () => {
      const root = collection();
      const phases = [];
      let lastConverting = null;

      const result = await migrateCollectionToYml({
        collectionPathname: root,
        onProgress: (progress) => {
          phases.push(progress.phase);
          if (progress.phase === 'converting') {
            lastConverting = progress;
          }
        }
      });

      expect(result.status).toBe('migrated');
      expect(phases[0]).toBe('scanning');
      expect(phases).toContain('converting');
      expect(phases).toContain('committing');
      expect(phases[phases.length - 1]).toBe('done');
      expect(lastConverting.total).toBe(result.total);
      expect(lastConverting.relativePath).toBeTruthy();
    });

    // Progress goes to a renderer window that can close, reload or navigate
    // away mid-run. A listener that throws must never take the migration with
    // it: thrown out of the commit phase it would stop halfway through moving
    // originals — the one state this design exists to avoid — and it is also
    // what keeps the post-commit "never roll back" branch out of reach.
    it('survives a progress listener that throws', async () => {
      const root = collection();

      const result = await migrateCollectionToYml({
        collectionPathname: root,
        onProgress: () => {
          throw new Error('the window went away');
        }
      });

      expect(result.status).toBe('migrated');
      expect(fs.existsSync(path.join(root, 'opencollection.yml'))).toBe(true);
      expect(listFiles(root).filter((file) => file.endsWith('.bru'))).toEqual([]);
      expect(readTrashEntries(root)).toHaveLength(6);
    });
  });
});
