import styled from 'styled-components';

const StyledWrapper = styled.div`
  .location-label {
    font-weight: 500;
  }

  .collection-select {
    width: 100%;
    padding: 0.45rem 0.6rem;
    border-radius: 3px;
    border: 1px solid ${(props) => props.theme.input.border};
    background: ${(props) => props.theme.input.bg};
    color: ${(props) => props.theme.text};
    outline: none;

    &:focus {
      border-color: ${(props) => props.theme.input.focusBorder};
    }
  }

  .folder-tree {
    margin-top: 0.5rem;
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 3px;
    padding: 4px 0;
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }

    &.selected {
      background: ${(props) => props.theme.sidebar.collection.item.bg};
    }

    .folder-row-icon {
      flex-shrink: 0;
      opacity: 0.7;
    }
  }

  .folder-tree-empty {
    padding: 6px 10px;
    opacity: 0.6;
    font-size: 0.8125rem;
  }
`;

export default StyledWrapper;
