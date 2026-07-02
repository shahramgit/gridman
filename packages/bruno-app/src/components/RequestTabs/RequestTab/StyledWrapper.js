import styled from 'styled-components';

const StyledWrapper = styled.div`
  position: relative;
  width: 100%;
  height: 100%;

  .tab-label {
    overflow: hidden;
    align-items: center;
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .tab-method {
    font-size: 0.6875rem;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  /* Shown when tabs from several collections are open at once, so the user
     can tell which collection a tab belongs to (Postman-style strip). */
  .tab-collection-hint {
    font-size: 0.625rem;
    opacity: 0.55;
    max-width: 72px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    flex-shrink: 0;
    margin-right: 4px;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.15);
  }

  .tab-name {
    position: relative;
    overflow: hidden;
    white-space: nowrap;
    font-size: 0.8125rem;

    // so that the name does not cutoff when italicized
    padding-right: 2px;
  }

  .example-icon {
    color: ${(props) => props.theme.requestTabs.example.iconColor};
  }
`;

export default StyledWrapper;
