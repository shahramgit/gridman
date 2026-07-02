// The filesystem util pulls in electron's dialog and utils/collection pulls
// in the preferences store; the export/import helpers never touch either, so
// stubs are enough.
jest.mock('electron', () => ({ dialog: {} }));
jest.mock('electron-store', () => {
  return class MemoryStore {
    constructor() {
      this.data = {};
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
const { parseRequest } = require('@usebruno/filestore');

const {
  readCollectionItemsFromDisk,
  readFolderForExport,
  writeItemsIntoFolder
} = require('../../src/ipc/collection-export-import');

const BRU_REQUEST = (name, url, seq = 1) => `meta {
  name: ${name}
  type: http
  seq: ${seq}
}

get {
  url: ${url}
  body: none
  auth: none
}
`;

const BRU_FOLDER = (name, seq = 1) => `meta {
  name: ${name}
  seq: ${seq}
}
`;

describe('folder export/import helpers', () => {
  let sourceCollectionPath;
  let targetCollectionPath;

  const write = (root, relative, content) => {
    const pathname = path.join(root, relative);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, content);
    return pathname;
  };

  beforeEach(() => {
    sourceCollectionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-export-src-'));
    targetCollectionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-import-dst-'));

    for (const root of [sourceCollectionPath, targetCollectionPath]) {
      fs.writeFileSync(
        path.join(root, 'bruno.json'),
        JSON.stringify({ version: '1', name: path.basename(root), type: 'collection' })
      );
    }

    write(sourceCollectionPath, 'api/folder.bru', BRU_FOLDER('API Folder'));
    write(sourceCollectionPath, 'api/get-user.bru', BRU_REQUEST('Get User', 'https://api.example.com/users/1', 1));
    write(sourceCollectionPath, 'api/list-users.bru', BRU_REQUEST('List Users', 'https://api.example.com/users', 2));
    write(sourceCollectionPath, 'api/inner/ping.bru', BRU_REQUEST('Ping', 'https://api.example.com/ping', 1));
  });

  afterEach(() => {
    fs.rmSync(sourceCollectionPath, { recursive: true, force: true });
    fs.rmSync(targetCollectionPath, { recursive: true, force: true });
  });

  describe('readFolderForExport', () => {
    it('reads a folder subtree into a collection-shaped object', () => {
      const exported = readFolderForExport({ folderPathname: path.join(sourceCollectionPath, 'api') });

      expect(exported.type).toBe('collection');
      expect(exported.name).toBe('API Folder');
      expect(exported.environments).toEqual([]);
      expect(exported.items).toHaveLength(3);

      const requests = exported.items.filter((item) => item.type === 'http-request');
      expect(requests.map((item) => item.name).sort()).toEqual(['Get User', 'List Users']);
      const getUser = requests.find((item) => item.name === 'Get User');
      expect(getUser.request.url).toBe('https://api.example.com/users/1');
      expect(getUser.filename).toBe('get-user.bru');

      const folders = exported.items.filter((item) => item.type === 'folder');
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('inner');
      expect(folders[0].items).toHaveLength(1);
      expect(folders[0].items[0].name).toBe('Ping');
    });

    it('falls back to the directory basename when there is no folder root file', () => {
      const exported = readFolderForExport({ folderPathname: path.join(sourceCollectionPath, 'api', 'inner') });
      expect(exported.name).toBe('inner');
      expect(exported.items).toHaveLength(1);
    });

    it('throws when the folder does not exist', () => {
      expect(() => readFolderForExport({ folderPathname: path.join(sourceCollectionPath, 'nope') }))
        .toThrow('Folder path does not exist');
    });

    it('skips collection root files and ignored directories', () => {
      write(sourceCollectionPath, 'node_modules/skipped/ignored.bru', BRU_REQUEST('Ignored', 'https://x'));
      const items = readCollectionItemsFromDisk(sourceCollectionPath);
      expect(items.map((item) => item.filename || item.name)).not.toContain('bruno.json');
      expect(items.filter((item) => item.type === 'folder').map((item) => item.name)).toEqual(['api']);
    });
  });

  describe('writeItemsIntoFolder', () => {
    it('writes requests and folders into the target directory', async () => {
      const exported = readFolderForExport({ folderPathname: path.join(sourceCollectionPath, 'api') });

      await writeItemsIntoFolder({
        items: exported.items,
        targetDirectory: targetCollectionPath,
        format: 'bru'
      });

      expect(fs.existsSync(path.join(targetCollectionPath, 'get-user.bru'))).toBe(true);
      expect(fs.existsSync(path.join(targetCollectionPath, 'list-users.bru'))).toBe(true);
      expect(fs.existsSync(path.join(targetCollectionPath, 'inner', 'ping.bru'))).toBe(true);

      const written = parseRequest(
        fs.readFileSync(path.join(targetCollectionPath, 'get-user.bru'), 'utf8'),
        { format: 'bru' }
      );
      expect(written.name).toBe('Get User');
      expect(written.request.url).toBe('https://api.example.com/users/1');
    });

    it('auto-renames on collisions with the standard copy suffix', async () => {
      const exported = readFolderForExport({ folderPathname: path.join(sourceCollectionPath, 'api') });

      // Pre-existing file and folder with the same names force renames.
      write(targetCollectionPath, 'get-user.bru', BRU_REQUEST('Existing', 'https://existing.example.com'));
      fs.mkdirSync(path.join(targetCollectionPath, 'inner'));

      await writeItemsIntoFolder({
        items: exported.items,
        targetDirectory: targetCollectionPath,
        format: 'bru'
      });

      expect(fs.existsSync(path.join(targetCollectionPath, 'get-user copy.bru'))).toBe(true);
      expect(fs.existsSync(path.join(targetCollectionPath, 'inner copy', 'ping.bru'))).toBe(true);

      // The pre-existing file is untouched.
      const existing = parseRequest(
        fs.readFileSync(path.join(targetCollectionPath, 'get-user.bru'), 'utf8'),
        { format: 'bru' }
      );
      expect(existing.name).toBe('Existing');

      // Importing again bumps the suffix counter.
      await writeItemsIntoFolder({
        items: exported.items,
        targetDirectory: targetCollectionPath,
        format: 'bru'
      });
      expect(fs.existsSync(path.join(targetCollectionPath, 'get-user copy 2.bru'))).toBe(true);
      expect(fs.existsSync(path.join(targetCollectionPath, 'inner copy 2', 'ping.bru'))).toBe(true);
    });

    it('converts request files to the target collection format', async () => {
      const exported = readFolderForExport({ folderPathname: path.join(sourceCollectionPath, 'api', 'inner') });

      await writeItemsIntoFolder({
        items: exported.items,
        targetDirectory: targetCollectionPath,
        format: 'yml'
      });

      expect(fs.existsSync(path.join(targetCollectionPath, 'ping.yml'))).toBe(true);
      const written = parseRequest(
        fs.readFileSync(path.join(targetCollectionPath, 'ping.yml'), 'utf8'),
        { format: 'yml' }
      );
      expect(written.request.url).toBe('https://api.example.com/ping');
    });
  });
});
