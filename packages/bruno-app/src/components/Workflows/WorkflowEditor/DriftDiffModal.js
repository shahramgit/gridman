import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import styled from 'styled-components';

import Modal from 'components/Modal';
import { fetchWorkflowNodeDriftDiff, syncWorkflowNodes } from 'providers/ReduxStore/slices/workflows';

// "View changes" modal: field-level diff between a request node's stored
// snapshot and the live request file, shown before syncing so the user never
// syncs blind. The diff is computed in the main process with the exact same
// normalization as drift hashing, so it can never disagree with the drift
// chip. Color-coding follows the drift-chip STATUS_COLORS pattern:
// added -> colors.text.green, removed -> colors.text.danger,
// changed -> colors.text.yellow.

const SECTION_ORDER = [
  'url',
  'method',
  'headers',
  'params',
  'body',
  'auth',
  'script',
  'vars',
  'assertions',
  'tests',
  'docs',
  'name',
  'type',
  'settings'
];

const stripIndices = (segment) => String(segment || '').replace(/\[\d+\]/g, '');

// Top-level section for a diff path: request fields group by their segment
// under `request.` (url, method, headers, body, auth, script, ...); anything
// else (name, type, settings) groups by its first segment.
export const diffEntrySection = (path) => {
  const segments = String(path || '').split('.');
  if (stripIndices(segments[0]) === 'request' && segments.length > 1) {
    return stripIndices(segments[1]);
  }
  return stripIndices(segments[0]) || 'other';
};

// Group diff entries by section, ordered by SECTION_ORDER (unknown sections
// trail alphabetically). The 'truncated' marker entry is filtered out here —
// the modal renders it separately as a footer note.
export const groupDiffEntries = (entries) => {
  const bySection = new Map();
  for (const entry of entries || []) {
    if (entry.kind === 'truncated') {
      continue;
    }
    const section = diffEntrySection(entry.path);
    if (!bySection.has(section)) {
      bySection.set(section, []);
    }
    bySection.get(section).push(entry);
  }

  const sections = Array.from(bySection.keys()).sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  return sections.map((section) => ({ section, entries: bySection.get(section) }));
};

const displayPath = (path) => String(path || '').replace(/^request\./, '');

const StyledDiff = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 50vh;
  overflow-y: auto;
  font-size: 12px;

  .diff-note {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .diff-pin-note {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 11px;
  }

  .diff-section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${(props) => props.theme.colors.text.muted};
    margin-bottom: 4px;
  }

  .diff-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
  }

  .diff-kind {
    flex-shrink: 0;
    width: 62px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* STATUS_COLORS pattern: added/removed/changed -> green/danger/yellow */
  .diff-row.kind-added .diff-kind {
    color: ${(props) => props.theme.colors.text.green};
  }
  .diff-row.kind-removed .diff-kind {
    color: ${(props) => props.theme.colors.text.danger};
  }
  .diff-row.kind-changed .diff-kind {
    color: ${(props) => props.theme.colors.text.yellow};
  }

  .diff-path {
    flex-shrink: 0;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ${(props) => props.theme.font.codeFont || 'monospace'};
  }

  .diff-values {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-family: ${(props) => props.theme.font.codeFont || 'monospace'};
    overflow-wrap: anywhere;
  }

  .diff-before {
    color: ${(props) => props.theme.colors.text.danger};
    text-decoration: line-through;
  }

  .diff-after {
    color: ${(props) => props.theme.colors.text.green};
  }

  .diff-arrow {
    color: ${(props) => props.theme.colors.text.muted};
    flex-shrink: 0;
  }

  .diff-truncated {
    color: ${(props) => props.theme.colors.text.yellow};
    font-size: 11px;
  }
`;

const DiffRow = ({ entry }) => (
  <div className={`diff-row kind-${entry.kind}`} data-testid="drift-diff-row">
    <span className="diff-kind">{entry.kind}</span>
    <span className="diff-path" title={entry.path}>{displayPath(entry.path)}</span>
    <span className="diff-values">
      {entry.kind !== 'added' && <span className="diff-before">{entry.before ?? ''}</span>}
      {entry.kind === 'changed' && <span className="diff-arrow">→</span>}
      {entry.kind !== 'removed' && <span className="diff-after">{entry.after ?? ''}</span>}
    </span>
  </div>
);

const DriftDiffModal = ({ pathname, node, onClose }) => {
  const dispatch = useDispatch();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [diff, setDiff] = useState(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    dispatch(fetchWorkflowNodeDriftDiff(pathname, node.id))
      .then((result) => {
        if (!stale) {
          setDiff(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!stale) {
          setError(e?.message || 'Unable to compute changes');
          setLoading(false);
        }
      });
    return () => {
      stale = true;
    };
  }, [dispatch, pathname, node.id]);

  const handleSync = () => {
    dispatch(syncWorkflowNodes(pathname, [node.id]))
      .then(() => {
        toast.success('Node synced');
        onClose();
      })
      .catch((e) => toast.error(e?.message || 'Unable to sync node'));
  };

  const entries = diff?.entries || [];
  const truncatedMarker = entries.find((entry) => entry.kind === 'truncated');
  const groups = groupDiffEntries(entries);
  const canSync = !loading && !error && diff?.status !== 'detached' && !node.pinned;

  const renderBody = () => {
    if (loading) {
      return <div className="diff-note">Comparing snapshot with the request on disk…</div>;
    }
    if (error) {
      return <div className="diff-note">{error}</div>;
    }
    if (diff?.status === 'detached') {
      return <div className="diff-note">The referenced request file could not be found, so there is nothing to compare.</div>;
    }
    if (!groups.length) {
      return diff?.status === 'drifted' ? (
        <div className="diff-note">
          The request content matches the snapshot, but the stored snapshot hash is out of date. Sync to refresh it.
        </div>
      ) : (
        <div className="diff-note">No differences — the snapshot matches the request on disk.</div>
      );
    }
    return (
      <>
        {groups.map((group) => (
          <div key={group.section} className="diff-section" data-testid="drift-diff-section">
            <div className="diff-section-title">{group.section}</div>
            {group.entries.map((entry, index) => <DiffRow key={`${entry.path}-${index}`} entry={entry} />)}
          </div>
        ))}
        {truncatedMarker && (
          <div className="diff-truncated">…{truncatedMarker.omitted} more change{truncatedMarker.omitted === 1 ? '' : 's'} not shown.</div>
        )}
      </>
    );
  };

  return (
    <Modal
      size="lg"
      title={`Changes — ${node.name}`}
      confirmText="Sync node"
      cancelText="Close"
      handleConfirm={handleSync}
      handleCancel={onClose}
      confirmDisabled={!canSync}
      dataTestId="drift-diff-modal"
    >
      <StyledDiff>
        {renderBody()}
        {node.pinnedOutput !== undefined && (
          <div className="diff-pin-note">
            This node's pinned output is kept after sync — the pin captures output data, the snapshot captures the
            request definition.
          </div>
        )}
        {node.pinned && (
          <div className="diff-pin-note">
            The snapshot is pinned — unpin the node to sync it.
          </div>
        )}
      </StyledDiff>
    </Modal>
  );
};

export default DriftDiffModal;
