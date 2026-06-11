import { test, expect } from '../../playwright';
import type { Page } from '@playwright/test';
import { closeAllCollections, createCollection, createRequest } from '../utils/page';

// Workspace config broadcasts shortly after first launch can steal tab focus
// once; re-open the workflow tab from the sidebar until its editor is shown.
const ensureWorkflowEditorOpen = async (page: Page, workflowName: string) => {
  const addStepButton = page.getByTestId('workflow-add-step');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await addStepButton.isVisible().catch(() => false)) {
      return;
    }
    await page.locator('.workflow-row').filter({ hasText: workflowName }).click();
    await page.waitForTimeout(500);
  }
  await expect(addStepButton).toBeVisible();
};

test.describe('Workflows', () => {
  test.afterEach(async ({ page }) => {
    await closeAllCollections(page);
  });

  test('classic collection: add step, drift on edit, sync, reveal', async ({ page, createTmpDir }) => {
    const collectionName = 'wf-classic';
    const requestName = 'wf-ping';
    const workflowName = `flow-${Date.now()}`;

    await createCollection(page, collectionName, await createTmpDir(collectionName));
    await createRequest(page, requestName, collectionName);

    // give the request a URL and save it
    await page.locator('#request-url .CodeMirror').click();
    await page.locator('#request-url').locator('textarea').fill('http://localhost:8081/ping');
    await page.locator('#request-actions').getByTitle('Save Request').click();

    // create a workflow
    await page.getByTestId('workflows-add').click();
    const createModal = page.locator('.bruno-modal-card').filter({ hasText: 'New Workflow' });
    await createModal.waitFor({ state: 'visible', timeout: 5000 });
    await createModal.locator('#workflow-name').fill(workflowName);
    await createModal.getByRole('button', { name: 'Create', exact: true }).click();

    // workflow tab opens; add the request as a step
    await ensureWorkflowEditorOpen(page, workflowName);
    await page.getByTestId('workflow-add-step').click();
    await page.locator('.tippy-box .dropdown-item').filter({ hasText: 'Request' }).first().click();
    const picker = page.locator('.bruno-modal-card').filter({ hasText: 'Add Request Step' });
    await picker.waitFor({ state: 'visible', timeout: 5000 });
    await picker.locator('input').fill(requestName);
    await picker.locator('button').filter({ hasText: requestName }).first().click();

    const stepStatus = page.locator('.step-status');
    await expect(stepStatus).toHaveText('linked', { timeout: 10000 });

    // edit the request (navigate via sidebar; the tab strip groups tabs per
    // collection so the request tab is not visible while the workflow tab is
    // active) and save it
    await page.locator('.collection-item-name').filter({ hasText: requestName }).first().click();
    await page.locator('#request-url .CodeMirror').click();
    await page.locator('#request-url').locator('textarea').fill('http://localhost:8081/ping?edited=1');
    await page.locator('#request-actions').getByTitle('Save Request').click();

    // switch back to the workflow via the sidebar; drift must appear
    await page.locator('.workflow-row').filter({ hasText: workflowName }).click();
    await expect(stepStatus).toHaveText('changed', { timeout: 10000 });

    // sync all; step must return to linked
    await page.getByRole('button', { name: 'Sync all' }).click();
    await expect(stepStatus).toHaveText('linked', { timeout: 10000 });

    // reveal from the workflow step: the sidebar row must flash visibly.
    // wait out any flash left over from earlier tab activity first.
    await expect(page.locator('.collection-item-name.reveal-flash')).toHaveCount(0, { timeout: 5000 });

    await page.locator('.step-row').hover();
    await page.getByTitle('Show request in sidebar').click();
    await expect(
      page.locator('.collection-item-name.reveal-flash').filter({ hasText: requestName })
    ).toBeVisible({ timeout: 5000 });

    // cleanup: delete the workflow file via the UI
    const workflowRow = page.locator('.workflow-row').filter({ hasText: workflowName });
    await workflowRow.hover();
    await workflowRow.getByTitle('Delete workflow').click();
    const deleteModal = page.locator('.bruno-modal-card').filter({ hasText: 'Delete Workflow' });
    await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(workflowRow).toHaveCount(0, { timeout: 5000 });
  });

  test('phase 2: map, condition, delay and flow vars in a run', async ({ page, createTmpDir }) => {
    const collectionName = 'wf-phase2';
    const requestName = 'wf-echo';
    const workflowName = `flow2-${Date.now()}`;

    await createCollection(page, collectionName, await createTmpDir(collectionName));
    await createRequest(page, requestName, collectionName);

    await page.locator('#request-url .CodeMirror').click();
    await page.locator('#request-url').locator('textarea').fill('http://localhost:8081/ping');
    await page.locator('#request-actions').getByTitle('Save Request').click();

    // create workflow with one request step
    await page.getByTestId('workflows-add').click();
    const createModal = page.locator('.bruno-modal-card').filter({ hasText: 'New Workflow' });
    await createModal.waitFor({ state: 'visible', timeout: 5000 });
    await createModal.locator('#workflow-name').fill(workflowName);
    await createModal.getByRole('button', { name: 'Create', exact: true }).click();

    const addStep = async (label: string) => {
      await ensureWorkflowEditorOpen(page, workflowName);
      await page.getByTestId('workflow-add-step').click();
      await page.locator('.tippy-box .dropdown-item').filter({ hasText: label }).click();
    };

    await addStep('Request');
    const picker = page.locator('.bruno-modal-card').filter({ hasText: 'Add Request Step' });
    await picker.waitFor({ state: 'visible', timeout: 5000 });
    await picker.locator('input').fill(requestName);
    await picker.locator('button').filter({ hasText: requestName }).first().click();
    await expect(page.locator('.step-status')).toHaveText('linked', { timeout: 10000 });

    // map step: status -> code
    await addStep('Map response');
    const mapEditor = page.locator('.step-editor').first();
    await mapEditor.locator('select').selectOption('status');
    await mapEditor.locator('input').last().fill('code');
    await mapEditor.locator('input').last().blur();

    // condition step: vars.code === 200
    await addStep('Condition');
    const conditionEditor = page.locator('.step-editor').nth(1);
    await conditionEditor.locator('.expression-input').fill('vars.code === 200');
    await conditionEditor.locator('.expression-input').blur();

    // delay step: 100ms
    await addStep('Delay');
    const delayEditor = page.locator('.step-editor').nth(2);
    await delayEditor.locator('input[type="number"]').fill('100');
    await delayEditor.locator('input[type="number"]').blur();

    // run: everything passes and the vars inspector shows code=200
    await page.getByTestId('workflow-run').click();
    await expect(page.locator('.run-summary')).toContainText('Run passed', { timeout: 30000 });
    const vars = page.getByTestId('workflow-vars');
    await expect(vars).toContainText('code');
    await expect(vars).toContainText('200');

    // flip the condition to false with stop: run reports stopped
    await conditionEditor.locator('.expression-input').fill('vars.code === 999');
    await conditionEditor.locator('.expression-input').blur();
    await page.getByTestId('workflow-run').click();
    await expect(page.locator('.run-summary')).toContainText('Run stopped', { timeout: 30000 });

    // cleanup
    const workflowRow = page.locator('.workflow-row').filter({ hasText: workflowName });
    await workflowRow.hover();
    await workflowRow.getByTitle('Delete workflow').click();
    const deleteModal = page.locator('.bruno-modal-card').filter({ hasText: 'Delete Workflow' });
    await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(workflowRow).toHaveCount(0, { timeout: 5000 });
  });
});
