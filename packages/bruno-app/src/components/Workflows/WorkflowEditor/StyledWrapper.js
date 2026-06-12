import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 16px;

  .workflow-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .workflow-title {
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workflow-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .run-button,
  .add-button {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    border-radius: 5px;
    font-size: 13px;
    border: 1px solid ${(props) => props.theme.input.border};
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .run-button {
    color: ${(props) => props.theme.colors.text.green};
  }

  .drift-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    margin-bottom: 10px;
    border-radius: 5px;
    font-size: 12px;
    border: 1px solid ${(props) => props.theme.colors.text.yellow};
    color: ${(props) => props.theme.colors.text.yellow};

    button {
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-weight: 600;
      text-decoration: underline;
    }
  }

  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .empty-state {
    padding: 24px 8px;
    font-size: 13px;
    opacity: 0.7;
  }

  .step-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 5px;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};

      .step-actions {
        visibility: visible;
      }
    }
  }

  .step-index {
    width: 18px;
    text-align: right;
    font-size: 12px;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .step-method {
    width: 48px;
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    color: ${(props) => props.theme.colors.text.green};
  }

  .step-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .step-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  .step-ref {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    opacity: 0.55;
  }

  .step-status {
    flex-shrink: 0;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 9px;
    border: 1px solid transparent;

    &.status-linked {
      color: ${(props) => props.theme.colors.text.green};
      border-color: ${(props) => props.theme.colors.text.green};
    }

    &.status-drifted {
      color: ${(props) => props.theme.colors.text.yellow};
      border-color: ${(props) => props.theme.colors.text.yellow};
    }

    &.status-detached {
      color: ${(props) => props.theme.colors.text.danger};
      border-color: ${(props) => props.theme.colors.text.danger};
    }
  }

  .step-result {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    max-width: 260px;
    overflow: hidden;

    &.result-passed {
      color: ${(props) => props.theme.colors.text.green};
    }

    &.result-failed {
      color: ${(props) => props.theme.colors.text.danger};
    }

    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .step-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    visibility: hidden;
  }

  .run-summary {
    margin-top: 12px;
    font-size: 13px;

    &.run-passed {
      color: ${(props) => props.theme.colors.text.green};
    }

    &.run-failed {
      color: ${(props) => props.theme.colors.text.danger};
    }

    &.run-stopped {
      color: ${(props) => props.theme.colors.text.yellow};
    }
  }

  .step-result.result-stopped {
    color: ${(props) => props.theme.colors.text.yellow};
  }

  .step-block {
    display: flex;
    flex-direction: column;
  }

  .step-type-icon {
    display: flex;
    align-items: center;
    opacity: 0.7;
  }

  .step-name-input {
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: inherit;
    font-size: 13px;
    padding: 1px 4px;

    &:hover,
    &:focus {
      border-color: ${(props) => props.theme.input.border};
      outline: none;
    }
  }

  .step-editor {
    margin: 0 0 4px 76px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .workflow-inputs {
    margin-bottom: 10px;
    padding: 8px 10px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 5px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .inputs-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
  }

  .editor-row {
    display: flex;
    align-items: center;
    gap: 6px;

    input,
    select {
      background: ${(props) => props.theme.input.bg};
      border: 1px solid ${(props) => props.theme.input.border};
      border-radius: 4px;
      color: inherit;
      font-size: 12px;
      padding: 3px 6px;
      min-width: 0;

      &:focus {
        outline: none;
      }
    }

    input[type='number'] {
      width: 90px;
    }

    .expression-input {
      flex: 1;
      font-family: monospace;
    }
  }

  .editor-arrow {
    font-size: 11px;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .editor-add {
    align-self: flex-start;
    border: none;
    background: transparent;
    color: inherit;
    opacity: 0.7;
    font-size: 12px;
    cursor: pointer;
    padding: 1px 2px;

    &:hover {
      opacity: 1;
      text-decoration: underline;
    }
  }

  .editor-hint {
    font-size: 11px;
    opacity: 0.55;
  }

  .vars-inspector {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 5px;
    color: ${(props) => props.theme.sidebar.color};
  }

  .vars-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin-bottom: 4px;
  }

  .vars-row {
    display: flex;
    gap: 10px;
    font-size: 12px;
    font-family: monospace;
  }

  .vars-key {
    min-width: 140px;
    color: ${(props) => props.theme.colors.text.green};
  }

  .vars-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .add-button.active {
    border-color: ${(props) => props.theme.colors.text.yellow};
    color: ${(props) => props.theme.colors.text.yellow};
  }

  .loop-body {
    margin: 2px 0 8px 44px;
    padding-left: 10px;
    border-left: 2px dashed ${(props) => props.theme.input.border};
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .loop-add {
    padding: 2px 0 2px 8px;
  }

  .history-empty {
    margin-bottom: 10px;
    font-size: 12px;
    opacity: 0.6;
  }

  .history-list {
    margin-bottom: 12px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 5px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 260px;
    overflow-y: auto;
  }

  .history-run summary {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    padding: 3px 0;
    list-style: none;

    &::-webkit-details-marker {
      display: none;
    }
  }

  .history-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;

    &.status-dot-passed {
      background: ${(props) => props.theme.colors.text.green};
    }

    &.status-dot-failed {
      background: ${(props) => props.theme.colors.text.danger};
    }

    &.status-dot-stopped {
      background: ${(props) => props.theme.colors.text.yellow};
    }
  }

  .history-time {
    opacity: 0.7;
    flex-shrink: 0;
  }

  .history-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .history-details {
    padding: 2px 0 6px 24px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .history-step {
    display: flex;
    gap: 10px;
    font-size: 11px;

    &.step-failed .history-step-info {
      color: ${(props) => props.theme.colors.text.danger};
    }

    &.step-stopped .history-step-info {
      color: ${(props) => props.theme.colors.text.yellow};
    }
  }

  .history-step-name {
    min-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .history-step-info {
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

export default StyledWrapper;
