import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import {
  IconArrowDown,
  IconArrowUp,
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
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconRoute,
  IconTarget,
  IconTrash,
  IconVariable,
  IconWand
} from '@tabler/icons';

import {
  addWorkflowRequestStep,
  addWorkflowStep,
  loadWorkflowRunHistory,
  moveWorkflowStep,
  refreshWorkflow,
  removeWorkflowStep,
  revealWorkflowStep,
  runWorkflow,
  syncWorkflowSteps,
  togglePinWorkflowStep,
  updateWorkflowInputs,
  updateWorkflowStep
} from 'providers/ReduxStore/slices/workflows';
import Modal from 'components/Modal';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import RequestPickerModal from './RequestPickerModal';
import WorkflowCanvas from './WorkflowCanvas';
import StyledWrapper from './StyledWrapper';

const STATUS_LABELS = {
  linked: 'linked',
  drifted: 'changed',
  detached: 'detached'
};

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
        {result.conditionResult === false ? ' condition false' : ''}
        {result.mappedVars && Object.keys(result.mappedVars).length
          ? ` ${Object.keys(result.mappedVars).map((key) => `${key}=${formatVarValue(result.mappedVars[key]).slice(0, 24)}`).join(', ')}`
          : ''}
        {result.error ? ` ${result.error}` : ''}
      </span>
    </span>
  );
};

const MapStepEditor = ({ step, onChange }) => {
  const mappings = step.mappings || [];

  const updateMapping = (index, patch) => {
    const next = mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping));
    onChange({ mappings: next });
  };

  return (
    <div className="step-editor">
      {mappings.map((mapping, index) => (
        <div key={index} className="editor-row">
          <select
            value={mapping.from}
            onChange={(e) => updateMapping(index, { from: e.target.value })}
          >
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
          <ActionIcon
            label="Remove mapping"
            onClick={() => onChange({ mappings: mappings.filter((_, i) => i !== index) })}
          >
            <IconTrash size={13} stroke={1.5} />
          </ActionIcon>
        </div>
      ))}
      <button
        type="button"
        className="editor-add"
        onClick={() => onChange({ mappings: [...mappings, { from: 'body', path: '$.', target: '' }] })}
      >
        + mapping
      </button>
    </div>
  );
};

const ConditionStepEditor = ({ step, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <input
        type="text"
        className="expression-input"
        placeholder="res.status === 200 && vars.token"
        defaultValue={step.expression}
        onBlur={(e) => onChange({ expression: e.target.value })}
      />
      <span className="editor-arrow">if false</span>
      <select value={step.onFalse} onChange={(e) => onChange({ onFalse: e.target.value })}>
        <option value="stop">stop run</option>
        <option value="continue">continue</option>
      </select>
    </div>
    <div className="editor-hint">Expression sees res (status, headers, body of the previous response) and vars.</div>
  </div>
);

const DelayStepEditor = ({ step, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <input
        type="number"
        min="0"
        step="100"
        defaultValue={step.durationMs}
        onBlur={(e) => onChange({ durationMs: Number(e.target.value) || 0 })}
      />
      <span className="editor-arrow">ms</span>
    </div>
  </div>
);

const LoopStepEditor = ({ step, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <span className="editor-arrow">for each</span>
      <input
        type="text"
        placeholder="item"
        style={{ width: 90 }}
        defaultValue={step.itemVar}
        onBlur={(e) => onChange({ itemVar: e.target.value || 'item' })}
      />
      <span className="editor-arrow">in vars.</span>
      <input
        type="text"
        placeholder="arrayVariable"
        defaultValue={step.source}
        onBlur={(e) => onChange({ source: e.target.value })}
      />
      <span className="editor-arrow">max</span>
      <input
        type="number"
        min="1"
        defaultValue={step.maxIterations}
        onBlur={(e) => onChange({ maxIterations: Number(e.target.value) || 100 })}
      />
    </div>
    <div className="editor-hint">
      The loop variable and its index are exposed as vars.{step.itemVar || 'item'} and vars.{step.itemVar || 'item'}Index.
    </div>
  </div>
);

const WorkflowInputs = ({ inputs, onChange }) => {
  const updateInput = (index, patch) => {
    onChange(inputs.map((input, i) => (i === index ? { ...input, ...patch } : input)));
  };

  return (
    <div className="workflow-inputs">
      <div className="inputs-title">Inputs</div>
      {inputs.map((input, index) => (
        <div key={index} className="editor-row">
          <input
            type="text"
            placeholder="name"
            defaultValue={input.name}
            onBlur={(e) => updateInput(index, { name: e.target.value })}
          />
          <span className="editor-arrow">=</span>
          <input
            type="text"
            placeholder="value"
            defaultValue={input.value}
            onBlur={(e) => updateInput(index, { value: e.target.value })}
          />
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

const STEP_TYPE_ICONS = {
  map: IconWand,
  condition: IconArrowsSplit,
  delay: IconClock,
  loop: IconRepeat
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

const VIEW_STORAGE_KEY = 'gridman.workflow-view';

const WorkflowEditor = ({ pathname }) => {
  const dispatch = useDispatch();
  const [pickerTarget, setPickerTarget] = useState(null); // null | { parentStepId }
  const [syncPromptOpen, setSyncPromptOpen] = useState(false);
  const [inputsOpen, setInputsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  // Re-read the document and drift every time this tab is shown, so request
  // edits saved while the user was elsewhere are reflected immediately.
  useEffect(() => {
    dispatch(refreshWorkflow(pathname)).catch(() => {});
    dispatch(loadWorkflowRunHistory(pathname)).catch(() => {});
  }, [dispatch, pathname]);

  if (!openWorkflowState) {
    return <StyledWrapper><div className="p-4">Loading workflow...</div></StyledWrapper>;
  }

  const { doc, drift } = openWorkflowState;
  const isRunning = run?.status === 'running';

  const collectDriftedUnpinned = (steps, out = []) => {
    for (const step of steps) {
      if (step.type === 'request' && !step.pinned && drift?.[step.id]?.status === 'drifted') {
        out.push(step.id);
      }
      if (step.type === 'loop') {
        collectDriftedUnpinned(step.steps || [], out);
      }
    }
    return out;
  };
  const driftedUnpinnedStepIds = collectDriftedUnpinned(doc.steps);

  const handleRunClick = () => {
    if (isRunning) {
      return;
    }
    if (driftedUnpinnedStepIds.length) {
      setSyncPromptOpen(true);
      return;
    }
    dispatch(runWorkflow(pathname));
  };

  const handleSyncAndRun = async () => {
    setSyncPromptOpen(false);
    try {
      await dispatch(syncWorkflowSteps(pathname, driftedUnpinnedStepIds));
      dispatch(runWorkflow(pathname));
    } catch (error) {
      toast.error(error?.message || 'Unable to sync workflow steps');
    }
  };

  const handleRunAsPinned = () => {
    setSyncPromptOpen(false);
    dispatch(runWorkflow(pathname));
  };

  const handlePick = (picked) => {
    const parentStepId = pickerTarget?.parentStepId;
    setPickerTarget(null);
    dispatch(addWorkflowRequestStep(pathname, picked, parentStepId))
      .catch((error) => toast.error(error?.message || 'Unable to add step'));
  };

  const handleStepPatch = (stepId) => (patch) => {
    dispatch(updateWorkflowStep(pathname, stepId, patch))
      .catch((error) => toast.error(error?.message || 'Unable to update step'));
  };

  const buildAddStepMenuItems = (parentStepId) => {
    const items = [
      {
        id: 'add-request',
        leftSection: IconPlus,
        label: 'Request',
        onClick: () => setPickerTarget({ parentStepId })
      },
      {
        id: 'add-map',
        leftSection: IconWand,
        label: 'Map response to variables',
        onClick: () => dispatch(addWorkflowStep(pathname, 'map', parentStepId))
      },
      {
        id: 'add-condition',
        leftSection: IconArrowsSplit,
        label: 'Condition',
        onClick: () => dispatch(addWorkflowStep(pathname, 'condition', parentStepId))
      },
      {
        id: 'add-delay',
        leftSection: IconClock,
        label: 'Delay',
        onClick: () => dispatch(addWorkflowStep(pathname, 'delay', parentStepId))
      }
    ];

    if (!parentStepId) {
      items.push({
        id: 'add-loop',
        leftSection: IconRepeat,
        label: 'Loop (for each)',
        onClick: () => dispatch(addWorkflowStep(pathname, 'loop'))
      });
    }

    return items;
  };

  const renderStepRow = (step, index, total, parentStepId) => {
    const stepDrift = drift?.[step.id] || { status: 'detached' };
    const stepResult = run?.stepResults?.[step.id];
    const isRequestStep = step.type === 'request';
    const TypeIcon = STEP_TYPE_ICONS[step.type];

    return (
      <div key={step.id} className="step-block">
        <div className="step-row">
          <span className="step-index">{index + 1}</span>
          {isRequestStep ? (
            <span className="step-method">{step.snapshot?.request?.method || ''}</span>
          ) : (
            <span className="step-method step-type-icon">
              {TypeIcon ? <TypeIcon size={14} stroke={1.6} /> : null}
            </span>
          )}
          <span className="step-main">
            {isRequestStep ? (
              <>
                <span className="step-name" title={`${step.ref.collection}/${step.ref.request}`}>
                  {step.name}
                </span>
                <span className="step-ref">{step.ref.collection}/{step.ref.request}</span>
              </>
            ) : (
              <input
                className="step-name-input"
                type="text"
                defaultValue={step.name}
                onBlur={(e) => handleStepPatch(step.id)({ name: e.target.value })}
              />
            )}
          </span>

          {isRequestStep && (
            <span className={`step-status status-${stepDrift.status}`}>
              {step.pinned ? 'pinned' : STATUS_LABELS[stepDrift.status] || stepDrift.status}
            </span>
          )}

          <StepResult result={stepResult} />

          <span className="step-actions">
            {isRequestStep && (
              <ActionIcon
                label="Show request in sidebar"
                onClick={() => {
                  dispatch(revealWorkflowStep(pathname, step.id))
                    .catch((error) => toast.error(error?.message || 'Unable to locate request'));
                }}
              >
                <IconTarget size={14} stroke={1.5} />
              </ActionIcon>
            )}
            {isRequestStep && stepDrift.status === 'drifted' && !step.pinned && (
              <ActionIcon
                label="Sync snapshot from request"
                onClick={() => {
                  dispatch(syncWorkflowSteps(pathname, [step.id]))
                    .catch((error) => toast.error(error?.message || 'Unable to sync step'));
                }}
              >
                <IconRefresh size={14} stroke={1.5} />
              </ActionIcon>
            )}
            {isRequestStep && (
              <ActionIcon
                label={step.pinned ? 'Unpin (allow sync)' : 'Pin snapshot'}
                onClick={() => dispatch(togglePinWorkflowStep(pathname, step.id))}
              >
                {step.pinned ? <IconPinned size={14} stroke={1.5} /> : <IconPin size={14} stroke={1.5} />}
              </ActionIcon>
            )}
            <ActionIcon
              label="Move up"
              disabled={index === 0}
              onClick={() => dispatch(moveWorkflowStep(pathname, step.id, -1, parentStepId))}
            >
              <IconArrowUp size={14} stroke={1.5} />
            </ActionIcon>
            <ActionIcon
              label="Move down"
              disabled={index === total - 1}
              onClick={() => dispatch(moveWorkflowStep(pathname, step.id, 1, parentStepId))}
            >
              <IconArrowDown size={14} stroke={1.5} />
            </ActionIcon>
            <ActionIcon
              label="Remove step"
              onClick={() => dispatch(removeWorkflowStep(pathname, step.id, parentStepId))}
            >
              <IconTrash size={14} stroke={1.5} />
            </ActionIcon>
          </span>
        </div>

        {step.type === 'map' && <MapStepEditor step={step} onChange={handleStepPatch(step.id)} />}
        {step.type === 'condition' && <ConditionStepEditor step={step} onChange={handleStepPatch(step.id)} />}
        {step.type === 'delay' && <DelayStepEditor step={step} onChange={handleStepPatch(step.id)} />}
        {step.type === 'loop' && (
          <>
            <LoopStepEditor step={step} onChange={handleStepPatch(step.id)} />
            <div className="loop-body">
              {(step.steps || []).map((child, childIndex) =>
                renderStepRow(child, childIndex, step.steps.length, step.id))}
              <div className="loop-add">
                <MenuDropdown items={buildAddStepMenuItems(step.id)} placement="bottom-start">
                  <button type="button" className="editor-add">+ step inside loop</button>
                </MenuDropdown>
              </div>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <StyledWrapper>
      {pickerTarget && (
        <RequestPickerModal onPick={handlePick} onClose={() => setPickerTarget(null)} />
      )}
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
          {driftedUnpinnedStepIds.length} step{driftedUnpinnedStepIds.length === 1 ? ' has' : 's have'} changed
          since the workflow was last synced. Sync the snapshots from the current requests before running?
        </Modal>
      )}

      <div className="workflow-header">
        <div className="workflow-title" title={pathname}>{doc.name}</div>
        <div className="workflow-actions">
          <button
            type="button"
            className="run-button"
            data-testid="workflow-run"
            disabled={isRunning || !doc.steps.length}
            onClick={handleRunClick}
          >
            {isRunning ? <IconLoader2 size={15} className="animate-spin" /> : <IconPlayerPlay size={15} />}
            <span>Run</span>
          </button>
          <button
            type="button"
            className={`add-button ${view === 'canvas' ? 'active' : ''}`}
            data-testid="workflow-view-toggle"
            title={view === 'canvas' ? 'Switch to list view' : 'Switch to canvas view'}
            onClick={() => setView(view === 'canvas' ? 'list' : 'canvas')}
          >
            {view === 'canvas' ? <IconLayoutList size={15} /> : <IconRoute size={15} />}
            <span>{view === 'canvas' ? 'List' : 'Canvas'}</span>
          </button>
          <button
            type="button"
            className="add-button"
            data-testid="workflow-inputs-toggle"
            onClick={() => setInputsOpen((open) => !open)}
          >
            <IconVariable size={15} />
            <span>Inputs{doc.inputs?.length ? ` (${doc.inputs.length})` : ''}</span>
          </button>
          <button
            type="button"
            className="add-button"
            data-testid="workflow-history-toggle"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <IconHistory size={15} />
            <span>History</span>
          </button>
          <MenuDropdown items={buildAddStepMenuItems(null)} placement="bottom-end" data-testid="workflow-add-step">
            <button type="button" className="add-button">
              <IconPlus size={15} />
              <span>Add Step</span>
            </button>
          </MenuDropdown>
        </div>
      </div>

      {inputsOpen && (
        <WorkflowInputs
          inputs={doc.inputs || []}
          onChange={(inputs) => {
            dispatch(updateWorkflowInputs(pathname, inputs))
              .catch((error) => toast.error(error?.message || 'Unable to update inputs'));
          }}
        />
      )}

      {historyOpen && <RunHistory runs={history} />}

      {driftedUnpinnedStepIds.length > 0 && (
        <div className="drift-banner">
          <span>
            {driftedUnpinnedStepIds.length} step{driftedUnpinnedStepIds.length === 1 ? '' : 's'} changed since last sync.
          </span>
          <button
            type="button"
            onClick={() => {
              dispatch(syncWorkflowSteps(pathname, driftedUnpinnedStepIds))
                .catch((error) => toast.error(error?.message || 'Unable to sync'));
            }}
          >
            Sync all
          </button>
        </div>
      )}

      {view === 'canvas' ? (
        <WorkflowCanvas doc={doc} stepResults={run?.stepResults} />
      ) : (
        <div className="steps-list">
          {doc.steps.length === 0 ? (
            <div className="empty-state">
              This workflow has no steps yet. Use Add Step to pick requests from this workspace.
            </div>
          ) : (
            doc.steps.map((step, index) => renderStepRow(step, index, doc.steps.length, null))
          )}
        </div>
      )}

      {run && run.status !== 'running' && (
        <div className={`run-summary run-${run.status}`}>
          <div>
            Run {run.status}
            {run.finishedAt && run.startedAt ? ` in ${formatDuration(run.finishedAt - run.startedAt)}` : ''}.
          </div>
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
