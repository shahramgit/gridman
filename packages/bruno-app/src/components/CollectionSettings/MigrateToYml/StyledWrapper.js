import styled from 'styled-components';

const StyledWrapper = styled.div`
  .advanced-toggle {
    color: ${(props) => props.theme.colors.text.muted};
    background: transparent;
    cursor: pointer;

    &:hover {
      color: ${(props) => props.theme.colors.text.subtext0};
    }
  }

  .advanced-panel {
    border: 1px solid ${(props) => props.theme.table.border};
    border-radius: 6px;
  }

  .muted {
    color: ${(props) => props.theme.colors.text.muted};
  }

  .danger {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .ok {
    color: ${(props) => props.theme.colors.text.green};
  }

  .warn {
    color: ${(props) => props.theme.colors.text.yellow};
  }

  .progress-track {
    height: 6px;
    border-radius: 3px;
    background: ${(props) => props.theme.table.border};
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: ${(props) => props.theme.colors.text.green};
    transition: width 120ms linear;
  }

  .file-line {
    font-family: monospace;
    word-break: break-all;
  }

  .difference-list {
    max-height: 12rem;
    overflow: auto;
    border: 1px solid ${(props) => props.theme.table.border};
    border-radius: 4px;
  }
`;

export default StyledWrapper;
