const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron-store', () => class {
  get(_key, fallback) { return fallback; }
  set() {}
});
jest.mock('../../src/store/env-secrets', () => class {
  getEnvSecrets() { return []; }
  storeEnvSecrets() {}
});

const { GlobalEnvironmentsManager } = require('../../src/store/workspace-environments');

describe('workspace environment forward compatibility', () => {
  let workspacePath;
  let manager;
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-env-compat-'));
    manager = new GlobalEnvironmentsManager();
  });
  afterEach(() => fs.rmSync(workspacePath, { recursive: true, force: true }));

  it('preserves inheritance and color when saving edited variables', async () => {
    const dir = path.join(workspacePath, 'environments');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Development.yml'), 'name: Development\nextends:\n  - Base\n  - Shared\ncolor: blue\nvariables: []\n');
    const { globalEnvironments: [environment] } = await manager.getGlobalEnvironments(workspacePath);
    expect(environment.extends).toEqual(['Base', 'Shared']);
    await manager.saveGlobalEnvironment(workspacePath, { environmentUid: environment.uid, variables: [] });
    const { globalEnvironments: [saved] } = await manager.getGlobalEnvironments(workspacePath);
    expect(saved.extends).toEqual(['Base', 'Shared']);
    expect(saved.color).toBe('blue');
  });

  it('retains inheritance when importing, renaming and recoloring an environment', async () => {
    const created = await manager.createGlobalEnvironment(workspacePath, {
      name: 'Development', variables: [], extends: 'Base', color: 'blue'
    });
    expect(created.extends).toBe('Base');
    const renamed = await manager.renameGlobalEnvironment(workspacePath, { environmentUid: created.uid, name: 'Staging' });
    await manager.updateGlobalEnvironmentColor(workspacePath, renamed.uid, 'green');
    const { globalEnvironments: [saved] } = await manager.getGlobalEnvironments(workspacePath);
    expect(saved.name).toBe('Staging');
    expect(saved.extends).toBe('Base');
    expect(saved.color).toBe('green');
  });
});
