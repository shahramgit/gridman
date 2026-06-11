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
  IconLoader2,
  IconPin,
  IconPinned,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTarget,
  IconTrash,
  IconVariable,
  IconWand
} from '@tabler/icons';

import {
  addWorkflowRequestStep,
  addWorkflowStep,
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
      ) : result.status === 'stopped' ? (
        <IconCircleX size={14} />
      ) : (
        <IconCircleX size={14} />
      )}
      <span>
        {result.httpStatus ? `${result.httpStatus} ` : ''}
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
  delay: IconClock
};

const WorkflowEditor = ({ pathname }) => {
  const dispatch = useDispatch();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [syncPromptOpen, setSyncPromptOpen] = useState(false);
  const [inputsOpen, setInputsOpen] = useState(false);
  const openWorkflowState = useSelector((state) => state.workflows.open[pathname]);
  const run = useSelector((state) => state.workflows.runs[pathname]);

  // Re-read the document and drift every time this tab is shown, so request
  // edits saved while the user was elsewhere are reflected immediately.
  useEffect(() => {
    dispatch(refreshWorkflow(pathname)).catch(() => {});
  }, [dispatch, pathname]);

  if (!openWorkflowState) {
    return <StyledWrapper><div className="p-4">Loading workflow...</div></StyledWrapper>;
  }

  const { doc, drift } = openWorkflowState;
  const isRunning = run?.status === 'running';

  const driftedUnpinnedStepIds = doc.steps
    .filter((step) => step.type === 'request' && !step.pinned && drift?.[step.id]?.status === 'drifted')
    .map((step) => step.id);

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
    setPickerOpen(false);
    dispatch(addWorkflowRequestStep(pathname, picked))
      .catch((error) => toast.error(error?.message || 'Unable to add step'));
  };

  const handleStepPatch = (stepId) => (patch) => {
    dispatch(updateWorkflowStep(pathname, stepId, patch))
      .catch((error) => toast.error(error?.message || 'Unable to update step'));
  };

  const addStepMenuItems = [
    {
      id: 'add-request',
      leftSection: IconPlus,
      label: 'Request',
      onClick: () => setPickerOpen(true)
    },
    {
      id: 'add-map',
      leftSection: IconWand,
      label: 'Map response to variables',
      onClick: () => dispatch(addWorkflowStep(pathname, 'map'))
    },
    {
      id: 'add-condition',
      leftSection: IconArrowsSplit,
      label: 'Condition',
      onClick: () => dispatch(addWorkflowStep(pathname, 'condition'))
    },
    {
      id: 'add-delay',
      leftSection: IconClock,
      label: 'Delay',
      onClick: () => dispatch(addWorkflowStep(pathname, 'delay'))
    }
  ];

  return (
    <StyledWrapper>
      {pickerOpen && (
        <RequestPickerModal onPick={handlePick} onClose={() => setPickerOpen(false)} />
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
            className="add-button"
            data-testid="workflow-inputs-toggle"
            onClick={() => setInputsOpen((open) => !open)}
          >
            <IconVariable size={15} />
            <span>Inputs{doc.inputs?.length ? ` (${doc.inputs.length})` : ''}</span>
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
        <WorkflowInputs
          inputs={doc.inputs || []}
          onChange={(inputs) => {
            dispatch(updateWorkflowInputs(pathname, inputs))
              .catch((error) => toast.error(error?.message || 'Unable to update inputs'));
          }}
        />
      )}

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

      <div className="steps-list">
        {doc.steps.length === 0 ? (
          <div className="empty-state">
            This workflow has no steps yet. Use Add Step to pick requests from this workspace.
          </div>
        ) : (
          doc.steps.map((step, index) => {
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
                      onClick={() => dispatch(moveWorkflowStep(pathname, step.id, -1))}
                    >
                      <IconArrowUp size={14} stroke={1.5} />
                    </ActionIcon>
                    <ActionIcon
                      label="Move down"
                      disabled={index === doc.steps.length - 1}
                      onClick={() => dispatch(moveWorkflowStep(pathname, step.id, 1))}
                    >
                      <IconArrowDown size={14} stroke={1.5} />
                    </ActionIcon>
                    <ActionIcon
                      label="Remove step"
                      onClick={() => dispatch(removeWorkflowStep(pathname, step.id))}
                    >
                      <IconTrash size={14} stroke={1.5} />
                    </ActionIcon>
                  </span>
                </div>

                {step.type === 'map' && <MapStepEditor step={step} onChange={handleStepPatch(step.id)} />}
                {step.type === 'condition' && <ConditionStepEditor step={step} onChange={handleStepPatch(step.id)} />}
                {step.type === 'delay' && <DelayStepEditor step={step} onChange={handleStepPatch(step.id)} />}
              </div>
            );
          })
        )}
      </div>

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
