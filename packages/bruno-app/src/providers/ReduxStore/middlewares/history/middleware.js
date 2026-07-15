import { createListenerMiddleware } from '@reduxjs/toolkit';
import { responseReceived } from 'providers/ReduxStore/slices/collections';
import { historyEntryAdded } from 'providers/ReduxStore/slices/history';
import { findCollectionByUid, findItemInCollection } from 'utils/collections/index';
import { uuid } from 'utils/common';

// Capture every completed send into History. Listens for responseReceived
// (fires for successes AND transport errors), snapshots the request AS
// AUTHORED (uninterpolated {{vars}} — identical to what the collection file
// already contains, so nothing new leaks) and the response meta only. The
// entry goes to the redux slice for the sidebar immediately and to the main
// process (fire-and-forget) for persistence.
const BODY_SNAPSHOT_CAP = 100 * 1024;

const capBody = (body) => {
  if (!body || typeof body !== 'object') {
    return body || null;
  }
  const capped = { ...body };
  for (const key of ['json', 'text', 'xml', 'sparql', 'graphql']) {
    if (typeof capped[key] === 'string' && capped[key].length > BODY_SNAPSHOT_CAP) {
      capped[key] = `${capped[key].slice(0, BODY_SNAPSHOT_CAP)}\n… (truncated for history)`;
    }
  }
  return capped;
};

const historyMiddleware = createListenerMiddleware();

historyMiddleware.startListening({
  actionCreator: responseReceived,
  effect: async (action, listenerApi) => {
    try {
      const { itemUid, collectionUid, response } = action.payload;
      const state = listenerApi.getState();
      const collection = findCollectionByUid(state.collections.collections, collectionUid);
      const item = collection ? findItemInCollection(collection, itemUid) : null;
      if (!item) {
        return;
      }
      const authored = item.draft?.request || item.request || {};
      const entry = {
        id: uuid(),
        ts: Date.now(),
        workspaceUid: state.workspaces.activeWorkspaceUid || null,
        collectionUid,
        collectionName: collection.name,
        itemUid,
        itemPathname: item.pathname || null,
        itemName: item.name || item.filename || 'request',
        type: item.type || 'http-request',
        method: authored.method || 'GET',
        url: authored.url || '',
        request: {
          headers: authored.headers || [],
          params: authored.params || [],
          body: capBody(authored.body),
          authMode: authored.auth?.mode || 'none'
        },
        status: response?.status ?? null,
        statusText: response?.statusText || (response ? '' : 'error'),
        durationMs: response?.duration ?? null,
        sizeBytes: response?.size ?? null
      };
      listenerApi.dispatch(historyEntryAdded(entry));
      window.ipcRenderer?.invoke?.('renderer:append-request-history', { entry }).catch(() => {});
    } catch (_err) {
      // history capture must never break the send flow
    }
  }
});

export default historyMiddleware;
