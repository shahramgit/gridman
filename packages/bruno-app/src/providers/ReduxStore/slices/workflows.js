import { createSlice } from '@reduxjs/toolkit';
import cloneDeep from 'lodash/cloneDeep';
import toast from 'react-hot-toast';
import { uuid } from 'utils/common';
import { findEnvironmentInCollection, getGlobalEnvironmentVariables } from 'utils/collections';
import { normalizePath } from 'utils/common/path';
import { sendNetworkRequest } from 'utils/network';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';

const initialState = {
  // workspaceUid -> [{ pathname, filename, name }]
  listsByWorkspace: {},
  // workflow pathname -> { doc, drift }
  open: {},
  // workflow pathname -> { status, stepResults: { stepId: {...} }, startedAt }
  runs: {}
};

export const workflowsSlice = createSlice({
  name: 'workflows',
  initialState,
  reducers: {
    workflowsListed: (state, action) => {
      const { workspaceUid, workflows } = action.payload;
      state.listsByWorkspace[workspaceUid] = workflows;
    },
    workflowOpened: (state, action) => {
      const { pathname, doc, drift } = action.payload;
      state.open[pathname] = { doc, drift };
    },
    workflowClosed: (state, action) => {
      const { pathname } = action.payload;
      delete state.open[pathname];
      delete state.runs[pathname];
    },
    workflowRunStarted: (state, action) => {
      const { pathname } = action.payload;
      state.runs[pathname] = {
        status: 'running',
        stepResults: {},
        startedAt: Date.now()
      };
    },
    workflowRunStepStarted: (state, action) => {
      const { pathname, stepId } = action.payload;
      const run = state.runs[pathname];
      if (run) {
        run.stepResults[stepId] = { status: 'running', startedAt: Date.now() };
      }
    },
    workflowRunStepFinished: (state, action) => {
      const { pathname, stepId, result } = action.payload;
      const run = state.runs[pathname];
      if (run) {
        run.stepResults[stepId] = { ...run.stepResults[stepId], ...result };
      }
    },
    workflowRunFinished: (state, action) => {
      const { pathname, status } = action.payload;
      const run = state.runs[pathname];
      if (run) {
        run.status = status;
        run.finishedAt = Date.now();
      }
    }
  }
});

export const {
  workflowsListed,
  workflowOpened,
  workflowClosed,
  workflowRunStarted,
  workflowRunStepStarted,
  workflowRunStepFinished,
  workflowRunFinished
} = workflowsSlice.actions;

const getActiveWorkspace = (state) => {
  const { workspaces, activeWorkspaceUid } = state.workspaces;
  return workspaces.find((workspace) => workspace.uid === activeWorkspaceUid);
};

export const loadWorkflows = () => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    return;
  }

  const workflows = await window.ipcRenderer.invoke('renderer:workflows-list', {
    workspacePath: workspace.pathname
  });
  dispatch(workflowsListed({ workspaceUid: workspace.uid, workflows }));
};

// Re-read the workflow document and recompute drift without touching tabs.
export const refreshWorkflow = (pathname) => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    return;
  }

  const { doc, drift } = await window.ipcRenderer.invoke('renderer:workflow-read', {
    workspacePath: workspace.pathname,
    pathname
  });
  dispatch(workflowOpened({ pathname, doc, drift }));
};

export const openWorkflow = (pathname) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  if (!workspace?.pathname) {
    return;
  }

  const { doc, drift } = await window.ipcRenderer.invoke('renderer:workflow-read', {
    workspacePath: workspace.pathname,
    pathname
  });
  dispatch(workflowOpened({ pathname, doc, drift }));

  const tabUid = `workflow:${pathname}`;
  const existingTab = state.tabs.tabs.find((tab) => tab.uid === tabUid);
  if (existingTab) {
    dispatch(focusTab({ uid: tabUid }));
  } else {
    dispatch(addTab({
      uid: tabUid,
      collectionUid: workspace.uid,
      type: 'workflow',
      itemPathname: pathname
    }));
  }
};

export const createWorkflow = (name) => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    throw new Error('No active workspace');
  }

  const pathname = await window.ipcRenderer.invoke('renderer:workflow-create', {
    workspacePath: workspace.pathname,
    name
  });
  await dispatch(loadWorkflows());
  await dispatch(openWorkflow(pathname));
  return pathname;
};

export const deleteWorkflow = (pathname) => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    return;
  }

  await window.ipcRenderer.invoke('renderer:workflow-delete', {
    workspacePath: workspace.pathname,
    pathname
  });
  dispatch(workflowClosed({ pathname }));
  await dispatch(loadWorkflows());
};

export const saveWorkflowDoc = (pathname, doc) => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    return;
  }

  const result = await window.ipcRenderer.invoke('renderer:workflow-save', {
    workspacePath: workspace.pathname,
    pathname,
    doc
  });
  dispatch(workflowOpened({ pathname, doc: result.doc, drift: result.drift }));
  await dispatch(loadWorkflows());
};

// picked: { collectionPathname, requestPathname, name } (absolute paths)
export const addWorkflowRequestStep = (pathname, picked) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!workspace?.pathname || !openWorkflowState) {
    return;
  }

  const { snapshot, hash, collectionRelPath, requestRelPath } = await window.ipcRenderer.invoke(
    'renderer:workflow-snapshot-request',
    {
      workspacePath: workspace.pathname,
      collectionPathname: picked.collectionPathname,
      requestPathname: picked.requestPathname
    }
  );

  const doc = cloneDeep(openWorkflowState.doc);
  doc.steps.push({
    id: uuid(),
    type: 'request',
    name: picked.name || snapshot.name,
    pinned: false,
    ref: {
      collection: collectionRelPath,
      request: requestRelPath
    },
    snapshotHash: hash,
    snapshot
  });

  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const removeWorkflowStep = (pathname, stepId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  doc.steps = doc.steps.filter((step) => step.id !== stepId);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const moveWorkflowStep = (pathname, stepId, direction) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const index = doc.steps.findIndex((step) => step.id === stepId);
  const targetIndex = index + direction;
  if (index === -1 || targetIndex < 0 || targetIndex >= doc.steps.length) {
    return;
  }

  const [step] = doc.steps.splice(index, 1);
  doc.steps.splice(targetIndex, 0, step);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const togglePinWorkflowStep = (pathname, stepId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const step = doc.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    return;
  }
  step.pinned = !step.pinned;
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Refresh step snapshots from their referenced request files.
export const syncWorkflowSteps = (pathname, stepIds) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!workspace?.pathname || !openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const idsToSync = new Set(stepIds || doc.steps.map((step) => step.id));

  for (const step of doc.steps) {
    if (!idsToSync.has(step.id) || !step.ref?.collection || !step.ref?.request) {
      continue;
    }

    try {
      const { snapshot, hash } = await window.ipcRenderer.invoke('renderer:workflow-snapshot-request', {
        workspacePath: workspace.pathname,
        collectionRelPath: step.ref.collection,
        requestRelPath: step.ref.request
      });
      step.snapshot = snapshot;
      step.snapshotHash = hash;
      step.name = snapshot.name || step.name;
    } catch (error) {
      // detached steps keep their snapshot
    }
  }

  await dispatch(saveWorkflowDoc(pathname, doc));
};

const SUPPORTED_RUN_TYPES = new Set(['http-request', 'graphql-request']);

const findLoadedCollectionForStep = (state, workspacePath, step) => {
  if (!step.ref?.collection) {
    return null;
  }

  // refs use portable forward-slash relative paths
  const normalizedRefPath = normalizePath(`${workspacePath}/${step.ref.collection}`);
  return state.collections.collections.find(
    (collection) => normalizePath(collection.pathname) === normalizedRefPath
  ) || null;
};

const buildRunContextForStep = (state, workspace, step) => {
  const loadedCollection = findLoadedCollectionForStep(state, workspace.pathname, step);
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
  const globalEnvironmentVariables = getGlobalEnvironmentVariables({
    globalEnvironments,
    activeGlobalEnvironmentUid
  });

  if (loadedCollection) {
    const collectionCopy = cloneDeep(loadedCollection);
    collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;
    collectionCopy.promptVariables = {};
    const environment = findEnvironmentInCollection(collectionCopy, collectionCopy.activeEnvironmentUid);
    return { collection: collectionCopy, environment, runtimeVariables: collectionCopy.runtimeVariables || {} };
  }

  // Detached steps run against a synthetic collection context: workspace
  // global environment variables only.
  return {
    collection: {
      uid: `workflow-synthetic-${workspace.uid}`,
      pathname: workspace.pathname,
      name: 'Workflow',
      brunoConfig: { version: '1', name: 'workflow', type: 'collection' },
      root: {},
      environments: [],
      globalEnvironmentVariables,
      promptVariables: {},
      runtimeVariables: {},
      settings: {}
    },
    environment: null,
    runtimeVariables: {}
  };
};

export const runWorkflow = (pathname) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!workspace?.pathname || !openWorkflowState) {
    return;
  }

  const { doc } = openWorkflowState;
  dispatch(workflowRunStarted({ pathname }));

  let runStatus = 'passed';

  for (const step of doc.steps) {
    dispatch(workflowRunStepStarted({ pathname, stepId: step.id }));

    if (!step.snapshot?.request) {
      dispatch(workflowRunStepFinished({
        pathname,
        stepId: step.id,
        result: { status: 'failed', error: 'Step has no snapshot to run' }
      }));
      runStatus = 'failed';
      break;
    }

    const stepType = step.snapshot.type || 'http-request';
    if (!SUPPORTED_RUN_TYPES.has(stepType)) {
      dispatch(workflowRunStepFinished({
        pathname,
        stepId: step.id,
        result: { status: 'failed', error: `${stepType} steps are not supported in workflow runs yet` }
      }));
      runStatus = 'failed';
      break;
    }

    const item = {
      uid: `workflow-step-${step.id}`,
      name: step.name,
      type: stepType,
      request: cloneDeep(step.snapshot.request),
      settings: cloneDeep(step.snapshot.settings || {})
    };

    const { collection, environment, runtimeVariables } = buildRunContextForStep(getState(), workspace, step);
    const startedAt = Date.now();

    try {
      const response = await sendNetworkRequest(item, collection, environment, runtimeVariables);
      const httpStatus = Number(response?.status) || 0;
      const failed = httpStatus >= 400;

      dispatch(workflowRunStepFinished({
        pathname,
        stepId: step.id,
        result: {
          status: failed ? 'failed' : 'passed',
          httpStatus,
          statusText: response?.statusText || '',
          durationMs: response?.duration ?? (Date.now() - startedAt),
          size: response?.size
        }
      }));

      if (failed) {
        runStatus = 'failed';
        break;
      }
    } catch (error) {
      dispatch(workflowRunStepFinished({
        pathname,
        stepId: step.id,
        result: {
          status: 'failed',
          error: error?.message || 'Request failed',
          durationMs: Date.now() - startedAt
        }
      }));
      runStatus = 'failed';
      break;
    }
  }

  dispatch(workflowRunFinished({ pathname, status: runStatus }));
  if (runStatus === 'failed') {
    toast.error('Workflow run failed');
  }
};

export default workflowsSlice.reducer;
