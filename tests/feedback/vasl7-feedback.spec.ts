import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, closeElectronApp } from '../../playwright';

for (const theme of ['light', 'dark']) {
  test(`vasl.7 feedback: navigation, variable replacement, Save As and refresh (${theme})`, async ({ launchElectronApp, createTmpDir }, testInfo) => {
    test.setTimeout(90000);
    const userDataPath = await createTmpDir('feedback-userdata');
    const workspacePath = await createTmpDir('feedback-workspace');
    const collectionPath = path.join(workspacePath, 'collections', 'feedback');
    fs.mkdirSync(collectionPath, { recursive: true });
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'Feedback', type: 'collection' }));
    const variablesFile = path.join(collectionPath, 'collection.bru');
    const variablesText = 'vars:pre-request {\n  test1: one\n  test2: two\n  test3: three\n  test11: eleven\n  test12: twelve\n}\n';
    fs.writeFileSync(variablesFile, variablesText);
    const requestFile = path.join(collectionPath, 'Request.bru');
    const requestText = 'meta {\n  name: Request\n  type: http\n  seq: 1\n}\nget {\n  url: http://localhost/{{test1}}/{{test1}}\n}\n';
    fs.writeFileSync(requestFile, requestText);
    for (const [name, seq] of [['Zulu', 1], ['Alpha', 2]] as const) {
      const folder = path.join(collectionPath, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'folder.bru'), `meta {\n  name: ${name}\n  seq: ${seq}\n}\n`);
    }
    fs.writeFileSync(path.join(workspacePath, 'workspace.yml'), 'opencollection: 1.0.0\ninfo:\n  name: Feedback Workspace\n  type: workspace\ncollections:\n  - name: Feedback\n    path: collections/feedback\nspecs: []\ndocs: ""\n');
    fs.writeFileSync(path.join(userDataPath, 'preferences.json'), JSON.stringify({
      workspaces: { lastOpenedWorkspaces: [workspacePath] },
      preferences: { onboarding: { hasLaunchedBefore: true, hasSeenWelcomeModal: true }, autoSave: { enabled: false } }
    }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Gridman Test');
    git('config', 'user.email', 'test@example.invalid');
    git('add', '--', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Test workspace');
    const remotePath = path.join(await createTmpDir('feedback-remote'), 'repo.git');
    git('clone', '--bare', workspacePath, remotePath);
    git('remote', 'add', 'origin', remotePath);
    git('fetch', 'origin');
    git('branch', '--set-upstream-to=origin/main', 'main');

    const focusSamples: string[] = [];
    const sampleFocus = () => {
      if (process.platform !== 'darwin') return;
      try {
        const front = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
        focusSamples.push(execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', front], { encoding: 'utf8' }).trim().split('\n')[0]);
      } catch { /* Focus sampling is unavailable on some CI hosts. */ }
    };
    sampleFocus();
    const sampler = setInterval(sampleFocus, 3000);
    let app;
    try {
      app = await launchElectronApp({ userDataPath });
      const page = await app.firstWindow();
      await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Change Theme', exact: true }).click();
      await page.getByRole('dialog', { name: 'Theme selector' }).getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
      await page.getByRole('button', { name: 'Change Theme', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      await expect(page.getByTestId('sidebar-collection-row').filter({ hasText: 'Feedback' })).toBeVisible();
      await page.locator('#sidebar-collection-name').filter({ hasText: 'Feedback' }).click();
      const request = page.getByTestId('sidebar-collection-item-row').filter({ hasText: 'Request' });
      await request.dblclick();
      const editor = page.locator('#request-url .CodeMirror');
      await expect(editor).toBeVisible();
      await page.getByTestId('workspace-git-menu').click();
      await page.getByRole('menuitem', { name: 'View Git tab', exact: true }).click();
      await request.dblclick();

      await test.step('Workspace controls occupy the header above request tabs at wide and narrow widths', async () => {
        const header = page.getByTestId('workspace-navigation-header');
        await expect(header.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
        const headerBox = await header.boundingBox();
        const requestBox = await page.locator('.tabs-scroll-container').boundingBox();
        expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(requestBox!.y + 2);
        await page.setViewportSize({ width: 1000, height: 800 });
        await expect(header.getByRole('tab', { name: 'Git', exact: true })).toBeVisible();
        await expect(page.getByTestId('pinned-workspace-tabs')).toHaveClass(/compact/);
        await page.screenshot({ path: testInfo.outputPath('navigation.png') });
        await page.setViewportSize({ width: 1400, height: 900 });
      });

      await test.step('Hover, search and choose a variable without changing disk content; Undo restores it', async () => {
        await editor.locator('.cm-variable-valid').filter({ hasText: 'test1' }).last().hover();
        const popup = page.getByRole('dialog', { name: 'Variable details' });
        await popup.getByRole('button', { name: 'Change variable...' }).click();
        await popup.getByRole('combobox').fill('test2');
        await expect(popup.getByRole('option')).toContainText('two');
        await expect(popup).toHaveCSS('opacity', '1');
        await page.screenshot({ path: testInfo.outputPath('variable-picker.png') });
        await popup.getByRole('option').click();
        await expect(editor).toContainText('http://localhost/{{test1}}/{{test2}}');
        expect(fs.readFileSync(variablesFile, 'utf8')).toBe(variablesText);
        expect(fs.readFileSync(requestFile, 'utf8')).toBe(requestText);
        await expect(page.locator('.request-tab.active').getByTestId('tab-draft-icon')).toBeVisible();
        await editor.locator('textarea').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
        await expect(editor).toContainText('http://localhost/{{test1}}/{{test1}}');
        const input = editor.locator('textarea');
        await input.press('Home');
        for (let i = 0; i < 21; i++) await input.press('ArrowRight');
        await input.press('Alt+ArrowDown');
        await expect(popup.getByRole('button', { name: 'Change variable...' })).toBeFocused();
        await page.keyboard.press('Enter');
        await popup.getByRole('combobox').fill('test3');
        await page.keyboard.press('Enter');
        await expect(editor).toContainText('http://localhost/{{test3}}/{{test1}}');
        await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
        await expect(editor).toContainText('http://localhost/{{test1}}/{{test1}}');
      });

      await test.step('Save As follows the sidebar folder sequence', async () => {
        await page.locator('[title="Save options"]').click();
        await page.getByRole('menuitem', { name: /^Save As/ }).click();
        const tree = page.getByTestId('save-as-folder-tree');
        await expect(tree).toBeVisible();
        expect(await tree.locator('.folder-row').allTextContents()).toEqual(['Feedback', 'Zulu', 'Alpha']);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      });

      await test.step('Both Git refresh buttons show loading and recover together', async () => {
        await page.getByTestId('workspace-navigation-header').getByRole('tab', { name: 'Git', exact: true }).click();
        const top = page.getByRole('button', { name: 'Refresh status', exact: true });
        await expect(top).toBeVisible();
        await page.locator('summary').filter({ hasText: 'Advanced Git' }).click();
        await page.evaluate(() => {
          const ipc = (window as any).ipcRenderer;
          const invoke = ipc.invoke.bind(ipc);
          ipc.invoke = async (channel: string, payload: any) => {
            if (channel === 'renderer:get-workspace-git-data' && payload?.fetchRemote) await new Promise((resolve) => setTimeout(resolve, 800));
            return invoke(channel, payload);
          };
        });
        await top.click();
        const bottom = page.getByRole('button', { name: 'Refresh', exact: true });
        await expect(top).toBeDisabled();
        await expect(bottom).toBeDisabled();
        await expect(top.locator('.spinner-icon')).toBeVisible();
        await expect(bottom.locator('.spinner-icon')).toBeVisible();
        await expect(top).toBeEnabled({ timeout: 15000 });
        await expect(bottom).toBeEnabled();
      });
    } finally {
      if (app) await closeElectronApp(app);
      clearInterval(sampler);
      sampleFocus();
      await testInfo.attach('frontmost-app-samples', { body: JSON.stringify(focusSamples), contentType: 'application/json' });
      console.log('Frontmost app samples:', JSON.stringify(focusSamples));
      if (process.platform === 'darwin') expect(focusSamples.length).toBeGreaterThan(2);
      expect(focusSamples.some((sample) => /"(?:Electron|Gridman)"/.test(sample))).toBe(false);
    }
  });
}
