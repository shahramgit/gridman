import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import {
  IconArrowDown,
  IconArrowUp,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
  IconPin,
  IconPinned,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTarget,
  IconTrash
} from '@tabler/icons';

import {
  addWorkflowRequestStep,
  moveWorkflowStep,
  refreshWorkflow,
  removeWorkflowStep,
  revealWorkflowStep,
  runWorkflow,
  syncWorkflowSteps,
  togglePinWorkflowStep
} from 'providers/ReduxStore/slices/workflows';
import Modal from 'components/Modal';
import ActionIcon from 'ui/ActionIcon';
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

const WorkflowEditor = ({ pathname }) => {
  const dispatch = useDispatch();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [syncPromptOpen, setSyncPromptOpen] = useState(false);
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
    .filter((step) => !step.pinned && drift?.[step.id]?.status === 'drifted')
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
            data-testid="workflow-add-step"
            onClick={() => setPickerOpen(true)}
          >
            <IconPlus size={15} />
            <span>Add Step</span>
          </button>
        </div>
      </div>

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

            return (
              <div key={step.id} className="step-row">
                <span className="step-index">{index + 1}</span>
                <span className="step-method">{step.snapshot?.request?.method || ''}</span>
                <span className="step-main">
                  <span className="step-name" title={`${step.ref.collection}/${step.ref.request}`}>
                    {step.name}
                  </span>
                  <span className="step-ref">{step.ref.collection}/{step.ref.request}</span>
                </span>

                <span className={`step-status status-${stepDrift.status}`}>
                  {step.pinned ? 'pinned' : STATUS_LABELS[stepDrift.status] || stepDrift.status}
                </span>

                {stepResult && (
                  <span className={`step-result result-${stepResult.status}`}>
                    {stepResult.status === 'running' ? (
                      <IconLoader2 size={14} className="animate-spin" />
                    ) : stepResult.status === 'passed' ? (
                      <IconCircleCheck size={14} />
                    ) : (
                      <IconCircleX size={14} />
                    )}
                    <span>
                      {stepResult.httpStatus ? `${stepResult.httpStatus} ` : ''}
                      {formatDuration(stepResult.durationMs)}
                      {stepResult.error ? ` ${stepResult.error}` : ''}
                    </span>
                  </span>
                )}

                <span className="step-actions">
                  <ActionIcon
                    label="Show request in sidebar"
                    onClick={() => {
                      dispatch(revealWorkflowStep(pathname, step.id))
                        .catch((error) => toast.error(error?.message || 'Unable to locate request'));
                    }}
                  >
                    <IconTarget size={14} stroke={1.5} />
                  </ActionIcon>
                  {stepDrift.status === 'drifted' && !step.pinned && (
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
                  <ActionIcon
                    label={step.pinned ? 'Unpin (allow sync)' : 'Pin snapshot'}
                    onClick={() => dispatch(togglePinWorkflowStep(pathname, step.id))}
                  >
                    {step.pinned ? <IconPinned size={14} stroke={1.5} /> : <IconPin size={14} stroke={1.5} />}
                  </ActionIcon>
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
            );
          })
        )}
      </div>

      {run && run.status !== 'running' && (
        <div className={`run-summary run-${run.status}`}>
          Run {run.status}
          {run.finishedAt && run.startedAt ? ` in ${formatDuration(run.finishedAt - run.startedAt)}` : ''}.
        </div>
      )}
    </StyledWrapper>
  );
};

export default WorkflowEditor;
