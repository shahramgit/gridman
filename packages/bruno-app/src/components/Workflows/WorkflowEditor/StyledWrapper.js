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

  .cancel-button {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .execute-node-button {
    align-self: flex-start;
  }

  .node-palette {
    width: 110px;
    flex-shrink: 0;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    height: 480px;
  }

  .palette-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.55;
  }

  .palette-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 6px;
    font-size: 12px;
    cursor: grab;
    background: ${(props) => props.theme.sidebar.bg};

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  .palette-hint {
    margin-top: auto;
    font-size: 10px;
    opacity: 0.5;
  }

  .log-pane {
    margin-top: 12px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 6px;
    overflow: hidden;
  }

  .log-pane-title {
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    border-bottom: 1px solid ${(props) => props.theme.input.border};
  }

  .log-lines {
    max-height: 200px;
    overflow-y: auto;
    padding: 6px 10px;
    font-family: monospace;
    font-size: 12px;
  }

  .log-empty {
    opacity: 0.5;
  }

  .log-line {
    display: flex;
    gap: 10px;
    padding: 1px 0;

    &.log-error .log-msg {
      color: ${(props) => props.theme.colors.text.danger};
    }

    &.log-warn .log-msg {
      color: ${(props) => props.theme.colors.text.yellow};
    }
  }

  .log-time {
    opacity: 0.5;
    flex-shrink: 0;
  }

  .node-io {
    display: flex;
    flex-direction: column;
    gap: 6px;

    summary {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.6;
      cursor: pointer;
    }

    .io-pre {
      margin: 4px 0 0;
      max-height: 160px;
      overflow: auto;
      font-size: 11px;
      font-family: monospace;
      background: ${(props) => props.theme.sidebar.bg};
      border: 1px solid ${(props) => props.theme.input.border};
      border-radius: 4px;
      padding: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }
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

  .canvas-wrap {
    display: flex;
    gap: 10px;
    min-height: 480px;
  }

  .wf-canvas {
    flex: 1;
    height: 480px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 6px;
    overflow: hidden;

    &.wf-canvas-drop-active {
      border-color: ${(props) => props.theme.colors.text.green};
      box-shadow: inset 0 0 0 1px ${(props) => props.theme.colors.text.green};
    }

    .wf-node-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .wf-loop-label {
      font-weight: 600;
      opacity: 0.8;
    }

    .wf-node-toolbar {
      display: flex;
      gap: 4px;

      button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 4px;
        border: 1px solid ${(props) => props.theme.input.border};
        background: ${(props) => props.theme.sidebar.bg};
        color: inherit;
        cursor: pointer;

        &:hover {
          background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
        }
      }
    }

    .wf-node {
      position: relative;
      width: 210px;
      border: 1.5px solid #8886;
      border-radius: 8px;
      background: ${(props) => props.theme.sidebar.bg};
      padding: 8px 10px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    }

    .wf-node-selected {
      box-shadow: 0 0 0 2px ${(props) => props.theme.colors.text.yellow};
    }

    .wf-node-disabled {
      opacity: 0.45;
      border-style: dashed !important;
    }
    .wf-node-disabled .wf-node-title {
      text-decoration: line-through;
    }

    .wf-node-start {
      width: 120px;
      text-align: center;
      border-radius: 18px;
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }

    .wf-node-head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
    }

    .wf-node-icon {
      flex-shrink: 0;
      opacity: 0.8;
    }

    .wf-node-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .wf-node-sub {
      margin-top: 2px;
      font-size: 10px;
      opacity: 0.55;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .wf-node-result {
      margin-top: 4px;
      font-size: 10px;

      &.result-passed {
        color: ${(props) => props.theme.colors.text.green};
      }

      &.result-failed {
        color: ${(props) => props.theme.colors.text.danger};
      }
    }

    .wf-port-label {
      position: absolute;
      right: 8px;
      font-size: 9px;
      opacity: 0.6;
      pointer-events: none;
    }

    .react-flow__handle {
      width: 9px;
      height: 9px;
      background: ${(props) => props.theme.colors.text.yellow};
      border: 1px solid ${(props) => props.theme.sidebar.bg};
    }
  }

  .canvas-panel {
    width: 320px;
    flex-shrink: 0;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    max-height: 480px;

    .step-editor {
      margin-left: 0;
    }

    &.canvas-panel-empty {
      font-size: 12px;
      opacity: 0.6;
    }
  }

  .panel-title {
    font-size: 14px;
    font-weight: 600;
  }

  .panel-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .panel-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
