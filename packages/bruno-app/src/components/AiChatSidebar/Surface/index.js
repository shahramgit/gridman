import React from 'react';
import find from 'lodash/find';
import get from 'lodash/get';
import { useSelector } from 'react-redux';
import AiChatSidebar from '../index';

/**
 * The single mount point for the AI chat panel.
 *
 * Render this as a sibling of the request pane — it is a right-side surface
 * and deliberately knows nothing about the collection sidebar.
 *
 * Everything below the `ai.enabled` check is skipped when the feature is off:
 * no subtree, no selectors on collection state, no IPC listeners, no status
 * poll. A fresh install renders exactly `null` here.
 *
 * The feature flag is read FIRST and every other selector is written
 * defensively. `providers/ReduxStore/index.js` registers the `ai` reducer, but
 * this component must not be the thing that depends on that having happened —
 * a store assembled in a different order (a test harness, a future lazy
 * reducer) has to render null, not throw and take the whole app down.
 */
const AiChatSurface = () => {
  const aiEnabled = useSelector((state) => get(state?.app?.preferences, 'ai.enabled', false));
  const isOpen = useSelector((state) => Boolean(state?.ai?.isOpen));
  const activeTabUid = useSelector((state) => state?.tabs?.activeTabUid);
  const tabs = useSelector((state) => state?.tabs?.tabs);
  const collections = useSelector((state) => state?.collections?.collections);

  if (!aiEnabled || !isOpen) return null;

  const focusedTab = find(tabs, (t) => t.uid === activeTabUid);
  const collection = find(collections, (c) => c.uid === focusedTab?.collectionUid);
  if (!collection) return null;

  return <AiChatSidebar collection={collection} />;
};

export default AiChatSurface;
