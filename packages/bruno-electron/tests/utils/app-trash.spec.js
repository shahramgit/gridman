const fs = require('fs');
const os = require('os');
const path = require('path');

// app-trash reads userData lazily, so the mock can point at a per-test tmp dir.
jest.mock('electron', () => ({
  app: { getPath: () => global.__gridmanUserDataDir },
  dialog: {}
}));

// The move itself is covered by filesystem.spec.js; here it only has to fail
// the way movePathWithRetry documents it can.
jest.mock('../../src/utils/filesystem', () => {
  const actual = jest.requireActual('../../src/utils/filesystem');
  return { ...actual, movePathWithRetry: jest.fn() };
});

const { movePathWithRetry } = require('../../src/utils/filesystem');
const { moveToAppTrash, listAppTrash } = require('../../src/utils/app-trash');

describe('moveToAppTrash', () => {
  let userDataDir;
  let collectionDir;
  let sourcePathname;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-userdata-'));
    collectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-collection-'));
    global.__gridmanUserDataDir = userDataDir;
    sourcePathname = path.join(collectionDir, 'گزارش.bru');
    fs.writeFileSync(sourcePathname, 'meta {\n  name: req\n}\n');
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete global.__gridmanUserDataDir;
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(collectionDir, { recursive: true, force: true });
  });

  const trashEntryDirs = () => {
    const trashRoot = path.join(userDataDir, 'trash');
    return fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [];
  };

  it('leaves no unreachable entry behind when the move fails', async () => {
    movePathWithRetry.mockRejectedValue(
      Object.assign(new Error('Could not move "گزارش.bru" — it is open in another program'), {
        code: 'EPERM',
        // Only a PROVEN-intact source lets the entry be cleaned up.
        sourceIntact: true
      })
    );

    await expect(moveToAppTrash(sourcePathname, { type: 'request' })).rejects.toThrow(/Could not move/);

    // An entry without meta.json is skipped by listAppTrash and never purged,
    // so it would sit in userData forever.
    expect(trashEntryDirs()).toEqual([]);
    expect(fs.existsSync(sourcePathname)).toBe(true);
  });

  // Deleting the entry is what destroys data when the payload turned out to be
  // the only complete copy, so anything short of proof has to keep it.
  it('keeps the entry when the failure does not prove the source survived', async () => {
    movePathWithRetry.mockImplementation(async (source, target) => {
      fs.copyFileSync(source, target);
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });

    await expect(moveToAppTrash(sourcePathname, { type: 'request' })).rejects.toThrow(/EIO/);

    expect(trashEntryDirs()).toHaveLength(1);
    // meta.json too, or the Trash panel never lists it and the purge never
    // reaches it — the payload would be unreachable forever.
    expect(await listAppTrash()).toHaveLength(1);
  });

  it('keeps and lists the entry when the payload is the only complete copy', async () => {
    movePathWithRetry.mockImplementation(async (source, target) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      throw Object.assign(new Error('the original could not be removed'), { code: 'EPERM', sourceIntact: false });
    });

    await expect(moveToAppTrash(sourcePathname, { type: 'request' })).rejects.toThrow(/could not be removed/);

    const entries = await listAppTrash();
    expect(entries).toHaveLength(1);
    expect(entries[0].basename).toBe('گزارش.bru');
    expect(fs.existsSync(path.join(userDataDir, 'trash', entries[0].id, 'payload', 'گزارش.bru'))).toBe(true);
  });

  it('writes the entry meta once the move succeeded', async () => {
    movePathWithRetry.mockImplementation(async (source, target) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
    });

    const entryMeta = await moveToAppTrash(sourcePathname, { type: 'request', collectionPathname: collectionDir });

    expect(entryMeta.basename).toBe('گزارش.bru');
    expect(await listAppTrash()).toHaveLength(1);
    expect(fs.existsSync(sourcePathname)).toBe(false);
  });
});
