import { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { foldSearchText } from '@usebruno/common';
import Modal from 'components/Modal';
import { flattenItems, isItemARequest } from 'utils/collections';
import { normalizePath } from 'utils/common/path';
import { isScratchCollection } from 'utils/collections';

const MAX_RESULTS = 100;

// Build a flat list of pickable requests from loaded collection trees and
// from indexes of large collections (whose trees are lazily hydrated).
const useWorkspaceRequests = () => {
  const { collections, collectionIndexes } = useSelector((state) => state.collections);
  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);

  return useMemo(() => {
    const activeWorkspace = workspaces.find((workspace) => workspace.uid === activeWorkspaceUid);
    if (!activeWorkspace) {
      return [];
    }

    const workspaceCollectionPaths = new Set(
      (activeWorkspace.collections || []).map((wc) => normalizePath(wc.path)).filter(Boolean)
    );

    const requests = [];
    const seenPathnames = new Set();

    for (const collection of collections) {
      if (isScratchCollection(collection, workspaces)) {
        continue;
      }
      if (!workspaceCollectionPaths.has(normalizePath(collection.pathname))) {
        continue;
      }

      const index = collectionIndexes?.[collection.uid];
      if (index?.nodesByUid) {
        for (const node of Object.values(index.nodesByUid)) {
          if (node.type === 'folder' || !node.pathname || seenPathnames.has(node.pathname)) {
            continue;
          }
          seenPathnames.add(node.pathname);
          requests.push({
            name: node.name || node.filename,
            method: node.method || '',
            url: node.url || '',
            requestPathname: node.pathname,
            collectionPathname: collection.pathname,
            collectionName: collection.name
          });
        }
        continue;
      }

      for (const item of flattenItems(collection.items)) {
        if (!isItemARequest(item) || item.isTransient || !item.pathname || seenPathnames.has(item.pathname)) {
          continue;
        }
        seenPathnames.add(item.pathname);
        requests.push({
          name: item.name,
          method: item.request?.method || '',
          url: item.request?.url || '',
          requestPathname: item.pathname,
          collectionPathname: collection.pathname,
          collectionName: collection.name
        });
      }
    }

    return requests;
  }, [collections, collectionIndexes, workspaces, activeWorkspaceUid]);
};

const RequestPickerModal = ({ onPick, onClose }) => {
  const [query, setQuery] = useState('');
  const requests = useWorkspaceRequests();

  const results = useMemo(() => {
    const foldedQuery = foldSearchText(query.trim());
    if (!foldedQuery) {
      return requests.slice(0, MAX_RESULTS);
    }

    const matches = [];
    for (const request of requests) {
      const haystack = [request.name, request.url, request.collectionName];
      if (haystack.some((value) => value && foldSearchText(value).includes(foldedQuery))) {
        matches.push(request);
        if (matches.length >= MAX_RESULTS) {
          break;
        }
      }
    }
    return matches;
  }, [requests, query]);

  return (
    <Modal size="md" title="Add Request Step" hideFooter handleCancel={onClose}>
      <input
        type="text"
        className="block textbox w-full"
        placeholder="Search requests in this workspace..."
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck="false"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="mt-3" style={{ maxHeight: 360, overflowY: 'auto' }}>
        {results.length === 0 ? (
          <div className="text-xs opacity-70 px-1 py-2">
            No requests found. Open the collection in the sidebar first if it has not been loaded.
          </div>
        ) : (
          results.map((request) => (
            <button
              key={request.requestPathname}
              type="button"
              className="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-500/10"
              title={request.requestPathname}
              onClick={() => onPick(request)}
            >
              <span className="text-xs font-semibold w-12 flex-shrink-0">{request.method}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{request.name}</span>
                <span className="block text-xs opacity-60 truncate">{request.collectionName}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
};

export default RequestPickerModal;
