import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useDrag } from 'react-dnd';
import toast from 'react-hot-toast';
import {
  IconArrowsSplit,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconHistory,
  IconLayoutList,
  IconLoader2,
  IconPin,
  IconPinned,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconRoute,
  IconTarget,
  IconTerminal2,
  IconTrash,
  IconVariable,
  IconWand,
  IconWorld
} from '@tabler/icons';

import {
  addWorkflowNode,
  addWorkflowRequestNode,
  addWorkflowRequestNodeFromDragItem,
  cancelWorkflowRun,
  connectWorkflowNodes,
  disconnectWorkflowConnection,
  executeWorkflowNode,
  layoutWorkflowNodes,
  loadWorkflowRunHistory,
  quickAddNode,
  reconnectWorkflowConnection,
  refreshWorkflow,
  removeWorkflowNode,
  revealWorkflowNode,
  runWorkflow,
  syncWorkflowNodes,
  togglePinWorkflowNode,
  updateWorkflowInputs,
  updateWorkflowNode,
  updateWorkflowNodePosition
} from 'providers/ReduxStore/slices/workflows';
import Modal from 'components/Modal';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import RequestPickerModal from './RequestPickerModal';
import WorkflowCanvas from './WorkflowCanvas';
import StyledWrapper from './StyledWrapper';

const STATUS_LABELS = { linked: 'linked', drifted: 'changed', detached: 'detached' };

// The single "continuation" output for each node type, used when auto-wiring
// a freshly added node into a linear chain.
const PRIMARY_PORT = { start: 'main', request: 'main', map: 'main', delay: 'main', condition: 'true', loop: 'loop' };

const formatDuration = (ms) => {
  if (typeof ms !== 'number' || Number.isNaN(ms)) {
    return '';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
};

const formatTime = (ts) => {
  if (!ts) {
    return '';
  }
  try {
    return new Date(ts).toLocaleString();
  } catch (error) {
    return '';
  }
};

const formatVarValue = (value) => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
};

const StepResult = ({ result }) => {
  if (!result) {
    return null;
  }
  return (
    <span className={`step-result result-${result.status}`}>
      {result.status === 'running' ? (
        <IconLoader2 size={14} className="animate-spin" />
      ) : result.status === 'passed' ? (
        <IconCircleCheck size={14} />
      ) : (
        <IconCircleX size={14} />
      )}
      <span>
        {result.httpStatus ? `${result.httpStatus} ` : ''}
        {typeof result.iterations === 'number' ? `${result.iterations}x ` : ''}
        {formatDuration(result.durationMs)}
        {result.conditionResult === true ? ' true' : result.conditionResult === false ? ' false' : ''}
        {result.mappedVars && Object.keys(result.mappedVars).length
          ? ` ${Object.keys(result.mappedVars).map((key) => `${key}=${formatVarValue(result.mappedVars[key]).slice(0, 24)}`).join(', ')}`
          : ''}
        {result.error ? ` ${result.error}` : ''}
      </span>
    </span>
  );
};

const MapNodeEditor = ({ node, onChange }) => {
  const mappings = node.mappings || [];
  const updateMapping = (index, patch) => {
    onChange({ mappings: mappings.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  };
  return (
    <div className="step-editor">
      {mappings.map((mapping, index) => (
        <div key={index} className="editor-row">
          <select value={mapping.from} onChange={(e) => updateMapping(index, { from: e.target.value })}>
            <option value="body">Body (JSONPath)</option>
            <option value="header">Header</option>
            <option value="status">Status</option>
          </select>
          {mapping.from !== 'status' && (
            <input
              type="text"
              placeholder={mapping.from === 'header' ? 'header name' : '$.data.token'}
              defaultValue={mapping.path}
              onBlur={(e) => updateMapping(index, { path: e.target.value })}
            />
          )}
          <span className="editor-arrow">to</span>
          <input
            type="text"
            placeholder="variable name"
            defaultValue={mapping.target}
            onBlur={(e) => updateMapping(index, { target: e.target.value })}
          />
          <ActionIcon label="Remove mapping" onClick={() => onChange({ mappings: mappings.filter((_, i) => i !== index) })}>
            <IconTrash size={13} stroke={1.5} />
          </ActionIcon>
        </div>
      ))}
      <button type="button" className="editor-add" onClick={() => onChange({ mappings: [...mappings, { from: 'body', path: '$.', target: '' }] })}>
        + mapping
      </button>
    </div>
  );
};

const SetVarsNodeEditor = ({ node, onChange }) => {
  const assignments = node.assignments || [];
  const update = (index, patch) => {
    onChange({ assignments: assignments.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  };
  return (
    <div className="step-editor">
      {assignments.map((assignment, index) => (
        <div key={index} className="editor-row">
          <input
            type="text"
            placeholder="variable name"
            defaultValue={assignment.name}
            onBlur={(e) => update(index, { name: e.target.value })}
          />
          <span className="editor-arrow">=</span>
          <input
            type="text"
            placeholder="value or {{otherVar}}"
            defaultValue={assignment.value}
            onBlur={(e) => update(index, { value: e.target.value })}
          />
          <ActionIcon label="Remove" onClick={() => onChange({ assignments: assignments.filter((_, i) => i !== index) })}>
            <IconTrash size={13} stroke={1.5} />
          </ActionIcon>
        </div>
      ))}
      <button type="button" className="editor-add" onClick={() => onChange({ assignments: [...assignments, { name: '', value: '' }] })}>
        + variable
      </button>
      <div className="editor-hint">Values resolve {'{{var}}'} placeholders against the current flow variables.</div>
    </div>
  );
};

const ConditionNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <input
        type="text"
        className="expression-input"
        placeholder="res.status === 200 && vars.token"
        defaultValue={node.expression}
        onBlur={(e) => onChange({ expression: e.target.value })}
      />
    </div>
    <div className="editor-hint">Wire the <strong>true</strong> and <strong>false</strong> outputs on the canvas. Expression sees res and vars.</div>
  </div>
);

const DelayNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <input type="number" min="0" step="100" defaultValue={node.durationMs} onBlur={(e) => onChange({ durationMs: Number(e.target.value) || 0 })} />
      <span className="editor-arrow">ms</span>
    </div>
  </div>
);

const LoopNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <span className="editor-arrow">for each</span>
      <input type="text" placeholder="item" style={{ width: 80 }} defaultValue={node.itemVar} onBlur={(e) => onChange({ itemVar: e.target.value || 'item' })} />
      <span className="editor-arrow">in vars.</span>
      <input type="text" placeholder="arrayVariable" defaultValue={node.source} onBlur={(e) => onChange({ source: e.target.value })} />
      <span className="editor-arrow">max</span>
      <input type="number" min="1" style={{ width: 80 }} defaultValue={node.maxIterations} onBlur={(e) => onChange({ maxIterations: Number(e.target.value) || 100 })} />
    </div>
    <div className="editor-hint">
      Wire the <strong>loop</strong> output through the body and back into this node; <strong>done</strong> continues after the loop.
      Exposes vars.{node.itemVar || 'item'} and vars.{node.itemVar || 'item'}Index.
    </div>
  </div>
);

const NodeParamEditor = ({ node, onChange }) => {
  if (node.type === 'map') return <MapNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'setvars') return <SetVarsNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'condition') return <ConditionNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'delay') return <DelayNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'loop') return <LoopNodeEditor node={node} onChange={onChange} />;
  return null;
};

const WorkflowInputs = ({ inputs, onChange }) => {
  const updateInput = (index, patch) => onChange(inputs.map((input, i) => (i === index ? { ...input, ...patch } : input)));
  return (
    <div className="workflow-inputs">
      <div className="inputs-title">Inputs</div>
      {inputs.map((input, index) => (
        <div key={index} className="editor-row">
          <input type="text" placeholder="name" defaultValue={input.name} onBlur={(e) => updateInput(index, { name: e.target.value })} />
          <span className="editor-arrow">=</span>
          <input type="text" placeholder="value" defaultValue={input.value} onBlur={(e) => updateInput(index, { value: e.target.value })} />
          <ActionIcon label="Remove input" onClick={() => onChange(inputs.filter((_, i) => i !== index))}>
            <IconTrash size={13} stroke={1.5} />
          </ActionIcon>
        </div>
      ))}
      <button type="button" className="editor-add" onClick={() => onChange([...inputs, { name: '', value: '' }])}>
        + input
      </button>
    </div>
  );
};

const RunHistory = ({ runs }) => {
  if (!runs?.length) {
    return <div className="history-empty">No runs recorded yet.</div>;
  }
  return (
    <div className="history-list" data-testid="workflow-history">
      {runs.map((run, index) => (
        <details key={index} className={`history-run run-${run.status}`}>
          <summary>
            <span className={`history-status status-dot-${run.status}`} />
            <span className="history-time">{formatTime(run.startedAt)}</span>
            <span className="history-summary">
              {run.status}
              {run.finishedAt && run.startedAt ? ` in ${formatDuration(run.finishedAt - run.startedAt)}` : ''}
              {` - ${run.steps?.length || 0} step${(run.steps?.length || 0) === 1 ? '' : 's'}`}
            </span>
          </summary>
          <div className="history-details">
            {(run.steps || []).map((step, stepIndex) => (
              <div key={stepIndex} className={`history-step step-${step.status}`}>
                <span className="history-step-name">{step.name}</span>
                <span className="history-step-info">
                  {step.status}
                  {step.httpStatus ? ` ${step.httpStatus}` : ''}
                  {typeof step.iterations === 'number' ? ` ${step.iterations}x` : ''}
                  {step.durationMs ? ` ${formatDuration(step.durationMs)}` : ''}
                  {step.error ? ` ${step.error}` : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
};

const TYPE_ICONS = { request: IconWorld, map: IconWand, setvars: IconVariable, condition: IconArrowsSplit, delay: IconClock, loop: IconRepeat };
const VIEW_STORAGE_KEY = 'gridman.workflow-view';

const PALETTE_ITEMS = [
  { type: 'map', label: 'Map', icon: IconWand },
  { type: 'setvars', label: 'Set Vars', icon: IconVariable },
  { type: 'condition', label: 'Condition', icon: IconArrowsSplit },
  { type: 'delay', label: 'Delay', icon: IconClock },
  { type: 'loop', label: 'Loop', icon: IconRepeat }
];

// A draggable palette chip (react-dnd source) that the canvas accepts as a
// 'workflow-node-template' drop to add a node at the cursor.
const PaletteChip = ({ item }) => {
  // No custom drag preview: let the browser render the chip itself as the
  // drag ghost so the user sees what they're dragging.
  const [{ isDragging }, drag] = useDrag({
    type: 'workflow-node-template',
    item: { nodeType: item.type },
    collect: (monitor) => ({ isDragging: monitor.isDragging() })
  });
  const Icon = item.icon;
  return (
    <div ref={drag} className="palette-chip" style={{ opacity: isDragging ? 0.4 : 1 }} title={`Drag ${item.label} onto the canvas`}>
      <Icon size={15} stroke={1.6} />
      <span>{item.label}</span>
    </div>
  );
};

const NodePalette = () => (
  <div className="node-palette" data-testid="workflow-palette">
    <div className="palette-title">Nodes</div>
    {PALETTE_ITEMS.map((item) => <PaletteChip key={item.type} item={item} />)}
    <div className="palette-hint">Drag requests from the sidebar too.</div>
  </div>
);

const LOG_LEVEL_PREFIX = { info: '·', warn: '!', error: '✗' };

const LogPane = ({ run }) => (
  <div className="log-pane" data-testid="workflow-logs">
    <div className="log-pane-title">
      Logs{run?.status ? ` — ${run.status}` : ''}
    </div>
    <div className="log-lines">
      {(run?.log || []).length === 0 ? (
        <div className="log-empty">No run yet.</div>
      ) : (
        run.log.map((entry, i) => (
          <div key={i} className={`log-line log-${entry.level}`}>
            <span className="log-time">{new Date(entry.ts).toLocaleTimeString()}</span>
            <span className="log-msg">{LOG_LEVEL_PREFIX[entry.level] || '·'} {entry.message}</span>
          </div>
        ))
      )}
    </div>
  </div>
);

// Follow the primary output from Start to produce a linear order, and report
// whether the graph is a simple chain (no branches/loops/fan-in).
const analyzeGraph = (doc) => {
  const nodesById = {};
  for (const node of doc.nodes) {
    nodesById[node.id] = node;
  }
  const start = doc.nodes.find((node) => node.type === 'start');
  const connections = doc.connections || [];
  const outCount = {};
  const inCount = {};
  for (const conn of connections) {
    outCount[conn.source] = (outCount[conn.source] || 0) + 1;
    inCount[conn.target] = (inCount[conn.target] || 0) + 1;
  }

  const order = [];
  const seen = new Set();
  let linear = true;
  let cursor = start;
  while (cursor) {
    const primary = PRIMARY_PORT[cursor.type] || 'main';
    // any extra outputs/inputs, loops, or branches mean it's not a plain chain
    if (cursor.type === 'loop' || cursor.type === 'condition') {
      linear = false;
    }
    if ((outCount[cursor.id] || 0) > 1) {
      linear = false;
    }
    const next = connections.find((conn) => conn.source === cursor.id && conn.sourcePort === primary)?.target;
    if (!next || seen.has(next)) {
      break;
    }
    if ((inCount[next] || 0) > 1) {
      linear = false;
    }
    const nextNode = nodesById[next];
    if (!nextNode) {
      break;
    }
    order.push(nextNode);
    seen.add(next);
    cursor = nextNode;
  }

  // nodes not reached by the linear walk -> graph isn't a single chain
  const nonStart = doc.nodes.filter((node) => node.type !== 'start');
  if (order.length !== nonStart.length) {
    linear = false;
  }

  // a node whose 'main' output is free is the chain tail to auto-wire onto
  return { order, linear, nodesById, start, outCount };
};

const WorkflowEditor = ({ pathname }) => {
  const dispatch = useDispatch();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [syncPromptOpen, setSyncPromptOpen] = useState(false);
  const [inputsOpen, setInputsOpen] = useState(false);
  // n8n-style quick add: context for the "+" menu opened from a node output or
  // a connection. Holds where to wire and where to place the new node.
  const [quickAdd, setQuickAdd] = useState(null);
  const [quickAddPickerCtx, setQuickAddPickerCtx] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [view, setViewState] = useState(() => {
    try {
      return window.localStorage.getItem(VIEW_STORAGE_KEY) || 'list';
    } catch (error) {
      return 'list';
    }
  });
  const openWorkflowState = useSelector((state) => state.workflows.open[pathname]);
  const run = useSelector((state) => state.workflows.runs[pathname]);
  const history = useSelector((state) => state.workflows.history[pathname]);

  const setView = (nextView) => {
    setViewState(nextView);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, nextView);
    } catch (error) {
      // non-critical
    }
  };

  useEffect(() => {
    dispatch(refreshWorkflow(pathname)).catch(() => {});
    dispatch(loadWorkflowRunHistory(pathname)).catch(() => {});
  }, [dispatch, pathname]);

  const doc = openWorkflowState?.doc;
  const drift = openWorkflowState?.drift;

  const graph = useMemo(() => (doc ? analyzeGraph(doc) : null), [doc]);

  const canvasHandlers = useMemo(() => ({
    onConnect: (conn) => dispatch(connectWorkflowNodes(pathname, conn)).catch((e) => toast.error(e?.message || 'Unable to connect')),
    onReconnect: (id, conn) => dispatch(reconnectWorkflowConnection(pathname, id, conn)).catch((e) => toast.error(e?.message || 'Unable to rewire')),
    onDeleteConnection: (id) => dispatch(disconnectWorkflowConnection(pathname, id)).catch(() => {}),
    onMoveNode: (id, position) => dispatch(updateWorkflowNodePosition(pathname, id, position)).catch(() => {}),
    onDeleteNode: (id) => {
      setSelectedNodeId(null);
      dispatch(removeWorkflowNode(pathname, id)).catch((e) => toast.error(e?.message || 'Unable to delete node'));
    },
    onRevealNode: (id) => dispatch(revealWorkflowNode(pathname, id)).catch((e) => toast.error(e?.message || 'Unable to locate request')),
    onToggleDisabled: (id, disabled) => dispatch(updateWorkflowNode(pathname, id, { disabled })).catch((e) => toast.error(e?.message || 'Unable to update node')),
    onDropRequest: (item, position) => dispatch(addWorkflowRequestNodeFromDragItem(pathname, item, position)).catch((e) => toast.error(e?.message || 'Unable to add request')),
    onDropNode: (nodeType, position) => dispatch(addWorkflowNode(pathname, nodeType, position)).catch((e) => toast.error(e?.message || 'Unable to add node')),
    onTidy: () => dispatch(layoutWorkflowNodes(pathname)).catch((e) => toast.error(e?.message || 'Unable to tidy layout')),
    onQuickAddOutput: ({ source, sourcePort, position, screen }) => setQuickAdd({ wireFrom: { source, sourcePort }, position, screen }),
    onInsertOnEdge: ({ connectionId, position, screen }) => setQuickAdd({ insertConnectionId: connectionId, position, screen })
  }), [dispatch, pathname]);

  if (!openWorkflowState) {
    return <StyledWrapper><div className="p-4">Loading workflow...</div></StyledWrapper>;
  }

  const isRunning = run?.status === 'running';
  const driftedUnpinned = doc.nodes
    .filter((node) => node.type === 'request' && !node.pinned && drift?.[node.id]?.status === 'drifted')
    .map((node) => node.id);

  // Auto-wire a newly added node onto the chain tail (the node whose primary
  // output is free), preferring the selected node, then Start.
  const autoWireSource = () => {
    if (selectedNodeId) {
      const node = graph.nodesById[selectedNodeId];
      if (node) {
        const port = PRIMARY_PORT[node.type] || 'main';
        const taken = (doc.connections || []).some((c) => c.source === node.id && c.sourcePort === port);
        if (!taken) {
          return { source: node.id, sourcePort: port };
        }
      }
    }
    // Start, then any node with a free 'main'
    const startTaken = (doc.connections || []).some((c) => c.source === graph.start?.id && c.sourcePort === 'main');
    if (graph.start && !startTaken) {
      return { source: graph.start.id, sourcePort: 'main' };
    }
    for (const node of doc.nodes) {
      if (node.type === 'start') continue;
      const port = PRIMARY_PORT[node.type] || 'main';
      if (port !== 'main') continue;
      const taken = (doc.connections || []).some((c) => c.source === node.id && c.sourcePort === port);
      if (!taken) {
        return { source: node.id, sourcePort: port };
      }
    }
    return null;
  };

  // Space new nodes out left-to-right so they do not overlap (matches the
  // migration layout spacing).
  const newNodePosition = () => ({ x: 40 + doc.nodes.length * 260, y: 200 });

  const wireNew = async (newId) => {
    if (!newId) return;
    const anchor = autoWireSource();
    if (anchor) {
      await dispatch(connectWorkflowNodes(pathname, { ...anchor, target: newId }));
    }
  };

  const handlePickRequest = (picked) => {
    setPickerOpen(false);
    if (quickAddPickerCtx) {
      const ctx = quickAddPickerCtx;
      setQuickAddPickerCtx(null);
      dispatch(quickAddNode(pathname, {
        nodeType: 'request',
        picked,
        position: ctx.position,
        wireFrom: ctx.wireFrom,
        insertConnectionId: ctx.insertConnectionId
      })).catch((e) => toast.error(e?.message || 'Unable to add request'));
      return;
    }
    dispatch(addWorkflowRequestNode(pathname, picked, newNodePosition()))
      .then((newId) => wireNew(newId))
      .catch((e) => toast.error(e?.message || 'Unable to add request'));
  };

  // Pick a node type from the quick-add "+" menu, then add + wire it.
  const handleQuickAddType = (nodeType) => {
    const ctx = quickAdd;
    setQuickAdd(null);
    if (!ctx) {
      return;
    }
    if (nodeType === 'request') {
      setQuickAddPickerCtx(ctx);
      setPickerOpen(true);
      return;
    }
    dispatch(quickAddNode(pathname, {
      nodeType,
      position: ctx.position,
      wireFrom: ctx.wireFrom,
      insertConnectionId: ctx.insertConnectionId
    })).catch((e) => toast.error(e?.message || 'Unable to add node'));
  };

  const handleAddNode = (nodeType) => {
    dispatch(addWorkflowNode(pathname, nodeType, newNodePosition()))
      .then((newId) => wireNew(newId))
      .catch((e) => toast.error(e?.message || 'Unable to add node'));
  };

  const handleRunClick = () => {
    if (isRunning) return;
    if (driftedUnpinned.length) {
      setSyncPromptOpen(true);
      return;
    }
    dispatch(runWorkflow(pathname));
  };

  const handleSyncAndRun = async () => {
    setSyncPromptOpen(false);
    try {
      await dispatch(syncWorkflowNodes(pathname, driftedUnpinned));
      dispatch(runWorkflow(pathname));
    } catch (error) {
      toast.error(error?.message || 'Unable to sync workflow nodes');
    }
  };

  const handleRunAsPinned = () => {
    setSyncPromptOpen(false);
    dispatch(runWorkflow(pathname));
  };

  const handleNodePatch = (nodeId) => (patch) => {
    dispatch(updateWorkflowNode(pathname, nodeId, patch)).catch((e) => toast.error(e?.message || 'Unable to update node'));
  };

  const addStepMenuItems = [
    { id: 'add-request', leftSection: IconPlus, label: 'Request', onClick: () => setPickerOpen(true) },
    { id: 'add-map', leftSection: IconWand, label: 'Map response to variables', onClick: () => handleAddNode('map') },
    { id: 'add-setvars', leftSection: IconVariable, label: 'Set variables', onClick: () => handleAddNode('setvars') },
    { id: 'add-condition', leftSection: IconArrowsSplit, label: 'Condition', onClick: () => handleAddNode('condition') },
    { id: 'add-delay', leftSection: IconClock, label: 'Delay', onClick: () => handleAddNode('delay') },
    { id: 'add-loop', leftSection: IconRepeat, label: 'Loop (for each)', onClick: () => handleAddNode('loop') }
  ];

  const selectedNode = selectedNodeId ? graph.nodesById[selectedNodeId] : null;

  const renderSelectionPanel = () => {
    if (!selectedNode) {
      return (
        <div className="canvas-panel canvas-panel-empty" data-testid="workflow-node-panel">
          Select a node to edit it. Drag requests from the sidebar onto the canvas, drag from a node's output port to wire
          the next node, and grab a wire's end to re-route it.
        </div>
      );
    }
    const selDrift = drift?.[selectedNode.id];
    return (
      <div className="canvas-panel" data-testid="workflow-node-panel">
        <div className="panel-title">
          {selectedNode.type === 'request' ? (
            <span>{selectedNode.name}</span>
          ) : (
            <input className="step-name-input" type="text" defaultValue={selectedNode.name} onBlur={(e) => handleNodePatch(selectedNode.id)({ name: e.target.value })} />
          )}
        </div>
        {selectedNode.type !== 'start' && (
          <button
            type="button"
            className="run-button execute-node-button"
            data-testid="workflow-execute-node"
            disabled={isRunning}
            onClick={() => dispatch(executeWorkflowNode(pathname, selectedNode.id)).catch((e) => toast.error(e?.message || 'Unable to run node'))}
            title="Run from Start up to and including this node"
          >
            <IconPlayerPlay size={14} />
            <span>Execute node</span>
          </button>
        )}
        {selectedNode.type === 'request' && (
          <div className="panel-section">
            <div className="step-ref">{selectedNode.ref.collection}/{selectedNode.ref.request}</div>
            {selDrift && (
              <div className={`step-status status-${selDrift.status}`} style={{ alignSelf: 'flex-start' }}>
                {selectedNode.pinned ? 'pinned' : STATUS_LABELS[selDrift.status] || selDrift.status}
              </div>
            )}
            <div className="panel-actions">
              <button type="button" className="add-button" onClick={() => canvasHandlers.onRevealNode(selectedNode.id)}>
                <IconTarget size={14} /> <span>Show in sidebar</span>
              </button>
              {selDrift?.status === 'drifted' && !selectedNode.pinned && (
                <button type="button" className="add-button" onClick={() => dispatch(syncWorkflowNodes(pathname, [selectedNode.id])).catch((e) => toast.error(e?.message || 'Unable to sync'))}>
                  <IconRefresh size={14} /> <span>Sync</span>
                </button>
              )}
              <button type="button" className="add-button" onClick={() => dispatch(togglePinWorkflowNode(pathname, selectedNode.id))}>
                {selectedNode.pinned ? <IconPinned size={14} /> : <IconPin size={14} />}
                <span>{selectedNode.pinned ? 'Unpin' : 'Pin'}</span>
              </button>
            </div>
          </div>
        )}
        <NodeParamEditor node={selectedNode} onChange={handleNodePatch(selectedNode.id)} />
        <StepResult result={run?.stepResults?.[selectedNode.id]} />

        {(() => {
          const data = run?.nodeData?.[selectedNode.id];
          if (!data) {
            return null;
          }
          const preview = (value) => {
            try {
              return JSON.stringify(value, null, 2).slice(0, 4000);
            } catch (error) {
              return String(value);
            }
          };
          return (
            <div className="node-io" data-testid="workflow-node-io">
              <details open>
                <summary>Input</summary>
                <pre className="io-pre">{preview(data.input)}</pre>
              </details>
              <details open>
                <summary>Output</summary>
                <pre className="io-pre">{preview(data.output)}</pre>
              </details>
            </div>
          );
        })()}
      </div>
    );
  };

  const renderListView = () => {
    if (!graph.linear) {
      return (
        <div className="steps-list">
          <div className="drift-banner">
            <span>This workflow has branches or loops. Use the Canvas view to edit its wiring.</span>
            <button type="button" onClick={() => setView('canvas')}>Open canvas</button>
          </div>
          {graph.order.map((node, index) => {
            const Icon = TYPE_ICONS[node.type] || IconWorld;
            return (
              <div key={node.id} className="step-row">
                <span className="step-index">{index + 1}</span>
                <span className="step-method step-type-icon"><Icon size={14} stroke={1.6} /></span>
                <span className="step-main"><span className="step-name">{node.name}</span></span>
                <StepResult result={run?.stepResults?.[node.id]} />
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className="steps-list">
        {graph.order.length === 0 ? (
          <div className="empty-state">No steps yet. Use Add Step (or drag a request onto the Canvas).</div>
        ) : graph.order.map((node, index) => {
          const nodeDrift = drift?.[node.id] || { status: 'detached' };
          const isRequest = node.type === 'request';
          const Icon = TYPE_ICONS[node.type] || IconWorld;
          return (
            <div key={node.id} className="step-block">
              <div className="step-row">
                <span className="step-index">{index + 1}</span>
                {isRequest ? (
                  <span className="step-method">{node.snapshot?.request?.method || ''}</span>
                ) : (
                  <span className="step-method step-type-icon"><Icon size={14} stroke={1.6} /></span>
                )}
                <span className="step-main">
                  {isRequest ? (
                    <>
                      <span className="step-name" title={`${node.ref.collection}/${node.ref.request}`}>{node.name}</span>
                      <span className="step-ref">{node.ref.collection}/{node.ref.request}</span>
                    </>
                  ) : (
                    <input className="step-name-input" type="text" defaultValue={node.name} onBlur={(e) => handleNodePatch(node.id)({ name: e.target.value })} />
                  )}
                </span>
                {isRequest && (
                  <span className={`step-status status-${nodeDrift.status}`}>
                    {node.pinned ? 'pinned' : STATUS_LABELS[nodeDrift.status] || nodeDrift.status}
                  </span>
                )}
                <StepResult result={run?.stepResults?.[node.id]} />
                <span className="step-actions">
                  {isRequest && (
                    <ActionIcon label="Show request in sidebar" onClick={() => canvasHandlers.onRevealNode(node.id)}>
                      <IconTarget size={14} stroke={1.5} />
                    </ActionIcon>
                  )}
                  {isRequest && nodeDrift.status === 'drifted' && !node.pinned && (
                    <ActionIcon label="Sync snapshot from request" onClick={() => dispatch(syncWorkflowNodes(pathname, [node.id])).catch((e) => toast.error(e?.message || 'Unable to sync node'))}>
                      <IconRefresh size={14} stroke={1.5} />
                    </ActionIcon>
                  )}
                  {isRequest && (
                    <ActionIcon label={node.pinned ? 'Unpin (allow sync)' : 'Pin snapshot'} onClick={() => dispatch(togglePinWorkflowNode(pathname, node.id))}>
                      {node.pinned ? <IconPinned size={14} stroke={1.5} /> : <IconPin size={14} stroke={1.5} />}
                    </ActionIcon>
                  )}
                  <ActionIcon label="Remove node" onClick={() => canvasHandlers.onDeleteNode(node.id)}>
                    <IconTrash size={14} stroke={1.5} />
                  </ActionIcon>
                </span>
              </div>
              {node.type !== 'request' && <NodeParamEditor node={node} onChange={handleNodePatch(node.id)} />}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <StyledWrapper>
      {pickerOpen && <RequestPickerModal onPick={handlePickRequest} onClose={() => setPickerOpen(false)} />}
      {syncPromptOpen && (
        <Modal
          size="sm"
          title="Requests changed"
          confirmText="Sync & Run"
          cancelText="Run as pinned"
          handleConfirm={handleSyncAndRun}
          handleCancel={handleRunAsPinned}
          disableCloseOnOutsideClick
        >
          {driftedUnpinned.length} request{driftedUnpinned.length === 1 ? ' has' : 's have'} changed since last sync. Sync before running?
        </Modal>
      )}

      <div className="workflow-header">
        <div className="workflow-title" title={pathname}>{doc.name}</div>
        <div className="workflow-actions">
          {isRunning ? (
            <button type="button" className="run-button cancel-button" data-testid="workflow-cancel" disabled={run?.cancelling} onClick={() => dispatch(cancelWorkflowRun(pathname))}>
              <IconPlayerStop size={15} />
              <span>{run?.cancelling ? 'Cancelling...' : 'Cancel'}</span>
            </button>
          ) : (
            <button type="button" className="run-button" data-testid="workflow-run" disabled={doc.nodes.length <= 1} onClick={handleRunClick}>
              <IconPlayerPlay size={15} />
              <span>Run</span>
            </button>
          )}
          <button type="button" className={`add-button ${view === 'canvas' ? 'active' : ''}`} data-testid="workflow-view-toggle" onClick={() => setView(view === 'canvas' ? 'list' : 'canvas')}>
            {view === 'canvas' ? <IconLayoutList size={15} /> : <IconRoute size={15} />}
            <span>{view === 'canvas' ? 'List' : 'Canvas'}</span>
          </button>
          <button type="button" className="add-button" data-testid="workflow-inputs-toggle" onClick={() => setInputsOpen((open) => !open)}>
            <IconVariable size={15} />
            <span>Inputs{doc.inputs?.length ? ` (${doc.inputs.length})` : ''}</span>
          </button>
          <button type="button" className={`add-button ${logsOpen ? 'active' : ''}`} data-testid="workflow-logs-toggle" onClick={() => setLogsOpen((open) => !open)}>
            <IconTerminal2 size={15} />
            <span>Logs</span>
          </button>
          <button type="button" className="add-button" data-testid="workflow-history-toggle" onClick={() => setHistoryOpen((open) => !open)}>
            <IconHistory size={15} />
            <span>History</span>
          </button>
          <MenuDropdown items={addStepMenuItems} placement="bottom-end" data-testid="workflow-add-step">
            <button type="button" className="add-button">
              <IconPlus size={15} />
              <span>Add Step</span>
            </button>
          </MenuDropdown>
        </div>
      </div>

      {inputsOpen && (
        <WorkflowInputs inputs={doc.inputs || []} onChange={(inputs) => dispatch(updateWorkflowInputs(pathname, inputs)).catch((e) => toast.error(e?.message || 'Unable to update inputs'))} />
      )}
      {historyOpen && <RunHistory runs={history} />}

      {driftedUnpinned.length > 0 && (
        <div className="drift-banner">
          <span>{driftedUnpinned.length} request{driftedUnpinned.length === 1 ? '' : 's'} changed since last sync.</span>
          <button type="button" onClick={() => dispatch(syncWorkflowNodes(pathname, driftedUnpinned)).catch((e) => toast.error(e?.message || 'Unable to sync'))}>Sync all</button>
        </div>
      )}

      {view === 'canvas' ? (
        <div className="canvas-wrap">
          <NodePalette />
          <WorkflowCanvas
            doc={doc}
            drift={drift}
            stepResults={run?.stepResults}
            handlers={canvasHandlers}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
          {renderSelectionPanel()}
        </div>
      ) : (
        renderListView()
      )}

      {quickAdd && (
        <>
          <div className="quick-add-overlay" onClick={() => setQuickAdd(null)} />
          <div
            className="quick-add-menu"
            data-testid="workflow-quick-add-menu"
            style={{ left: quickAdd.screen?.x ?? 0, top: quickAdd.screen?.y ?? 0 }}
          >
            <div className="quick-add-title">Add node</div>
            <button type="button" className="quick-add-item" onClick={() => handleQuickAddType('request')}>
              <IconWorld size={15} stroke={1.6} /><span>Request</span>
            </button>
            {PALETTE_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.type} type="button" className="quick-add-item" onClick={() => handleQuickAddType(item.type)}>
                  <Icon size={15} stroke={1.6} /><span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {logsOpen && <LogPane run={run} />}

      {run && run.status !== 'running' && (
        <div className={`run-summary run-${run.status}`}>
          <div>Run {run.status}{run.finishedAt && run.startedAt ? ` in ${formatDuration(run.finishedAt - run.startedAt)}` : ''}.</div>
          {run.flowVars && Object.keys(run.flowVars).length > 0 && (
            <div className="vars-inspector" data-testid="workflow-vars">
              <div className="vars-title">Flow variables</div>
              {Object.entries(run.flowVars).map(([key, value]) => (
                <div key={key} className="vars-row">
                  <span className="vars-key">{key}</span>
                  <span className="vars-value" title={formatVarValue(value)}>{formatVarValue(value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </StyledWrapper>
  );
};

export default WorkflowEditor;
