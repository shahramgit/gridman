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
    test.setTimeout(60000);
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
    const deleteIcon = workflowRow.getByTitle('Delete workflow');
    await expect(deleteIcon).toBeVisible();
    await deleteIcon.click();
    const deleteModal = page.locator('.bruno-modal-card').filter({ hasText: 'Delete Workflow' });
    await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(workflowRow).toHaveCount(0, { timeout: 5000 });
  });

  test('graph: map flow vars, run, canvas editing and history', async ({ page, createTmpDir }) => {
    test.setTimeout(60000);
    const collectionName = 'wf-graph';
    const requestName = 'wf-echo';
    const workflowName = `flowg-${Date.now()}`;

    await createCollection(page, collectionName, await createTmpDir(collectionName));
    await createRequest(page, requestName, collectionName);

    await page.locator('#request-url .CodeMirror').click();
    await page.locator('#request-url').locator('textarea').fill('http://localhost:8081/api/echo/headers');
    await page.locator('#request-actions').getByTitle('Save Request').click();

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

    // Request node (auto-wired from Start), then a Map node after it. Both keep
    // the graph linear, so the List view stays editable.
    await addStep('Request');
    const picker = page.locator('.bruno-modal-card').filter({ hasText: 'Add Request Step' });
    await picker.waitFor({ state: 'visible', timeout: 5000 });
    await picker.locator('input').fill(requestName);
    await picker.locator('button').filter({ hasText: requestName }).first().click();
    await expect(page.locator('.step-status')).toHaveText('linked', { timeout: 10000 });

    await addStep('Map response');
    const mapEditor = page.locator('.step-editor').first();
    await mapEditor.locator('select').selectOption('status');
    await mapEditor.locator('input').last().fill('code');
    await mapEditor.locator('input').last().blur();

    // run: passes; the mapped flow var code=200 shows in the inspector
    await page.getByTestId('workflow-run').click();
    await expect(page.locator('.run-summary')).toContainText('Run passed', { timeout: 30000 });
    const vars = page.getByTestId('workflow-vars');
    await expect(vars).toContainText('code');
    await expect(vars).toContainText('200');

    // canvas renders Start + request + map nodes, plus the node palette
    await page.getByTestId('workflow-view-toggle').click();
    await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('workflow-canvas')).toContainText('Start');
    await expect(page.getByTestId('workflow-canvas')).toContainText('Map response');
    await expect(page.getByTestId('workflow-palette')).toBeVisible();

    // selecting the request node opens its editor panel with input/output data
    await page.locator('.react-flow__node').filter({ hasText: requestName }).first().click({ force: true });
    await expect(page.getByTestId('workflow-node-panel')).toContainText('Show in sidebar', { timeout: 5000 });
    await expect(page.getByTestId('workflow-node-io')).toContainText('Output', { timeout: 5000 });

    // per-node Execute runs the chain up to the node (logs a node run)
    await page.getByTestId('workflow-execute-node').click();
    await page.getByTestId('workflow-logs-toggle').click();
    await expect(page.getByTestId('workflow-logs')).toContainText('Node run passed', { timeout: 10000 });
    // (palette + sidebar drag-to-canvas are exercised manually: Playwright's
    // synthetic HTML5 drag is unreliable and can register as a click that
    // navigates away from the workflow tab.)

    // run history records the run
    await page.getByTestId('workflow-history-toggle').click();
    const historyPanel = page.getByTestId('workflow-history');
    await expect(historyPanel).toBeVisible({ timeout: 5000 });
    await expect(historyPanel).toContainText('passed');

    // cleanup
    const workflowRow = page.locator('.workflow-row').filter({ hasText: workflowName });
    await workflowRow.hover();
    const deleteIcon = workflowRow.getByTitle('Delete workflow');
    await expect(deleteIcon).toBeVisible();
    await deleteIcon.click();
    const deleteModal = page.locator('.bruno-modal-card').filter({ hasText: 'Delete Workflow' });
    await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(workflowRow).toHaveCount(0, { timeout: 5000 });
  });
});
