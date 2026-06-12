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
    await page.locator('#request-url').locator('textarea').fill('http://localhost:8081/api/echo/headers');
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

    // map step: status -> code, plus body header values -> headerValues array
    await addStep('Map response');
    const mapEditor = page.locator('.step-editor').first();
    await mapEditor.locator('select').selectOption('status');
    await mapEditor.locator('input').last().fill('code');
    await mapEditor.locator('input').last().blur();

    await mapEditor.locator('.editor-add').click();
    const secondMapping = mapEditor.locator('.editor-row').nth(1);
    await secondMapping.locator('input').first().fill('$.headers[*]');
    await secondMapping.locator('input').first().blur();
    await secondMapping.locator('input').last().fill('headerValues');
    await secondMapping.locator('input').last().blur();

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

    // loop step over the mapped header values with a delay inside
    await addStep('Loop (for each)');
    const loopEditor = page.locator('.step-editor').nth(3);
    await loopEditor.locator('input[placeholder="arrayVariable"]').fill('headerValues');
    await loopEditor.locator('input[placeholder="arrayVariable"]').blur();

    const loopBody = page.locator('.loop-body');
    await loopBody.locator('.editor-add').click();
    await page.locator('.tippy-box .dropdown-item').filter({ hasText: 'Delay' }).click();
    const innerDelay = loopBody.locator('input[type="number"]').first();
    await innerDelay.fill('10');
    await innerDelay.blur();

    // run: everything passes; the vars inspector shows code=200 and the
    // loop result reports its iterations
    await page.getByTestId('workflow-run').click();
    await expect(page.locator('.run-summary')).toContainText('Run passed', { timeout: 30000 });
    const vars = page.getByTestId('workflow-vars');
    await expect(vars).toContainText('code');
    await expect(vars).toContainText('200');
    await expect(vars).toContainText('headerValues');
    // the loop step reports its iteration count as "Nx"
    await expect(page.locator('.step-result').filter({ hasText: /\d+x/ }).first()).toBeVisible({ timeout: 5000 });

    // canvas view renders nodes for the steps
    await page.getByTestId('workflow-view-toggle').click();
    await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('workflow-canvas')).toContainText('For each');

    // selecting a node opens the editor panel
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('workflow-step-panel')).toContainText('Show in sidebar', { timeout: 5000 });

    // dragging a request from the sidebar onto the canvas adds a step
    const nodeCountBefore = await page.locator('.react-flow__node').count();
    const sidebarRequest = page.locator('.collection-item-name').filter({ hasText: requestName }).first();
    await sidebarRequest.dragTo(page.getByTestId('workflow-canvas'));
    await expect(page.locator('.react-flow__node')).toHaveCount(nodeCountBefore + 1, { timeout: 10000 });

    // the node toolbar can delete the selected step
    await page.locator('.react-flow__node').last().click();
    await page.getByTitle('Delete step').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(nodeCountBefore, { timeout: 10000 });

    await page.getByTestId('workflow-view-toggle').click();

    // run history records the run
    await page.getByTestId('workflow-history-toggle').click();
    const historyPanel = page.getByTestId('workflow-history');
    await expect(historyPanel).toBeVisible({ timeout: 5000 });
    await expect(historyPanel).toContainText('passed');

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
