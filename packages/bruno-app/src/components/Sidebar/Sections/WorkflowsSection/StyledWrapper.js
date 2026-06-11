import styled from 'styled-components';

const StyledWrapper = styled.div`
  .empty-message {
    padding: 4px 16px 8px 16px;
    font-size: 12px;
    color: ${(props) => props.theme.sidebar.muted};
  }

  .workflow-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 16px;
    cursor: pointer;
    font-size: 13px;
    color: ${(props) => props.theme.sidebar.color};

    .row-icon {
      color: ${(props) => props.theme.sidebar.muted};
      flex-shrink: 0;
    }

    .workflow-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .delete-icon {
      visibility: hidden;
    }

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};

      .delete-icon {
        visibility: visible;
      }
    }
  }
`;

export default StyledWrapper;
