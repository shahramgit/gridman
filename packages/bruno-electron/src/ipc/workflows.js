const path = require('path');
const { ipcMain, dialog } = require('electron');
const {
  snapshotRequestForWorkflow,
  computeWorkflowNodeDriftDiff,
  listWorkflows,
  readWorkflowWithDrift,
  writeWorkflowFile,
  createWorkflow,
  deleteWorkflow,
  exportWorkflowToPath,
  importWorkflowFromPath,
  evaluateWorkflowExpression,
  evaluateWorkflowScript
} = require('../workflows');
const { WorkflowRunsStore } = require('../store/workflow-runs');

const workflowRunsStore = new WorkflowRunsStore();

const registerWorkflowsIpc = (mainWindow) => {
  ipcMain.handle('renderer:workflows-list', async (event, { workspacePath }) => {
    return listWorkflows(workspacePath);
  });

  ipcMain.handle('renderer:workflow-read', async (event, { workspacePath, pathname }) => {
    return readWorkflowWithDrift(workspacePath, pathname);
  });

  // Field-level diff between a request node's stored snapshot and the live
  // request file — powers the "View changes" modal shown before syncing.
  ipcMain.handle('renderer:workflow-node-drift-diff', async (event, { workspacePath, pathname, nodeId }) => {
    return computeWorkflowNodeDriftDiff(workspacePath, pathname, nodeId);
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

  // Thin dialog wrapper: the copy/strip/write core lives in ../workflows so it
  // is testable without electron (same split as ipc/collection-export-import).
  ipcMain.handle('renderer:workflow-export', async (event, { workspacePath, pathname }) => {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Workflow',
      defaultPath: path.basename(pathname),
      filters: [{ name: 'Workflow', extensions: ['yml', 'yaml'] }]
    });

    if (canceled || !filePath) {
      return { cancelled: true };
    }

    await exportWorkflowToPath(workspacePath, pathname, filePath);
    return { filePath };
  });

  ipcMain.handle('renderer:workflow-import', async (event, { workspacePath }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Workflow',
      properties: ['openFile'],
      filters: [{ name: 'Workflow', extensions: ['yml', 'yaml'] }]
    });

    if (canceled || !filePaths || !filePaths.length) {
      return { cancelled: true };
    }

    return importWorkflowFromPath(workspacePath, filePaths[0]);
  });

  ipcMain.handle('renderer:workflow-evaluate-expression', async (event, { expression, res, vars }) => {
    return evaluateWorkflowExpression(expression, { res, vars });
  });

  // Script nodes: run plain JS in the same vm sandbox as condition
  // expressions and return the (JSON-sanitized) result to the renderer.
  ipcMain.handle('renderer:workflow-evaluate-script', async (event, { code, res, vars }) => {
    return evaluateWorkflowScript(code, { res, vars });
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
