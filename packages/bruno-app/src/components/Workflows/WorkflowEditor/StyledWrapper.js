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
  }
`;

export default StyledWrapper;
