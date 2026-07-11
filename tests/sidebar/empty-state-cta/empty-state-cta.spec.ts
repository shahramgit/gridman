import fs from 'node:fs';
import path from 'node:path';
import { test, expect, Page, closeElectronApp } from '../../../playwright';
import { buildCommonLocators } from '../../utils/page';
import type { ElectronApplication } from 'playwright';

// Gridman opens collections through workspaces (workspace.yml), not the
// legacy lastOpenedCollections preference — so this suite builds a temp
// workspace containing the fixture collections and points
// workspaces.lastOpenedWorkspaces at it before launching.
test.describe.serial('Sidebar empty-state "+ Add request" CTA', () => {
  let app: ElectronApplication;
  let page: Page;
  let locators: ReturnType<typeof buildCommonLocators>;

  test.beforeAll(async ({ launchElectronApp, createTmpDir }, testInfo) => {
    const userDataPath = await createTmpDir('cta-userdata');
    const workspacePath = await createTmpDir('cta-workspace');

    // Copy the fixture collections INTO the workspace (workspace-only
    // collection constraint: entries outside the workspace are dropped).
    const fixturesSrc = path.join(path.dirname(testInfo.file), 'fixtures', 'collections');
    const collectionNames = fs.readdirSync(fixturesSrc).filter((name) => !name.startsWith('.'));
    fs.mkdirSync(path.join(workspacePath, 'collections'), { recursive: true });
    for (const name of collectionNames) {
      fs.cpSync(path.join(fixturesSrc, name), path.join(workspacePath, 'collections', name), { recursive: true });
    }

    const workspaceYml = [
      'opencollection: 1.0.0',
      'info:',
      '  name: CTA Workspace',
      '  type: workspace',
      'collections:',
      ...collectionNames.flatMap((name) => [
        `  - name: "${name}"`,
        `    path: "collections/${name}"`
      ]),
      'specs: []',
      'docs: \'\'',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(workspacePath, 'workspace.yml'), workspaceYml);

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

  // Scope an assertion to a single collection — the app is reused across the
  // describe block, and multiple expanded collections would otherwise make
  // `getByTestId('add-request-cta')` match more than one element.
  const collectionScope = (targetPage: Page, name: string) => targetPage.locator(`#collection-${name}`);

  const expandCollection = async (name: string) => {
    const collection = locators.sidebar.collection(name);
    await collection.waitFor({ state: 'visible' });
    await collection.click();
  };

  // Empty collection — CTA should appear

  test('should show CTA for an empty .bru collection', async () => {
    await test.step('Expand empty-bru collection', async () => {
      await expandCollection('empty-bru');
    });

    await test.step('Verify CTA is visible at collection root', async () => {
      await expect(collectionScope(page, 'empty-bru').getByTestId('add-request-cta')).toBeVisible();
    });
  });

  test('should show CTA for an empty .yml collection', async () => {
    await test.step('Expand empty-yml collection', async () => {
      await expandCollection('empty-yml');
    });

    await test.step('Verify CTA is visible at collection root', async () => {
      await expect(collectionScope(page, 'empty-yml').getByTestId('add-request-cta')).toBeVisible();
    });
  });

  // Collection containing only a .js script — CTA should still appear

  test('should show CTA for a .bru collection containing only a .js script', async () => {
    await test.step('Expand bru-with-js collection', async () => {
      await expandCollection('bru-with-js');
    });

    await test.step('Verify CTA is visible at collection root', async () => {
      await expect(collectionScope(page, 'bru-with-js').getByTestId('add-request-cta')).toBeVisible();
    });
  });

  test('should show CTA for a .yml collection containing only a .js script', async () => {
    await test.step('Expand yml-with-js collection', async () => {
      await expandCollection('yml-with-js');
    });

    await test.step('Verify CTA is visible at collection root', async () => {
      await expect(collectionScope(page, 'yml-with-js').getByTestId('add-request-cta')).toBeVisible();
    });
  });

  // Collection has user content — root CTA should be hidden

  test('should hide CTA when .bru collection contains a request', async () => {
    await test.step('Expand bru-with-request collection', async () => {
      await expandCollection('bru-with-request');
      await expect(locators.sidebar.request('bru-echo')).toBeVisible();
    });

    await test.step('Verify CTA is not rendered at collection root', async () => {
      await expect(collectionScope(page, 'bru-with-request').getByTestId('add-request-cta')).toHaveCount(0);
    });
  });

  test('should hide CTA when .yml collection contains a request', async () => {
    await test.step('Expand yml-with-request collection', async () => {
      await expandCollection('yml-with-request');
      await expect(locators.sidebar.request('yml-echo')).toBeVisible();
    });

    await test.step('Verify CTA is not rendered at collection root', async () => {
      await expect(collectionScope(page, 'yml-with-request').getByTestId('add-request-cta')).toHaveCount(0);
    });
  });

  test('should hide root CTA when .bru collection contains a folder', async () => {
    await test.step('Expand bru-folder-with-js collection', async () => {
      await expandCollection('bru-folder-with-js');
      await expect(locators.sidebar.folder('bru-scripts')).toBeVisible();
    });

    await test.step('Verify CTA is not rendered at collection root', async () => {
      await expect(collectionScope(page, 'bru-folder-with-js').getByTestId('add-request-cta')).toHaveCount(0);
    });
  });

  test('should hide root CTA when .yml collection contains a folder', async () => {
    await test.step('Expand yml-with-folder collection', async () => {
      await expandCollection('yml-with-folder');
      await expect(locators.sidebar.folder('yml-scripts')).toBeVisible();
    });

    await test.step('Verify CTA is not rendered at collection root', async () => {
      await expect(collectionScope(page, 'yml-with-folder').getByTestId('add-request-cta')).toHaveCount(0);
    });
  });

  // Folder containing only a .js script — folder CTA should appear

  test('should show folder CTA when a .bru folder contains only a .js script', async () => {
    await test.step('Expand bru-folder-with-js collection and the bru-scripts folder', async () => {
      await expandCollection('bru-folder-with-js');
      const folder = locators.sidebar.folder('bru-scripts');
      await folder.waitFor({ state: 'visible' });
      await folder.click();
    });

    await test.step('Verify folder-level CTA is visible', async () => {
      await expect(collectionScope(page, 'bru-folder-with-js').getByTestId('add-request-cta-folder')).toBeVisible();
    });
  });

  test('should show folder CTA when a .yml folder contains only a .js script', async () => {
    await test.step('Expand yml-with-folder collection and the yml-scripts folder', async () => {
      await expandCollection('yml-with-folder');
      const folder = locators.sidebar.folder('yml-scripts');
      await folder.waitFor({ state: 'visible' });
      await folder.click();
    });

    await test.step('Verify folder-level CTA is visible', async () => {
      await expect(collectionScope(page, 'yml-with-folder').getByTestId('add-request-cta-folder')).toBeVisible();
    });
  });
});
