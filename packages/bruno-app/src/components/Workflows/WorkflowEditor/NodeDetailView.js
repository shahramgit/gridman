import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import {
  IconArrowsSplit,
  IconClock,
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconRepeat,
  IconVariable,
  IconWand,
  IconWorld,
  IconX
} from '@tabler/icons';

import { executeWorkflowNode, updateWorkflowNode } from 'providers/ReduxStore/slices/workflows';
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
  loop: IconRepeat
};

const TYPE_LABELS = {
  start: 'Start',
  request: 'Request',
  map: 'Map',
  setvars: 'Set Vars',
  condition: 'Condition',
  delay: 'Delay',
  loop: 'Loop'
};

// Node input/output previews are capped well above the side panel's 4k so the
// columns feel complete without letting a huge body freeze the renderer.
const NDV_JSON_LIMIT = 100000;

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

const NodeDetailView = ({ pathname, node, drift, workflowInputs, onClose }) => {
  const dispatch = useDispatch();
  const [inputView, setInputView] = useState('fields');
  const run = useSelector((state) => state.workflows.runs[pathname]);

  const isRunning = run?.status === 'running';
  const isStart = node.type === 'start';
  const result = run?.stepResults?.[node.id];
  const data = run?.nodeData?.[node.id];
  const hasDropTargets = ['map', 'setvars', 'condition', 'loop'].includes(node.type);
  const Icon = TYPE_ICONS[node.type] || IconWorld;

  // Escape closes only the NDV — the canvas keydown handler is gated while the
  // NDV is open, so this can't also deselect the node.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handlePatch = (patch) =>
    dispatch(updateWorkflowNode(pathname, node.id, patch)).catch((e) => toast.error(e?.message || 'Unable to update node'));
  const handleExecute = () =>
    dispatch(executeWorkflowNode(pathname, node.id)).catch((e) => toast.error(e?.message || 'Unable to run node'));

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
    if (data?.output === undefined) {
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
        <pre className="io-pre ndv-pre">{prettyJson(data.output, NDV_JSON_LIMIT)}</pre>
      </>
    );
  };

  return (
    <>
      <div className="ndv-backdrop" data-testid="ndv-backdrop" onClick={onClose} />
      <div className="ndv" role="dialog" aria-modal="true" data-testid="workflow-ndv">
        <div className="ndv-header">
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

        <div className="ndv-body">
          <div className="ndv-col ndv-col-input" data-testid="ndv-input">
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

          <div className="ndv-col ndv-col-params" data-testid="ndv-params">
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

          <div className="ndv-col ndv-col-output" data-testid="ndv-output">
            <div className="ndv-col-head">
              <span className="ndv-col-title">Output</span>
              <StatusChip result={result} />
            </div>
            <div className="ndv-col-body">{renderOutputColumn()}</div>
          </div>
        </div>
      </div>
    </>
  );
};

export default NodeDetailView;
