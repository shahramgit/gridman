import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { test, expect, closeElectronApp } from '../../../playwright';

// Gridman's initial-workspace bootstrap (ensureInitialWorkspace in
// bruno-electron/src/ipc/workspace.js): when no previously opened workspace
// is valid, the app creates "My Workspace" under the default location
// (GRIDMAN_DEFAULT_LOCATION in tests — the fixture points it at the temp
// userData dir so runs never touch ~/Documents/gridman).
//
// The previous specs in this directory tested upstream Bruno's divergent
// default-workspace design (userData/default-workspace naming, numbered
// recovery workspaces, lastOpenedCollections migration, global-environment
// backups) which Gridman's workspace model never implemented; they were
// removed with the 2026-07-12 test-hardening batch.
test.describe('Default workspace bootstrap', () => {
  test('fresh install creates "My Workspace" at the default location', async ({ launchElectronApp, createTmpDir }) => {
    const userDataPath = await createTmpDir('default-ws-fresh');

    const app = await launchElectronApp({ userDataPath });
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
    await expect(page.getByTestId('workspace-name')).toHaveText('My Workspace');

    const workspacePath = path.join(userDataPath, 'My Workspace');
    expect(fs.existsSync(path.join(workspacePath, 'workspace.yml'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'collections'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'environments'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.gitignore'))).toBe(true);

    const config = yaml.load(fs.readFileSync(path.join(workspacePath, 'workspace.yml'), 'utf8')) as any;
    expect(config?.info?.name).toBe('My Workspace');
    expect(config?.info?.type).toBe('workspace');

    await closeElectronApp(app);
  });

  test('second launch reuses the workspace without modifying it', async ({ launchElectronApp, createTmpDir }) => {
    const userDataPath = await createTmpDir('default-ws-reuse');

    const app1 = await launchElectronApp({ userDataPath });
    const page1 = await app1.firstWindow();
    await page1.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
    await expect(page1.getByTestId('workspace-name')).toHaveText('My Workspace');

    const workspacePath = path.join(userDataPath, 'My Workspace');
    const originalYml = fs.readFileSync(path.join(workspacePath, 'workspace.yml'), 'utf8');
    await closeElectronApp(app1);

    const app2 = await launchElectronApp({ userDataPath });
    const page2 = await app2.firstWindow();
    await page2.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
    await expect(page2.getByTestId('workspace-name')).toHaveText('My Workspace');

    expect(fs.readFileSync(path.join(workspacePath, 'workspace.yml'), 'utf8')).toBe(originalYml);
    // No duplicate bootstrap workspace next to the original
    const siblings = fs.readdirSync(userDataPath).filter((name) => name.startsWith('My Workspace'));
    expect(siblings).toEqual(['My Workspace']);

    await closeElectronApp(app2);
  });
});
