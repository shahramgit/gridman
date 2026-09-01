// The filesystem util pulls in electron's dialog; nothing under test touches
// it, so a stub is enough.
jest.mock('electron', () => ({ dialog: {} }));

const fs = require('fs');
const fsPromises = require('fs/promises');
const fsExtra = require('fs-extra');
const os = require('os');
const path = require('path');

const { movePathWithRetry, getCollectionStats } = require('../../src/utils/filesystem');

const lockError = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

// movePathWithRetry hands fs the EXTENDED-LENGTH form of a path on Windows
// (`\\?\C:\...`), so a mock comparing against the plain path never fires
// there: the simulated failure never happened, the move succeeded, and three
// tests that assert a rejection passed a resolution instead. Compare the way
// the filesystem does.
const isSamePath = (a, b) => {
  const strip = (v) => String(v || '').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
  return strip(a) === strip(b);
};

describe('movePathWithRetry', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-move-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeFolder = (name, requestNames = ['request.bru']) => {
    const folderPath = path.join(tmpDir, name);
    fs.mkdirSync(folderPath, { recursive: true });
    requestNames.forEach((requestName) => {
      fs.writeFileSync(path.join(folderPath, requestName), 'meta {\n  name: req\n}\n');
    });
    return folderPath;
  };

  // userData and the collections sit on different drives on most Windows
  // machines, so EVERY trash move is cross-device — where fs-extra's move is
  // copy-then-remove and the remove is the part a lock breaks.
  const mockCrossDeviceMoveWithLockedSource = () => jest.spyOn(fsExtra, 'move').mockImplementation(async (src, dest) => {
    if (fs.existsSync(dest)) {
      // fs-extra's own guard: a plain Error, no `code` to match on.
      throw new Error('dest already exists.');
    }
    fs.cpSync(src, dest, { recursive: true });
    throw lockError('EPERM');
  });

  it('renames a folder', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'folder نسخه 2');

    await movePathWithRetry(source, target);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readdirSync(target)).toEqual(['request.bru']);
  });

  it('retries a transient lock and never falls back to copying', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'renamed');
    const move = jest.spyOn(fsExtra, 'move');
    move.mockRejectedValueOnce(lockError('EPERM')).mockRejectedValueOnce(lockError('EBUSY'));
    const copy = jest.spyOn(fsExtra, 'copy');

    await movePathWithRetry(source, target);

    expect(move).toHaveBeenCalledTimes(3);
    expect(copy).not.toHaveBeenCalled();
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('falls back to copy + remove when the lock never clears', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'renamed');
    jest.spyOn(fsExtra, 'move').mockRejectedValue(lockError('EPERM'));

    await movePathWithRetry(source, target);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readdirSync(target)).toEqual(['request.bru']);
  });

  it('rolls the copy back when the source cannot be removed', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'renamed');
    jest.spyOn(fsExtra, 'move').mockRejectedValue(lockError('EPERM'));
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (pathname, options) => {
      if (isSamePath(pathname, source)) {
        throw lockError('EPERM');
      }
      return fs.rmSync(pathname, options);
    });

    await expect(movePathWithRetry(source, target)).rejects.toThrow(/folder/);

    // Both copies on disk would show the folder twice in the sidebar.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
  });

  it('keeps retrying a cross-device move whose source removal failed', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'trash payload');
    mockCrossDeviceMoveWithLockedSource();

    await movePathWithRetry(source, target);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readdirSync(target)).toEqual(['request.bru']);
  });

  it('leaves no orphan copy when a cross-device move cannot be completed', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'trash payload');
    mockCrossDeviceMoveWithLockedSource();
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (pathname, options) => {
      if (isSamePath(pathname, source)) {
        throw lockError('EPERM');
      }
      return fs.rmSync(pathname, options);
    });

    await expect(movePathWithRetry(source, target)).rejects.toThrow(/Could not move "folder"/);

    // An orphan copy under userData/trash has no meta.json, so the Trash panel
    // never lists it and the purge never reaches it.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(source)).toEqual(['request.bru']);
  });

  // The mock above copies and then fails WITHOUT touching the source, so it
  // never modelled the case that actually loses data: fs-extra's cross-device
  // remove unlinks depth-first, so a lock can break it with descendants already
  // gone — and at that instant the target holds the only complete copy.
  // Discarding it (and retrying against the truncated source) destroyed the
  // user's requests outright.
  it('keeps the copy when a cross-device move ate part of the source', async () => {
    const source = makeFolder('folder', ['a.bru', 'b.bru']);
    const target = path.join(tmpDir, 'trash payload');
    jest.spyOn(fsExtra, 'move').mockImplementation(async (src, dest) => {
      if (fs.existsSync(dest)) {
        throw new Error('dest already exists.');
      }
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(path.join(src, 'a.bru'));
      throw lockError('EPERM');
    });

    await expect(movePathWithRetry(source, target)).rejects.toMatchObject({ sourceIntact: false });

    expect(fs.readdirSync(target).sort()).toEqual(['a.bru', 'b.bru']);
  });

  it('keeps the copy when the source removal only partly succeeded', async () => {
    const source = makeFolder('folder', ['a.bru', 'b.bru']);
    const target = path.join(tmpDir, 'trash payload');
    jest.spyOn(fsExtra, 'move').mockRejectedValue(lockError('EPERM'));
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (pathname, options) => {
      if (isSamePath(pathname, source)) {
        // fsPromises.rm unlinks depth-first: it can reject with descendants
        // already gone.
        fs.rmSync(path.join(source, 'a.bru'));
        throw lockError('EPERM');
      }
      return fs.rmSync(pathname, options);
    });

    await expect(movePathWithRetry(source, target)).rejects.toMatchObject({ sourceIntact: false });

    // The copy is now the only complete copy of the user's requests; rolling it
    // back would delete a.bru from the disk entirely.
    expect(fs.readdirSync(target).sort()).toEqual(['a.bru', 'b.bru']);
  });

  it('cleans up a half-written copy when the fallback copy fails', async () => {
    const source = makeFolder('folder', ['a.bru', 'b.bru']);
    const target = path.join(tmpDir, 'folder نسخه 2');
    jest.spyOn(fsExtra, 'move').mockRejectedValue(lockError('EPERM'));
    jest.spyOn(fsExtra, 'copy').mockImplementation(async (_source, destination) => {
      // fsExtra.copy is not transactional.
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'a.bru'), 'half written');
      throw lockError('EPERM');
    });

    await expect(movePathWithRetry(source, target)).rejects.toThrow(/Could not move/);

    expect(fs.readdirSync(source).sort()).toEqual(['a.bru', 'b.bru']);
    // A half-written twin next to the original is the duplicate sidebar row
    // this helper exists to prevent.
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never deletes a target that already held the user data', async () => {
    const source = makeFolder('folder', ['a.bru']);
    const target = makeFolder('existing', ['their request.bru']);

    await expect(movePathWithRetry(source, target)).rejects.toThrow(/already exists/);

    expect(fs.readdirSync(target)).toEqual(['their request.bru']);
    expect(fs.readdirSync(source)).toEqual(['a.bru']);
  });

  it('renames a folder that only changes case', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'Folder');

    await movePathWithRetry(source, target);

    expect(fs.readdirSync(target)).toEqual(['request.bru']);
  });

  it('reports a locked path in human readable terms', async () => {
    const source = makeFolder('گزارش');
    const target = path.join(tmpDir, 'renamed');
    jest.spyOn(fsExtra, 'move').mockRejectedValue(lockError('EBUSY'));
    jest.spyOn(fsExtra, 'copy').mockRejectedValue(lockError('EBUSY'));

    await expect(movePathWithRetry(source, target)).rejects.toThrow(
      /Could not move "گزارش" — it is open in another program/
    );
  });

  it('rethrows a non-transient error without retrying', async () => {
    const source = makeFolder('folder');
    const target = path.join(tmpDir, 'renamed');
    const move = jest.spyOn(fsExtra, 'move').mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

    await expect(movePathWithRetry(source, target)).rejects.toThrow('ENOSPC');
    expect(move).toHaveBeenCalledTimes(1);
  });
});

describe('getCollectionStats', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-stats-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeRequest = (relativePath, sizeInBytes) => {
    const target = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(sizeInBytes));
  };

  it('counts yml requests, not just bru', async () => {
    fs.writeFileSync(path.join(tmpDir, 'opencollection.yml'), 'name: collection\n');
    writeRequest('login.yml', 1024);
    writeRequest('folder/get users.yml', 2048);

    const stats = await getCollectionStats(tmpDir);

    expect(stats.filesCount).toBe(2);
    expect(stats.maxFileSize).toBeCloseTo(2048 / (1024 * 1024));
    expect(stats.size).toBeGreaterThan(0);
  });

  it('ignores the yml files a yml collection does not treat as requests', async () => {
    fs.writeFileSync(path.join(tmpDir, 'opencollection.yml'), 'name: collection\n');
    writeRequest('login.yml', 1024);
    writeRequest('folder/folder.yml', 512);
    writeRequest('environments/prod.yml', 512);

    const stats = await getCollectionStats(tmpDir);

    // Only login.yml: the collection root file, the folder root file and the
    // environments directory are what the watcher routes away from its request
    // handling, so the stats must not count them either.
    expect(stats.filesCount).toBe(1);
    expect(stats.maxFileSize).toBeCloseTo(1024 / (1024 * 1024));
  });

  it('ignores yml files in a bru collection', async () => {
    writeRequest('bruno.json', 64);
    writeRequest('login.bru', 256);
    // Users keep API specs and CI config next to a collection. Counting them
    // pushed maxFileSize over the 5 MB threshold and silently flipped a
    // one-request collection from the eager to the lazy (indexed) load.
    writeRequest('swagger.yml', 6 * 1024 * 1024);
    writeRequest('docker-compose.yml', 4096);
    writeRequest('environments/prod.bru', 256);

    const stats = await getCollectionStats(tmpDir);

    expect(stats.filesCount).toBe(1);
    expect(stats.maxFileSize).toBeCloseTo(256 / (1024 * 1024));
  });

  it('counts bru requests in nested folders', async () => {
    writeRequest('login.bru', 512);
    writeRequest('folder/nested/get users.bru', 4096);

    const stats = await getCollectionStats(tmpDir);

    expect(stats.filesCount).toBe(2);
    expect(stats.maxFileSize).toBeCloseTo(4096 / (1024 * 1024));
  });

  it('ignores non-request files and dependency folders', async () => {
    writeRequest('bruno.json', 128);
    writeRequest('readme.md', 128);
    writeRequest('node_modules/pkg/index.bru', 4096);
    writeRequest('.git/objects/thing.yml', 4096);
    writeRequest('login.bru', 256);

    const stats = await getCollectionStats(tmpDir);

    expect(stats.filesCount).toBe(1);
    expect(stats.maxFileSize).toBeCloseTo(256 / (1024 * 1024));
  });
});
