import cloneDeep from 'lodash/cloneDeep';

// Pure helpers for the workflow canvas (copy/paste/duplicate and undo/redo
// history). Kept store-free so they can be unit tested without Redux.

// Doc-history entries kept per direction (past/future).
export const DOC_HISTORY_LIMIT = 50;

// Consecutive position-only changes of the same node set within this window
// are coalesced into one history entry (so a drag isn't 10 entries).
export const DOC_HISTORY_COALESCE_MS = 1000;

// Default paste offset so pasted nodes don't sit on top of the originals.
export const PASTE_OFFSET = 32;

// Collect a clipboard payload from the doc: deep copies of the requested
// nodes (the Start node is never copyable) plus the connections whose BOTH
// endpoints are in the selection.
export const collectClipboardPayload = (doc, nodeIds) => {
  const wanted = new Set(nodeIds || []);
  const nodes = (doc?.nodes || []).filter((node) => wanted.has(node.id) && node.type !== 'start');
  const copiedIds = new Set(nodes.map((node) => node.id));
  const connections = (doc?.connections || []).filter(
    (conn) => copiedIds.has(conn.source) && copiedIds.has(conn.target)
  );
  return cloneDeep({ nodes, connections });
};

// Build the fragment to splice into a doc on paste/duplicate: every node gets
// a fresh uid, internal connections are remapped onto the new uids, and
// positions shift by `offset`. Returns the idMap so callers can select the
// pasted nodes.
export const buildPasteFragment = ({ nodes, connections, offset = { x: PASTE_OFFSET, y: PASTE_OFFSET }, generateId }) => {
  const idMap = {};
  const newNodes = (nodes || [])
    .filter((node) => node.type !== 'start')
    .map((node) => {
      const copy = cloneDeep(node);
      copy.id = generateId();
      idMap[node.id] = copy.id;
      copy.position = {
        x: Math.round((node.position?.x || 0) + offset.x),
        y: Math.round((node.position?.y || 0) + offset.y)
      };
      return copy;
    });

  const newConnections = (connections || [])
    .filter((conn) => idMap[conn.source] && idMap[conn.target])
    .map((conn) => ({
      ...cloneDeep(conn),
      id: generateId(),
      source: idMap[conn.source],
      target: idMap[conn.target]
    }));

  return { nodes: newNodes, connections: newConnections, idMap };
};

const stripNodePositions = (doc) => ({
  ...doc,
  nodes: (doc?.nodes || []).map(({ position, ...rest }) => rest)
});

// Describe how nextDoc differs from prevDoc for history coalescing:
// positionOnly is true when the docs are identical except for node positions,
// and movedIds lists (sorted) the nodes whose position changed. A result of
// { positionOnly: true, movedIds: [] } means the docs are identical.
export const describeDocChange = (prevDoc, nextDoc) => {
  let positionOnly = false;
  try {
    positionOnly = JSON.stringify(stripNodePositions(prevDoc)) === JSON.stringify(stripNodePositions(nextDoc));
  } catch (error) {
    positionOnly = false;
  }

  const movedIds = [];
  if (positionOnly) {
    const prevById = {};
    for (const node of prevDoc?.nodes || []) {
      prevById[node.id] = node;
    }
    for (const node of nextDoc?.nodes || []) {
      const prev = prevById[node.id];
      if (prev && (prev.position?.x !== node.position?.x || prev.position?.y !== node.position?.y)) {
        movedIds.push(node.id);
      }
    }
    movedIds.sort();
  }

  return { positionOnly, movedIds };
};

// Map a horizontal offset inside a text input's content box to a caret index,
// using a text-measuring function (canvas measureText in the app, a mock in
// tests). Walks substring widths and snaps to the nearest character boundary
// (midpoint rule), clamped to [0, text.length]. Used by DroppableInput to
// insert a dragged field reference at the drop position.
export const caretIndexFromOffset = (text, offsetX, measure) => {
  const value = String(text ?? '');
  if (!value.length || !Number.isFinite(offsetX) || offsetX <= 0) {
    return 0;
  }
  let prevWidth = 0;
  for (let i = 1; i <= value.length; i++) {
    const width = measure(value.slice(0, i));
    if (offsetX < (prevWidth + width) / 2) {
      return i - 1;
    }
    prevWidth = width;
  }
  return value.length;
};

// --- Run-loop decision helpers ----------------------------------------------
// Pure functions extracted from the runWorkflow thunk so the routing/seeding
// semantics are unit-testable without Redux or IPC.

// The scenario the doc's activeScenario points at, or null when unset/stale.
export const findActiveScenario = (doc) => {
  if (!doc?.activeScenario) {
    return null;
  }
  return (doc.scenarios || []).find((scenario) => scenario && scenario.name === doc.activeScenario) || null;
};

// Seed flow vars for a run: doc.inputs are the baseline; the active
// scenario's values are layered on top (scenario wins per key).
export const buildRunSeedVars = (doc) => {
  const vars = {};
  for (const input of doc?.inputs || []) {
    if (input?.name) {
      vars[input.name] = input.value;
    }
  }
  const scenario = findActiveScenario(doc);
  for (const [key, value] of Object.entries(scenario?.values || {})) {
    if (key) {
      vars[key] = value;
    }
  }
  return vars;
};

// A request outcome is a success when the final (redirect-followed) HTTP
// status is 2xx/3xx.
export const isSuccessHttpStatus = (status) => Number(status) >= 200 && Number(status) < 400;

// Where does a request node's outcome leave the node?
// - success -> 'main'
// - failure with a wired 'error' port -> 'error' (failed-but-handled: the
//   step records status 'failed' + handled true, but the run continues and
//   does not count it as a run failure)
// - failure with no 'error' wiring -> halt the run (legacy behavior)
export const resolveRequestOutcomePort = ({ ok, hasErrorConnection }) => {
  if (ok) {
    return { port: 'main', stepStatus: 'passed', handled: false, halt: false };
  }
  if (hasErrorConnection) {
    return { port: 'error', stepStatus: 'failed', handled: true, halt: false };
  }
  return { port: null, stepStatus: 'failed', handled: false, halt: true };
};

// Script node result -> flow var updates. A plain object merges into flow
// vars; any other non-null value is stored under `assignTo` when set (and
// ignored otherwise). null/undefined results never write anything.
export const resolveScriptVars = (value, assignTo) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value };
  }
  if (value !== undefined && value !== null && assignTo) {
    return { [assignTo]: value };
  }
  return {};
};

// Resolve {{var}} placeholders against flow vars (shared by setvars values
// and the loop node's count template).
export const interpolateTemplate = (value, vars) =>
  String(value ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
    const val = vars?.[key];
    return val === undefined || val === null ? '' : String(val);
  });

// Compute a loop node's iteration plan when it is first entered.
// - list mode (default): iterate vars[source], which must be an array.
// - count mode: fire the loop port N times; `items` is null and the item var
//   is the iteration index. The count is a {{var}}-interpolated template that
//   must resolve to a non-negative integer.
// Both modes are capped by maxIterations. Returns { error } on bad input.
export const resolveLoopPlan = (node, vars) => {
  const maxIterations = node?.maxIterations || 100;
  if (node?.mode === 'count') {
    const raw = interpolateTemplate(node.count ?? '', vars).trim();
    const count = Number(raw);
    if (raw === '' || !Number.isInteger(count) || count < 0) {
      return { error: `Loop count "${raw || node.count || ''}" is not a non-negative integer` };
    }
    return { total: Math.min(count, maxIterations), items: null };
  }
  const source = vars?.[node?.source];
  if (!Array.isArray(source)) {
    return { error: `Loop source "${node?.source}" is not an array flow variable` };
  }
  return { total: Math.min(source.length, maxIterations), items: source };
};

// Should a new history entry be folded into the previous one? Only when both
// are position-only changes of the same node set, close together in time.
export const shouldCoalesceHistoryEntry = (topMeta, nextMeta, windowMs = DOC_HISTORY_COALESCE_MS) => {
  if (!topMeta?.positionOnly || !nextMeta?.positionOnly) {
    return false;
  }
  const a = topMeta.movedIds || [];
  const b = nextMeta.movedIds || [];
  if (!a.length || a.length !== b.length || a.some((id, i) => id !== b[i])) {
    return false;
  }
  const elapsed = (nextMeta.at || 0) - (topMeta.at || 0);
  return elapsed >= 0 && elapsed <= windowMs;
};
