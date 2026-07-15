import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { IconFolder, IconFileText, IconBox, IconVariable, IconTrash, IconArrowBackUp } from '@tabler/icons';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { refreshCollectionIndex } from 'providers/ReduxStore/slices/collections/actions';
import StyledWrapper from './StyledWrapper';

const TYPE_ICONS = {
  request: IconFileText,
  folder: IconFolder,
  collection: IconBox,
  environment: IconVariable
};

const formatDeletedAt = (iso) => {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return '';
  }
  const deltaMinutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes} min ago`;
  const hours = Math.round(deltaMinutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
};

// Postman-style in-app Trash, opened from the bottom status bar. Lists items
// deleted in Gridman (kept 30 days in the app's own trash store) with restore
// and delete-forever. Restore puts the file/folder back at its original path;
// the watcher/index refresh makes it reappear in the sidebar.
const Trash = ({ onClose }) => {
  const dispatch = useDispatch();
  const collections = useSelector((state) => state.collections.collections);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await window.ipcRenderer.invoke('renderer:list-app-trash');
      setEntries(list || []);
    } catch (error) {
      toast.error(error?.message || 'Failed to load trash');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshOwningCollection = (entry) => {
    const target = entry.collectionPathname || entry.originalPathname;
    const collection = collections?.find((c) => target && target.startsWith(c.pathname));
    if (collection) {
      dispatch(refreshCollectionIndex({ collectionUid: collection.uid, priority: true })).catch(() => {});
    }
  };

  const handleRestore = async (entry) => {
    setBusyId(entry.id);
    try {
      await window.ipcRenderer.invoke('renderer:restore-app-trash-item', { entryId: entry.id });
      refreshOwningCollection(entry);
      toast.success(`Restored "${entry.displayName}"`);
      await load();
    } catch (error) {
      toast.error(error?.message || 'Failed to restore');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteForever = async (entry) => {
    setBusyId(entry.id);
    try {
      await window.ipcRenderer.invoke('renderer:delete-app-trash-item', { entryId: entry.id });
      await load();
    } catch (error) {
      toast.error(error?.message || 'Failed to delete');
    } finally {
      setBusyId(null);
    }
  };

  const handleEmpty = async () => {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    try {
      await window.ipcRenderer.invoke('renderer:empty-app-trash');
      setConfirmEmpty(false);
      await load();
      toast.success('Trash emptied');
    } catch (error) {
      toast.error(error?.message || 'Failed to empty trash');
    }
  };

  return (
    <Modal size="lg" title="Trash" handleCancel={onClose} hideFooter>
      <StyledWrapper>
        <div className="flex items-center justify-between mb-3">
          <div className="text-muted text-sm">
            Items deleted in Gridman are kept here for 30 days, then removed automatically.
          </div>
          <Button
            size="xs"
            color="danger"
            variant="outline"
            disabled={!entries.length}
            onClick={handleEmpty}
            onMouseLeave={() => setConfirmEmpty(false)}
          >
            {confirmEmpty ? 'Really empty trash?' : 'Empty trash'}
          </Button>
        </div>

        {loading ? (
          <div className="text-muted py-6 text-center">Loading…</div>
        ) : !entries.length ? (
          <div className="text-muted py-8 text-center">Trash is empty.</div>
        ) : (
          <div className="trash-list">
            {entries.map((entry) => {
              const TypeIcon = TYPE_ICONS[entry.type] || IconFileText;
              return (
                <div key={entry.id} className="trash-row" data-testid="trash-row">
                  <TypeIcon size={16} strokeWidth={1.5} className="trash-type-icon" />
                  <div className="trash-main">
                    <div className="trash-name truncate" title={entry.displayName}>{entry.displayName}</div>
                    <div className="trash-origin truncate text-muted" title={entry.originalPathname}>
                      {entry.originalPathname}
                    </div>
                  </div>
                  <div className="trash-when text-muted">{formatDeletedAt(entry.deletedAt)}</div>
                  <Button
                    size="xs"
                    color="light"
                    icon={<IconArrowBackUp size={13} />}
                    loading={busyId === entry.id}
                    onClick={() => handleRestore(entry)}
                    data-testid="trash-restore"
                  >
                    Restore
                  </Button>
                  <Button
                    size="xs"
                    color="danger"
                    variant="ghost"
                    icon={<IconTrash size={13} />}
                    loading={busyId === entry.id}
                    onClick={() => handleDeleteForever(entry)}
                    data-testid="trash-delete-forever"
                  >
                    Delete
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </StyledWrapper>
    </Modal>
  );
};

export default Trash;
