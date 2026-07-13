import fs from 'node:fs';
import path from 'node:path';
import { test, expect, Page, closeElectronApp } from '../../../playwright';
import { buildCommonLocators } from '../../utils/page';
import type { ElectronApplication } from 'playwright';

// Phase 3b: content search filters the ordinary sidebar. The regression this
// guards: a collection with hits that was NEVER expanded has no renderer
// index (the index builds on mount), so the filter must auto-mount it —
// previously it sat on 'Loading collection...' until expanded manually.
test.describe.serial('Sidebar search filters collections', () => {
  let app: ElectronApplication;
  let page: Page;
  let locators: ReturnType<typeof buildCommonLocators>;

  const writeCollection = (workspacePath: string, name: string, requestName: string, url: string) => {
    const dir = path.join(workspacePath, 'collections', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bruno.json'),
      JSON.stringify({ version: '1', name, type: 'collection' })
    );
    fs.writeFileSync(
      path.join(dir, `${requestName}.bru`),
      ['meta {', `  name: ${requestName}`, '  type: http', '  seq: 1', '}', '', 'get {', `  url: ${url}`, '}', ''].join('\n')
    );
  };

  test.beforeAll(async ({ launchElectronApp, createTmpDir }) => {
    const userDataPath = await createTmpDir('search-filter-userdata');
    const workspacePath = await createTmpDir('search-filter-ws');

    writeCollection(workspacePath, 'alpha', 'find-me', 'http://localhost:8081/zebra-endpoint');
    writeCollection(workspacePath, 'beta', 'other', 'http://localhost:8081/plain');

    fs.writeFileSync(
      path.join(workspacePath, 'workspace.yml'),
      [
        'opencollection: 1.0.0',
        'info:',
        '  name: Search Filter WS',
        '  type: workspace',
        'collections:',
        '  - name: "alpha"',
        '    path: "collections/alpha"',
        '  - name: "beta"',
        '    path: "collections/beta"',
        'specs: []',
        'docs: \'\'',
        ''
      ].join('\n')
    );

    fs.writeFileSync(
      path.join(userDataPath, 'preferences.json'),
      JSON.stringify({
        workspaces: { lastOpenedWorkspaces: [workspacePath] },
        preferences: {
          onboarding: { hasLaunchedBefore: true, hasSeenWelcomeModal: true }
        }
      }, null, 2)
    );

    app = await launchElectronApp({ userDataPath });
    page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
    locators = buildCommonLocators(page);
  });

  test.afterAll(async () => {
    if (app) {
      await closeElectronApp(app);
    }
  });

  test('content hit in a never-expanded collection shows its filtered rows', async () => {
    await test.step('Both collections are listed, unexpanded', async () => {
      await expect(locators.sidebar.collection('alpha')).toBeVisible();
      await expect(locators.sidebar.collection('beta')).toBeVisible();
    });

    await test.step('Search for a url fragment that only alpha contains', async () => {
      await page.locator('button[title="Search requests"]').click();
      await page.getByTestId('sidebar-search-input').fill('zebra');
    });

    await test.step('alpha auto-mounts and shows the matched request; beta collapses out', async () => {
      // The regression showed a stuck 'Loading collection...' row here.
      await expect(
        page.getByTestId('sidebar-collection-item-row').filter({ hasText: 'find-me' })
      ).toBeVisible({ timeout: 15000 });
      await expect(locators.sidebar.collection('beta')).toHaveCount(0);
    });
  });

  test('clearing the search restores the full collection list', async () => {
    await page.getByTestId('sidebar-search-input').fill('');
    await expect(locators.sidebar.collection('alpha')).toBeVisible();
    await expect(locators.sidebar.collection('beta')).toBeVisible();
  });
});
