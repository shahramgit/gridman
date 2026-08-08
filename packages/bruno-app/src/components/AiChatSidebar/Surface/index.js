import React from 'react';
import get from 'lodash/get';
import { useSelector } from 'react-redux';
import AiChatSidebar from '../index';
import { useAiTarget } from '../useAiTarget';

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
  // Resolves `ai.enabled` too, but the cheap flag is still read first so the
  // feature-off path does no tab or collection work at all.
  const target = useAiTarget();

  if (!aiEnabled || !isOpen) return null;
  if (!target) return null;

  return <AiChatSidebar collection={target.collection} workflow={target.workflow || null} />;
};

export default AiChatSurface;
