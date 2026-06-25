import styled from 'styled-components';

const StyledWrapper = styled.div`
  width: 100%;
  height: fit-content;
  max-height: 200px;
  overflow: auto;

  &.read-only {
    .CodeMirror .CodeMirror-lines {
      cursor: not-allowed !important;
    }

    .CodeMirror-line {
      color: ${(props) => props.theme.colors.text.muted} !important;
    }

    .CodeMirror-cursor {
      display: none !important;
    }
  }

  /* Expand-on-focus: long value grows into a bordered, scrollable box
     (Postman-style) only while focused. */
  &.cm-expanded .CodeMirror {
    max-height: 220px;
    overflow: auto;
    border: 1px solid ${(props) => props.theme.input?.border || '#8884'};
    border-radius: 4px;
    background: ${(props) => props.theme.input?.bg || props.theme.bg};
    padding: 3px 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  }
  &.cm-expanded .CodeMirror-vscrollbar {
    display: block !important;
  }
  &.cm-expanded .CodeMirror-line {
    white-space: pre-wrap !important;
    word-break: break-all;
  }

  .CodeMirror {
    background: transparent;
    height: fit-content;
    font-size: ${(props) => props.theme.font.size.base};
    line-height: 30px;
    display: flex;
    flex-direction: column;
    max-height: 200px;

    pre.CodeMirror-placeholder {
      color: ${(props) => props.theme.text};
      padding-left: 0;
      opacity: 0.5;
    }

    .CodeMirror-vscrollbar,
    .CodeMirror-hscrollbar,
    .CodeMirror-scrollbar-filler {
      display: none !important;
    }

    .CodeMirror-lines {
      padding: 0;
    }

    .CodeMirror-cursor {
      height: 20px !important;
      margin-top: 5px !important;
      border-left: 1px solid ${(props) => props.theme.text} !important;
    }

    pre {
      font-family: Inter, sans-serif !important;
      font-weight: 400;
    }

    .CodeMirror-line {
      color: ${(props) => props.theme.text};
      padding: 0;
    }

    .CodeMirror-selected {
      background-color: rgba(212, 125, 59, 0.3);
    }
  }
`;

export default StyledWrapper;
