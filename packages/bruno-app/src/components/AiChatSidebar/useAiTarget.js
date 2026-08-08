import find from 'lodash/find';
import get from 'lodash/get';
import { useSelector } from 'react-redux';

/**
 * What the AI panel is currently pointed at, and whether there is anything to
 * point at.
 *
 * These two questions used to be answered in two places that disagreed:
 * ToggleButton rendered on `ai.enabled` alone while Surface bailed on
 * `!collection`, so on any tab whose `collectionUid` does not resolve to a
 * collection the user got a visible button that opened nothing. A workflow tab
 * is exactly that case — it carries the WORKSPACE uid as its `collectionUid`
 * (slices/workflows.js), which never matches a collection.
 *
 * Both components now derive from here, so the button and the panel cannot
 * disagree again.
 */

const resolveTarget = (state) => {
  if (!get(state?.app?.preferences, 'ai.enabled', false)) return null;

  const activeTabUid = state?.tabs?.activeTabUid;
  const focusedTab = find(state?.tabs?.tabs, (tab) => tab.uid === activeTabUid);
  if (!focusedTab) return null;

  const collections = state?.collections?.collections;

  // A workflow tab is workspace-scoped: its `collectionUid` is the WORKSPACE
  // uid, which matches no collection. The chat still needs a collection to hang
  // its conversation history and variable lookups on, so it binds to the
  // workspace's scratch collection — the same one the workspace Overview tab
  // uses. The workflow itself is carried separately and is what the prompt and
  // tools actually key off.
  if (focusedTab.type === 'workflow') {
    const workspace = find(state?.workspaces?.workspaces, (w) => w.uid === focusedTab.collectionUid);
    const scratch = find(collections, (c) => c.uid === workspace?.scratchCollectionUid);
    if (!scratch) return null;
    const workflow = state?.workflows?.open?.[focusedTab.itemPathname];
    return {
      collection: scratch,
      focusedTab,
      workflow: { pathname: focusedTab.itemPathname, doc: workflow?.doc || null }
    };
  }

  const collection = find(collections, (c) => c.uid === focusedTab.collectionUid);
  if (!collection) return null;

  return { collection, focusedTab };
};

/**
 * The resolved target, or null. Returns a fresh object each call, so only use
 * this where the component already re-renders on collection state — the panel
 * itself. Buttons and other always-mounted chrome want `useHasAiTarget`.
 */
export const useAiTarget = () => useSelector(resolveTarget);

/**
 * Whether the panel has somewhere to open — a boolean, deliberately.
 *
 * The toggle button is mounted for the entire session next to the request pane.
 * Selecting the collections array here would re-render it on every collection
 * mutation in the workspace (11k files, indexed sidebar); selecting a boolean
 * means default reference equality holds and it re-renders only when the answer
 * actually flips.
 */
export const useHasAiTarget = () => useSelector((state) => resolveTarget(state) !== null);
