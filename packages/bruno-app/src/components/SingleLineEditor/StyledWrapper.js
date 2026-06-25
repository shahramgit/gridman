import styled from 'styled-components';

const StyledWrapper = styled.div`
  width: 100%;
  height: ${(props) => (props.$isCompact ? '1.375rem' : '1.875rem')};
  overflow-y: hidden;
  overflow-x: hidden;

  &.read-only {
    .CodeMirror-cursor {
      display: none !important;
    }
  }

  /* Expand-on-focus: long value grows into a bordered, scrollable box
     (Postman-style) only while focused. */
  &.cm-expanded {
    height: auto;
    overflow: visible;

    .CodeMirror {
      height: auto;
      max-height: 220px;
      overflow: auto;
      border: 1px solid ${(props) => props.theme.input?.border || '#8884'};
      border-radius: 4px;
      background: ${(props) => props.theme.input?.bg || props.theme.bg};
      padding: 3px 6px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
    }
    .CodeMirror-scroll {
      overflow: auto !important;
      padding-bottom: 0 !important;
    }
    .CodeMirror-vscrollbar {
      display: block;
    }
    .CodeMirror-line {
      white-space: pre-wrap !important;
      word-break: break-all;
    }
  }

  .CodeMirror {
    background: transparent;
    height: ${(props) => (props.$isCompact ? '1.375rem' : '2.125rem')};
    font-size: ${(props) => props.theme.font.size.base};
    line-height: ${(props) => (props.$isCompact ? '1.375rem' : '1.875rem')};
    overflow: hidden;

    .CodeMirror-scroll {
      overflow: hidden !important;
      padding-bottom: 3.125rem !important;
    }

    .CodeMirror-vscrollbar,
    .CodeMirror-hscrollbar,
    .CodeMirror-scrollbar-filler {
      display: none;
    }

    .CodeMirror-lines {
      padding: 0;

      .CodeMirror-placeholder {
        color: ${(props) => props.theme.codemirror.placeholder.color} !important;
        opacity:  ${(props) => props.theme.codemirror.placeholder.opacity} !important
      }
    }

    .CodeMirror-cursor {
      height: ${(props) => (props.$isCompact ? '0.875rem' : '1.25rem')} !important;
      margin-top: ${(props) => (props.$isCompact ? '0.25rem' : '0.3125rem')} !important;
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
