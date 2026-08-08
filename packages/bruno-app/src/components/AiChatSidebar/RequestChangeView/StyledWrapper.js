import styled from 'styled-components';

/**
 * Deliberately mirrors DiffView's frame — same border, header bar, Apply/Dismiss
 * buttons and accepted/rejected states — so a proposed request reads as the
 * same KIND of thing as a proposed script: something the user reviews and
 * accepts, not something that already happened.
 *
 * The body differs because the content does. A request is a set of fields, and
 * a line diff of a serialised request would ask the user to read `.bru` syntax
 * to answer "what is this going to do".
 */
const StyledWrapper = styled.div`
  margin-top: 8px;
  border-radius: ${(props) => props.theme.border.radius.base};
  overflow: hidden;
  border: 1px solid ${(props) => props.theme.border.border1};
  background: ${(props) => props.theme.codemirror.bg};

  &.accepted {
    border-color: ${(props) => props.theme.colors.text.green};
  }

  &.rejected {
    opacity: 0.5;
  }

  .rc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: ${(props) => props.theme.background.mantle};
    border-bottom: 1px solid ${(props) => props.theme.border.border1};
    gap: 8px;
  }

  .rc-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: ${(props) => props.theme.colors.text.muted};
    min-width: 0;

    .rc-icon {
      color: ${(props) => props.theme.brand};
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
  }

  .rc-op {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 3px;
    background: ${(props) => props.theme.background.surface0};
    color: ${(props) => props.theme.colors.text.muted};
    flex-shrink: 0;
  }

  .rc-name {
    font-weight: 600;
    color: ${(props) => props.theme.text};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rc-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    margin-left: auto;
  }

  .rc-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 500;
    border: 1px solid transparent;
    border-radius: ${(props) => props.theme.border.radius.base};
    cursor: pointer;
    white-space: nowrap;

    &.accept {
      background: ${(props) => props.theme.brand};
      color: ${(props) => (props.theme.mode === 'dark' ? '#000' : '#fff')};
    }

    &.reject {
      background: transparent;
      border-color: ${(props) => props.theme.border.border1};
      color: ${(props) => props.theme.colors.text.muted};
    }

    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: ${(props) => props.theme.border.radius.base};
    flex-shrink: 0;

    &.accepted {
      color: ${(props) => props.theme.colors.text.green};
      background: ${(props) => props.theme.status.success.background};
    }

    &.rejected {
      color: ${(props) => props.theme.colors.text.muted};
      background: ${(props) => props.theme.background.surface0};
    }
  }

  .rc-warning {
    padding: 5px 10px;
    font-size: 11px;
    border-bottom: 1px solid ${(props) => props.theme.border.border1};
    color: ${(props) => props.theme.colors.text.danger};
    background: ${(props) => props.theme.status.danger.background};
  }

  .rc-body {
    padding: 8px 10px;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 10px;
    font-size: 11.5px;
  }

  .rc-label {
    color: ${(props) => props.theme.colors.text.muted};
    white-space: nowrap;
  }

  .rc-value {
    font-family: ${(props) => props.theme.font.mono}, monospace;
    /* A URL with query parameters is the whole point of the preview — it has to
       wrap rather than be clipped into "…". */
    word-break: break-all;
    color: ${(props) => props.theme.text};
  }

  .rc-old {
    color: ${(props) => props.theme.colors.text.danger};
    text-decoration: line-through;
    word-break: break-all;
    display: block;
  }

  .rc-new {
    color: ${(props) => props.theme.colors.text.green};
    word-break: break-all;
    display: block;
  }

  .rc-pre {
    margin: 0;
    padding: 6px 8px;
    max-height: 180px;
    overflow: auto;
    background: ${(props) => props.theme.background.surface0};
    border-radius: ${(props) => props.theme.border.radius.base};
    font-family: ${(props) => props.theme.font.mono}, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    color: ${(props) => props.theme.text};
  }

  .rc-note {
    padding: 0 10px 8px;
    font-size: 10.5px;
    color: ${(props) => props.theme.colors.text.muted};
  }
`;

export default StyledWrapper;
