import { useEffect } from 'react';
import { perfCount } from 'utils/common/perfLogger';
import {
  updateCookies,
  updatePreferences,
  setGitVersion
} from 'providers/ReduxStore/slices/app';
import {
  addTab
} from 'providers/ReduxStore/slices/tabs';
import {
  brunoConfigUpdateEvent,
  collectionAddDirectoryEvent,
  collectionAddFileEvent,
  collectionIndexBatchReceived,
  collectionIndexCancelled,
  collectionIndexFailed,
  collectionIndexReady,
  collectionIndexStarted,
  collectionTreeBatchUpdatedEvent,
  collectionChangeFileEvent,
  collectionRenamedEvent,
  collectionUnlinkDirectoryEvent,
  collectionUnlinkEnvFileEvent,
  collectionUnlinkFileEvent,
  processEnvUpdateEvent,
  workspaceEnvUpdateEvent,
  requestCancelled,
  runFolderEvent,
  runRequestEvent,
  scriptEnvironmentUpdateEvent,
  streamDataReceived,
  setDotEnvVariables
} from 'providers/ReduxStore/slices/collections';
import { collectionAddEnvFileEvent, openCollectionEvent, hydrateCollectionWithUiStateSnapshot, mergeAndPersistEnvironment } from 'providers/ReduxStore/slices/collections/actions';
import {
  workspaceOpenedEvent,
  workspaceConfigUpdatedEvent
} from 'providers/ReduxStore/slices/workspaces/actions';
import { workspaceDotEnvUpdateEvent, setWorkspaceDotEnvVariables } from 'providers/ReduxStore/slices/workspaces';
import toast from 'react-hot-toast';
import { batch, useDispatch, useStore } from 'react-redux';
import { isElectron } from 'utils/common/platform';
import { globalEnvironmentsUpdateEvent, updateGlobalEnvironments } from 'providers/ReduxStore/slices/global-environments';
import { collectionAddOauth2CredentialsByUrl, collectionClearOauth2CredentialsByCredentialsId, updateCollectionLoadingState } from 'providers/ReduxStore/slices/collections/index';
import { addLog } from 'providers/ReduxStore/slices/logs';
import { updateSystemResources } from 'providers/ReduxStore/slices/performance';
import { apiSpecAddFileEvent, apiSpecChangeFileEvent } from 'providers/ReduxStore/slices/apiSpec';

const useIpcEvents = () => {
  const dispatch = useDispatch();
  const store = useStore();

  useEffect(() => {
    if (!isElectron()) {
      return () => {};
    }

    const { ipcRenderer } = window;
    const collectionTreeQueue = [];
    let collectionTreeFlushTimer = null;

    const dispatchCollectionTreeUpdate = (type, val) => {
      if (type === 'addDir') {
        dispatch(
          collectionAddDirectoryEvent({
            dir: val
          })
        );
      }
      if (type === 'addFile') {
        dispatch(
          collectionAddFileEvent({
            file: val
          })
        );
      }
      if (type === 'change') {
        dispatch(
          collectionChangeFileEvent({
            file: val
          })
        );
      }
      if (type === 'unlink') {
        dispatch(
          collectionUnlinkFileEvent({
            file: val
          })
        );
      }
      if (type === 'unlinkDir') {
        dispatch(
          collectionUnlinkDirectoryEvent({
            directory: val
          })
        );
      }
      if (type === 'addEnvironmentFile') {
        dispatch(collectionAddEnvFileEvent(val));
      }
      if (type === 'unlinkEnvironmentFile') {
        dispatch(collectionUnlinkEnvFileEvent(val));
      }
    };

    // Background eager hydration streams addFile/addDir tree updates for ~85s
    // after warm. Each batch re-renders the sidebar; while a workspace search
    // is active and its result list is mounted, that was 400-700ms per batch
    // (measured on GSB) — the "scrolling hangs for a minute" report. So HOLD
    // hydration adds while a search is active and drain them when it clears;
    // structural updates (unlink/rename/change) still apply immediately so the
    // tree stays correct. TREE_FLUSH_CAP also bounds any single flush (incl.
    // the post-search drain) so applying a large backlog never becomes one
    // multi-second immer produce.
    const TREE_FLUSH_CAP = 80;
    const TREE_HOLD_RECHECK_MS = 400;
    const flushCollectionTreeQueue = () => {
      collectionTreeFlushTimer = null;
      if (!collectionTreeQueue.length) {
        return;
      }
      const searchActive = Boolean(store.getState().app?.workspaceSearchActive);

      const dispatchNow = [];
      const remaining = [];
      let addBudget = TREE_FLUSH_CAP;
      for (const update of collectionTreeQueue) {
        const isAdd = update.type === 'addFile' || update.type === 'addDir';
        if (isAdd && (searchActive || addBudget <= 0)) {
          remaining.push(update);
        } else {
          if (isAdd) {
            addBudget -= 1;
          }
          dispatchNow.push(update);
        }
      }
      collectionTreeQueue.length = 0;
      if (remaining.length) {
        collectionTreeQueue.push(...remaining);
      }

      if (dispatchNow.length) {
        const batchableUpdates = dispatchNow.filter(({ type }) => type === 'addDir' || type === 'addFile');
        const otherUpdates = dispatchNow.filter(({ type }) => type !== 'addDir' && type !== 'addFile');
        perfCount('treeFiles', dispatchNow.length);
        batch(() => {
          if (batchableUpdates.length) {
            dispatch(collectionTreeBatchUpdatedEvent({ updates: batchableUpdates }));
          }
          otherUpdates.forEach(({ type, val }) => dispatchCollectionTreeUpdate(type, val));
        });
      }

      if (collectionTreeQueue.length && !collectionTreeFlushTimer) {
        collectionTreeFlushTimer = setTimeout(flushCollectionTreeQueue, searchActive ? TREE_HOLD_RECHECK_MS : 50);
      }
    };

    const queueCollectionTreeUpdate = (type, val) => {
      const isReadyRequestFile = type === 'addFile'
        && val?.meta?.pathname
        && val?.loading === false
        && val?.partial === false;

      if (isReadyRequestFile) {
        // Drop any stale queued (partial) updates for the same file — the
        // ready payload supersedes them.
        const readyPathname = String(val.meta.pathname || '').normalize('NFC');
        for (let i = collectionTreeQueue.length - 1; i >= 0; i -= 1) {
          const update = collectionTreeQueue[i];
          if (
            update.type === 'addFile'
            && update.val?.meta?.collectionUid === val.meta.collectionUid
            && String(update.val?.meta?.pathname || '').normalize('NFC') === readyPathname
          ) {
            collectionTreeQueue.splice(i, 1);
          }
        }
        // A ready file some queued task is WAITING on (OPEN_REQUEST /
        // OPEN_EXAMPLE — i.e. the user just created it) must dispatch
        // immediately: the tasks middleware listens for the SINGLE
        // collectionAddFileEvent, and routing it through the batch dispatch
        // silently broke 'create request -> tab opens'. Everything else
        // (bulk background hydration) stays batched — dispatching those
        // individually meant one render per hydrated file, thousands of
        // times, which kept the app laggy for ~30s after a first search.
        const taskQueue = store.getState().app?.taskQueue || [];
        const hasWaitingTask = taskQueue.some(
          (task) => task.collectionUid === val.meta.collectionUid
        );
        if (hasWaitingTask) {
          dispatchCollectionTreeUpdate(type, val);
          return;
        }
      }

      collectionTreeQueue.push({ type, val });

      if (!collectionTreeFlushTimer) {
        collectionTreeFlushTimer = setTimeout(flushCollectionTreeQueue, 50);
      }
    };

    const _collectionTreeUpdated = (type, val) => {
      if (window.__IS_DEV__) {
        console.log(type);
        console.log(val);
      }

      if (type === 'unlink') {
        setTimeout(() => {
          queueCollectionTreeUpdate(type, val);
        }, 100);
        return;
      }

      queueCollectionTreeUpdate(type, val);
    };

    const _apiSpecTreeUpdated = (type, val) => {
      if (window.__IS_DEV__) {
        console.log('API Spec update:', type);
        console.log(val);
      }
      if (type === 'addFile') {
        dispatch(apiSpecAddFileEvent({ data: val }));
      }
      if (type === 'changeFile') {
        dispatch(apiSpecChangeFileEvent({ data: val }));
      }
    };

    ipcRenderer.invoke('renderer:ready');

    const removeCollectionTreeUpdateListener = ipcRenderer.on('main:collection-tree-updated', _collectionTreeUpdated);
    const removeCollectionIndexStartedListener = ipcRenderer.on('main:collection-index-started', (val) => {
      flushIndexBatchBuffer(true);
      dispatch(collectionIndexStarted(val));
    });
    // Index batches are coalesced before hitting redux: the startup warm
    // streams batches for 100+ collections and dispatching each one froze
    // frames (immer re-freezes the index maps per dispatch) while the user
    // scrolled. Consecutive batches for the same load session merge into one
    // dispatch, flushed at most every ~120ms; started/ready/failed/cancelled
    // flush the buffer first so event ordering is preserved.
    let indexBatchBuffer = [];
    let indexBatchFlushTimer = null;
    // Cap the reducer work per flush: an unbounded merge applied a whole
    // large collection (4k+ nodes) in one dispatch — a multi-second renderer
    // task in dev when it landed while the user scrolled. Oversized merges
    // split into <=1200-node dispatches; leftovers re-arm the timer so each
    // main-thread task stays bounded.
    const INDEX_FLUSH_NODE_CAP = 1200;
    const flushIndexBatchBuffer = (drainAll = false) => {
      if (indexBatchFlushTimer) {
        clearTimeout(indexBatchFlushTimer);
        indexBatchFlushTimer = null;
      }
      if (!indexBatchBuffer.length) {
        return;
      }
      const events = indexBatchBuffer;
      indexBatchBuffer = [];
      const merged = [];
      for (const event of events) {
        const last = merged[merged.length - 1];
        if (last && last.collectionUid === event.collectionUid && last.loadSessionId === event.loadSessionId) {
          last.nodes = last.nodes.concat(event.nodes || []);
          last.totalScanned = event.totalScanned ?? last.totalScanned;
        } else {
          merged.push({ ...event, nodes: [...(event.nodes || [])] });
        }
      }
      let appliedNodes = 0;
      while (merged.length) {
        const event = merged.shift();
        if (!drainAll && appliedNodes >= INDEX_FLUSH_NODE_CAP) {
          indexBatchBuffer.unshift(event, ...merged);
          break;
        }
        if (!drainAll && (event.nodes || []).length > INDEX_FLUSH_NODE_CAP) {
          const rest = { ...event, nodes: event.nodes.slice(INDEX_FLUSH_NODE_CAP) };
          event.nodes = event.nodes.slice(0, INDEX_FLUSH_NODE_CAP);
          merged.unshift(rest);
        }
        appliedNodes += (event.nodes || []).length;
        perfCount('indexBatchNodes', (event.nodes || []).length);
        dispatch(collectionIndexBatchReceived(event));
      }
      if (indexBatchBuffer.length && !indexBatchFlushTimer) {
        indexBatchFlushTimer = setTimeout(flushIndexBatchBuffer, 120);
      }
    };
    const removeCollectionIndexBatchListener = ipcRenderer.on('main:collection-index-batch', (val) => {
      indexBatchBuffer.push(val);
      if (!indexBatchFlushTimer) {
        indexBatchFlushTimer = setTimeout(flushIndexBatchBuffer, 120);
      }
    });
    const removeCollectionIndexReadyListener = ipcRenderer.on('main:collection-index-ready', (val) => {
      flushIndexBatchBuffer(true);
      perfCount('indexesReady', 1);
      dispatch(collectionIndexReady(val));
    });
    const removeCollectionIndexFailedListener = ipcRenderer.on('main:collection-index-failed', (val) => {
      flushIndexBatchBuffer(true);
      dispatch(collectionIndexFailed(val));
    });
    const removeCollectionIndexCancelledListener = ipcRenderer.on('main:collection-index-cancelled', (val) => {
      flushIndexBatchBuffer(true);
      dispatch(collectionIndexCancelled(val));
    });

    const removeApiSpecTreeUpdateListener = ipcRenderer.on('main:apispec-tree-updated', _apiSpecTreeUpdated);

    const removeOpenCollectionListener = ipcRenderer.on('main:collection-opened', (pathname, uid, brunoConfig, sourceWorkspacePath) => {
      dispatch(openCollectionEvent(uid, pathname, brunoConfig, sourceWorkspacePath));
    });

    const removeOpenWorkspaceListener = ipcRenderer.on('main:workspace-opened', (workspacePath, workspaceUid, workspaceConfig) => {
      dispatch(workspaceOpenedEvent(workspacePath, workspaceUid, workspaceConfig));
    });

    const removeWorkspaceConfigUpdatedListener = ipcRenderer.on('main:workspace-config-updated', (workspacePath, workspaceUid, workspaceConfig) => {
      dispatch(workspaceConfigUpdatedEvent(workspacePath, workspaceUid, workspaceConfig));
    });

    // Channel names must match what app/workspace-watcher.js sends
    // (`main:global-environment-*`). They didn't, so an environment file added,
    // edited or deleted outside the app never refreshed the global environments —
    // the listeners below were never called. upstream bruno #8370
    const removeWorkspaceEnvironmentAddedListener = ipcRenderer.on('main:global-environment-added', (workspaceUid, file) => {
      const state = store.getState();
      const activeWorkspaceUid = state.workspaces?.activeWorkspaceUid;
      if (activeWorkspaceUid === workspaceUid) {
        const workspace = state.workspaces?.workspaces?.find((w) => w.uid === workspaceUid);
        if (workspace) {
          ipcRenderer.invoke('renderer:get-global-environments', {
            workspaceUid,
            workspacePath: workspace.pathname
          }).then((result) => {
            dispatch(updateGlobalEnvironments(result));
          }).catch((error) => {
            console.error('Error refreshing global environments:', error);
          });
        }
      }
    });

    const removeWorkspaceEnvironmentChangedListener = ipcRenderer.on('main:global-environment-changed', (workspaceUid, file) => {
      const state = store.getState();
      const activeWorkspaceUid = state.workspaces?.activeWorkspaceUid;
      if (activeWorkspaceUid === workspaceUid) {
        const workspace = state.workspaces?.workspaces?.find((w) => w.uid === workspaceUid);
        if (workspace) {
          ipcRenderer.invoke('renderer:get-global-environments', {
            workspaceUid,
            workspacePath: workspace.pathname
          }).then((result) => {
            dispatch(updateGlobalEnvironments(result));
          }).catch((error) => {
            console.error('Error refreshing global environments:', error);
          });
        }
      }
    });

    const removeWorkspaceEnvironmentDeletedListener = ipcRenderer.on('main:global-environment-deleted', (workspaceUid, environmentUid) => {
      const state = store.getState();
      const activeWorkspaceUid = state.workspaces?.activeWorkspaceUid;
      if (activeWorkspaceUid === workspaceUid) {
        const workspace = state.workspaces?.workspaces?.find((w) => w.uid === workspaceUid);
        if (workspace) {
          ipcRenderer.invoke('renderer:get-global-environments', {
            workspaceUid,
            workspacePath: workspace.pathname
          }).then((result) => {
            dispatch(updateGlobalEnvironments(result));
          }).catch((error) => {
            console.error('Error refreshing global environments:', error);
          });
        }
      }
    });

    const removeDisplayErrorListener = ipcRenderer.on('main:display-error', (error) => {
      if (typeof error === 'string') {
        return toast.error(error || 'Something went wrong!');
      }
      if (typeof error === 'object') {
        return toast.error(error.message || 'Something went wrong!');
      }
    });

    const removeScriptEnvUpdateListener = ipcRenderer.on('main:script-environment-update', (val) => {
      dispatch(scriptEnvironmentUpdateEvent(val));
    });

    const removePersistentEnvVariablesUpdateListener = ipcRenderer.on('main:persistent-env-variables-update', (val) => {
      dispatch(mergeAndPersistEnvironment(val));
    });

    const removeGlobalEnvironmentVariablesUpdateListener = ipcRenderer.on('main:global-environment-variables-update', (val) => {
      dispatch(globalEnvironmentsUpdateEvent(val));
    });

    const removeCollectionRenamedListener = ipcRenderer.on('main:collection-renamed', (val) => {
      dispatch(collectionRenamedEvent(val));
    });

    const removeRunFolderEventListener = ipcRenderer.on('main:run-folder-event', (val) => {
      dispatch(runFolderEvent(val));
    });

    const removeRunRequestEventListener = ipcRenderer.on('main:run-request-event', (val) => {
      dispatch(runRequestEvent(val));
    });

    const removeProcessEnvUpdatesListener = ipcRenderer.on('main:process-env-update', (val) => {
      dispatch(processEnvUpdateEvent(val));
    });

    const removeWorkspaceDotEnvUpdatesListener = ipcRenderer.on('main:workspace-dotenv-update', (val) => {
      dispatch(workspaceDotEnvUpdateEvent(val));
      dispatch(workspaceEnvUpdateEvent({ processEnvVariables: val.processEnvVariables }));
    });

    const removeDotEnvFileUpdateListener = ipcRenderer.on('main:dotenv-file-update', (val) => {
      const { type, collectionUid, workspaceUid, filename, variables, exists, processEnvVariables } = val;

      if (type === 'collection' && collectionUid) {
        dispatch(setDotEnvVariables({
          collectionUid,
          variables,
          exists,
          filename
        }));
        if (filename === '.env') {
          dispatch(processEnvUpdateEvent({ collectionUid, processEnvVariables }));
        }
      } else if (type === 'workspace' && workspaceUid) {
        dispatch(setWorkspaceDotEnvVariables({
          workspaceUid,
          variables,
          exists,
          filename
        }));
        if (filename === '.env') {
          dispatch(workspaceDotEnvUpdateEvent(val));
          dispatch(workspaceEnvUpdateEvent({ processEnvVariables }));
        }
      }
    });

    const removeConsoleLogListener = ipcRenderer.on('main:console-log', (val) => {
      console[val.type](...val.args);
      dispatch(addLog({
        type: val.type,
        args: val.args,
        timestamp: new Date().toISOString()
      }));
    });

    const removeSystemResourcesListener = ipcRenderer.on('main:filesync-system-resources', (resourceData) => {
      dispatch(updateSystemResources(resourceData));
    });

    const removeConfigUpdatesListener = ipcRenderer.on('main:bruno-config-update', (val) =>
      dispatch(brunoConfigUpdateEvent(val))
    );

    const removeShowPreferencesListener = ipcRenderer.on('main:open-preferences', () => {
      const state = store.getState();
      const activeWorkspaceUid = state.workspaces?.activeWorkspaceUid;
      const workspaces = state.workspaces?.workspaces;
      const tabs = state.tabs?.tabs;
      const activeTabUid = state.tabs?.activeTabUid;
      const activeTab = tabs?.find((t) => t.uid === activeTabUid);

      const activeWorkspace = workspaces?.find((w) => w.uid === activeWorkspaceUid);
      const collectionUid = activeTab?.collectionUid || activeWorkspace?.scratchCollectionUid;

      dispatch(
        addTab({
          type: 'preferences',
          uid: collectionUid ? `${collectionUid}-preferences` : 'preferences',
          collectionUid
        })
      );
    });

    const removePreferencesUpdatesListener = ipcRenderer.on('main:load-preferences', (val) => {
      dispatch(updatePreferences(val));
    });

    const removeCookieUpdateListener = ipcRenderer.on('main:cookies-update', (val) => {
      dispatch(updateCookies(val));
    });

    const removeGlobalEnvironmentsUpdatesListener = ipcRenderer.on('main:load-global-environments', (val) => {
      dispatch(updateGlobalEnvironments(val));
    });

    const removeSnapshotHydrationListener = ipcRenderer.on('main:hydrate-app-with-ui-state-snapshot', (val) => {
      dispatch(hydrateCollectionWithUiStateSnapshot(val));
    });

    const removeCollectionOauth2CredentialsUpdatesListener = ipcRenderer.on('main:credentials-update', (val) => {
      const payload = {
        ...val,
        itemUid: val.itemUid || null,
        folderUid: val.folderUid || null,
        credentialsId: val.credentialsId || 'credentials'
      };
      dispatch(collectionAddOauth2CredentialsByUrl(payload));
    });

    const removeCollectionOauth2CredentialsClearListener = ipcRenderer.on('main:credentials-clear', (val) => {
      dispatch(collectionClearOauth2CredentialsByCredentialsId(val));
    });

    const removeHttpStreamNewDataListener = ipcRenderer.on('main:http-stream-new-data', (val) => {
      dispatch(streamDataReceived(val));
    });

    const removeHttpStreamEndListener = ipcRenderer.on('main:http-stream-end', (val) => {
      dispatch(requestCancelled(val));
    });

    const removeCollectionLoadingStateListener = ipcRenderer.on('main:collection-loading-state-updated', (val) => {
      dispatch(updateCollectionLoadingState(val));
    });

    const gitVersionListener = ipcRenderer.on('main:git-version', (val) => {
      dispatch(setGitVersion(val));
    });

    return () => {
      removeCollectionTreeUpdateListener();
      removeCollectionIndexStartedListener();
      removeCollectionIndexBatchListener();
      removeCollectionIndexReadyListener();
      removeCollectionIndexFailedListener();
      removeCollectionIndexCancelledListener();
      flushIndexBatchBuffer(true);
      removeApiSpecTreeUpdateListener();
      removeOpenCollectionListener();
      removeOpenWorkspaceListener();
      removeWorkspaceConfigUpdatedListener();
      removeWorkspaceEnvironmentAddedListener();
      removeWorkspaceEnvironmentChangedListener();
      removeWorkspaceEnvironmentDeletedListener();
      removeDisplayErrorListener();
      removeScriptEnvUpdateListener();
      removeGlobalEnvironmentVariablesUpdateListener();
      removeCollectionRenamedListener();
      removeRunFolderEventListener();
      removeRunRequestEventListener();
      removeProcessEnvUpdatesListener();
      removeWorkspaceDotEnvUpdatesListener();
      removeDotEnvFileUpdateListener();
      removeConsoleLogListener();
      removeConfigUpdatesListener();
      removeShowPreferencesListener();
      removePreferencesUpdatesListener();
      removeCookieUpdateListener();
      removeGlobalEnvironmentsUpdatesListener();
      removeSnapshotHydrationListener();
      removeCollectionOauth2CredentialsUpdatesListener();
      removeCollectionOauth2CredentialsClearListener();
      removeHttpStreamNewDataListener();
      removeHttpStreamEndListener();
      removeCollectionLoadingStateListener();
      removePersistentEnvVariablesUpdateListener();
      removeSystemResourcesListener();
      gitVersionListener();
      if (collectionTreeFlushTimer) {
        clearTimeout(collectionTreeFlushTimer);
      }
      collectionTreeQueue.splice(0, collectionTreeQueue.length);
    };
  }, [isElectron]);
};

export default useIpcEvents;
