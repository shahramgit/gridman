const fs = require('fs');
const os = require('os');
const path = require('path');

const mockStoreData = {};
jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), on: jest.fn(), getName: () => 'gridman' },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}));
jest.mock('electron-store', () =>
  jest.fn().mockImplementation(() => ({
    get: (key, fallback) => (key in mockStoreData ? mockStoreData[key] : fallback),
    set: (key, value) => { mockStoreData[key] = value; }
  }))
);

const { globalEnvironmentsManager } = require('../../src/store/workspace-environments');

/**
 * RENAMING THE ENVIRONMENT YOU ARE USING.
 *
 * A workspace environment's uid is a hash of its FILE PATH, so a rename mints a new one.
 * The "active environment" is stored as that uid — so renaming the selected environment
 * left the selection pointing at a file that no longer exists, and the next lookup failed
 * with "Environment file not found for uid: ...". Reported by users as "rename on the
 * current env does not work, and returns an error".
 *
 * These pin the uid behaviour the fix depends on. The re-pointing itself lives in
 * ipc/global-environments.js, which mirrors what delete already did.
 */
describe('renaming a workspace environment', () => {
  let ws;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-envrename-'));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const create = (name) =>
    globalEnvironmentsManager.createGlobalEnvironment(ws, {
      uid: 'seed',
      name,
      variables: [{ uid: 'v1', name: 'baseUrl', value: 'https://a.test', enabled: true, secret: false }]
    });

  it('mints a NEW uid, which is what breaks a stored selection', async () => {
    await create('Local');
    const { globalEnvironments } = await globalEnvironmentsManager.getGlobalEnvironments(ws);
    const before = globalEnvironments[0];

    const renamed = await globalEnvironmentsManager.renameGlobalEnvironment(ws, {
      environmentUid: before.uid,
      name: 'Production'
    });

    expect(renamed.name).toBe('Production');
    // The whole reason the active uid has to be re-pointed.
    expect(renamed.uid).not.toBe(before.uid);
  });

  it('makes the old uid unusable, with the error users reported', async () => {
    await create('Local');
    const { globalEnvironments } = await globalEnvironmentsManager.getGlobalEnvironments(ws);
    const oldUid = globalEnvironments[0].uid;

    await globalEnvironmentsManager.renameGlobalEnvironment(ws, { environmentUid: oldUid, name: 'Production' });

    await expect(
      globalEnvironmentsManager.renameGlobalEnvironment(ws, { environmentUid: oldUid, name: 'Staging' })
    ).rejects.toThrow(/not found for uid/);
  });

  it('keeps the variables and leaves exactly one file behind', async () => {
    await create('Local');
    const { globalEnvironments } = await globalEnvironmentsManager.getGlobalEnvironments(ws);

    await globalEnvironmentsManager.renameGlobalEnvironment(ws, {
      environmentUid: globalEnvironments[0].uid,
      name: 'Production'
    });

    expect(fs.readdirSync(path.join(ws, 'environments'))).toEqual(['Production.yml']);
    const after = await globalEnvironmentsManager.getGlobalEnvironments(ws);
    expect(after.globalEnvironments).toHaveLength(1);
    expect(after.globalEnvironments[0].name).toBe('Production');
    expect(after.globalEnvironments[0].variables.map((v) => v.name)).toEqual(['baseUrl']);
  });
});
