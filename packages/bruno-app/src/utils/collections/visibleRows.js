import { foldSearchText } from '@usebruno/common';
import { sortByNameThenSequence } from 'utils/common/index';
import { normalizePath } from 'utils/common/path';

// Row projection for the indexed sidebar renderer (the only sidebar renderer
// since unification Phase 3a). Pure functions so the search-as-filter
// behavior (Phase 3b) is unit-testable without mounting the component.

// Must stay the very same function the collection index keys uidByPathname
// with (slices/collections indexPathnameKey) and the one useWorkspaceSearch
// normalizes hit pathnames with. When these drifted apart the O(1) lookup
// below could never hit on Windows — the index keyed through path.win32's
// normalize(), which keeps backslashes — so every filtered render fell back to
// the full Object.values(nodesByUid) scan.
export const normalizeForPathCompare = (pathname) => normalizePath(pathname);

export const sortNodes = (nodes = []) => {
  // Folders first using sortByNameThenSequence semantics, then requests by
  // sequence (ties broken by name).
  const folders = nodes.filter((node) => node.type === 'folder');
  const requests = nodes.filter((node) => node.type !== 'folder');

  const sortedRequests = [...requests].sort((a, b) => {
    const aSeq = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) {
      return aSeq - bSeq;
    }

    return (a.name || '').localeCompare(b.name || '');
  });

  return [...sortByNameThenSequence(folders), ...sortedRequests];
};

export const nodeMatchesSearch = (node, searchText) => {
  if (!searchText) {
    return true;
  }

  const text = foldSearchText(searchText);
  return [node.name, node.method, node.url, node.pathname]
    .filter(Boolean)
    .some((value) => foldSearchText(value).includes(text));
};

// Build the sidebar's visible row list for one collection.
//
// - No filter: the expanded tree (expandedNodeUids drives folder expansion).
// - searchMatches (content search, from the main-process folded index):
//   matched nodes + their ancestor chain + matched-folder subtrees, fully
//   expanded; matched rows carry `searchMatchMeta` ({ field, text }) for the
//   match-context subtitle. A collection matched only by name (empty match
//   set) browses normally so the user can drill into it.
// - searchText only (short renderer-side filter): same shape, matched by
//   folded name/method/url/pathname.
export const buildVisibleRows = ({ index, expandedNodeUids = new Set(), searchText, searchMatches = null, filterCollapsedUids = null }) => {
  if (!index?.nodesByUid) {
    return [];
  }

  const nodesByUid = index.nodesByUid;
  const childrenByParentUid = index.childrenByParentUid || {};
  const trimmedSearchText = searchText?.trim();

  // includeEmptyFolderRows: an expanded folder with no children gets a
  // synthetic '+ Add request' CTA row (only outside search/filter views,
  // matching the classic renderer's empty-folder message).
  const walkExpanded = ({ includeEmptyFolderRows = false } = {}) => {
    const rows = [];
    const walk = (parentUid) => {
      const children = sortNodes((childrenByParentUid[parentUid || 'root'] || []).map((uid) => nodesByUid[uid]).filter(Boolean));
      for (const child of children) {
        rows.push(child);
        if (child.type === 'folder' && expandedNodeUids.has(child.uid)) {
          const childCount = (childrenByParentUid[child.uid] || []).length;
          if (childCount) {
            walk(child.uid);
          } else if (includeEmptyFolderRows) {
            rows.push({
              uid: `${child.uid}:empty-folder`,
              type: 'empty-folder',
              folderUid: child.uid,
              // computeItemKey keys rows by pathname
              pathname: `${child.pathname || child.uid}::empty-folder`
            });
          }
        }
      }
    };
    walk(null);
    return rows;
  };

  // Shared by both filter sources: show matched nodes with their ancestor
  // chain, plus the full subtree of matched folders, in sidebar order.
  const buildFilteredRows = (matched, matchMetaByUid = null) => {
    if (!matched.size) {
      return [];
    }

    const included = new Set();
    const includeAncestors = (uid) => {
      let node = nodesByUid[uid];
      while (node && !included.has(node.uid)) {
        included.add(node.uid);
        node = node.parentUid ? nodesByUid[node.parentUid] : null;
      }
    };
    const includeSubtree = (uid) => {
      const stack = [uid];
      while (stack.length) {
        const current = stack.pop();
        included.add(current);
        for (const childUid of childrenByParentUid[current] || []) {
          stack.push(childUid);
        }
      }
    };
    for (const uid of matched) {
      includeAncestors(uid);
      if (nodesByUid[uid]?.type === 'folder') {
        includeSubtree(uid);
      }
    }

    const searchRows = [];
    const walkFiltered = (parentUid) => {
      const children = sortNodes(
        (childrenByParentUid[parentUid || 'root'] || [])
          .map((uid) => nodesByUid[uid])
          .filter((node) => node && included.has(node.uid))
      );
      for (const child of children) {
        const meta = matchMetaByUid?.get(child.uid);
        // Shallow-clone matched rows to carry their match context; index
        // nodes are immutable redux state and must not be mutated.
        searchRows.push(meta ? { ...child, searchMatchMeta: meta } : child);
        // Filtered rows auto-expand as the INITIAL state, but the user can
        // collapse a folder during the search (its row stays, children hide).
        if (child.type === 'folder' && !filterCollapsedUids?.has(child.uid)) {
          walkFiltered(child.uid);
        }
      }
    };
    walkFiltered(null);
    return searchRows;
  };

  // Content search: the match set comes from the main process (folded
  // body/headers/examples index); this only projects it onto the tree.
  if (searchMatches) {
    // Collection matched by name only (no item hits): show the ordinary
    // browsable tree so the user can drill into the matched collection.
    if (!searchMatches.matchedPathnames.size) {
      return walkExpanded();
    }

    const uidByPathname = index.uidByPathname || {};
    const matched = new Set();
    const matchMetaByUid = new Map();
    let unresolved = null;
    for (const pathname of searchMatches.matchedPathnames) {
      // O(1) via the index's normalized pathname map; unresolved hits fall
      // back to one normalize-compare scan (covers NFC/NFD mismatches).
      const uid = uidByPathname[normalizeForPathCompare(pathname)];
      if (uid && nodesByUid[uid]) {
        matched.add(uid);
        matchMetaByUid.set(uid, searchMatches.matchMeta.get(pathname));
      } else {
        (unresolved ||= []).push(pathname);
      }
    }
    if (unresolved) {
      const wanted = new Set(unresolved.map((pathname) => normalizeForPathCompare(pathname)));
      for (const node of Object.values(nodesByUid)) {
        const nodeKey = normalizeForPathCompare(node.pathname);
        if (wanted.has(nodeKey) && !matched.has(node.uid)) {
          matched.add(node.uid);
          const meta = searchMatches.matchMeta.get(node.pathname)
            || [...searchMatches.matchMeta.entries()].find(([key]) => normalizeForPathCompare(key) === nodeKey)?.[1];
          if (meta) {
            matchMetaByUid.set(node.uid, meta);
          }
        }
      }
    }

    return buildFilteredRows(matched, matchMetaByUid);
  }

  // Short-query filter (renderer-side, names/urls from the index).
  if (trimmedSearchText) {
    const matched = new Set(
      Object.values(nodesByUid).filter((node) => nodeMatchesSearch(node, trimmedSearchText)).map((node) => node.uid)
    );
    return buildFilteredRows(matched);
  }

  return walkExpanded({ includeEmptyFolderRows: true });
};
