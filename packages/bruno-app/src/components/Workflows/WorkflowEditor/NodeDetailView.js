import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import {
  IconArrowsSplit,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconLoader2,
  IconNote,
  IconPin,
  IconPinned,
  IconPlayerPause,
  IconPlayerPlay,
  IconRepeat,
  IconVariable,
  IconWand,
  IconWorld,
  IconX
} from '@tabler/icons';

import {
  executeWorkflowNode,
  PINNABLE_OUTPUT_TYPES,
  toggleWorkflowNodeOutputPin,
  updateWorkflowNode
} from 'providers/ReduxStore/slices/workflows';
import ActionIcon from 'ui/ActionIcon';
import NodeParamsEditor from './NodeParamsEditor';
import { blurOnEnter, formatDuration, InputFieldTree, prettyJson } from './nodeIo';

// n8n-style fullscreen Node Detail View: Input | Parameters | Output.
// Opened by double-clicking a node on the canvas or from the side panel's
// expand button; closed with X, Escape or a backdrop click. Styles live in
// the editor's StyledWrapper under `.ndv-*` (this renders inside it).

const TYPE_ICONS = {
  start: IconPlayerPlay,
  request: IconWorld,
  map: IconWand,
  setvars: IconVariable,
  condition: IconArrowsSplit,
  delay: IconClock,
  loop: IconRepeat,
  note: IconNote
};

const TYPE_LABELS = {
  start: 'Start',
  request: 'Request',
  map: 'Map',
  setvars: 'Set Vars',
  condition: 'Condition',
  delay: 'Delay',
  loop: 'Loop',
  note: 'Note'
};

// Node input/output previews are capped well above the side panel's 4k so the
// columns feel complete without letting a huge body freeze the renderer.
const NDV_JSON_LIMIT = 100000;

// Column widths (% of the body, [input, params, output]) persist across
// sessions; a divider double-click restores the default split.
const NDV_COLS_STORAGE_KEY = 'gridman.workflows.ndvCols';
const NDV_DEFAULT_COLS = [28, 44, 28];
const NDV_MIN_COL_PX = 200;

const loadStoredCols = () => {
  try {
    const cols = JSON.parse(window.localStorage.getItem(NDV_COLS_STORAGE_KEY));
    if (Array.isArray(cols) && cols.length === 3 && cols.every((n) => Number.isFinite(n) && n > 0)) {
      return cols;
    }
  } catch (error) {
    // fall through to defaults
  }
  return NDV_DEFAULT_COLS;
};

const isTypingTarget = (element) => {
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(element?.isContentEditable);
};

const StatusChip = ({ result }) => {
  if (!result) {
    return null;
  }
  return (
    <span className={`ndv-status ndv-status-${result.status}`} data-testid="ndv-status">
      {result.status === 'running' && <IconLoader2 size={12} className="animate-spin" />}
      <span>
        {result.status}
        {result.httpStatus ? ` · ${result.httpStatus}` : ''}
        {typeof result.iterations === 'number' ? ` · ${result.iterations}x` : ''}
        {formatDuration(result.durationMs) ? ` · ${formatDuration(result.durationMs)}` : ''}
      </span>
    </span>
  );
};

const NodeDetailView = ({ pathname, node, drift, workflowInputs, onClose, onNavigate, prevNodeId, nextNodeId }) => {
  const dispatch = useDispatch();
  const [inputView, setInputView] = useState('fields');
  const [cols, setCols] = useState(loadStoredCols);
  const bodyRef = useRef(null);
  const run = useSelector((state) => state.workflows.runs[pathname]);

  const isRunning = run?.status === 'running';
  const isStart = node.type === 'start';
  const result = run?.stepResults?.[node.id];
  const data = run?.nodeData?.[node.id];
  const hasDropTargets = ['map', 'setvars', 'condition', 'loop'].includes(node.type);
  const canPinOutput = PINNABLE_OUTPUT_TYPES.has(node.type);
  const outputPinned = node.pinnedOutput !== undefined;
  const Icon = TYPE_ICONS[node.type] || IconWorld;

  // Escape closes only the NDV — the canvas keydown handler is gated while the
  // NDV is open (undo/redo excepted), so this can't also deselect the node.
  // Alt+Left / Alt+Right step to the previous/next node (except while typing).
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (!event.altKey || isTypingTarget(event.target)) {
        return;
      }
      if (event.key === 'ArrowLeft' && prevNodeId && onNavigate) {
        event.preventDefault();
        onNavigate(prevNodeId);
      } else if (event.key === 'ArrowRight' && nextNodeId && onNavigate) {
        event.preventDefault();
        onNavigate(nextNodeId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onNavigate, prevNodeId, nextNodeId]);

  // Drag a divider between two columns; widths are % of the body with a
  // 200px-per-column floor. Double-click resets to the default split.
  const startColDrag = useCallback((dividerIndex) => (event) => {
    event.preventDefault();
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const totalWidth = body.getBoundingClientRect().width || 1;
    const minPct = Math.min((NDV_MIN_COL_PX / totalWidth) * 100, 33);
    const startX = event.clientX;
    const startCols = [...cols];
    let latest = startCols;

    const onMove = (moveEvent) => {
      let deltaPct = ((moveEvent.clientX - startX) / totalWidth) * 100;
      deltaPct = Math.max(deltaPct, minPct - startCols[dividerIndex]);
      deltaPct = Math.min(deltaPct, startCols[dividerIndex + 1] - minPct);
      const next = [...startCols];
      next[dividerIndex] += deltaPct;
      next[dividerIndex + 1] -= deltaPct;
      latest = next;
      setCols(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try {
        window.localStorage.setItem(NDV_COLS_STORAGE_KEY, JSON.stringify(latest));
      } catch (error) {
        // non-critical
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [cols]);

  const resetCols = useCallback(() => {
    setCols(NDV_DEFAULT_COLS);
    try {
      window.localStorage.removeItem(NDV_COLS_STORAGE_KEY);
    } catch (error) {
      // non-critical
    }
  }, []);

  const handlePatch = (patch) =>
    dispatch(updateWorkflowNode(pathname, node.id, patch)).catch((e) => toast.error(e?.message || 'Unable to update node'));
  const handleExecute = () =>
    dispatch(executeWorkflowNode(pathname, node.id)).catch((e) => toast.error(e?.message || 'Unable to run node'));
  const handleTogglePin = () =>
    dispatch(toggleWorkflowNodeOutputPin(pathname, node.id)).catch((e) => toast.error(e?.message || 'Unable to pin output'));

  const executeButton = (
    <button
      type="button"
      className="run-button execute-node-button"
      data-testid="ndv-execute-node"
      disabled={isRunning}
      onClick={handleExecute}
      title="Run from Start up to and including this node"
    >
      <IconPlayerPlay size={14} />
      <span>Execute node</span>
    </button>
  );

  // Start's "output" is what it feeds the flow: the initial flow variables.
  const initialVars = {};
  for (const input of workflowInputs || []) {
    if (input.name) {
      initialVars[input.name] = input.value;
    }
  }

  const renderInputColumn = () => {
    if (isStart) {
      return <div className="ndv-empty">Start has no input.</div>;
    }
    if (!data?.input) {
      return (
        <div className="ndv-empty">
          <p>No input data yet — execute the node or run the workflow.</p>
          {executeButton}
        </div>
      );
    }
    if (inputView === 'json') {
      return <pre className="io-pre ndv-pre">{prettyJson(data.input, NDV_JSON_LIMIT)}</pre>;
    }
    return <InputFieldTree input={data.input} />;
  };

  const renderOutputColumn = () => {
    if (isStart) {
      return Object.keys(initialVars).length ? (
        <pre className="io-pre ndv-pre">{prettyJson(initialVars, NDV_JSON_LIMIT)}</pre>
      ) : (
        <div className="ndv-empty">No workflow inputs defined — Start seeds an empty set of flow variables.</div>
      );
    }
    const error = result?.status === 'failed' && result.error ? (
      <div className="ndv-error" data-testid="ndv-error">{String(result.error)}</div>
    ) : null;
    // Prefer the latest run data; fall back to the pinned output so a pinned
    // node shows what a run would replay.
    const output = data?.output !== undefined ? data.output : node.pinnedOutput;
    if (output === undefined) {
      return (
        <>
          {error}
          <div className="ndv-empty">
            <p>No output data yet — execute the node or run the workflow.</p>
            {executeButton}
          </div>
        </>
      );
    }
    return (
      <>
        {error}
        {outputPinned && (
          <div className="ndv-pinned-note" data-testid="ndv-pinned-note">
            Output pinned — runs reuse it instead of executing this node.
          </div>
        )}
        <pre className="io-pre ndv-pre">{prettyJson(output, NDV_JSON_LIMIT)}</pre>
      </>
    );
  };

  return (
    <>
      <div className="ndv-backdrop" data-testid="ndv-backdrop" onClick={onClose} />
      <div className="ndv" role="dialog" aria-modal="true" data-testid="workflow-ndv">
        <div className="ndv-header">
          <span className="ndv-nav">
            <ActionIcon label="Previous node (Alt+Left)" disabled={!prevNodeId} data-testid="ndv-prev" onClick={() => prevNodeId && onNavigate?.(prevNodeId)}>
              <IconChevronLeft size={16} stroke={1.7} />
            </ActionIcon>
            <ActionIcon label="Next node (Alt+Right)" disabled={!nextNodeId} data-testid="ndv-next" onClick={() => nextNodeId && onNavigate?.(nextNodeId)}>
              <IconChevronRight size={16} stroke={1.7} />
            </ActionIcon>
          </span>
          <span className="ndv-type">
            <Icon size={15} stroke={1.7} />
            <span>{TYPE_LABELS[node.type] || node.type}</span>
          </span>
          {node.type === 'request' ? (
            <span className="ndv-name" title={node.name}>{node.name}</span>
          ) : (
            <input
              className="step-name-input ndv-name-input"
              type="text"
              defaultValue={node.name}
              onKeyDown={blurOnEnter}
              onBlur={(e) => handlePatch({ name: e.target.value })}
            />
          )}
          <StatusChip result={result} />
          {outputPinned && (
            <span className="ndv-pin-badge" title="Output pinned — runs reuse this output instead of executing" data-testid="ndv-pin-badge">
              <IconPinned size={12} stroke={1.8} />
              <span>output pinned</span>
            </span>
          )}
          <div className="ndv-header-actions">
            {!isStart && executeButton}
            {!isStart && (
              <ActionIcon
                label={node.disabled ? 'Enable node' : 'Disable node (skip during run)'}
                onClick={() => handlePatch({ disabled: !node.disabled })}
              >
                {node.disabled ? <IconPlayerPlay size={15} stroke={1.6} /> : <IconPlayerPause size={15} stroke={1.6} />}
              </ActionIcon>
            )}
            <ActionIcon label="Close (Esc)" onClick={onClose} data-testid="ndv-close">
              <IconX size={16} stroke={1.6} />
            </ActionIcon>
          </div>
        </div>

        <div className="ndv-body" ref={bodyRef}>
          <div className="ndv-col ndv-col-input" style={{ flexGrow: cols[0], flexBasis: 0 }} data-testid="ndv-input">
            <div className="ndv-col-head">
              <span className="ndv-col-title">Input</span>
              {!isStart && data?.input && (
                <div className="ndv-view-toggle">
                  <button type="button" className={inputView === 'fields' ? 'active' : ''} onClick={() => setInputView('fields')}>
                    Fields
                  </button>
                  <button type="button" className={inputView === 'json' ? 'active' : ''} onClick={() => setInputView('json')}>
                    JSON
                  </button>
                </div>
              )}
            </div>
            <div className="ndv-col-body node-io">{renderInputColumn()}</div>
          </div>

          <div
            className="ndv-divider"
            data-testid="ndv-divider-0"
            title="Drag to resize — double-click to reset"
            onMouseDown={startColDrag(0)}
            onDoubleClick={resetCols}
          />

          <div className="ndv-col ndv-col-params" style={{ flexGrow: cols[1], flexBasis: 0 }} data-testid="ndv-params">
            <div className="ndv-col-head">
              <span className="ndv-col-title">Parameters</span>
            </div>
            <div className="ndv-col-body">
              {isStart ? (
                <div className="ndv-hint">
                  The Start node has no parameters. It kicks off every run and seeds the flow variables from the
                  workflow inputs (the Inputs button in the toolbar).
                </div>
              ) : (
                <>
                  <NodeParamsEditor pathname={pathname} node={node} drift={drift} onChange={handlePatch} />
                  {hasDropTargets && (
                    <div className="editor-hint">Drag fields from the Input column onto the parameters.</div>
                  )}
                </>
              )}
            </div>
          </div>

          <div
            className="ndv-divider"
            data-testid="ndv-divider-1"
            title="Drag to resize — double-click to reset"
            onMouseDown={startColDrag(1)}
            onDoubleClick={resetCols}
          />

          <div className="ndv-col ndv-col-output" style={{ flexGrow: cols[2], flexBasis: 0 }} data-testid="ndv-output">
            <div className="ndv-col-head">
              <span className="ndv-col-title">Output</span>
              <span className="ndv-col-head-actions">
                <StatusChip result={result} />
                {canPinOutput && (
                  <ActionIcon
                    label={outputPinned
                      ? 'Unpin output (execute this node on runs again)'
                      : 'Pin output (runs reuse this output instead of executing)'}
                    className={outputPinned ? 'ndv-pin-active' : ''}
                    data-testid="ndv-pin-output"
                    onClick={handleTogglePin}
                  >
                    {outputPinned ? <IconPinned size={14} stroke={1.6} /> : <IconPin size={14} stroke={1.6} />}
                  </ActionIcon>
                )}
              </span>
            </div>
            <div className="ndv-col-body">{renderOutputColumn()}</div>
          </div>
        </div>
      </div>
    </>
  );
};

export default NodeDetailView;
