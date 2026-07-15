import styled from 'styled-components';

const StyledWrapper = styled.div`
  .trash-list {
    max-height: 420px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .trash-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: ${(props) => props.theme.border.radius.sm};

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  .trash-type-icon {
    flex-shrink: 0;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .trash-main {
    flex: 1;
    min-width: 0;
  }

  .trash-name {
    font-size: 0.8125rem;
  }

  .trash-origin {
    font-size: 0.6875rem;
  }

  .trash-when {
    flex-shrink: 0;
    font-size: 0.6875rem;
    white-space: nowrap;
  }
`;

export default StyledWrapper;
