# Sidebar Renderer Unification Plan

Status: approved direction, not started. Written 2026-06-10.

## Problem

Two sidebar renderers exist:

- Classic recursive tree: `bruno-app/src/components/Sidebar/Collections/Collection/CollectionItem/index.js`
  (full features, slow on large collections)
- Indexed virtualized list: `.../Collection/IndexedCollectionItems.js`
  (fast, lazy hydration, missing features)

Main process picks per collection in `bruno-electron/src/ipc/collection.js`
(`shouldUseIndexedCollectionLoad`: >20MB total, >100 files, or any file >5MB).
Modals are shared; the row renderer, context menu, click handling, and
drag/drop are duplicated and have drifted (source of the move/clone hang bug
fixed in commit 1bf5233c3).

Goal: one renderer (the indexed one) for all collections, keeping the speed
and restoring full feature parity. Never reintroduce full recursive tree
rendering for large collections.

## Known feature gaps in IndexedCollectionItems (audit 2026-06-10)

1. Request-level "Run" context menu item (grpc/ws/non-http single run).
2. "Create Example" menu item + response examples rendered as expandable
   child rows under requests + opening `response-example` tabs.
3. Folder "Run" disabled until folder hydrated; classic always works.
4. Adjacent drag/drop does not persist sibling `seq`
   (classic uses `getReorderedItemsInSourceDirectory` + `updateItemsSequences`).
5. No scroll-to-active-tab after click; no double-click handling
   (`makeTabPermanent`).
6. Sort logic differs slightly (indexed: folders-first -> seq -> name;
   classic: folder block + request block by seq).

## Phase 1: feature parity in IndexedCollectionItems (safe, shippable alone)

Both renderers stay; small collections untouched. All work in
`IndexedCollectionItems.js` plus small shared helpers.

1. Request "Run" menu item: same type conditions as classic
   (`!http-request && !graphql-request`); hydrate via existing
   `loadRequest` + `collectionIndexNodeActivated` chain before running.
2. Create Example: add menu item (http-request only); requires hydrated item;
   reuse classic's create-example modal. Render examples as child rows of
   expanded hydrated requests (flat rows appended in `useVisibleRows` from the
   hydrated tree item, not from the index).
3. Folder Run: replace the disabled state with hydrate-on-demand: activate
   the node chain, load child requests, then open `RunCollectionItem`.
4. Seq persistence on adjacent drops: after `moveCollectionItemByPath`
   resolves, resequence target (and source) directory siblings using the
   classic helpers, dispatched through `updateItemsSequences`.
5. UX: `scrollToTheActiveTab` after click; double-click ->
   `makeTabPermanent` (no-op today since indexed tabs are permanent, but
   keeps semantics aligned for Phase 2).
6. Align `sortNodes` with classic ordering exactly.

Verification: eslint on touched files, `npm run build:web`, manual smoke on
the large `002 (g_sabteahval)` collection (run folder, create example, drag
reorder, clone, move) and on a small collection (unchanged behavior).

## Phase 2: one pipeline for all collections

1. Main: always build the collection index (the scan already runs to make
   the size decision). Keep `shouldUseIndexedCollectionLoad` only to decide
   eager vs lazy hydration:
   - small collections: index + eager background hydration (tree fully
     loaded as today, so all data-dependent features are instant)
   - large collections: index + lazy hydration (current behavior)
2. Renderer: `Collection/index.js` always renders `IndexedCollectionItems`.
   Keep the classic branch behind a temporary fallback flag
   (e.g. env/localStorage `gridman.classicSidebar`) for one release.
3. Watch invariants: loadedRequestsByPath stays the panel's render source;
   recovery paths from commit 1bf5233c3 (load-on-miss, cycle guards,
   move re-keying) must not be weakened.

Verification: full manual matrix (small/large collection x open/move/clone/
rename/delete/search/run/examples), `npm run build:web`, smoke `npm run dev`.

## Phase 3: delete the classic render path

After Phase 2 soaks one release:

1. Remove the recursive rendering branch from `Collection/index.js` and the
   fallback flag.
2. Remove `CollectionItem/index.js` recursive self-rendering; keep only the
   pieces still imported (modals already live in separate files; example row
   component may be extracted).
3. Delete dead selectors/utils that only served the recursive path; strip
   the debug instrumentation from the hang investigation
   (`renderer:debug-log-event` breadcrumbs) once confidence is high.

## Notes

- Riskiest area: index <-> tree <-> loadedRequestsByPath consistency.
  See DEBUGGING.md and commit 1bf5233c3 for the failure class and guards.
- Indexed tab uids are synthetic (`indexed-request:<collectionUid>:<pathname>`);
  tabs-slice reducers resolve updates via `findTabForUpdate` (uid, then
  itemUid fallback). Any new tab-state writes must go through it.
