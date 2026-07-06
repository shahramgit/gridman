import styled from 'styled-components';

const StyledWrapper = styled.div`
  height: 100%;
  overflow: auto;
  padding: 18px 24px;

  .git-layout {
    max-width: 1280px;
    margin: 0 auto;
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

  .git-assistant-panel {
    border-color: ${(props) => props.theme.colors.text.orange};
  }

  .git-progress {
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    padding: 10px 12px;
  }

  .git-progress-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .git-progress-label {
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .git-progress-bar {
    margin-top: 8px;
    height: 6px;
    border-radius: 3px;
    background: ${(props) => props.theme.border.border1};
    overflow: hidden;
    position: relative;
  }

  .git-progress-fill {
    height: 100%;
    border-radius: 3px;
    background: ${(props) => props.theme.colors.text.green};
    transition: width 0.2s ease;
  }

  .git-progress-bar.indeterminate .git-progress-fill {
    position: absolute;
    width: 35%;
    animation: git-progress-slide 1.2s ease-in-out infinite;
  }

  @keyframes git-progress-slide {
    0% {
      left: -35%;
    }
    100% {
      left: 100%;
    }
  }

  .assistant-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .assistant-title {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .assistant-description {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
  }

  .assistant-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .assistant-facts span {
    padding: 4px 7px;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: 999px;
    color: ${(props) => props.theme.colors.text.muted};
    background: ${(props) => props.theme.input.bg};
    font-size: 12px;
  }

  .assistant-note {
    margin-top: 10px;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 12px;
    line-height: 1.45;
  }

  .advanced-details,
  .nested-advanced-details {
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.bg};
  }

  .advanced-details > summary,
  .nested-advanced-details > summary {
    cursor: pointer;
    padding: 10px 12px;
    color: ${(props) => props.theme.text};
    font-weight: 600;
    list-style-position: inside;
  }

  .advanced-details > summary:hover,
  .nested-advanced-details > summary:hover {
    background: ${(props) => props.theme.tabs.secondary.active.bg};
  }

  .advanced-content {
    display: grid;
    gap: 16px;
    padding: 0 12px 12px;
  }

  .changes-diff-content {
    display: grid;
    grid-template-columns: minmax(300px, 38%) minmax(0, 1fr);
    gap: 16px;
    padding: 0 12px 12px;
    align-items: stretch;
  }

  .changes-panel,
  .diff-panel {
    min-height: 360px;
  }

  .changes-scroll {
    max-height: 520px;
    overflow: auto;
    padding-right: 4px;
  }

  .nested-advanced-details {
    border-style: dashed;
  }

  .nested-advanced-details .panel {
    border: none;
    padding-top: 0;
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
    grid-template-columns: 88px minmax(0, 760px);
    gap: 8px 10px;
    font-size: 13px;
    align-items: center;
  }

  .meta-label {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .auth-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .auth-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 4px 8px;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.tabs.secondary.active.bg};
    font-size: 13px;
    font-weight: 500;
  }

  .auth-provider {
    min-width: 0;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .auth-detail {
    display: grid;
    grid-template-columns: 118px minmax(0, 1fr);
    gap: 8px;
    font-size: 13px;
  }

  .remote-value {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, max-content) auto;
    align-items: center;
    gap: 6px;
    justify-content: start;
  }

  .remote-value-empty {
    grid-template-columns: max-content auto;
    gap: 10px;
  }

  .remote-link,
  .remote-text {
    min-width: 0;
    font: inherit;
  }

  .remote-link {
    border: none;
    padding: 0;
    background: transparent;
    color: ${(props) => props.theme.colors.link};
    text-align: left;
    cursor: pointer;
  }

  .remote-link:hover {
    text-decoration: underline;
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

  .file-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
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
    height: 520px;
    min-height: 320px;
    max-height: 520px;
  }

  .output-box {
    max-height: 140px;
  }

  .success-output {
    border-color: ${(props) => props.theme.colors.text.green || props.theme.border.border1};
  }

  .error-output {
    border-color: ${(props) => props.theme.colors.text.red || props.theme.border.border1};
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
    grid-template-columns: minmax(0, 1fr) minmax(120px, 180px) auto;
    gap: 8px;
    align-items: center;
  }

  .repository-branch-select {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(180px, 280px);
    align-items: center;
    gap: 6px;
    justify-content: start;
  }

  .repository-branch-select .textbox {
    min-width: 0;
    width: 100%;
  }

  .branch-controls,
  .branch-create-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .branch-create-form {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }

  .branch-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 13px;
  }

  .action-help {
    display: grid;
    gap: 4px;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 12px;
    line-height: 1.45;
  }

  .setup-checklist {
    display: grid;
    gap: 8px;
  }

  .setup-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 9px 10px;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    background: ${(props) => props.theme.input.bg};
  }

  .setup-status-icon {
    display: flex;
    justify-content: center;
    color: ${(props) => props.theme.colors.text.muted};
    padding-top: 2px;
  }

  .setup-row-title {
    font-weight: 600;
  }

  .setup-row-fa,
  .setup-row-detail {
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
  }

  .setup-badge {
    padding: 3px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid ${(props) => props.theme.border.border1};
  }

  .setup-ok {
    color: ${(props) => props.theme.colors.text.green || props.theme.text};
  }

  .setup-warning,
  .setup-admin,
  .setup-missing {
    color: ${(props) => props.theme.colors.text.orange};
  }

  .setup-unknown {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .setup-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .setup-form {
    display: grid;
    gap: 8px;
  }

  .setup-two-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .setup-input-label {
    display: grid;
    gap: 4px;
    color: ${(props) => props.theme.colors.text.muted};
    font-size: 12px;
  }

  @media (max-width: 1100px) {
    .changes-diff-content,
    .empty-state-grid {
      grid-template-columns: 1fr;
    }

    .assistant-header {
      flex-direction: column;
      align-items: stretch;
    }

    .branch-create-form,
    .remote-form,
    .setup-two-columns {
      grid-template-columns: 1fr;
    }
  }
`;

export default StyledWrapper;
