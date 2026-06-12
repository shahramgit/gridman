import { createSlice } from '@reduxjs/toolkit';
import { JSONPath } from 'jsonpath-plus';
import cloneDeep from 'lodash/cloneDeep';
import toast from 'react-hot-toast';
import { uuid } from 'utils/common';
import { findEnvironmentInCollection, getGlobalEnvironmentVariables } from 'utils/collections';
import { normalizePath } from 'utils/common/path';
import { sendNetworkRequest } from 'utils/network';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import { revealRequestInSidebar } from 'providers/ReduxStore/slices/app';
import { openMultipleCollections } from 'providers/ReduxStore/slices/collections/actions';

const initialState = {
  // workspaceUid -> [{ pathname, filename, name }]
  listsByWorkspace: {},
  // workflow pathname -> { doc, drift }
  open: {},
  // workflow pathname -> { status, stepResults: { stepId: {...} }, startedAt }
  runs: {},
  // workflow pathname -> [{ startedAt, finishedAt, status, steps, flowVars }]
  history: {}
};

// Locate the steps array a step operation targets: the document root or a
// loop step's body.
const getStepsContainer = (doc, parentStepId) => {
  if (!parentStepId) {
    return doc.steps;
  }
  const parent = doc.steps.find((step) => step.id === parentStepId);
  return parent?.type === 'loop' ? parent.steps : null;
};

const walkSteps = (steps, visit) => {
  for (const step of steps || []) {
    visit(step);
    if (step.type === 'loop') {
      walkSteps(step.steps, visit);
    }
  }
};

const findStepDeep = (steps, stepId) => {
  let found = null;
  walkSteps(steps, (step) => {
    if (step.id === stepId) {
      found = step;
    }
  });
  return found;
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
      const { pathname, status, flowVars } = action.payload;
      const run = state.runs[pathname];
      if (run) {
        run.status = status;
        run.finishedAt = Date.now();
        run.flowVars = flowVars || {};
      }
    },
    workflowHistoryLoaded: (state, action) => {
      const { pathname, runs } = action.payload;
      state.history[pathname] = runs || [];
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
  workflowRunFinished,
  workflowHistoryLoaded
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

const removeStepDeep = (steps, stepId) => {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index !== -1) {
    return steps.splice(index, 1)[0];
  }
  for (const step of steps) {
    if (step.type === 'loop') {
      const removed = removeStepDeep(step.steps || [], stepId);
      if (removed) {
        return removed;
      }
    }
  }
  return null;
};

// Move a step to a new container (document root or a loop body) and index.
// Used by canvas drag interactions.
export const restructureWorkflowStep = (pathname, stepId, { parentStepId = null, index }) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const step = findStepDeep(doc.steps, stepId);
  if (!step) {
    return;
  }
  // loops stay at the root (no nested loops)
  if (step.type === 'loop' && parentStepId) {
    return;
  }

  const removed = removeStepDeep(doc.steps, stepId);
  if (!removed) {
    return;
  }

  const container = getStepsContainer(doc, parentStepId);
  if (!container) {
    // target loop vanished; restore at root end
    doc.steps.push(removed);
  } else {
    const boundedIndex = Math.min(Math.max(Number(index) || 0, 0), container.length);
    container.splice(boundedIndex, 0, removed);
  }

  await dispatch(saveWorkflowDoc(pathname, doc));
};

// picked: { collectionPathname, requestPathname, name } (absolute paths)
export const addWorkflowRequestStep = (pathname, picked, parentStepId, insertIndex) => async (dispatch, getState) => {
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
  const container = getStepsContainer(doc, parentStepId);
  if (!container) {
    return;
  }
  const newStep = {
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
  };
  const boundedIndex = Number.isInteger(insertIndex)
    ? Math.min(Math.max(insertIndex, 0), container.length)
    : container.length;
  container.splice(boundedIndex, 0, newStep);

  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Append a non-request step (map / condition / delay / loop) with defaults.
export const addWorkflowStep = (pathname, stepType, parentStepId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const defaults = {
    map: { name: 'Map response', mappings: [{ from: 'body', path: '$.', target: '' }] },
    condition: { name: 'Condition', expression: 'res.status === 200', onFalse: 'stop' },
    delay: { name: 'Delay', durationMs: 1000 },
    loop: { name: 'For each', source: '', itemVar: 'item', maxIterations: 100, steps: [] }
  };
  if (!defaults[stepType] || (stepType === 'loop' && parentStepId)) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const container = getStepsContainer(doc, parentStepId);
  if (!container) {
    return;
  }
  container.push({ id: uuid(), type: stepType, ...defaults[stepType] });
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Patch fields of a step (used by the inline editors). Steps are looked up
// recursively so loop bodies are covered.
export const updateWorkflowStep = (pathname, stepId, patch) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const step = findStepDeep(doc.steps, stepId);
  if (!step) {
    return;
  }
  Object.assign(step, patch);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const updateWorkflowInputs = (pathname, inputs) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  doc.inputs = inputs;
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Accepts a react-dnd 'collection-item' drag payload (sidebar rows, both
// classic and indexed) and adds it as a request step.
export const addWorkflowRequestStepFromDragItem = (pathname, draggedItem, parentStepId, insertIndex) => async (dispatch, getState) => {
  const state = getState();
  const collectionPathname = draggedItem.sourceCollectionPathname
    || state.collections.collections.find((c) => c.uid === draggedItem.sourceCollectionUid)?.pathname;
  const requestPathname = draggedItem.sourcePathname || draggedItem.pathname;
  if (!collectionPathname || !requestPathname) {
    throw new Error('Unable to resolve the dragged request');
  }

  return dispatch(addWorkflowRequestStep(pathname, {
    collectionPathname,
    requestPathname,
    name: draggedItem.name
  }, parentStepId, insertIndex));
};

export const removeWorkflowStep = (pathname, stepId, parentStepId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const container = getStepsContainer(doc, parentStepId);
  if (!container) {
    return;
  }
  const index = container.findIndex((step) => step.id === stepId);
  if (index === -1) {
    return;
  }
  container.splice(index, 1);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const moveWorkflowStep = (pathname, stepId, direction, parentStepId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const container = getStepsContainer(doc, parentStepId);
  if (!container) {
    return;
  }
  const index = container.findIndex((step) => step.id === stepId);
  const targetIndex = index + direction;
  if (index === -1 || targetIndex < 0 || targetIndex >= container.length) {
    return;
  }

  const [step] = container.splice(index, 1);
  container.splice(targetIndex, 0, step);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const togglePinWorkflowStep = (pathname, stepId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const step = findStepDeep(doc.steps, stepId);
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
  const allRequestSteps = [];
  walkSteps(doc.steps, (step) => {
    if (step.type === 'request') {
      allRequestSteps.push(step);
    }
  });
  const idsToSync = new Set(stepIds || allRequestSteps.map((step) => step.id));
  const failures = [];

  for (const step of allRequestSteps) {
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
      // detached steps keep their snapshot; surface everything else
      failures.push(`${step.name}: ${error?.message || 'sync failed'}`);
    }
  }

  await dispatch(saveWorkflowDoc(pathname, doc));

  if (failures.length) {
    throw new Error(`Could not sync ${failures.length} step(s) - ${failures[0]}`);
  }
};

// Show the step's referenced request in the sidebar, opening its collection
// first when it is not loaded yet.
export const revealWorkflowStep = (pathname, stepId) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const step = findStepDeep(state.workflows.open[pathname]?.doc?.steps || [], stepId);
  if (!workspace?.pathname || !step?.ref?.collection || !step?.ref?.request) {
    throw new Error('This step has no linked request');
  }

  const collectionPathname = `${workspace.pathname}/${step.ref.collection}`;
  const requestPathname = `${collectionPathname}/${step.ref.request}`;
  const findLoaded = () => getState().collections.collections.find(
    (collection) => normalizePath(collection.pathname) === normalizePath(collectionPathname)
  );

  let collection = findLoaded();
  if (!collection) {
    await dispatch(openMultipleCollections([collectionPathname], { workspacePath: workspace.pathname }));
    collection = findLoaded();
  }
  if (!collection) {
    throw new Error('The referenced collection is not available in this workspace');
  }

  // Build the request path from the loaded collection's native pathname so
  // separator-insensitive matching works on Windows too.
  dispatch(revealRequestInSidebar({
    collectionUid: collection.uid,
    pathname: `${collection.pathname}/${step.ref.request}`
  }));
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

// Normalize a response into the shape exposed to map/condition steps:
// { status, statusText, headers (lowercased map), body (parsed JSON when
// possible) }.
const buildResponseContext = (response) => {
  let body = response?.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      // keep raw string body
    }
  }

  const headerMap = {};
  const headers = response?.headers;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (Array.isArray(header)) {
        headerMap[String(header[0]).toLowerCase()] = header[1];
      } else if (header?.name) {
        headerMap[String(header.name).toLowerCase()] = header.value;
      }
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      headerMap[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  return {
    status: Number(response?.status) || 0,
    statusText: response?.statusText || '',
    headers: headerMap,
    body: body ?? null
  };
};

const applyMapStep = (step, responseContext) => {
  const mapped = {};
  const errors = [];

  for (const mapping of step.mappings || []) {
    if (!mapping.target) {
      continue;
    }

    let value;
    try {
      if (mapping.from === 'status') {
        value = responseContext?.status;
      } else if (mapping.from === 'header') {
        value = responseContext?.headers?.[String(mapping.path || '').toLowerCase()];
      } else {
        const matches = JSONPath({ path: mapping.path || '$', json: responseContext?.body ?? null, wrap: true });
        value = matches.length > 1 ? matches : matches[0];
      }
    } catch (error) {
      errors.push(`${mapping.target}: ${error?.message || 'invalid path'}`);
      continue;
    }

    if (value === undefined) {
      errors.push(`${mapping.target}: no value at ${mapping.from === 'body' ? mapping.path : mapping.from}`);
    } else {
      mapped[mapping.target] = value;
    }
  }

  return { mapped, errors };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const loadWorkflowRunHistory = (pathname) => async (dispatch) => {
  const runs = await window.ipcRenderer.invoke('renderer:workflow-runs-list', { pathname });
  dispatch(workflowHistoryLoaded({ pathname, runs }));
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
  const runStartedAt = Date.now();

  // flow vars: seeded by workflow inputs, written by map steps, read by
  // condition steps and {{var}} interpolation in request steps
  const flowVars = {};
  for (const input of doc.inputs || []) {
    if (input.name) {
      flowVars[input.name] = input.value;
    }
  }

  // shared executor state across nesting levels
  const exec = {
    lastResponseContext: null,
    // 'passed' | 'failed' | 'stopped'
    runStatus: 'passed',
    // flat per-step summaries for the run history record
    recordedSteps: []
  };

  const finishStep = (step, result) => {
    dispatch(workflowRunStepFinished({ pathname, stepId: step.id, result }));
    exec.recordedSteps.push({
      id: step.id,
      name: step.name,
      type: step.type,
      status: result.status,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      iterations: result.iterations,
      error: result.error
    });
  };

  // Executes steps sequentially; returns false when the run must not
  // continue (failure or condition stop).
  const executeSteps = async (steps) => {
    for (const step of steps) {
      dispatch(workflowRunStepStarted({ pathname, stepId: step.id }));

      if (step.type === 'delay') {
        await sleep(step.durationMs || 0);
        finishStep(step, { status: 'passed', durationMs: step.durationMs || 0 });
        continue;
      }

      if (step.type === 'map') {
        const { mapped, errors } = applyMapStep(step, exec.lastResponseContext);
        Object.assign(flowVars, mapped);

        if (errors.length) {
          finishStep(step, { status: 'failed', error: errors.join('; '), mappedVars: mapped });
          exec.runStatus = 'failed';
          return false;
        }
        finishStep(step, { status: 'passed', mappedVars: mapped });
        continue;
      }

      if (step.type === 'condition') {
        try {
          const passed = await window.ipcRenderer.invoke('renderer:workflow-evaluate-expression', {
            expression: step.expression || 'true',
            res: exec.lastResponseContext,
            vars: flowVars
          });

          if (passed) {
            finishStep(step, { status: 'passed', conditionResult: true });
            continue;
          }

          if (step.onFalse === 'continue') {
            finishStep(step, { status: 'passed', conditionResult: false });
            continue;
          }

          finishStep(step, { status: 'stopped', conditionResult: false });
          exec.runStatus = 'stopped';
          return false;
        } catch (error) {
          finishStep(step, { status: 'failed', error: error?.message || 'Invalid expression' });
          exec.runStatus = 'failed';
          return false;
        }
      }

      if (step.type === 'loop') {
        const source = flowVars[step.source];
        if (!Array.isArray(source)) {
          finishStep(step, {
            status: 'failed',
            error: `Loop source "${step.source}" is not an array flow variable`
          });
          exec.runStatus = 'failed';
          return false;
        }

        const itemVar = step.itemVar || 'item';
        const iterations = Math.min(source.length, step.maxIterations || 100);
        const loopStartedAt = Date.now();

        for (let index = 0; index < iterations; index += 1) {
          flowVars[itemVar] = source[index];
          flowVars[`${itemVar}Index`] = index;
          const ok = await executeSteps(step.steps || []);
          if (!ok) {
            finishStep(step, {
              status: exec.runStatus,
              iterations: index + 1,
              durationMs: Date.now() - loopStartedAt
            });
            return false;
          }
        }

        finishStep(step, { status: 'passed', iterations, durationMs: Date.now() - loopStartedAt });
        continue;
      }

      // request step
      if (!step.snapshot?.request) {
        finishStep(step, { status: 'failed', error: 'Step has no snapshot to run' });
        exec.runStatus = 'failed';
        return false;
      }

      const stepType = step.snapshot.type || 'http-request';
      if (!SUPPORTED_RUN_TYPES.has(stepType)) {
        finishStep(step, { status: 'failed', error: `${stepType} steps are not supported in workflow runs yet` });
        exec.runStatus = 'failed';
        return false;
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
        // flow vars win over collection runtime vars during interpolation
        const mergedRuntimeVariables = { ...(runtimeVariables || {}), ...flowVars };
        const response = await sendNetworkRequest(item, collection, environment, mergedRuntimeVariables);
        const httpStatus = Number(response?.status) || 0;
        const failed = httpStatus >= 400;
        exec.lastResponseContext = buildResponseContext(response);

        finishStep(step, {
          status: failed ? 'failed' : 'passed',
          httpStatus,
          statusText: response?.statusText || '',
          durationMs: response?.duration ?? (Date.now() - startedAt),
          size: response?.size
        });

        if (failed) {
          exec.runStatus = 'failed';
          return false;
        }
      } catch (error) {
        finishStep(step, {
          status: 'failed',
          error: error?.message || 'Request failed',
          durationMs: Date.now() - startedAt
        });
        exec.runStatus = 'failed';
        return false;
      }
    }

    return true;
  };

  await executeSteps(doc.steps);

  dispatch(workflowRunFinished({ pathname, status: exec.runStatus, flowVars }));
  if (exec.runStatus === 'failed') {
    toast.error('Workflow run failed');
  }

  // persist to run history (best effort)
  try {
    const runs = await window.ipcRenderer.invoke('renderer:workflow-runs-append', {
      pathname,
      run: {
        startedAt: runStartedAt,
        finishedAt: Date.now(),
        status: exec.runStatus,
        steps: exec.recordedSteps,
        flowVars: JSON.parse(JSON.stringify(flowVars))
      }
    });
    dispatch(workflowHistoryLoaded({ pathname, runs }));
  } catch (error) {
    // history is non-critical
  }
};

export default workflowsSlice.reducer;
