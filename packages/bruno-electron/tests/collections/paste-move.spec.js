// The filesystem util pulls in electron's dialog; the paste/move helpers
// never touch it, so stubs are enough.
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
const { parseRequest, parseFolder } = require('@usebruno/filestore');

const {
  resolveUniqueTargetPathname,
  applyDisplayNameSuffix,
  pasteRequestByPath,
  pasteFolderByPath
} = require('../../src/ipc/collection-paste-move');

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

describe('collection paste/move helpers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-paste-move-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveUniqueTargetPathname', () => {
    it('keeps the desired name when there is no collision', () => {
      const result = resolveUniqueTargetPathname({ targetDirname: tmpDir, basename: 'ping.bru', isFolder: false });
      expect(result.pathname).toBe(path.join(tmpDir, 'ping.bru'));
      expect(result.renamed).toBe(false);
      expect(result.suffix).toBe('');
    });

    it('auto-renames a colliding request file, preserving the extension', () => {
      fs.writeFileSync(path.join(tmpDir, 'ping.bru'), BRU_REQUEST('ping', 'https://example.com'));
      const result = resolveUniqueTargetPathname({ targetDirname: tmpDir, basename: 'ping.bru', isFolder: false });
      expect(result.pathname).toBe(path.join(tmpDir, 'ping copy.bru'));
      expect(result.basename).toBe('ping copy.bru');
      expect(result.renamed).toBe(true);
      expect(result.suffix).toBe(' copy');
    });

    it('increments the copy counter until the name is free', () => {
      fs.writeFileSync(path.join(tmpDir, 'ping.bru'), 'x');
      fs.writeFileSync(path.join(tmpDir, 'ping copy.bru'), 'x');
      const result = resolveUniqueTargetPathname({ targetDirname: tmpDir, basename: 'ping.bru', isFolder: false });
      expect(result.pathname).toBe(path.join(tmpDir, 'ping copy 2.bru'));
      expect(result.suffix).toBe(' copy 2');
    });

    it('auto-renames a colliding folder (no extension handling)', () => {
      fs.mkdirSync(path.join(tmpDir, 'api'));
      const result = resolveUniqueTargetPathname({ targetDirname: tmpDir, basename: 'api', isFolder: true });
      expect(result.pathname).toBe(path.join(tmpDir, 'api copy'));
      expect(result.renamed).toBe(true);
      expect(result.suffix).toBe(' copy');
    });
  });

  describe('applyDisplayNameSuffix', () => {
    it('suffixes a request display name', async () => {
      const requestPath = path.join(tmpDir, 'ping copy.bru');
      fs.writeFileSync(requestPath, BRU_REQUEST('ping', 'https://example.com'));
      await applyDisplayNameSuffix({ pathname: requestPath, kind: 'request', suffix: ' copy', format: 'bru' });
      const parsed = parseRequest(fs.readFileSync(requestPath, 'utf8'), { format: 'bru' });
      expect(parsed.name).toBe('ping copy');
    });

    it('suffixes a folder meta name', async () => {
      const folderPath = path.join(tmpDir, 'api copy');
      fs.mkdirSync(folderPath);
      fs.writeFileSync(path.join(folderPath, 'folder.bru'), BRU_FOLDER('API'));
      await applyDisplayNameSuffix({ pathname: folderPath, kind: 'folder', suffix: ' copy', format: 'bru' });
      const parsed = await parseFolder(fs.readFileSync(path.join(folderPath, 'folder.bru'), 'utf8'), { format: 'bru' });
      expect(parsed.meta.name).toBe('API copy');
    });
  });

  describe('pasteRequestByPath', () => {
    it('pastes a request from disk into another directory, keeping the name when free', async () => {
      const sourceDir = path.join(tmpDir, 'source');
      const targetDir = path.join(tmpDir, 'target');
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(targetDir);
      const sourcePathname = path.join(sourceDir, 'ping.bru');
      fs.writeFileSync(sourcePathname, BRU_REQUEST('ping', 'https://example.com'));

      const result = await pasteRequestByPath({ sourcePathname, targetDirname: targetDir, sourceFormat: 'bru', targetFormat: 'bru' });

      expect(result.pathname).toBe(path.join(targetDir, 'ping.bru'));
      expect(result.type).toBe('http-request');
      const parsed = parseRequest(fs.readFileSync(result.pathname, 'utf8'), { format: 'bru' });
      expect(parsed.name).toBe('ping');
      expect(parsed.request.url).toBe('https://example.com');
    });

    it('auto-renames the file and display name on collision', async () => {
      const sourcePathname = path.join(tmpDir, 'ping.bru');
      fs.writeFileSync(sourcePathname, BRU_REQUEST('ping', 'https://example.com'));

      // paste right next to the original
      const result = await pasteRequestByPath({ sourcePathname, targetDirname: tmpDir, sourceFormat: 'bru', targetFormat: 'bru' });

      expect(result.pathname).toBe(path.join(tmpDir, 'ping copy.bru'));
      expect(result.name).toBe('ping copy');
      const parsed = parseRequest(fs.readFileSync(result.pathname, 'utf8'), { format: 'bru' });
      expect(parsed.name).toBe('ping copy');
    });
  });

  describe('pasteFolderByPath', () => {
    const makeSourceFolder = () => {
      const sourceFolder = path.join(tmpDir, 'api');
      fs.mkdirSync(sourceFolder);
      fs.writeFileSync(path.join(sourceFolder, 'folder.bru'), BRU_FOLDER('API'));
      fs.writeFileSync(path.join(sourceFolder, 'ping.bru'), BRU_REQUEST('ping', 'https://example.com'));
      fs.mkdirSync(path.join(sourceFolder, 'nested'));
      fs.writeFileSync(path.join(sourceFolder, 'nested', 'pong.bru'), BRU_REQUEST('pong', 'https://example.com/pong'));
      return sourceFolder;
    };

    it('copies the folder subtree from disk into another collection directory', async () => {
      const sourceFolder = makeSourceFolder();
      const targetDir = path.join(tmpDir, 'other-collection');
      fs.mkdirSync(targetDir);

      const result = await pasteFolderByPath({
        sourcePathname: sourceFolder,
        targetDirname: targetDir,
        sourceFormat: 'bru',
        targetFormat: 'bru'
      });

      expect(result.pathname).toBe(path.join(targetDir, 'api'));
      expect(result.type).toBe('folder');
      expect(result.name).toBe('API');
      expect(fs.existsSync(path.join(targetDir, 'api', 'ping.bru'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'api', 'nested', 'pong.bru'))).toBe(true);
      // source untouched
      expect(fs.existsSync(path.join(sourceFolder, 'ping.bru'))).toBe(true);
    });

    it('auto-renames the folder (dir + meta name) on collision', async () => {
      const sourceFolder = makeSourceFolder();

      // paste right next to the original
      const result = await pasteFolderByPath({
        sourcePathname: sourceFolder,
        targetDirname: tmpDir,
        sourceFormat: 'bru',
        targetFormat: 'bru'
      });

      expect(result.pathname).toBe(path.join(tmpDir, 'api copy'));
      expect(result.name).toBe('API copy');
      const parsedMeta = await parseFolder(fs.readFileSync(path.join(result.pathname, 'folder.bru'), 'utf8'), { format: 'bru' });
      expect(parsedMeta.meta.name).toBe('API copy');
      expect(fs.existsSync(path.join(result.pathname, 'nested', 'pong.bru'))).toBe(true);
    });

    it('converts request files when pasting across formats', async () => {
      const sourceFolder = makeSourceFolder();
      const targetDir = path.join(tmpDir, 'yml-collection');
      fs.mkdirSync(targetDir);

      const result = await pasteFolderByPath({
        sourcePathname: sourceFolder,
        targetDirname: targetDir,
        sourceFormat: 'bru',
        targetFormat: 'yml'
      });

      expect(fs.existsSync(path.join(result.pathname, 'ping.yml'))).toBe(true);
      expect(fs.existsSync(path.join(result.pathname, 'folder.yml'))).toBe(true);
      expect(fs.existsSync(path.join(result.pathname, 'nested', 'pong.yml'))).toBe(true);
      const parsed = parseRequest(fs.readFileSync(path.join(result.pathname, 'ping.yml'), 'utf8'), { format: 'yml' });
      expect(parsed.name).toBe('ping');
    });
  });
});
