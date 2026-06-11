import { test, expect } from '../../playwright';
import { closeAllCollections, createCollection, createRequest } from '../utils/page';

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
    await page.getByTestId('workflow-add-step').click();
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
});
