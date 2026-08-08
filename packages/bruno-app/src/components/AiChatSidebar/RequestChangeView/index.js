import React from 'react';
import { IconCheck, IconWorld, IconX } from '@tabler/icons';
import StyledWrapper from './StyledWrapper';

/**
 * Preview + approval for a structured request proposal.
 *
 * DiffView answers "what text changes"; this answers "what request is this
 * going to be". A serialised `.bru` line diff would technically show the same
 * information and would be the wrong thing to put in front of someone deciding
 * whether to accept a URL — so create shows the resulting request as fields,
 * and update shows only the fields that move, old struck through above new.
 *
 * Nothing here writes. `onAccept` hands back to the panel, which creates an
 * UNSAVED request or an unsaved draft; the user still saves.
 */

const FIELD_ORDER = ['method', 'url', 'headers', 'body', 'auth'];

const describeHeaders = (headers) => {
  if (!Array.isArray(headers) || headers.length === 0) return '(none)';
  return headers
    .filter((h) => h && h.name)
    .map((h) => `${h.name}: ${h.value ?? ''}${h.enabled === false ? '  (disabled)' : ''}`)
    .join('\n');
};

const describeBody = (body) => {
  if (!body || !body.mode || body.mode === 'none') return 'none';
  if (!body.content) return body.mode;
  return `${body.mode}\n${body.content}`;
};

const describeAuth = (auth) => (auth?.mode ? auth.mode : null);

const renderValue = (field, value) => {
  if (field === 'headers') return <pre className="rc-pre">{describeHeaders(value)}</pre>;
  if (field === 'body') return <pre className="rc-pre">{describeBody(value)}</pre>;
  if (field === 'auth') return <span className="rc-value">{describeAuth(value)}</span>;
  return <span className="rc-value">{String(value ?? '')}</span>;
};

const LABELS = {
  method: 'Method',
  url: 'URL',
  headers: 'Headers',
  body: 'Body',
  auth: 'Auth'
};

const RequestChangeView = ({ change, current, onAccept, onReject, status, warning, disableAccept }) => {
  const isCreate = change?.op === 'create';

  // For an update, show only what actually moves. A field the model echoed back
  // unchanged is noise in a review, and worse, it implies a change that isn't
  // one.
  const changedFields = FIELD_ORDER.filter((field) => {
    if (change?.[field] === undefined) return false;
    if (isCreate) return true;
    const before = current?.[field];
    if (field === 'headers' || field === 'body' || field === 'auth') {
      return JSON.stringify(before ?? null) !== JSON.stringify(change[field] ?? null);
    }
    return String(before ?? '') !== String(change[field] ?? '');
  });

  const renderActions = () => {
    if (status === 'accepted') {
      return (
        <span className="status-badge accepted">
          <IconCheck size={12} /> {isCreate ? 'Created' : 'Applied'}
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
          title={isCreate ? 'Create this request' : 'Apply these changes'}
          disabled={disableAccept}
          data-testid="ai-request-change-accept"
        >
          <IconCheck size={12} /> {isCreate ? 'Create' : 'Apply'}
        </button>
      </div>
    );
  };

  return (
    <StyledWrapper className={status || ''} data-testid="ai-request-change">
      <div className="rc-header">
        <div className="rc-title">
          <span className="rc-icon">
            <IconWorld size={12} />
          </span>
          <span className="rc-op">{isCreate ? 'New request' : 'Edit request'}</span>
          {isCreate && <span className="rc-name">{change.name || 'Untitled'}</span>}
        </div>
        {renderActions()}
      </div>

      {warning && <div className="rc-warning">{warning}</div>}

      <div className="rc-body">
        {changedFields.length === 0 && (
          <>
            <span className="rc-label">Changes</span>
            <span className="rc-value">(nothing differs from the current request)</span>
          </>
        )}
        {changedFields.map((field) => (
          <React.Fragment key={field}>
            <span className="rc-label">{LABELS[field]}</span>
            <span>
              {!isCreate && current?.[field] !== undefined && (
                <span className="rc-old">
                  {field === 'headers'
                    ? describeHeaders(current[field])
                    : field === 'body'
                      ? describeBody(current[field])
                      : field === 'auth'
                        ? describeAuth(current[field])
                        : String(current[field] ?? '')}
                </span>
              )}
              <span className={isCreate ? '' : 'rc-new'}>{renderValue(field, change[field])}</span>
            </span>
          </React.Fragment>
        ))}
        {isCreate && change.folderPathname && (
          <>
            <span className="rc-label">Folder</span>
            <span className="rc-value">{change.folderPathname}</span>
          </>
        )}
      </div>

      <div className="rc-note">
        {isCreate
          ? 'Created unsaved — you choose where to save it.'
          : 'Applied as an unsaved draft — save the request to keep it.'}
      </div>
    </StyledWrapper>
  );
};

export default RequestChangeView;
