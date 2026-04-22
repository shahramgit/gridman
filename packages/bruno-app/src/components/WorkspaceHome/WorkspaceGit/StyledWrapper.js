import styled from 'styled-components';

const StyledWrapper = styled.div`
  height: 100%;
  overflow: auto;
  padding: 18px 24px;

  .git-layout {
    display: grid;
    grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
    gap: 18px;
  }

  .empty-state-grid {
    display: grid;
    grid-template-columns: minmax(320px, 520px) minmax(320px, 1fr);
    gap: 18px;
    align-items: start;
  }

  .panel {
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    padding: 14px;
    background: ${(props) => props.theme.bg};
  }

  .warning-panel,
  .workspace-warning {
    border: 1px solid ${(props) => props.theme.colors.text.orange};
    border-radius: ${(props) => props.theme.border.radius.sm};
    padding: 12px;
    background: ${(props) => props.theme.tabs.secondary.active.bg};
  }

  .outside-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .outside-row {
    font-family: monospace;
    font-size: 12px;
    padding: 7px 8px;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.input.bg};
    word-break: break-all;
  }

  .empty-state-panel {
    min-height: 220px;
  }

  .empty-state-panel h3 {
    font-size: 18px;
    font-weight: 600;
    margin: 10px 0 8px;
  }

  .status-icon {
    width: 52px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: 50%;
    background: ${(props) => props.theme.tabs.secondary.active.bg};
    color: ${(props) => props.theme.colors.text.orange};
  }

  .section-title {
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.muted};
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 8px 10px;
    font-size: 13px;
  }

  .meta-label {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .file-row {
    display: grid;
    grid-template-columns: 32px 1fr auto;
    gap: 8px;
    align-items: center;
    padding: 7px 8px;
    border-radius: ${(props) => props.theme.border.radius.sm};
    cursor: pointer;
  }

  .file-row:hover,
  .file-row.active {
    background: ${(props) => props.theme.tabs.secondary.active.bg};
  }

  .file-status {
    font-family: monospace;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .diff-box,
  .output-box {
    white-space: pre-wrap;
    overflow: auto;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.45;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    padding: 12px;
    background: ${(props) => props.theme.input.bg};
  }

  .diff-box {
    min-height: 420px;
    max-height: 620px;
  }

  .output-box {
    max-height: 140px;
  }

  .textbox {
    line-height: 1.5;
    padding: 0.45rem;
    border-radius: ${(props) => props.theme.border.radius.sm};
    background-color: ${(props) => props.theme.input.bg};
    border: 1px solid ${(props) => props.theme.input.border};
    color: ${(props) => props.theme.text};
  }

  .textbox:focus {
    border: solid 1px ${(props) => props.theme.input.focusBorder} !important;
    outline: none !important;
  }

  .commands-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .command-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 28px;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.input.bg};
  }

  .command-row code {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .copy-command {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: transparent;
    color: ${(props) => props.theme.colors.text.muted};
    cursor: pointer;
  }

  .copy-command:hover {
    background: ${(props) => props.theme.tabs.secondary.active.bg};
    color: ${(props) => props.theme.text};
  }

  .terminal-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 12px;
  }

  .remote-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .action-help {
    display: grid;
    gap: 4px;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 12px;
    line-height: 1.45;
  }

  @media (max-width: 1100px) {
    .git-layout,
    .empty-state-grid {
      grid-template-columns: 1fr;
    }
  }
`;

export default StyledWrapper;
