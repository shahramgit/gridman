import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { IconHistory, IconTrash, IconX } from '@tabler/icons';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { revealRequestInSidebar } from 'providers/ReduxStore/slices/app';
import { historyLoaded, historyEntryRemoved, historyCleared } from 'providers/ReduxStore/slices/history';
import { loadRequest } from 'providers/ReduxStore/slices/collections/actions';
import { findCollectionByUid, getDefaultRequestPaneTab } from 'utils/collections/index';
import StyledWrapper from './StyledWrapper';

const dayLabel = (ts) => {
  const date = new Date(ts);
  const today = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString();
};

const timeLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const statusClass = (status) => {
  if (typeof status !== 'number') return 'status-error';
  if (status < 300) return 'status-ok';
  if (status < 400) return 'status-redirect';
  return 'status-error';
};

// Postman-style History: every send, grouped by day, newest first. Click an
// entry to open its request (loads from disk and focuses the tab — same
// robust path save-as uses). Entries are local-only snapshots of the
// AUTHORED request + response meta; nothing leaves the machine.
const HistorySection = () => {
  const dispatch = useDispatch();
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const entries = useSelector((state) => state.history.entries);
  const loadedWorkspaceUid = useSelector((state) => state.history.workspaceUid);
  const collections = useSelector((state) => state.collections.collections);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceUid || loadedWorkspaceUid === activeWorkspaceUid) {
      return;
    }
    window.ipcRenderer
      ?.invoke?.('renderer:load-request-history', { workspaceUid: activeWorkspaceUid })
      .then((loaded) => dispatch(historyLoaded({ workspaceUid: activeWorkspaceUid, entries: loaded || [] })))
      .catch(() => dispatch(historyLoaded({ workspaceUid: activeWorkspaceUid, entries: [] })));
  }, [activeWorkspaceUid, loadedWorkspaceUid, dispatch]);

  const grouped = useMemo(() => {
    const groups = [];
    let current = null;
    for (const entry of entries) {
      const label = dayLabel(entry.ts);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(entry);
    }
    return groups;
  }, [entries]);

  const openEntry = async (entry) => {
    const collection = findCollectionByUid(collections, entry.collectionUid);
    if (!collection || !entry.itemPathname) {
      toast.error('The request\'s collection is not open in this workspace');
      return;
    }
    try {
      const loadedFile = await dispatch(loadRequest({ collectionUid: entry.collectionUid, pathname: entry.itemPathname }));
      const tabUid = loadedFile?.data?.uid;
      if (!tabUid) {
        throw new Error('Request file no longer exists');
      }
      dispatch(addTab({
        uid: tabUid,
        collectionUid: entry.collectionUid,
        requestPaneTab: getDefaultRequestPaneTab(loadedFile.data),
        preview: true,
        itemUid: tabUid,
        itemPathname: String(entry.itemPathname).normalize('NFC')
      }));
      dispatch(revealRequestInSidebar({
        collectionUid: entry.collectionUid,
        pathname: String(entry.itemPathname).normalize('NFC')
      }));
    } catch (error) {
      toast.error(error?.message || 'This request no longer exists on disk');
    }
  };

  const removeEntry = (entry) => {
    dispatch(historyEntryRemoved({ id: entry.id }));
    window.ipcRenderer?.invoke?.('renderer:remove-request-history-entry', { workspaceUid: activeWorkspaceUid, id: entry.id }).catch(() => {});
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    dispatch(historyCleared());
    window.ipcRenderer?.invoke?.('renderer:clear-request-history', { workspaceUid: activeWorkspaceUid }).catch(() => {});
  };

  const sectionActions = (
    <ActionIcon
      label={confirmClear ? 'Click again to clear all history' : 'Clear history'}
      data-testid="history-clear"
      color={confirmClear ? 'red' : undefined}
      onClick={clearAll}
    >
      <IconTrash size={14} stroke={1.5} aria-hidden="true" />
    </ActionIcon>
  );

  return (
    <SidebarSection id="history" title="History" icon={IconHistory} actions={sectionActions} className="history-section">
      <StyledWrapper>
        {!entries.length ? (
          <div className="empty-message">Requests you send will appear here.</div>
        ) : (
          grouped.map((group) => (
            <div key={group.label}>
              <div className="day-label">{group.label}</div>
              {group.items.map((entry) => (
                <div
                  key={entry.id}
                  className="history-row"
                  data-testid="history-row"
                  title={`${entry.method} ${entry.url}\n${entry.collectionName}`}
                  onClick={() => openEntry(entry)}
                >
                  <span className={`method method-${String(entry.method || '').toLowerCase()}`}>{entry.method}</span>
                  <span className="entry-name truncate">{entry.itemName}</span>
                  <span className={`status ${statusClass(entry.status)}`}>
                    {typeof entry.status === 'number' ? entry.status : 'ERR'}
                  </span>
                  <span className="entry-time">{timeLabel(entry.ts)}</span>
                  <ActionIcon
                    label="Remove from history"
                    className="remove-icon"
                    data-testid="history-remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeEntry(entry);
                    }}
                  >
                    <IconX size={12} stroke={1.5} aria-hidden="true" />
                  </ActionIcon>
                </div>
              ))}
            </div>
          ))
        )}
      </StyledWrapper>
    </SidebarSection>
  );
};

export default HistorySection;
