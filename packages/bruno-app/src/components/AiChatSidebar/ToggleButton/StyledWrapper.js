import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: inline-flex;
  align-items: center;

  /*
    Rail variant used by the app's single mount point (pages/Bruno/index.js):
    a thin always-visible strip at the right edge of the workspace row, so the
    panel can be reopened after it is closed. The rail lives INSIDE this
    component on purpose — the ai.enabled gate returns null before any of it
    renders, so a disabled install has no empty bordered column either.
  */
  &.ai-rail {
    flex-shrink: 0;
    align-items: flex-start;
    padding: 8px 4px;
    border-left: 1px solid ${(props) => props.theme.border.border1};
  }

  .ai-toggle-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    border-radius: ${(props) => props.theme.border.radius.sm};
    color: ${(props) => props.theme.colors.text.muted};
    cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease;

    &:hover {
      color: ${(props) => props.theme.text};
      background: ${(props) => props.theme.colors.accent}12;
    }

    &.is-active {
      color: ${(props) => props.theme.colors.accent};
      background: ${(props) => props.theme.colors.accent}18;
    }
  }
`;

export default StyledWrapper;
