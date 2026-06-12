const { ipcMain } = require('electron');
const {
  snapshotRequestForWorkflow,
  listWorkflows,
  readWorkflowWithDrift,
  writeWorkflowFile,
  createWorkflow,
  deleteWorkflow,
  evaluateWorkflowExpression
} = require('../workflows');
const { WorkflowRunsStore } = require('../store/workflow-runs');

const workflowRunsStore = new WorkflowRunsStore();

const registerWorkflowsIpc = () => {
  ipcMain.handle('renderer:workflows-list', async (event, { workspacePath }) => {
    return listWorkflows(workspacePath);
  });

  ipcMain.handle('renderer:workflow-read', async (event, { workspacePath, pathname }) => {
    return readWorkflowWithDrift(workspacePath, pathname);
  });

  ipcMain.handle('renderer:workflow-save', async (event, { workspacePath, pathname, doc }) => {
    // re-read drift after save so the editor reflects the new state
    await writeWorkflowFile(pathname, doc);
    return readWorkflowWithDrift(workspacePath, pathname);
  });

  ipcMain.handle('renderer:workflow-create', async (event, { workspacePath, name }) => {
    return createWorkflow(workspacePath, name);
  });

  ipcMain.handle('renderer:workflow-delete', async (event, { workspacePath, pathname }) => {
    return deleteWorkflow(workspacePath, pathname);
  });

  ipcMain.handle('renderer:workflow-evaluate-expression', async (event, { expression, res, vars }) => {
    return evaluateWorkflowExpression(expression, { res, vars });
  });

  ipcMain.handle('renderer:workflow-runs-list', async (event, { pathname }) => {
    return workflowRunsStore.listRuns(pathname);
  });

  ipcMain.handle('renderer:workflow-runs-append', async (event, { pathname, run }) => {
    return workflowRunsStore.appendRun(pathname, run);
  });

  ipcMain.handle('renderer:workflow-snapshot-request', async (event, options) => {
    const result = await snapshotRequestForWorkflow(options);
    if (!result) {
      throw new Error('Request file not found');
    }
    return result;
  });
};

module.exports = registerWorkflowsIpc;
