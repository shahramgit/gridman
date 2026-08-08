import React, { useEffect, useRef, useState } from 'react';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { IconChevronDown, IconChevronRight, IconFileCode } from '@tabler/icons';
import StyledWrapper from './StyledWrapper';

// The id only has to correlate this component's progress events with its own
// migration inside one app session, so it is generated here rather than by
// pulling in utils/common's uuid — that module drags prettier, xml-formatter
// and jsonpath-plus in behind it, which is a lot of graph for one identifier.
const newMigrationUid = () => `migration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// A read-only tree, a locked drive or a lost network share produces one of
// these per file, and on a collection of this size that is five figures. The
// panel shows the first few and counts the rest rather than rendering thousands
// of rows into the settings tab.
const FILE_LINE_LIMIT = 20;

const FileLines = ({ entries }) => (
  <div className="difference-list mt-2 p-2">
    {entries.slice(0, FILE_LINE_LIMIT).map((entry, index) => (
      <div key={index} className="file-line">
        {entry.pathname}
        {entry.message ? ` — ${entry.message}` : null}
      </div>
    ))}
    {entries.length > FILE_LINE_LIMIT ? (
      <div className="muted mt-1">and {entries.length - FILE_LINE_LIMIT} more</div>
    ) : null}
  </div>
);

// When the migration stops in phase 1 it deletes every .yml it created, and
// that is the whole basis of the "your collection is untouched" claim it makes
// here. It also reports the files it could NOT delete — a locked file, a
// read-only directory — precisely so the claim can be withdrawn when it is not
// true. Those files are still sitting in the collection, so the user has to be
// told which ones and where they are: they are the user's to remove, and the
// next attempt refuses outright on a .yml it did not create.
const RollbackLeftovers = ({ failures }) => {
  if (!failures?.length) {
    return null;
  }

  return (
    <div className="warn mt-2" data-testid="migrate-collection-to-yml-rollback-failures">
      <div>
        {failures.length} .yml file{failures.length === 1 ? '' : 's'} this run created could not be removed and{' '}
        {failures.length === 1 ? 'is' : 'are'} still in the collection. Your <code>.bru</code> files were not touched
        &mdash; delete these by hand before converting again:
      </div>
      <FileLines entries={failures} />
    </div>
  );
};

// Converting a collection from .bru to .yml rewrites every request file in it.
// It is a one-time, deliberate decision, not something anyone should trip over
// while reading the Overview tab — so it lives behind a collapsed "Advanced"
// disclosure at the bottom of the tab, and the button itself opens a
// confirmation that spells out what happens and where the originals end up.
const MigrateToYml = ({ collection }) => {
  const [expanded, setExpanded] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // Ref, not state: the progress listener is registered once and has to compare
  // against the current migration id from inside that stale closure.
  const migrationUidRef = useRef(null);

  // `progress` is set the moment the run starts and cleared when it settles, so
  // it is the render-time truth. Deriving this from the ref instead would mean
  // rendering off a value React never re-renders for.
  const running = progress !== null;

  useEffect(() => {
    const { ipcRenderer } = window;
    if (!ipcRenderer) {
      return;
    }

    const removeListener = ipcRenderer.on('main:collection-yml-migration-progress', (payload) => {
      // Several collections could in principle be converting; only follow ours.
      if (!payload || payload.migrationUid !== migrationUidRef.current) {
        return;
      }
      setProgress(payload);
    });

    return () => {
      if (typeof removeListener === 'function') {
        removeListener();
      }
    };
  }, []);

  // Only .bru collections have anything to convert.
  if (collection?.format === 'yml') {
    return null;
  }

  const startMigration = async () => {
    const { ipcRenderer } = window;
    const migrationUid = newMigrationUid();
    migrationUidRef.current = migrationUid;
    setShowConfirm(false);
    setResult(null);
    setError(null);
    setProgress({ phase: 'scanning', processed: 0, total: 0 });

    try {
      const migrationResult = await ipcRenderer.invoke('renderer:migrate-collection-to-yml', {
        collectionPathname: collection.pathname,
        collectionUid: collection.uid,
        migrationUid
      });
      setResult(migrationResult);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      migrationUidRef.current = null;
      setProgress(null);
    }
  };

  const cancelMigration = () => {
    const { ipcRenderer } = window;
    if (!migrationUidRef.current) {
      return;
    }
    ipcRenderer.invoke('renderer:cancel-collection-yml-migration', { migrationUid: migrationUidRef.current });
  };

  const percent = progress && progress.total
    ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
    : 0;

  // Cancel is only honoured while files are being converted and verified. Once
  // the commit starts (originals moving to the Trash) stopping halfway would
  // leave a tree that is neither the old one nor the new one.
  const cancellable = progress && progress.phase !== 'committing';

  return (
    <StyledWrapper className="w-full">
      <button
        type="button"
        className="advanced-toggle flex items-center gap-1 text-xs py-2"
        onClick={() => setExpanded(!expanded)}
        data-testid="collection-settings-advanced-toggle"
      >
        {expanded ? <IconChevronDown size={14} stroke={1.5} /> : <IconChevronRight size={14} stroke={1.5} />}
        Advanced
      </button>

      {expanded ? (
        <div className="advanced-panel p-3 text-xs">
          <div className="flex items-start gap-2">
            <IconFileCode size={16} stroke={1.5} className="flex-shrink-0 mt-[2px]" />
            <div className="flex-1">
              <div className="font-medium">Convert this collection to the .yml format</div>
              <div className="muted mt-1">
                Rewrites every <code>.bru</code> file in this collection as <code>.yml</code>. Each converted file is
                read back and checked against the original before anything is removed, and the originals move to
                Gridman&rsquo;s Trash rather than being deleted.
              </div>

              {!running && !result && !error ? (
                <div className="mt-3">
                  <Button
                    size="sm"
                    color="secondary"
                    variant="outline"
                    onClick={() => setShowConfirm(true)}
                    data-testid="migrate-collection-to-yml-btn"
                  >
                    Convert to .yml…
                  </Button>
                </div>
              ) : null}

              {running ? (
                <div className="mt-3" data-testid="migrate-collection-to-yml-progress">
                  <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="muted">
                      {progress?.phase === 'scanning' ? 'Scanning collection…' : null}
                      {progress?.phase === 'converting'
                        ? `Converting and verifying ${progress.processed} of ${progress.total}…`
                        : null}
                      {progress?.phase === 'committing' ? 'Moving originals to Trash…' : null}
                    </div>
                    <Button
                      size="sm"
                      color="secondary"
                      variant="ghost"
                      disabled={!cancellable}
                      onClick={cancelMigration}
                      data-testid="migrate-collection-to-yml-cancel-btn"
                    >
                      Cancel
                    </Button>
                  </div>
                  {progress?.relativePath ? (
                    <div className="muted file-line mt-1">{progress.relativePath}</div>
                  ) : null}
                </div>
              ) : null}

              {error ? (
                <div className="mt-3 danger" data-testid="migrate-collection-to-yml-error">
                  {error}
                </div>
              ) : null}

              {result?.status === 'migrated' ? (
                <div className="mt-3" data-testid="migrate-collection-to-yml-done">
                  <div className="ok font-medium">
                    Converted {result.converted} file{result.converted === 1 ? '' : 's'}.
                  </div>
                  <div className="muted mt-1">
                    The originals are in Trash and can be restored from there. Reopen this collection (or restart
                    Gridman) to load it in the new format.
                  </div>
                  {/*
                    A failed move is not proof that the original is still where
                    it was: app-trash's movePathWithRetry copies before it
                    removes, and when the removal fails half way it reports the
                    copy in Trash as the only COMPLETE copy (sourceIntact:
                    false) and keeps that entry. So "still on disk next to their
                    .yml replacements" can be false for exactly the file the
                    user would then delete. Nothing was lost either way — the
                    per-file reason says which case each one is.
                  */}
                  {result.notTrashed?.length ? (
                    <div className="warn mt-2">
                      <div>
                        {result.notTrashed.length} original file{result.notTrashed.length === 1 ? '' : 's'} could not be
                        moved to Trash. Nothing was lost, but do not delete anything before reading these: a file may
                        still be in the collection, or its only complete copy may already be in Trash.
                      </div>
                      <FileLines entries={result.notTrashed} />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {result?.status === 'cancelled' ? (
                <div className="mt-3" data-testid="migrate-collection-to-yml-cancelled">
                  <div className="warn">
                    {result.rollbackFailures?.length
                      ? 'Cancelled, but the collection is not quite as it was.'
                      : 'Cancelled. Every .yml file this run created was removed — the collection is untouched.'}
                  </div>
                  <RollbackLeftovers failures={result.rollbackFailures} />
                </div>
              ) : null}

              {result?.status === 'aborted' ? (
                <div className="mt-3" data-testid="migrate-collection-to-yml-aborted">
                  <div className="danger font-medium">
                    {result.rollbackFailures?.length
                      ? 'Conversion stopped — nothing was migrated, but the collection is not quite as it was.'
                      : 'Conversion cancelled — the collection is untouched.'}
                  </div>
                  <div className="muted mt-1">{result.reason}</div>
                  <RollbackLeftovers failures={result.rollbackFailures} />
                  {result.differences?.length ? (
                    <div className="difference-list mt-2 p-2">
                      {result.differences.map((difference, index) => (
                        <div key={index} className="file-line">
                          <span className="muted">{difference.path}</span>: {difference.expected} &rarr;{' '}
                          {difference.actual}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {result || error ? (
                <div className="mt-3">
                  <Button
                    size="sm"
                    color="secondary"
                    variant="ghost"
                    onClick={() => {
                      setResult(null);
                      setError(null);
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {showConfirm ? (
        <Modal
          size="md"
          title="Convert collection to .yml"
          confirmText="Convert to .yml"
          cancelText="Cancel"
          confirmButtonColor="danger"
          handleConfirm={startMigration}
          handleCancel={() => setShowConfirm(false)}
          dataTestId="migrate-collection-to-yml-modal"
        >
          <div className="text-sm">
            <p>
              Gridman will convert every <code>.bru</code> file in <strong>{collection?.name}</strong> to{' '}
              <code>.yml</code>, in this order:
            </p>
            <ol className="list-decimal ml-5 mt-2 space-y-1">
              <li>Write a <code>.yml</code> copy next to each original. Nothing is removed at this stage.</li>
              <li>
                Read every copy back from disk and compare it to the original. If a single file does not match, the
                whole conversion stops, every <code>.yml</code> it wrote is deleted, and your collection is left exactly
                as it is now.
              </li>
              <li>
                Only after a clean pass: move the <code>.bru</code> originals — and <code>bruno.json</code> — into
                Gridman&rsquo;s Trash. They are <strong>not deleted</strong>; you can restore any of them from the Trash
                panel.
              </li>
            </ol>
            <p className="mt-3 muted">
              This rewrites every request file in the collection, so if it is tracked by git, expect a large diff.
              Committing before you convert makes it easy to compare afterwards.
            </p>
            <p className="mt-2 muted">
              You can cancel while files are being converted; a cancel deletes the copies made so far and leaves the
              collection unchanged.
            </p>
          </div>
        </Modal>
      ) : null}
    </StyledWrapper>
  );
};

export default MigrateToYml;
