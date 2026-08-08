import styled from 'styled-components';

const StyledWrapper = styled.div`
  color: ${(props) => props.theme.text};

  .ai-tabs {
    border-bottom: 1px solid ${(props) => props.theme.input.border};
    margin-bottom: 14px;
  }

  .ai-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0px;
    margin-right: ${(props) => props.theme.tabs.marginRight};
    margin-bottom: -1px;
    color: ${(props) => props.theme.colors.text.subtext0};
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;

    &:hover:not(.active) {
      color: ${(props) => props.theme.tabs.active.color};
    }

    &.active {
      color: ${(props) => props.theme.tabs.active.color};
      font-weight: ${(props) => props.theme.tabs.active.fontWeight};
      border-bottom-color: ${(props) => props.theme.tabs.active.border};
    }

    svg {
      color: inherit;
    }
  }

  .ai-tab-panel {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 2rem;
  }

  .ai-master {
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.md};
    background: ${(props) => props.theme.input.bg};
  }

  .ai-master-icon {
    color: ${(props) => props.theme.colors.accent};
  }

  .ai-master-summary {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .ai-section-header {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .ai-section-note {
    color: ${(props) => props.theme.colors.text.muted};
    line-height: 1.5;
  }

  .ai-empty-notice {
    color: ${(props) => props.theme.colors.text.muted};
    background: ${(props) => props.theme.input.bg};
    border: 1px dashed ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.md};
    line-height: 1.5;
  }

  /* The self-hosted / OpenAI-compatible section leads the Configuration tab —
     it is the only path that works on a network with no egress to a hosted
     provider, so it gets the visual weight rather than a footnote. */
  .ai-primary-section {
    border: 1px solid ${(props) => props.theme.colors.accent}55;
    border-radius: ${(props) => props.theme.border.radius.md};
    padding: 12px;
    margin-bottom: 18px;
  }

  .ai-primary-title {
    color: ${(props) => props.theme.text};
  }

  .provider-row {
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.md};
    background: ${(props) => props.theme.input.bg};
    overflow: hidden;
    transition: border-color 0.15s ease;

    &.expanded {
      border-color: ${(props) => props.theme.colors.accent}80;
    }
  }

  .provider-header {
    transition: background-color 0.15s ease;

    &:hover {
      background: ${(props) => props.theme.colors.accent}08;
    }
  }

  .provider-logo {
    color: ${(props) => props.theme.text};
  }

  .provider-status {
    color: ${(props) => props.theme.colors.text.muted};

    &.configured {
      color: ${(props) => props.theme.colors.text.green};
    }
  }

  .status-dot {
    background: ${(props) => props.theme.input.border};

    &.configured {
      background: ${(props) => props.theme.colors.text.green};
      box-shadow: 0 0 0 2px ${(props) => props.theme.colors.text.green}25;
    }
  }

  .chevron {
    color: ${(props) => props.theme.colors.text.muted};
    transition: transform 0.2s ease;

    &.expanded {
      transform: rotate(180deg);
    }
  }

  /* Smooth expand/collapse using the grid-template-rows trick */
  .provider-body-wrapper {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.2s ease;

    &.open {
      grid-template-rows: 1fr;
    }
  }

  .provider-body-inner {
    overflow: hidden;
    min-height: 0;
  }

  .provider-body {
    border-top: 1px solid ${(props) => props.theme.input.border};
  }

  .key-section-label {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .key-input {
    font-family: var(--font-family-mono);
    border-radius: ${(props) => props.theme.border.radius.sm};
    background-color: ${(props) => props.theme.input.bg};
    border: 1px solid ${(props) => props.theme.input.border};
    color: ${(props) => props.theme.text};

    &::placeholder {
      color: ${(props) => props.theme.colors.text.muted};
      opacity: 0.7;
    }

    &:focus {
      outline: none;
      border-color: ${(props) => props.theme.input.focusBorder};
    }
  }

  .key-eye-btn {
    border-radius: ${(props) => props.theme.border.radius.sm};
    color: ${(props) => props.theme.colors.text.muted};
    transition: background-color 0.15s ease, color 0.15s ease;

    &:hover {
      color: ${(props) => props.theme.text};
      background: ${(props) => props.theme.colors.accent}10;
    }
  }

  .key-display-row {
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.input.bg};
  }

  .key-display-mask {
    font-family: var(--font-family-mono);
    color: ${(props) => props.theme.colors.text.muted};
    letter-spacing: 1px;
  }

  .btn-primary {
    border-radius: ${(props) => props.theme.border.radius.sm};
    border: 1px solid ${(props) => props.theme.colors.accent};
    background: ${(props) => props.theme.colors.accent};
    color: white;
    transition: opacity 0.15s ease;

    &:hover:not(:disabled) {
      opacity: 0.88;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .btn-icon {
    border-radius: ${(props) => props.theme.border.radius.sm};
    border: none;
    background: transparent;
    color: ${(props) => props.theme.colors.text.muted};
    transition: background-color 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) {
      background: ${(props) => props.theme.colors.accent}10;
      color: ${(props) => props.theme.text};
    }

    &.danger:hover:not(:disabled) {
      color: ${(props) => props.theme.colors.text.danger};
      background: ${(props) => props.theme.colors.bg.danger}15;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .feedback {
    border-radius: ${(props) => props.theme.border.radius.sm};

    &.success {
      color: ${(props) => props.theme.colors.text.green};
      background: ${(props) => props.theme.colors.text.green}10;
    }

    &.error {
      color: ${(props) => props.theme.colors.text.danger};
      background: ${(props) => props.theme.colors.bg.danger}15;
    }
  }

  .models-label-row {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .model-chip {
    border-radius: ${(props) => props.theme.border.radius.sm};
    border: 1px solid transparent;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover:not(.disabled) {
      background: ${(props) => props.theme.colors.accent}08;
    }

    &.selected {
      border-color: ${(props) => props.theme.input.border};
      background: ${(props) => props.theme.colors.accent}06;
    }

    &.disabled {
      opacity: 0.45;
      cursor: not-allowed;

      input,
      label {
        cursor: not-allowed;
      }
    }
  }

  .keyless-hint {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .model-select-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .model-select {
    appearance: none;
    -webkit-appearance: none;
    padding: 4px 24px 4px 8px;
    font-size: 11.5px;
    font-family: inherit;
    border-radius: ${(props) => props.theme.border.radius.sm};
    border: 1px solid ${(props) => props.theme.input.border};
    background: ${(props) => props.theme.bg};
    color: ${(props) => props.theme.text};
    cursor: pointer;
    min-width: 190px;
    transition: border-color 0.15s ease;

    &:hover:not(:disabled) {
      border-color: ${(props) => props.theme.colors.accent}80;
    }

    &:focus {
      outline: none;
      border-color: ${(props) => props.theme.input.focusBorder};
    }

    &:disabled {
      cursor: not-allowed;
    }
  }

  .model-select-chevron {
    position: absolute;
    right: 6px;
    pointer-events: none;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .default-model-card {
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.md};
    background: ${(props) => props.theme.input.bg};
  }

  .default-model-sub {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .compat-add-btn {
    color: ${(props) => props.theme.colors.text.muted};
    background: transparent;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    padding: 3px 8px;
    transition: color 0.15s ease, border-color 0.15s ease;

    &:hover {
      color: ${(props) => props.theme.text};
      border-color: ${(props) => props.theme.colors.accent}80;
    }
  }

  .compat-models-empty {
    color: ${(props) => props.theme.colors.text.muted};
    border: 1px dashed ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};

    code {
      font-family: var(--font-family-mono);
      color: ${(props) => props.theme.text};
    }
  }

  .compat-model-row {
    border-radius: ${(props) => props.theme.border.radius.sm};
    border: 1px solid ${(props) => props.theme.input.border};
    background: ${(props) => props.theme.input.bg};
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &.selected {
      background: ${(props) => props.theme.colors.accent}06;
    }

    &.disabled {
      opacity: 0.45;

      input {
        cursor: not-allowed;
      }
    }
  }

  .compat-inline-input {
    background: transparent;
    border: none;
    outline: none;
    color: ${(props) => props.theme.text};
    padding: 2px 4px;
    border-radius: ${(props) => props.theme.border.radius.sm};
    min-width: 0;
    font-family: inherit;

    &::placeholder {
      color: ${(props) => props.theme.colors.text.muted};
      opacity: 0.6;
    }

    &:focus {
      background: ${(props) => props.theme.bg};
      box-shadow: inset 0 0 0 1px ${(props) => props.theme.input.focusBorder};
    }
  }

  .compat-inline-id {
    font-family: var(--font-family-mono);
  }

  .compat-add-model {
    padding-top: 4px;
  }

  .compat-remove-endpoint {
    color: ${(props) => props.theme.colors.text.muted};
    background: transparent;
    border: none;
    padding: 4px 6px;
    border-radius: ${(props) => props.theme.border.radius.sm};
    transition: color 0.15s ease, background-color 0.15s ease;

    &:hover {
      color: ${(props) => props.theme.colors.text.danger};
      background: ${(props) => props.theme.colors.bg.danger}15;
    }
  }

  .security-card {
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.md};
    background: ${(props) => props.theme.input.bg};
  }

  .security-sub {
    color: ${(props) => props.theme.colors.text.muted};
    line-height: 1.5;

    code {
      font-family: var(--font-family-mono);
      color: ${(props) => props.theme.text};
    }
  }

  .security-row + .security-row {
    border-top: 1px dashed ${(props) => props.theme.input.border};
  }

  .security-input {
    padding: 5px 8px;
    font-size: 12px;
    font-family: var(--font-family-mono);
    border-radius: ${(props) => props.theme.border.radius.sm};
    border: 1px solid ${(props) => props.theme.input.border};
    background: ${(props) => props.theme.bg};
    color: ${(props) => props.theme.text};

    &::placeholder {
      color: ${(props) => props.theme.colors.text.muted};
      opacity: 0.7;
    }

    &:focus {
      outline: none;
      border-color: ${(props) => props.theme.input.focusBorder};
    }
  }

  .security-add-btn {
    color: ${(props) => props.theme.colors.text.muted};
    background: transparent;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    padding: 4px 10px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;

    &:hover:not(:disabled) {
      color: ${(props) => props.theme.text};
      border-color: ${(props) => props.theme.colors.accent}80;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .security-chip-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .security-chip {
    padding: 3px 4px 3px 8px;
    font-size: 11px;
    font-family: var(--font-family-mono);
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.bg};
    color: ${(props) => props.theme.text};
  }

  .security-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    background: transparent;
    color: ${(props) => props.theme.colors.text.muted};
    cursor: pointer;
    border-radius: ${(props) => props.theme.border.radius.sm};
    transition: color 0.15s ease, background-color 0.15s ease;

    &:hover {
      color: ${(props) => props.theme.colors.text.danger};
      background: ${(props) => props.theme.colors.bg.danger}15;
    }
  }

  .security-builtin-chip {
    padding: 2px 7px;
    font-size: 10.5px;
    font-family: var(--font-family-mono);
    color: ${(props) => props.theme.colors.text.muted};
    border: 1px dashed ${(props) => props.theme.input.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
  }

  .security-builtin-more {
    color: ${(props) => props.theme.colors.text.muted};
    align-self: center;

    code {
      font-family: var(--font-family-mono);
      color: ${(props) => props.theme.text};
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .spin {
    animation: spin 1s linear infinite;
  }
`;

export default StyledWrapper;
