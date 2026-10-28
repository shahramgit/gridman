import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { ElectronApplication, Page } from '@playwright/test';
import { stringifyRequest } from '@usebruno/filestore';
import { test as base, expect, closeElectronApp } from '../../playwright';

const escapedResponse = String.raw`{"2":2,"1":1,"id":123456789012345678901,"userMessage":"\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062B\u0628\u062A \u06AF\u0631\u062F\u06CC\u062F.","literal":"\\u062F"}`;
const readableMessage = '\u062f\u0631\u062e\u0648\u0627\u0633\u062a \u062b\u0628\u062a \u06af\u0631\u062f\u06cc\u062f.';

const test = base.extend<{
  delayCollectionMount: boolean;
  feedback: { app: ElectronApplication; page: Page; requestFile: string };
}>({
  delayCollectionMount: [false, { option: true }],
  feedback: async ({ createTmpDir, launchElectronApp, delayCollectionMount }, use) => {
    const userDataPath = await createTmpDir('feedback421-userdata');
    const workspacePath = await createTmpDir('feedback421-workspace');
    const collectionPath = path.join(workspacePath, 'collections', 'feedback');
    for (const name of ['Parent', 'Parent/Child', 'Bulk']) {
      const folder = path.join(collectionPath, name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'folder.bru'), `meta {\n  name: ${path.basename(name)}\n  seq: 1\n}\n`);
    }
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'Feedback', type: 'collection' }));
    const request = {
      method: 'GET', url: 'http://localhost:8081/ping', headers: [], params: [],
      auth: { mode: 'none' }, body: { mode: 'none' }, script: {}, vars: { req: [], res: [] }
    };
    const requestFile = path.join(collectionPath, 'Feedback.bru');
    fs.writeFileSync(requestFile, stringifyRequest({
      name: 'Feedback Request', type: 'http-request', seq: 1, request,
      examples: [{ name: 'Saved Example', request, response: {
        status: 200, statusText: 'OK', headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: { type: 'json', content: escapedResponse }
      } }]
    }, { format: 'bru' }));
    // Exercise the index-before-mount path used by large real collections.
    for (let i = 0; i < 105; i++) {
      fs.writeFileSync(path.join(collectionPath, 'Bulk', `Request-${i}.bru`), `meta {\n  name: Request ${i}\n  type: http\n  seq: ${i + 1}\n}\nget {\n  url: http://localhost:8081/ping\n  body: none\n  auth: none\n}\n`);
    }
    fs.writeFileSync(path.join(workspacePath, 'workspace.yml'), 'opencollection: 1.0.0\ninfo:\n  name: Feedback Workspace\n  type: workspace\ncollections:\n  - name: Feedback\n    path: collections/feedback\nspecs: []\ndocs: ""\n');
    fs.writeFileSync(path.join(userDataPath, 'preferences.json'), JSON.stringify({
      workspaces: { lastOpenedWorkspaces: [workspacePath] },
      preferences: { onboarding: { hasLaunchedBefore: true, hasSeenWelcomeModal: true }, autoSave: { enabled: false } }
    }));
    fs.writeFileSync(path.join(userDataPath, 'ui-state-snapshot.json'), JSON.stringify({
      collections: [{ pathname: collectionPath, expandedFolders: ['Parent', 'Parent/Child'] }]
    }));

    const focusSamples: string[] = [];
    const sampleFocus = () => {
      if (process.platform !== 'darwin') return;
      const front = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
      focusSamples.push(execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', front], { encoding: 'utf8' }));
    };
    sampleFocus();
    const sampler = setInterval(sampleFocus, 3000);
    let app: ElectronApplication | undefined;
    let baselineLanding: ReturnType<typeof createServer> | undefined;
    try {
      const dotEnv: Record<string, string> = {};
      if (process.env.GRIDMAN_FEEDBACK_BASELINE_RENDERER) {
        // Prevent the dev renderer from consuming the one-time startup IPC
        // before the shipped renderer loads. The landing page runs no scripts.
        baselineLanding = createServer((_req, res) => res.end('<!doctype html><html></html>'));
        await new Promise<void>((resolve) => baselineLanding!.listen(0, 'localhost', resolve));
        const address = baselineLanding.address();
        if (!address || typeof address === 'string') throw new Error('No baseline landing port');
        dotEnv.BRUNO_DEV_PORT = String(address.port);
      }
      app = await launchElectronApp({ userDataPath, dotEnv });
      expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userDataPath);
      if (delayCollectionMount) {
        await expect.poll(() => app!.evaluate(({ ipcMain }) => (ipcMain as any)._invokeHandlers.has('renderer:mount-collection'))).toBe(true);
        await app.evaluate(({ ipcMain }) => {
          const handlers = (ipcMain as any)._invokeHandlers;
          const original = handlers.get('renderer:mount-collection');
          ipcMain.removeHandler('renderer:mount-collection');
          ipcMain.handle('renderer:mount-collection', async (...args) => {
            const result = await original(...args);
            await new Promise<void>((resolve) => { (globalThis as any).releaseFeedbackMount = resolve; });
            return result;
          });
        });
      }
      const page = await app.firstWindow();
      // Optional baseline: the unchanged shipped renderer, with the same IPC
      // backend, inside our explicitly verified temporary-data Electron fixture.
      if (process.env.GRIDMAN_FEEDBACK_BASELINE_RENDERER) {
        await page.goto(pathToFileURL(process.env.GRIDMAN_FEEDBACK_BASELINE_RENDERER).toString());
      }
      await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
      await use({ app, page, requestFile });
    } finally {
      clearInterval(sampler);
      if (app) await closeElectronApp(app);
      if (baselineLanding) await new Promise<void>((resolve) => baselineLanding!.close(() => resolve()));
      sampleFocus();
      if (process.platform === 'darwin') {
        expect(focusSamples.length).toBeGreaterThan(1);
        expect(focusSamples.some((name) => /Electron|Gridman/i.test(name))).toBe(false);
      }
    }
  }
});

const collectionChevron = (page: Page) => page.getByTestId('sidebar-collection-row').locator('svg.chevron-icon');
const row = (page: Page, name: string) => page.getByTestId('sidebar-collection-item-row')
  .filter({ has: page.locator('.item-name', { hasText: new RegExp(`^${name}$`) }) });

test.describe('delayed mount', () => {
  test.use({ delayCollectionMount: true });
  test('old expansion snapshots do not open folders after manual browsing starts', async ({ feedback }) => {
    const { app, page } = feedback;
    await collectionChevron(page).click();
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).releaseFeedbackMount)).toBe('function');
    await row(page, 'Parent').locator('.item-name').click();
    await expect(row(page, 'Child')).toBeVisible();
    await expect(page.getByTestId('add-request-cta-folder')).toHaveCount(0);
    await app.evaluate(() => { (globalThis as any).releaseFeedbackMount(); });
    // The snapshot arrives through the real IPC handler, after our user action.
    await page.waitForTimeout(700);
    await expect(page.getByTestId('add-request-cta-folder')).toHaveCount(0);
    await expect(row(page, 'Child').locator('svg.chevron-icon')).not.toHaveClass(/rotate-90/);
  });
});

test('closing and reopening a collection keeps a manually closed child closed', async ({ feedback }) => {
  const { page } = feedback;
  await collectionChevron(page).click();
  await expect(row(page, 'Parent')).toBeVisible();
  if (!(await row(page, 'Parent').locator('svg.chevron-icon').getAttribute('class'))?.includes('rotate-90')) {
    await row(page, 'Parent').locator('.item-name').click();
  }
  if (!(await row(page, 'Child').locator('svg.chevron-icon').getAttribute('class'))?.includes('rotate-90')) {
    await row(page, 'Child').locator('.item-name').click();
  }
  await expect(page.getByTestId('add-request-cta-folder')).toHaveCount(1);
  await row(page, 'Child').locator('.item-name').click();
  await expect(page.getByTestId('add-request-cta-folder')).toHaveCount(0);
  await collectionChevron(page).click();
  await expect(row(page, 'Parent')).toHaveCount(0);
  await collectionChevron(page).click();
  await expect(row(page, 'Child')).toBeVisible();
  await expect(page.getByTestId('add-request-cta-folder')).toHaveCount(0);
});

test('clicking a request after its example restores the live request and response', async ({ feedback }) => {
  const { page } = feedback;
  await collectionChevron(page).click();
  const requestRow = row(page, 'Feedback Request');
  await requestRow.locator('.item-name').click();
  await page.getByTestId('send-arrow-icon').click();
  await expect(page.getByTestId('response-status-code')).toContainText('200');
  // Select an already-run request as a preview, as in the tester's report.
  // Sending it pins its tab; closing/reopening retains the cached response.
  await page.locator('.request-tab.active').hover();
  await page.locator('.request-tab.active').getByTestId('request-tab-close-icon').click();
  await requestRow.locator('.item-name').click();
  await expect(page.getByTestId('response-status-code')).toContainText('200');
  await requestRow.getByTestId('request-item-chevron').click();
  await page.locator('.collection-item-name .item-name').filter({ hasText: /^Saved Example$/ }).click();
  await expect(page.getByTestId('response-example-title')).toContainText('Saved Example');
  await requestRow.locator('.item-name').click();
  await expect(page.getByTestId('send-arrow-icon')).toBeVisible();
  await expect(page.getByTestId('response-status-code')).toContainText('200');
  await expect(page.getByTestId('response-example-title')).toHaveCount(0);
});

test('JSON examples decode Persian for display and paste, preserving raw saved text and undo', async ({ feedback }) => {
  const { page, requestFile } = feedback;
  const original = fs.readFileSync(requestFile, 'utf8');
  await collectionChevron(page).click();
  await row(page, 'Feedback Request').getByTestId('request-item-chevron').click();
  await page.locator('.collection-item-name .item-name').filter({ hasText: /^Saved Example$/ }).click();
  const responseEditor = page.getByTestId('response-pane').locator('.CodeMirror');
  await expect.soft(responseEditor.locator('.CodeMirror-code')).toContainText(readableMessage);
  expect(fs.readFileSync(requestFile, 'utf8')).toBe(original);
  await page.getByTestId('response-example-edit-btn').click();
  const input = responseEditor.locator('textarea');
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, escapedResponse);
  const value = () => responseEditor.evaluate((element) => (element as any).CodeMirror.getValue());
  await expect.poll(value).toContain(readableMessage);
  const pasted = await value();
  expect(pasted).toContain('123456789012345678901');
  expect(pasted.indexOf('"2"')).toBeLessThan(pasted.indexOf('"1"'));
  expect(pasted).toContain(String.raw`"literal":"\\u062F"`);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await expect.poll(value).toBe(escapedResponse);
  await page.getByTestId('response-example-cancel-btn').click();
  expect(fs.readFileSync(requestFile, 'utf8')).toBe(original);
});
