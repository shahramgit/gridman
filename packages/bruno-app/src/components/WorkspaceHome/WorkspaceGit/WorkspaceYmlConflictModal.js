import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import Portal from 'components/Portal';

// Visual resolver for merge conflicts in workspace.yml.
//
// The main process parses both sides of the conflict and returns a structured
// comparison. Collections that exist on only one side get a checkbox (checked
// by default: keeping the union is almost always right for a collections
// list); conflicting scalar fields get a local/remote radio. Confirming writes
// the merged YAML through the workspace-config writers and stages the file;
// the merge is completed afterwards with the existing "Continue merge" button.

const sideNote = { fontSize: 12, color: '#888' };

const CollectionCheckbox = ({ entry, side, checked, onToggle }) => (
  <label
    style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 4, cursor: 'pointer' }}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={() => onToggle(entry.path)}
      style={{ marginTop: 3 }}
    />
    <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{entry.name || entry.path}</span>
      <span style={{ ...sideNote, wordBreak: 'break-all' }}>
        {entry.path} — {side === 'ours' ? 'only in your local version' : 'only in the remote version'}
      </span>
    </span>
  </label>
);

const WorkspaceYmlConflictModal = ({ gitRootPath, otherConflictCount = 0, onClose, onResolved }) => {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [excluded, setExcluded] = useState({}); // path -> true when unchecked
  const [scalarChoices, setScalarChoices] = useState({}); // field -> 'ours' | 'theirs'

  useEffect(() => {
    let active = true;
    setLoading(true);
    window.ipcRenderer
      .invoke('renderer:get-workspace-yml-conflict', { gitRootPath })
      .then((result) => {
        if (!active) return;
        setSummary(result);
      })
      .catch((error) => {
        if (!active) return;
        setSummary({ ok: false, error: error?.message || 'Failed to read workspace.yml' });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gitRootPath]);

  const oursOnly = summary?.ok ? summary.collections.oursOnly : [];
  const theirsOnly = summary?.ok ? summary.collections.theirsOnly : [];
  const bothCount = summary?.ok ? summary.collections.both.length : 0;
  const scalarConflicts = summary?.ok ? summary.scalarConflicts : [];

  const keptCount = useMemo(
    () => [...oursOnly, ...theirsOnly].filter((entry) => !excluded[entry.path]).length + bothCount,
    [oursOnly, theirsOnly, excluded, bothCount]
  );

  const toggleEntry = (entryPath) => {
    setExcluded((current) => ({ ...current, [entryPath]: !current[entryPath] }));
  };

  const setScalarChoice = (field, side) => {
    setScalarChoices((current) => ({ ...current, [field]: side }));
  };

  const confirmResolve = async () => {
    if (!summary?.ok || resolving) return;
    setResolving(true);
    try {
      await window.ipcRenderer.invoke('renderer:resolve-workspace-yml-conflict', {
        gitRootPath,
        selections: {
          excludedPaths: Object.keys(excluded).filter((entryPath) => excluded[entryPath]),
          scalarChoices
        }
      });
      toast.success('workspace.yml resolved and staged');
      onResolved?.();
    } catch (error) {
      const message = (error?.message || String(error)).replace(/^Error invoking remote method '[^']+':\s*/i, '');
      toast.error(message || 'Failed to resolve workspace.yml');
      setResolving(false);
    }
  };

  return (
    <Portal>
      <Modal
        size="md"
        title="Resolve workspace.yml conflict"
        confirmText={resolving ? 'Resolving...' : 'Apply merged workspace.yml'}
        confirmDisabled={loading || resolving || !summary?.ok}
        handleConfirm={confirmResolve}
        handleCancel={onClose}
      >
        <div style={{ display: 'grid', gap: 16 }}>
          {loading && <p style={{ margin: 0 }}>Reading workspace.yml conflict...</p>}

          {!loading && summary && !summary.ok && (
            <>
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                Gridman could not resolve this conflict automatically: {summary.error}
              </p>
              <p style={{ margin: 0, lineHeight: 1.5, ...sideNote }}>
                Resolve workspace.yml manually instead: open the file in an editor, remove the
                {' <<<<<<< / ======= / >>>>>>> '}markers, then use "Mark resolved" and "Continue merge" in the Conflicts
                section.
              </p>
            </>
          )}

          {!loading && summary?.ok && (
            <>
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                Both versions of workspace.yml were parsed. {bothCount} collection{bothCount === 1 ? '' : 's'} appear in
                both versions and will be kept. Choose what to do with the entries that differ — keeping both sides is
                usually right.
              </p>

              {(oursOnly.length > 0 || theirsOnly.length > 0) && (
                <div style={{ display: 'grid', gap: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Collections to keep</div>
                  {oursOnly.map((entry) => (
                    <CollectionCheckbox
                      key={`ours-${entry.path}`}
                      entry={entry}
                      side="ours"
                      checked={!excluded[entry.path]}
                      onToggle={toggleEntry}
                    />
                  ))}
                  {theirsOnly.map((entry) => (
                    <CollectionCheckbox
                      key={`theirs-${entry.path}`}
                      entry={entry}
                      side="theirs"
                      checked={!excluded[entry.path]}
                      onToggle={toggleEntry}
                    />
                  ))}
                </div>
              )}

              {scalarConflicts.length > 0 && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Conflicting fields</div>
                  {scalarConflicts.map((conflict) => (
                    <div key={conflict.field} style={{ display: 'grid', gap: 4 }}>
                      <div style={{ fontSize: 13 }}>{conflict.label}</div>
                      <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name={`scalar-${conflict.field}`}
                          checked={(scalarChoices[conflict.field] || 'ours') === 'ours'}
                          onChange={() => setScalarChoice(conflict.field, 'ours')}
                        />
                        <span style={{ fontSize: 13 }}>
                          Keep local: <strong>{String(conflict.ours) || '(empty)'}</strong>
                        </span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name={`scalar-${conflict.field}`}
                          checked={scalarChoices[conflict.field] === 'theirs'}
                          onChange={() => setScalarChoice(conflict.field, 'theirs')}
                        />
                        <span style={{ fontSize: 13 }}>
                          Keep remote: <strong>{String(conflict.theirs) || '(empty)'}</strong>
                        </span>
                      </label>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ padding: '9px 10px', border: '1px solid #e5e5e5', borderRadius: 4, fontSize: 12, lineHeight: 1.5, color: '#777' }}>
                Applying writes workspace.yml with {keptCount} collection{keptCount === 1 ? '' : 's'} and stages the
                file. This resolver only handles workspace.yml
                {otherConflictCount > 0
                  ? ` — ${otherConflictCount} other conflicted file${otherConflictCount === 1 ? '' : 's'} still need${otherConflictCount === 1 ? 's' : ''} to be resolved`
                  : ''}
                . Finish with "Continue merge" once every conflict is resolved.
              </div>
            </>
          )}
        </div>
      </Modal>
    </Portal>
  );
};

export default WorkspaceYmlConflictModal;
