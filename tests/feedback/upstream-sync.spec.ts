import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, closeElectronApp } from '../../playwright';
import { parseCollection, stringifyCollection, stringifyRequest } from '@usebruno/filestore';

test('upstream sync: YAML settings save, request execution and failed recovery', async ({ launchElectronApp, createTmpDir }) => {
  test.setTimeout(90000);
  const userDataPath = await createTmpDir('sync-userdata');
  const workspacePath = await createTmpDir('sync-workspace');
  const collectionPath = path.join(workspacePath, 'collections', 'sync');
  fs.mkdirSync(collectionPath, { recursive: true });
  const collectionFile = path.join(collectionPath, 'opencollection.yml');
  fs.writeFileSync(collectionFile, stringifyCollection({ request: {
    headers: [], auth: { mode: 'none' }, script: { req: '', res: '' }, vars: { req: [], res: [] }
  } }, { version: '1', name: 'Sync', type: 'collection' }, { format: 'yml' }));
  fs.writeFileSync(path.join(collectionPath, 'Ping.yml'), stringifyRequest({
    name: 'Ping', type: 'http-request', seq: 1,
    request: { method: 'GET', url: 'http://localhost:8081/ping', headers: [], params: [],
      auth: { mode: 'none' }, body: { mode: 'none' }, script: {}, vars: { req: [], res: [] } }
  }, { format: 'yml' }));
  fs.writeFileSync(path.join(workspacePath, 'workspace.yml'), 'opencollection: 1.0.0\ninfo:\n  name: Sync Workspace\n  type: workspace\ncollections:\n  - name: Sync\n    path: collections/sync\nspecs: []\ndocs: ""\n');
  fs.writeFileSync(path.join(userDataPath, 'preferences.json'), JSON.stringify({
    workspaces: { lastOpenedWorkspaces: [workspacePath] },
    preferences: { onboarding: { hasLaunchedBefore: true, hasSeenWelcomeModal: true }, autoSave: { enabled: false } }
  }));

  const focusSamples: string[] = [];
  const sampleFocus = () => {
    if (process.platform !== 'darwin') return;
    const front = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    focusSamples.push(execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', front], { encoding: 'utf8' }).trim().split('\n')[0]);
  };
  sampleFocus();
  const sampler = setInterval(sampleFocus, 3000);
  let app;
  try {
    app = await launchElectronApp({ userDataPath });
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
    await page.locator('#sidebar-collection-name').filter({ hasText: 'Sync' }).click();
    await page.getByTestId('collection-settings-tab-script').click();
    await page.getByRole('button', { name: 'Pre Request', exact: true }).click();
    const editor = page.getByTestId('collection-pre-request-script-editor').locator('.CodeMirror textarea');
    await editor.focus();
    await page.keyboard.insertText('bru.setVar("syncSaved", true);');
    await page.getByTestId('collection-settings-tab-proxy').click();
    await page.getByRole('radio', { name: 'disabled', exact: true }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => {
      const saved = parseCollection(fs.readFileSync(collectionFile, 'utf8'), { format: 'yml' });
      return { script: saved.collectionRoot?.request?.script?.req, disabled: saved.brunoConfig?.proxy?.disabled };
    }).toEqual({ script: 'bru.setVar("syncSaved", true);', disabled: true });

    await page.getByTestId('sidebar-collection-item-row').filter({ hasText: 'Ping' }).dblclick();
    await page.getByTestId('send-arrow-icon').click();
    await expect(page.getByTestId('response-status-code')).toContainText('200');

    // An unloaded root must be recovered from disk before a config-only save.
    await page.evaluate(async ({ collectionPath }) => {
      await (window as any).ipcRenderer.invoke('renderer:update-bruno-config',
        { version: '1', name: 'Sync', type: 'collection' }, collectionPath, {});
    }, { collectionPath });
    expect(parseCollection(fs.readFileSync(collectionFile, 'utf8'), { format: 'yml' }).collectionRoot?.request?.script?.req)
      .toBe('bru.setVar("syncSaved", true);');

    const badPath = path.join(workspacePath, 'collections', 'malformed');
    fs.mkdirSync(badPath);
    const badFile = path.join(badPath, 'opencollection.yml');
    const malformed = 'info: [unterminated';
    fs.writeFileSync(badFile, malformed);
    const error = await page.evaluate(async ({ badPath }) => {
      try {
        await (window as any).ipcRenderer.invoke('renderer:update-bruno-config',
          { version: '1', name: 'Malformed', type: 'collection' }, badPath, {});
        return '';
      } catch (error: any) { return error.message; }
    }, { badPath });
    expect(error).toContain('file was not changed');
    expect(fs.readFileSync(badFile, 'utf8')).toBe(malformed);
  } finally {
    clearInterval(sampler);
    sampleFocus();
    if (app) await closeElectronApp(app);
  }
  if (process.platform === 'darwin') {
    expect(focusSamples.length).toBeGreaterThan(1);
    expect(focusSamples.some((name) => /Electron|Gridman/i.test(name))).toBe(false);
  }
});
