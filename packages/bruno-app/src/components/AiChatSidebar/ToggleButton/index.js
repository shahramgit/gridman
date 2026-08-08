import React from 'react';
import get from 'lodash/get';
import { useDispatch, useSelector } from 'react-redux';
import { IconStars } from '@tabler/icons';
import { toggleAiPanel } from 'providers/ReduxStore/slices/ai';
import { useHasAiTarget } from '../useAiTarget';
import StyledWrapper from './StyledWrapper';

/**
 * Entry point for the AI chat panel.
 *
 * Renders nothing at all when `ai.enabled` is false — no button, no tooltip,
 * no listener. The feature has to be turned on in Preferences > AI before any
 * of it becomes reachable.
 *
 * It also renders nothing when the panel would have nothing to open. Those two
 * conditions used to be checked in different places with different answers, so
 * on a tab whose collectionUid resolves to no collection (a workflow tab, which
 * carries the workspace uid) the button was visible and clicking it did
 * nothing. Both sides now read `useAiTarget`.
 *
 * Selectors are defensive for the same reason as Surface: mounting order must
 * never be able to crash the app over an optional feature's slice.
 */
const AiToggleButton = ({ className = '' }) => {
  const dispatch = useDispatch();
  const aiEnabled = useSelector((state) => get(state?.app?.preferences, 'ai.enabled', false));
  const isOpen = useSelector((state) => Boolean(state?.ai?.isOpen));
  const hasTarget = useHasAiTarget();

  if (!aiEnabled || !hasTarget) return null;

  return (
    <StyledWrapper className={className}>
      <button
        type="button"
        className={`ai-toggle-btn ${isOpen ? 'is-active' : ''}`}
        onClick={() => dispatch(toggleAiPanel())}
        title={isOpen ? 'Close Gridman AI' : 'Open Gridman AI'}
        aria-label={isOpen ? 'Close Gridman AI' : 'Open Gridman AI'}
        aria-pressed={isOpen}
        data-testid="ai-toggle-button"
      >
        <IconStars size={16} strokeWidth={1.5} />
      </button>
    </StyledWrapper>
  );
};

export default AiToggleButton;
