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
import {
  DOC_HISTORY_LIMIT,
  buildPasteFragment,
  collectClipboardPayload,
  describeDocChange,
  PASTE_OFFSET,
  shouldCoalesceHistoryEntry
} from './workflows-canvas-helpers';

const initialState = {
  // workspaceUid -> [{ pathname, filename, name }]
  listsByWorkspace: {},
  // workflow pathname -> { doc, drift }
  open: {},
  // workflow pathname -> { status, stepResults: { stepId: {...} }, startedAt }
  runs: {},
  // workflow pathname -> [{ startedAt, finishedAt, status, steps, flowVars }]
  history: {},
  // undo/redo snapshots per open workflow:
  // pathname -> { past: [{ doc, meta }], future: [{ doc, meta }] }
  docHistory: {}
};

// Output ports per node type (mirror of the main-process schema). Sticky
// notes are documentation only: no ports, never wired, never executed.
const NODE_OUTPUT_PORTS = {
  start: ['main'],
  request: ['main'],
  map: ['main'],
  setvars: ['main'],
  delay: ['main'],
  condition: ['true', 'false'],
  loop: ['loop', 'done'],
  note: []
};

// Defaults for freshly added non-request nodes (shared by the palette drop,
// the Add Step menu and quick-add).
const NODE_DEFAULTS = {
  map: { name: 'Map response', mappings: [{ from: 'body', path: '$.', target: '' }] },
  setvars: { name: 'Set variables', assignments: [{ name: '', value: '' }] },
  condition: { name: 'Condition', expression: 'res.status === 200' },
  delay: { name: 'Delay', durationMs: 1000 },
  loop: { name: 'For each', source: '', itemVar: 'item', maxIterations: 100 },
  note: { name: 'Note', content: '', tint: 'yellow', size: { width: 200, height: 120 } }
};

// Node types whose output can be pinned n8n-style (reused on the next run
// instead of executing). Condition and loop are excluded: their result decides
// which port fires, so replaying a stored output would be ambiguous.
export const PINNABLE_OUTPUT_TYPES = new Set(['request', 'map', 'setvars', 'delay']);
export const MAX_PINNED_OUTPUT_CHARS = 200000;

const findNode = (doc, nodeId) => (doc.nodes || []).find((node) => node.id === nodeId) || null;

// Replace any existing connection from (source, sourcePort) so each output
// port drives exactly one target.
const setConnection = (doc, source, sourcePort, target) => {
  doc.connections = (doc.connections || []).filter(
    (conn) => !(conn.source === source && conn.sourcePort === sourcePort)
  );
  if (target) {
    doc.connections.push({ id: uuid(), source, sourcePort, target });
  }
};

const outgoingConnection = (doc, source, sourcePort) =>
  (doc.connections || []).find((conn) => conn.source === source && conn.sourcePort === sourcePort) || null;

const incomingConnections = (doc, target) =>
  (doc.connections || []).filter((conn) => conn.target === target);

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
      delete state.docHistory[pathname];
    },
    // Push the pre-change doc onto the undo stack (clearing redo). Consecutive
    // position-only changes of the same node set are coalesced into the
    // existing top entry so a drag doesn't flood the history.
    workflowDocHistoryRecorded: (state, action) => {
      const { pathname, prevDoc, meta } = action.payload;
      const hist = state.docHistory[pathname] || { past: [], future: [] };
      const top = hist.past[hist.past.length - 1];
      if (top && shouldCoalesceHistoryEntry(top.meta, meta)) {
        top.meta = { ...top.meta, at: meta.at };
      } else {
        hist.past.push({ doc: prevDoc, meta });
        if (hist.past.length > DOC_HISTORY_LIMIT) {
          hist.past.shift();
        }
      }
      hist.future = [];
      state.docHistory[pathname] = hist;
    },
    // Move the current doc across the undo/redo boundary. The actual doc swap
    // happens through the normal save path (with history recording skipped).
    workflowDocHistoryStepped: (state, action) => {
      const { pathname, direction, currentDoc } = action.payload;
      const hist = state.docHistory[pathname];
      if (!hist) {
        return;
      }
      if (direction === 'undo' && hist.past.length) {
        hist.past.pop();
        hist.future.push({ doc: currentDoc, meta: { at: Date.now() } });
        if (hist.future.length > DOC_HISTORY_LIMIT) {
          hist.future.shift();
        }
      } else if (direction === 'redo' && hist.future.length) {
        hist.future.pop();
        hist.past.push({ doc: currentDoc, meta: { at: Date.now() } });
        if (hist.past.length > DOC_HISTORY_LIMIT) {
          hist.past.shift();
        }
      }
    },
    workflowDocHistoryCleared: (state, action) => {
      delete state.docHistory[action.payload.pathname];
    },
    workflowRunStarted: (state, action) => {
      const { pathname } = action.payload;
      state.runs[pathname] = {
        status: 'running',
        stepResults: {},
        startedAt: Date.now(),
        cancelling: false,
        log: [{ ts: Date.now(), level: 'info', message: 'Run started' }]
      };
    },
    workflowRunLogged: (state, action) => {
      const { pathname, entry } = action.payload;
      const run = state.runs[pathname];
      if (run) {
        run.log = run.log || [];
        run.log.push(entry);
      }
    },
    workflowRunCancelling: (state, action) => {
      const run = state.runs[action.payload.pathname];
      if (run) {
        run.cancelling = true;
      }
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
    workflowRunNodeData: (state, action) => {
      const { pathname, nodeId, data } = action.payload;
      const run = state.runs[pathname];
      if (run) {
        run.nodeData = run.nodeData || {};
        run.nodeData[nodeId] = data;
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
  workflowDocHistoryRecorded,
  workflowDocHistoryStepped,
  workflowDocHistoryCleared,
  workflowRunStarted,
  workflowRunStepStarted,
  workflowRunStepFinished,
  workflowRunNodeData,
  workflowRunFinished,
  workflowRunLogged,
  workflowRunCancelling,
  workflowHistoryLoaded
} = workflowsSlice.actions;

// Cancellation tokens keyed by workflow pathname. The run loop checks the
// token between nodes; an in-flight request still finishes (cancellation
// takes effect at the next node boundary).
const runCancellation = new Map();

export const cancelWorkflowRun = (pathname) => (dispatch) => {
  const token = runCancellation.get(pathname);
  if (token) {
    token.cancelled = true;
    dispatch(workflowRunCancelling({ pathname }));
  }
};

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
  // An external re-read invalidates the undo snapshots.
  dispatch(workflowDocHistoryCleared({ pathname }));
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
  dispatch(workflowDocHistoryCleared({ pathname }));

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

// Export a workflow to a user-chosen path. The main process shows the save
// dialog and strips pinnedOutput (captured responses can contain tokens/PII).
// Resolves to { cancelled: true } or { filePath }.
export const exportWorkflow = (pathname) => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    throw new Error('No active workspace');
  }

  return window.ipcRenderer.invoke('renderer:workflow-export', {
    workspacePath: workspace.pathname,
    pathname
  });
};

// Import a workflow file into the workspace (validated + normalized in the
// main process, collisions auto-renamed). Resolves to { cancelled: true } or
// { pathname, name }.
export const importWorkflow = () => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    throw new Error('No active workspace');
  }

  const result = await window.ipcRenderer.invoke('renderer:workflow-import', {
    workspacePath: workspace.pathname
  });
  if (result?.cancelled) {
    return result;
  }

  await dispatch(loadWorkflows());
  return result;
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

// Every workflow mutation funnels through here (one write per mutation), so
// this is also where undo history is recorded. Pass { skipHistory: true } when
// applying an undo/redo so restoring a snapshot doesn't record a new entry.
export const saveWorkflowDoc = (pathname, doc, options = {}) => async (dispatch, getState) => {
  const workspace = getActiveWorkspace(getState());
  if (!workspace?.pathname) {
    return;
  }

  const prevDoc = getState().workflows.open[pathname]?.doc || null;
  const result = await window.ipcRenderer.invoke('renderer:workflow-save', {
    workspacePath: workspace.pathname,
    pathname,
    doc
  });
  if (!options.skipHistory && prevDoc) {
    const change = describeDocChange(prevDoc, result.doc);
    const isNoop = change.positionOnly && !change.movedIds.length;
    if (!isNoop) {
      dispatch(workflowDocHistoryRecorded({ pathname, prevDoc, meta: { ...change, at: Date.now() } }));
    }
  }
  dispatch(workflowOpened({ pathname, doc: result.doc, drift: result.drift }));
  await dispatch(loadWorkflows());
};

export const undoWorkflowDoc = (pathname) => async (dispatch, getState) => {
  const workflowsState = getState().workflows;
  const hist = workflowsState.docHistory[pathname];
  const currentDoc = workflowsState.open[pathname]?.doc;
  if (!hist?.past?.length || !currentDoc) {
    return;
  }
  const target = hist.past[hist.past.length - 1].doc;
  dispatch(workflowDocHistoryStepped({ pathname, direction: 'undo', currentDoc }));
  await dispatch(saveWorkflowDoc(pathname, cloneDeep(target), { skipHistory: true }));
};

export const redoWorkflowDoc = (pathname) => async (dispatch, getState) => {
  const workflowsState = getState().workflows;
  const hist = workflowsState.docHistory[pathname];
  const currentDoc = workflowsState.open[pathname]?.doc;
  if (!hist?.future?.length || !currentDoc) {
    return;
  }
  const target = hist.future[hist.future.length - 1].doc;
  dispatch(workflowDocHistoryStepped({ pathname, direction: 'redo', currentDoc }));
  await dispatch(saveWorkflowDoc(pathname, cloneDeep(target), { skipHistory: true }));
};

// Build (but do not save) a fresh request node from a picked request
// (absolute paths). Fetches the snapshot over IPC.
const buildRequestNode = async (workspace, picked, position) => {
  const { snapshot, hash, collectionRelPath, requestRelPath } = await window.ipcRenderer.invoke(
    'renderer:workflow-snapshot-request',
    {
      workspacePath: workspace.pathname,
      collectionPathname: picked.collectionPathname,
      requestPathname: picked.requestPathname
    }
  );

  return {
    id: uuid(),
    type: 'request',
    name: picked.name || snapshot.name,
    position: position || { x: 320, y: 200 },
    pinned: false,
    ref: { collection: collectionRelPath, request: requestRelPath },
    snapshotHash: hash,
    snapshot
  };
};

// Build (but do not save) a fresh non-request node with defaults.
const buildDefaultNode = (nodeType, position) => {
  if (!NODE_DEFAULTS[nodeType]) {
    return null;
  }
  return { id: uuid(), type: nodeType, position: position || { x: 320, y: 200 }, ...cloneDeep(NODE_DEFAULTS[nodeType]) };
};

// Add a request node from a picked request (absolute paths). Returns the new
// node id so the caller can auto-wire it.
export const addWorkflowRequestNode = (pathname, picked, position) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!workspace?.pathname || !openWorkflowState) {
    return null;
  }

  const node = await buildRequestNode(workspace, picked, position);
  const doc = cloneDeep(openWorkflowState.doc);
  doc.nodes.push(node);
  await dispatch(saveWorkflowDoc(pathname, doc));
  return node.id;
};

// Add a non-request node (map / setvars / condition / delay / loop / note)
// with defaults.
export const addWorkflowNode = (pathname, nodeType, position) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return null;
  }

  const node = buildDefaultNode(nodeType, position);
  if (!node) {
    return null;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  doc.nodes.push(node);
  await dispatch(saveWorkflowDoc(pathname, doc));
  return node.id;
};

// Accepts a react-dnd 'collection-item' drag payload (sidebar rows, both
// classic and indexed) and adds it as a request node at the given position.
export const addWorkflowRequestNodeFromDragItem = (pathname, draggedItem, position) => async (dispatch, getState) => {
  const state = getState();
  const collectionPathname = draggedItem.sourceCollectionPathname
    || state.collections.collections.find((c) => c.uid === draggedItem.sourceCollectionUid)?.pathname;
  const requestPathname = draggedItem.sourcePathname || draggedItem.pathname;
  if (!collectionPathname || !requestPathname) {
    throw new Error('Unable to resolve the dragged request');
  }

  return dispatch(addWorkflowRequestNode(pathname, {
    collectionPathname,
    requestPathname,
    name: draggedItem.name
  }, position));
};

export const updateWorkflowNode = (pathname, nodeId, patch) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const node = findNode(doc, nodeId);
  if (!node) {
    return;
  }
  Object.assign(node, patch);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// n8n-style quick add: create a node and wire it up in ONE doc write (so it is
// exactly one undo step). Either append it to a node's output (wireFrom) or
// splice it into an existing connection (insertConnectionId), keeping the
// downstream node connected.
export const quickAddNode = (pathname, { nodeType, picked, position, wireFrom, insertConnectionId }) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!openWorkflowState) {
    return null;
  }

  const node = nodeType === 'request'
    ? (workspace?.pathname && picked ? await buildRequestNode(workspace, picked, position) : null)
    : buildDefaultNode(nodeType, position);
  if (!node) {
    return null;
  }

  // Compose the final doc: node added, spliced connection removed, new
  // connections in place — then save once.
  const doc = cloneDeep(getState().workflows.open[pathname]?.doc || openWorkflowState.doc);
  doc.nodes.push(node);

  const connBefore = insertConnectionId
    ? (doc.connections || []).find((c) => c.id === insertConnectionId)
    : null;
  if (connBefore) {
    doc.connections = (doc.connections || []).filter((c) => c.id !== insertConnectionId);
    setConnection(doc, connBefore.source, connBefore.sourcePort, node.id);
    // Continue downstream from the new node's primary output ('true' for
    // condition, 'loop' for loop, 'main' otherwise).
    const continuationPort = (NODE_OUTPUT_PORTS[node.type] || [])[0];
    if (continuationPort) {
      setConnection(doc, node.id, continuationPort, connBefore.target);
    }
  } else if (wireFrom?.source && findNode(doc, wireFrom.source)) {
    setConnection(doc, wireFrom.source, wireFrom.sourcePort || 'main', node.id);
  }

  await dispatch(saveWorkflowDoc(pathname, doc));
  return node.id;
};

// Persist canvas positions for a batch of nodes in one write (called on drag
// stop — a group drag moves every selected node).
export const updateWorkflowNodePositions = (pathname, moves) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState || !moves?.length) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  let changed = false;
  for (const move of moves) {
    const node = findNode(doc, move.id);
    if (!node || !move.position) {
      continue;
    }
    const next = { x: Math.round(move.position.x), y: Math.round(move.position.y) };
    if (node.position?.x !== next.x || node.position?.y !== next.y) {
      node.position = next;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Auto-layout: place nodes left-to-right by their distance from Start, stacking
// siblings vertically. One save persists every position.
export const layoutWorkflowNodes = (pathname) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const nodes = doc.nodes || [];
  const connections = doc.connections || [];
  const start = nodes.find((n) => n.type === 'start') || nodes[0];
  if (!start) {
    return;
  }

  const childrenOf = (id) => connections.filter((c) => c.source === id).map((c) => c.target);

  // BFS from Start assigns each node a column (depth).
  const depth = { [start.id]: 0 };
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift();
    for (const child of childrenOf(id)) {
      if (depth[child] === undefined) {
        depth[child] = depth[id] + 1;
        queue.push(child);
      }
    }
  }

  // Nodes unreachable from Start get parked in a trailing column. Sticky
  // notes keep their positions — they are annotations, not flow steps.
  let maxDepth = 0;
  for (const value of Object.values(depth)) {
    maxDepth = Math.max(maxDepth, value);
  }
  for (const node of nodes) {
    if (node.type !== 'note' && depth[node.id] === undefined) {
      depth[node.id] = maxDepth + 1;
    }
  }

  const COL_WIDTH = 260;
  const ROW_HEIGHT = 120;
  const rowByColumn = {};
  // Keep document order stable within a column for predictable stacking.
  for (const node of nodes) {
    if (node.type === 'note') {
      continue;
    }
    const col = depth[node.id];
    const row = rowByColumn[col] || 0;
    rowByColumn[col] = row + 1;
    node.position = { x: 40 + col * COL_WIDTH, y: 60 + row * ROW_HEIGHT };
  }

  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Remove a batch of nodes (the Start node is permanent and always filtered
// out) plus any explicitly deleted connections, in ONE doc write. Their
// incident connections are dropped too.
export const removeWorkflowNodes = (pathname, nodeIds, connectionIds = []) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const removeIds = new Set(
    (nodeIds || []).filter((id) => {
      const node = findNode(doc, id);
      return node && node.type !== 'start';
    })
  );
  const removeConnIds = new Set(connectionIds || []);
  if (!removeIds.size && !removeConnIds.size) {
    return;
  }

  // Heal a simple in/out when removing a single node: if it has one incoming
  // and a single 'main' output, reconnect the predecessor to the successor.
  if (removeIds.size === 1) {
    const [nodeId] = removeIds;
    const incoming = incomingConnections(doc, nodeId);
    const mainOut = outgoingConnection(doc, nodeId, 'main');
    if (incoming.length === 1 && mainOut && mainOut.target !== nodeId) {
      setConnection(doc, incoming[0].source, incoming[0].sourcePort, mainOut.target);
    }
  }

  doc.nodes = doc.nodes.filter((candidate) => !removeIds.has(candidate.id));
  doc.connections = (doc.connections || []).filter(
    (conn) => !removeIds.has(conn.source) && !removeIds.has(conn.target) && !removeConnIds.has(conn.id)
  );
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const removeWorkflowNode = (pathname, nodeId) => removeWorkflowNodes(pathname, [nodeId]);

// Paste a clipboard payload ({ nodes, connections }) into the doc: fresh uids
// for every node, internal connections remapped, positions offset so repeat
// pastes don't stack. One doc write. Returns the new node ids.
export const pasteWorkflowNodes = (pathname, clipboard, offsetStep = 1) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState || !clipboard?.nodes?.length) {
    return [];
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const fragment = buildPasteFragment({
    nodes: clipboard.nodes,
    connections: clipboard.connections,
    offset: { x: PASTE_OFFSET * offsetStep, y: PASTE_OFFSET * offsetStep },
    generateId: uuid
  });
  if (!fragment.nodes.length) {
    return [];
  }
  doc.nodes.push(...fragment.nodes);
  doc.connections = [...(doc.connections || []), ...fragment.connections];
  await dispatch(saveWorkflowDoc(pathname, doc));
  return fragment.nodes.map((node) => node.id);
};

// Duplicate a selection in one step (copy + paste without touching the
// clipboard). Returns the new node ids.
export const duplicateWorkflowNodes = (pathname, nodeIds) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return [];
  }
  const clipboard = collectClipboardPayload(openWorkflowState.doc, nodeIds);
  if (!clipboard.nodes.length) {
    return [];
  }
  return dispatch(pasteWorkflowNodes(pathname, clipboard, 1));
};

export const connectWorkflowNodes = (pathname, { source, sourcePort = 'main', target }) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState || !source || !target || source === target) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const sourceNode = findNode(doc, source);
  const targetNode = findNode(doc, target);
  if (!sourceNode || !targetNode || targetNode.type === 'note') {
    return; // sticky notes have no ports
  }
  if (!(NODE_OUTPUT_PORTS[sourceNode.type] || []).includes(sourcePort)) {
    return;
  }
  setConnection(doc, source, sourcePort, target);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Rewire an existing edge to a new source/port/target in one save.
export const reconnectWorkflowConnection = (pathname, connectionId, { source, sourcePort = 'main', target }) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState || !source || !target || source === target) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const sourceNode = findNode(doc, source);
  const targetNode = findNode(doc, target);
  if (!sourceNode || !targetNode || targetNode.type === 'note') {
    return; // sticky notes have no ports
  }
  if (!(NODE_OUTPUT_PORTS[sourceNode.type] || []).includes(sourcePort)) {
    return;
  }
  doc.connections = (doc.connections || []).filter((conn) => conn.id !== connectionId);
  setConnection(doc, source, sourcePort, target);
  await dispatch(saveWorkflowDoc(pathname, doc));
};

export const disconnectWorkflowConnection = (pathname, connectionId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const before = (doc.connections || []).length;
  doc.connections = (doc.connections || []).filter((conn) => conn.id !== connectionId);
  if (doc.connections.length === before) {
    return; // already gone (e.g. removed together with its node) — skip the write
  }
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

export const togglePinWorkflowNode = (pathname, nodeId) => async (dispatch, getState) => {
  const openWorkflowState = getState().workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const node = findNode(doc, nodeId);
  if (!node) {
    return;
  }
  node.pinned = !node.pinned;
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// n8n-style output pin: store the node's latest output on the node itself so
// runs reuse it instead of executing the node. Unpin removes the field. One
// doc write either way (an undoable history entry).
export const toggleWorkflowNodeOutputPin = (pathname, nodeId) => async (dispatch, getState) => {
  const state = getState();
  const openWorkflowState = state.workflows.open[pathname];
  if (!openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const node = findNode(doc, nodeId);
  if (!node || !PINNABLE_OUTPUT_TYPES.has(node.type)) {
    return;
  }

  if (node.pinnedOutput !== undefined) {
    delete node.pinnedOutput;
  } else {
    const output = state.workflows.runs[pathname]?.nodeData?.[nodeId]?.output;
    if (output === undefined) {
      throw new Error('No output to pin yet — execute the node first');
    }
    let serialized;
    try {
      serialized = JSON.stringify(output);
    } catch (error) {
      throw new Error('This output cannot be pinned');
    }
    if (typeof serialized !== 'string') {
      throw new Error('This output cannot be pinned');
    }
    if (serialized.length > MAX_PINNED_OUTPUT_CHARS) {
      throw new Error('Output is too large to pin (over 200k characters)');
    }
    node.pinnedOutput = JSON.parse(serialized);
  }
  await dispatch(saveWorkflowDoc(pathname, doc));
};

// Refresh request-node snapshots from their referenced request files.
export const syncWorkflowNodes = (pathname, nodeIds) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!workspace?.pathname || !openWorkflowState) {
    return;
  }

  const doc = cloneDeep(openWorkflowState.doc);
  const requestNodes = doc.nodes.filter((node) => node.type === 'request');
  const idsToSync = new Set(nodeIds || requestNodes.map((node) => node.id));
  const failures = [];

  for (const node of requestNodes) {
    if (!idsToSync.has(node.id) || !node.ref?.collection || !node.ref?.request) {
      continue;
    }

    try {
      const { snapshot, hash } = await window.ipcRenderer.invoke('renderer:workflow-snapshot-request', {
        workspacePath: workspace.pathname,
        collectionRelPath: node.ref.collection,
        requestRelPath: node.ref.request
      });
      node.snapshot = snapshot;
      node.snapshotHash = hash;
      node.name = snapshot.name || node.name;
    } catch (error) {
      failures.push(`${node.name}: ${error?.message || 'sync failed'}`);
    }
  }

  await dispatch(saveWorkflowDoc(pathname, doc));

  if (failures.length) {
    throw new Error(`Could not sync ${failures.length} node(s) - ${failures[0]}`);
  }
};

// Show the node's referenced request in the sidebar, opening its collection
// first when it is not loaded yet.
export const revealWorkflowNode = (pathname, nodeId) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const node = findNode(state.workflows.open[pathname]?.doc || { nodes: [] }, nodeId);
  if (!workspace?.pathname || !node?.ref?.collection || !node?.ref?.request) {
    throw new Error('This node has no linked request');
  }

  const collectionPathname = `${workspace.pathname}/${node.ref.collection}`;
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

  dispatch(revealRequestInSidebar({
    collectionUid: collection.uid,
    pathname: `${collection.pathname}/${node.ref.request}`
  }));
};

const SUPPORTED_RUN_TYPES = new Set(['http-request', 'graphql-request']);

const findLoadedCollectionForNode = (state, workspacePath, node) => {
  if (!node.ref?.collection) {
    return null;
  }

  // refs use portable forward-slash relative paths
  const normalizedRefPath = normalizePath(`${workspacePath}/${node.ref.collection}`);
  return state.collections.collections.find(
    (collection) => normalizePath(collection.pathname) === normalizedRefPath
  ) || null;
};

const buildRunContextForNode = (state, workspace, node) => {
  const loadedCollection = findLoadedCollectionForNode(state, workspace.pathname, node);
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

  // Detached nodes run against a synthetic collection context: workspace
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

// Global safety cap on node executions, so a manual cycle (wiring without a
// loop node) can never run forever.
const MAX_NODE_EXECUTIONS = 5000;

// Run a single node n8n-style: execute the chain from Start up to and
// including the target node, then stop. Populates the node's input/output.
export const executeWorkflowNode = (pathname, targetNodeId) => (dispatch, getState) =>
  dispatch(runWorkflow(pathname, { targetNodeId }));

export const runWorkflow = (pathname, options = {}) => async (dispatch, getState) => {
  const state = getState();
  const workspace = getActiveWorkspace(state);
  const openWorkflowState = state.workflows.open[pathname];
  if (!workspace?.pathname || !openWorkflowState) {
    return;
  }

  const targetNodeId = options.targetNodeId || null;
  const isSingleNodeRun = Boolean(targetNodeId);
  const { doc } = openWorkflowState;
  dispatch(workflowRunStarted({ pathname }));
  const runStartedAt = Date.now();
  const cancelToken = { cancelled: false };
  runCancellation.set(pathname, cancelToken);
  const log = (level, message) => dispatch(workflowRunLogged({ pathname, entry: { ts: Date.now(), level, message } }));

  const nodesById = {};
  for (const node of doc.nodes) {
    nodesById[node.id] = node;
  }
  const outgoing = (nodeId, port) =>
    (doc.connections || []).find((conn) => conn.source === nodeId && conn.sourcePort === port)?.target || null;

  // flow vars: seeded by workflow inputs, written by map nodes, read by
  // condition nodes and {{var}} interpolation in request nodes
  const flowVars = {};
  for (const input of doc.inputs || []) {
    if (input.name) {
      flowVars[input.name] = input.value;
    }
  }

  let lastResponseContext = null;
  let runStatus = 'passed';
  const recordedNodes = [];
  const loopState = {}; // loopNodeId -> { items, index, startedAt }

  const finishNode = (node, result) => {
    dispatch(workflowRunStepFinished({ pathname, stepId: node.id, result }));
    const bits = [
      result.pinned ? 'pinned' : '',
      result.httpStatus ? `${result.httpStatus}` : '',
      typeof result.iterations === 'number' ? `${result.iterations}x` : '',
      result.durationMs ? `${Math.round(result.durationMs)}ms` : '',
      result.error || ''
    ].filter(Boolean).join(' ');
    log(result.status === 'failed' ? 'error' : 'info', `${node.name}: ${result.status}${bits ? ` (${bits})` : ''}`);
    recordedNodes.push({
      id: node.id,
      name: node.name,
      type: node.type,
      status: result.status,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      iterations: result.iterations,
      pinned: result.pinned,
      error: result.error
    });
  };

  const startNode = doc.nodes.find((node) => node.type === 'start');
  let currentId = startNode ? outgoing(startNode.id, 'main') : null;
  let executions = 0;

  while (currentId && executions < MAX_NODE_EXECUTIONS) {
    if (cancelToken.cancelled) {
      runStatus = 'cancelled';
      break;
    }
    executions += 1;
    const node = nodesById[currentId];
    if (!node) {
      break;
    }

    // Sticky notes are documentation only; they can never be wired, but guard
    // anyway so a malformed doc cannot execute one.
    if (node.type === 'note') {
      break;
    }

    // Muted node: skip execution and pass the current input straight through to
    // the node wired on its primary output.
    if (node.disabled) {
      log('info', `${node.name}: skipped (disabled)`);
      const passthroughPort = node.type === 'condition'
        ? 'true'
        : node.type === 'loop'
          ? 'done'
          : 'main';
      currentId = outgoing(node.id, passthroughPort);
      continue;
    }

    // Snapshot what this node sees as input (the previous response + current
    // flow vars) so the node panel can show Input on the left.
    const inputSnapshot = { response: lastResponseContext, vars: { ...flowVars } };
    const recordData = (output) => dispatch(workflowRunNodeData({ pathname, nodeId: node.id, data: { input: inputSnapshot, output } }));

    // Loop re-entry (via body back-edge) should not reset the loop's UI row.
    const isLoopReentry = node.type === 'loop' && loopState[node.id];
    if (!isLoopReentry) {
      dispatch(workflowRunStepStarted({ pathname, stepId: node.id }));
    }

    // Pinned output (n8n-style pin data): don't execute the node — replay its
    // stored output so downstream input flows from it as usual.
    if (node.pinnedOutput !== undefined && PINNABLE_OUTPUT_TYPES.has(node.type)) {
      const pinnedOutput = cloneDeep(node.pinnedOutput);
      if (node.type === 'request') {
        lastResponseContext = pinnedOutput;
      } else if ((node.type === 'map' || node.type === 'setvars')
        && pinnedOutput && typeof pinnedOutput === 'object' && !Array.isArray(pinnedOutput)) {
        Object.assign(flowVars, pinnedOutput);
      }
      recordData(pinnedOutput);
      finishNode(node, { status: 'passed', pinned: true });
      if (isSingleNodeRun && currentId === targetNodeId) {
        break;
      }
      currentId = outgoing(node.id, 'main');
      continue;
    }

    let firedPort = 'main';

    if (node.type === 'delay') {
      await sleep(node.durationMs || 0);
      finishNode(node, { status: 'passed', durationMs: node.durationMs || 0 });
      recordData({ delayedMs: node.durationMs || 0 });
    } else if (node.type === 'map') {
      const { mapped, errors } = applyMapStep(node, lastResponseContext);
      Object.assign(flowVars, mapped);
      recordData(mapped);
      if (errors.length) {
        finishNode(node, { status: 'failed', error: errors.join('; '), mappedVars: mapped });
        runStatus = 'failed';
        break;
      }
      finishNode(node, { status: 'passed', mappedVars: mapped });
    } else if (node.type === 'setvars') {
      // Each assignment's value is a {{var}} template resolved against the
      // current flow vars (so you can set constants, rename, or combine).
      const setVars = {};
      for (const assignment of node.assignments || []) {
        if (!assignment.name) {
          continue;
        }
        setVars[assignment.name] = String(assignment.value || '').replace(
          /\{\{\s*([\w.-]+)\s*\}\}/g,
          (_match, key) => {
            const val = flowVars[key];
            return val === undefined || val === null ? '' : String(val);
          }
        );
      }
      Object.assign(flowVars, setVars);
      recordData(setVars);
      finishNode(node, { status: 'passed', mappedVars: setVars });
    } else if (node.type === 'condition') {
      try {
        const passed = await window.ipcRenderer.invoke('renderer:workflow-evaluate-expression', {
          expression: node.expression || 'true',
          res: lastResponseContext,
          vars: flowVars
        });
        firedPort = passed ? 'true' : 'false';
        finishNode(node, { status: 'passed', conditionResult: passed });
        recordData({ result: passed });
      } catch (error) {
        finishNode(node, { status: 'failed', error: error?.message || 'Invalid expression' });
        runStatus = 'failed';
        break;
      }
    } else if (node.type === 'loop') {
      let stateForLoop = loopState[node.id];
      if (!stateForLoop) {
        const source = flowVars[node.source];
        if (!Array.isArray(source)) {
          finishNode(node, { status: 'failed', error: `Loop source "${node.source}" is not an array flow variable` });
          runStatus = 'failed';
          break;
        }
        stateForLoop = { items: source, index: 0, startedAt: Date.now() };
        loopState[node.id] = stateForLoop;
      } else {
        stateForLoop.index += 1;
      }

      const limit = Math.min(stateForLoop.items.length, node.maxIterations || 100);
      if (stateForLoop.index < limit) {
        const itemVar = node.itemVar || 'item';
        flowVars[itemVar] = stateForLoop.items[stateForLoop.index];
        flowVars[`${itemVar}Index`] = stateForLoop.index;
        firedPort = 'loop';
      } else {
        finishNode(node, {
          status: 'passed',
          iterations: stateForLoop.index,
          durationMs: Date.now() - stateForLoop.startedAt
        });
        delete loopState[node.id];
        firedPort = 'done';
      }
    } else if (node.type === 'request') {
      if (!node.snapshot?.request) {
        finishNode(node, { status: 'failed', error: 'Node has no snapshot to run' });
        runStatus = 'failed';
        break;
      }
      const requestType = node.snapshot.type || 'http-request';
      if (!SUPPORTED_RUN_TYPES.has(requestType)) {
        finishNode(node, { status: 'failed', error: `${requestType} nodes are not supported in workflow runs yet` });
        runStatus = 'failed';
        break;
      }

      const item = {
        uid: `workflow-node-${node.id}`,
        name: node.name,
        type: requestType,
        request: cloneDeep(node.snapshot.request),
        settings: cloneDeep(node.snapshot.settings || {})
      };
      const { collection, environment, runtimeVariables } = buildRunContextForNode(getState(), workspace, node);
      const startedAt = Date.now();

      try {
        const mergedRuntimeVariables = { ...(runtimeVariables || {}), ...flowVars };
        const response = await sendNetworkRequest(item, collection, environment, mergedRuntimeVariables);
        const httpStatus = Number(response?.status) || 0;
        const failed = httpStatus >= 400;
        lastResponseContext = buildResponseContext(response);

        finishNode(node, {
          status: failed ? 'failed' : 'passed',
          httpStatus,
          statusText: response?.statusText || '',
          durationMs: response?.duration ?? (Date.now() - startedAt),
          size: response?.size
        });
        recordData(lastResponseContext);
        if (failed) {
          runStatus = 'failed';
          break;
        }
      } catch (error) {
        finishNode(node, { status: 'failed', error: error?.message || 'Request failed', durationMs: Date.now() - startedAt });
        runStatus = 'failed';
        break;
      }
    } else {
      // unknown / start node mid-graph: just follow main
      finishNode(node, { status: 'passed' });
    }

    // Single-node run: stop once the target node has executed.
    if (isSingleNodeRun && currentId === targetNodeId) {
      break;
    }

    currentId = outgoing(currentId, firedPort);
    // currentId === null ends the run via this branch (a valid terminus).
  }

  if (executions >= MAX_NODE_EXECUTIONS && runStatus === 'passed') {
    runStatus = 'failed';
    toast.error('Workflow stopped: too many steps (possible loop without a Loop node)');
  }

  runCancellation.delete(pathname);
  log(runStatus === 'failed' ? 'error' : runStatus === 'cancelled' ? 'warn' : 'info',
    isSingleNodeRun ? `Node run ${runStatus}` : `Run ${runStatus}`);
  dispatch(workflowRunFinished({ pathname, status: runStatus, flowVars }));
  if (runStatus === 'failed') {
    toast.error(isSingleNodeRun ? 'Node run failed' : 'Workflow run failed');
  }

  // Single-node runs are not recorded in run history.
  if (isSingleNodeRun) {
    return;
  }

  // persist to run history (best effort)
  try {
    const runs = await window.ipcRenderer.invoke('renderer:workflow-runs-append', {
      pathname,
      run: {
        startedAt: runStartedAt,
        finishedAt: Date.now(),
        status: runStatus,
        steps: recordedNodes,
        flowVars: JSON.parse(JSON.stringify(flowVars))
      }
    });
    dispatch(workflowHistoryLoaded({ pathname, runs }));
  } catch (error) {
    // history is non-critical
  }
};

export default workflowsSlice.reducer;
