import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;

  .body-type-selector select.textbox {
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--color-input-border, #8884);
    border-radius: 3px;
    background: var(--color-input-background, transparent);
    color: inherit;
  }

  /* CodeEditor container */
  .code-editor-container {
    flex: 1;
    min-height: 300px;
    height: 300px;
  }
`;

export default StyledWrapper;
