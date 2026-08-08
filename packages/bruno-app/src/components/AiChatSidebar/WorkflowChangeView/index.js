import React from 'react';
import { IconCheck, IconSitemap, IconX } from '@tabler/icons';
import StyledWrapper from '../RequestChangeView/StyledWrapper';

/**
 * Preview + approval for a proposed workflow.
 *
 * Shows the flow as the ordered step list the assistant authors in — the same
 * vocabulary the prompt teaches — rather than a diff of the serialised graph.
 * A user deciding whether to accept a flow is asking "what will this run, in
 * what order", and node ids and coordinates answer neither.
 *
 * Accepting hands back to the panel, which saves through the normal workflow
 * save path. That path records an undo entry, so an accepted flow the user
 * dislikes is one undo away.
 */

const summarise = (step) => {
  switch (step.type) {
    case 'request':
      return step.ref?.request ? String(step.ref.request).split('/').pop() : '(no request)';
    case 'map':
      return (step.mappings || []).map((m) => `${m.from}.${m.path} → {{${m.target}}}`).join(', ');
    case 'setvars':
      return (step.assignments || []).map((a) => `${a.name} = ${a.value}`).join(', ');
    case 'condition':
      return step.expression || '';
    case 'delay':
      return `${step.durationMs ?? 0} ms`;
    case 'loop':
      return step.mode === 'count'
        ? `${step.count ?? ''} times as {{${step.itemVar || 'item'}}}`
        : `each of {{${step.source || ''}}} as {{${step.itemVar || 'item'}}}`;
    case 'script':
      return step.assignTo ? `→ {{${step.assignTo}}}` : '';
    default:
      return '';
  }
};

const StepRows = ({ steps, depth = 0 }) =>
  (steps || []).map((step, idx) => (
    <React.Fragment key={`${depth}-${idx}`}>
      <span className="rc-label" style={{ paddingLeft: depth * 12 }}>
        {step.type}
      </span>
      <span className="rc-value">
        {step.name ? <strong>{step.name}</strong> : null}
        {step.name && summarise(step) ? ' — ' : ''}
        {summarise(step)}
      </span>
      {step.steps?.length ? <StepRows steps={step.steps} depth={depth + 1} /> : null}
    </React.Fragment>
  ));

const WorkflowChangeView = ({ change, onAccept, onReject, status, warning, disableAccept }) => {
  const steps = change?.steps || [];

  const renderActions = () => {
    if (status === 'accepted') {
      return (
        <span className="status-badge accepted">
          <IconCheck size={12} /> Applied
        </span>
      );
    }
    if (status === 'rejected') {
      return (
        <span className="status-badge rejected">
          <IconX size={12} /> Dismissed
        </span>
      );
    }
    return (
      <div className="rc-actions">
        <button className="rc-btn reject" onClick={onReject} title="Dismiss">
          <IconX size={12} />
        </button>
        <button
          className="rc-btn accept"
          onClick={onAccept}
          title="Apply this workflow"
          disabled={disableAccept}
          data-testid="ai-workflow-change-accept"
        >
          <IconCheck size={12} /> Apply
        </button>
      </div>
    );
  };

  return (
    <StyledWrapper className={status || ''} data-testid="ai-workflow-change">
      <div className="rc-header">
        <div className="rc-title">
          <span className="rc-icon">
            <IconSitemap size={12} />
          </span>
          <span className="rc-op">Workflow</span>
          <span className="rc-name">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
        </div>
        {renderActions()}
      </div>

      {warning && <div className="rc-warning">{warning}</div>}

      <div className="rc-body">
        {steps.length === 0 ? (
          <>
            <span className="rc-label">Steps</span>
            <span className="rc-value">(empty — this would clear the workflow)</span>
          </>
        ) : (
          <StepRows steps={steps} />
        )}
      </div>

      <div className="rc-note">Replaces the whole flow. Undo is available after applying.</div>
    </StyledWrapper>
  );
};

export default WorkflowChangeView;
