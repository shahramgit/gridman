import React, { useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import classnames from 'classnames';
import { IconChevronRight, IconFolder } from '@tabler/icons';
import { useDispatch, useSelector } from 'react-redux';
import { addTab, focusTab } from 'providers/ReduxStore/slices/tabs';
import { collectionIndexNodeActivated } from 'providers/ReduxStore/slices/collections';
import { loadRequest } from 'providers/ReduxStore/slices/collections/actions';
import SearchHighlight from '../SearchHighlight';
import CollectionItemIcon from './CollectionItem/CollectionItemIcon';
import { getDefaultRequestPaneTab } from 'utils/collections';
import { findItemInCollection, findItemInCollectionByPathname } from 'utils/collections';
import { isTabForItemPresent as isTabForItemPresentSelector } from 'src/selectors/tab';
import { isEqual } from 'lodash';

const ROW_HEIGHT = 28;
const MAX_LIST_HEIGHT = 520;

const sortNodes = (nodes = []) => {
  return [...nodes].sort((a, b) => {
    const aFolder = a.type === 'folder' ? 0 : 1;
    const bFolder = b.type === 'folder' ? 0 : 1;
    if (aFolder !== bFolder) {
      return aFolder - bFolder;
    }

    const aSeq = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) {
      return aSeq - bSeq;
    }

    return (a.name || '').localeCompare(b.name || '');
  });
};

const nodeMatchesSearch = (node, searchText) => {
  if (!searchText) {
    return true;
  }

  const text = searchText.toLowerCase();
  return [node.name, node.method, node.url, node.pathname]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(text));
};

const normalizeRequestType = (type) => {
  const normalizedType = String(type || '').toLowerCase();
  const typeMap = {
    http: 'http-request',
    graphql: 'graphql-request',
    grpc: 'grpc-request',
    ws: 'ws-request',
    websocket: 'ws-request'
  };

  return typeMap[normalizedType] || normalizedType || 'http-request';
};

const useVisibleRows = ({ index, expandedNodeUids, searchText }) => {
  return useMemo(() => {
    if (!index?.nodesByUid) {
      return [];
    }

    const nodesByUid = index.nodesByUid;
    const childrenByParentUid = index.childrenByParentUid || {};
    const trimmedSearchText = searchText?.trim();

    if (trimmedSearchText) {
      return sortNodes(Object.values(nodesByUid).filter((node) => nodeMatchesSearch(node, trimmedSearchText)));
    }

    const rows = [];
    const walk = (parentUid) => {
      const children = sortNodes((childrenByParentUid[parentUid || 'root'] || []).map((uid) => nodesByUid[uid]).filter(Boolean));
      for (const child of children) {
        rows.push(child);
        if (child.type === 'folder' && expandedNodeUids.has(child.uid)) {
          walk(child.uid);
        }
      }
    };

    walk(null);
    return rows;
  }, [index, expandedNodeUids, searchText]);
};

const IndexedRow = ({ node, collectionUid, searchText, expandedNodeUids, onToggleFolder }) => {
  const dispatch = useDispatch();
  const isRequest = node.type !== 'folder';
  const isExpanded = expandedNodeUids.has(node.uid);
  const isTabForItemPresent = useSelector(isTabForItemPresentSelector({ itemUid: node.uid }), isEqual);
  const item = useSelector((state) => {
    const collection = state.collections.collections?.find((c) => c.uid === collectionUid);
    return collection ? (
      findItemInCollection(collection, node.uid) || findItemInCollectionByPathname(collection, node.pathname)
    ) : null;
  }, isEqual);
  const displayItem = item || {
    ...node,
    type: normalizeRequestType(node.type),
    partial: false,
    loading: false,
    error: false,
    request: {
      method: node.method || '',
      url: node.url || ''
    }
  };

  const openRequest = () => {
    dispatch(collectionIndexNodeActivated({ collectionUid, node }));

    if (isTabForItemPresent) {
      dispatch(focusTab({ uid: node.uid }));
    } else {
      dispatch(
        addTab({
          uid: node.uid,
          collectionUid,
          requestPaneTab: getDefaultRequestPaneTab(node),
          type: 'request',
          itemUid: node.uid,
          itemPathname: node.pathname
        })
      );
    }

    if (!item || item.loading || item.partial || !item.request) {
      dispatch(loadRequest({ collectionUid, pathname: node.pathname }));
    }
  };

  const handleClick = () => {
    if (isRequest) {
      openRequest();
      return;
    }

    onToggleFolder(node.uid);
  };

  return (
    <div
      className={classnames('flex items-center py-1 collection-item-name item', {
        'cursor-pointer': true
      })}
      style={{ height: ROW_HEIGHT, paddingLeft: 8 + (node.depth || 0) * 14 }}
      title={node.pathname}
      onClick={handleClick}
    >
      <span className="flex items-center justify-center" style={{ width: 16, minWidth: 16 }}>
        {node.type === 'folder' ? (
          <IconChevronRight
            size={16}
            strokeWidth={2}
            className={classnames('chevron-icon', { 'rotate-90': isExpanded })}
            style={{ color: 'rgb(160 160 160)' }}
          />
        ) : null}
      </span>
      <span className="flex items-center justify-center ml-1" style={{ width: 18, minWidth: 18 }}>
        {node.type === 'folder' ? <IconFolder size={16} strokeWidth={1.7} /> : <CollectionItemIcon item={displayItem} />}
      </span>
      <span className="ml-1 truncate">
        <SearchHighlight text={node.name || node.filename || 'Untitled'} searchText={searchText} />
      </span>
    </div>
  );
};

const IndexedCollectionItems = ({ collectionUid, searchText }) => {
  const index = useSelector((state) => state.collections.collectionIndexes?.[collectionUid]);
  const [expandedNodeUids, setExpandedNodeUids] = useState(() => new Set());
  const visibleRows = useVisibleRows({ index, expandedNodeUids, searchText });

  const onToggleFolder = (uid) => {
    setExpandedNodeUids((current) => {
      const next = new Set(current);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  if (!index) {
    return null;
  }

  if (!visibleRows.length && index.status === 'indexing') {
    return (
      <div className="text-xs text-muted ml-8 py-1">
        Indexing collection...
      </div>
    );
  }

  if (!visibleRows.length && searchText?.trim()) {
    return null;
  }

  const listHeight = Math.min(Math.max(visibleRows.length * ROW_HEIGHT, ROW_HEIGHT), MAX_LIST_HEIGHT);

  return (
    <div>
      {index.status === 'indexing' ? (
        <div className="text-xs text-muted ml-8 py-1">
          Indexing {index.totalScanned || 0} items...
        </div>
      ) : null}
      <Virtuoso
        style={{ height: listHeight }}
        data={visibleRows}
        itemContent={(_index, node) => (
          <IndexedRow
            node={node}
            collectionUid={collectionUid}
            searchText={searchText}
            expandedNodeUids={expandedNodeUids}
            onToggleFolder={onToggleFolder}
          />
        )}
      />
    </div>
  );
};

export default IndexedCollectionItems;
