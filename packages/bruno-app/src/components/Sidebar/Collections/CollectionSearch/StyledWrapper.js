import styled from 'styled-components';

const StyledWrapper = styled.div`
  margin: 4px 10px 8px 10px;

  .search-input-row {
    position: relative;
  }

  .search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: ${(props) => props.theme.sidebar.muted};
    pointer-events: none;
  }

  input[type='text'] {
    width: 100%;
    height: 32px;
    padding: 0 76px 0 32px;
    font-size: 12px;
    color: ${(props) => props.theme.sidebar.color};
    background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    border: 1px solid transparent;
    border-radius: 6px;
    outline: none;
    transition: all 0.15s ease;

    &::placeholder {
      color: ${(props) => props.theme.sidebar.muted};
    }

    &:hover {
      border-color: ${(props) => props.theme.input.border};
    }

    &:focus {
      background: ${(props) => props.theme.input.bg};
      border-color: ${(props) => props.theme.input.border};
    }
  }

  .search-actions {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: ${(props) => props.theme.sidebar.muted};
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover {
      color: ${(props) => props.theme.sidebar.color};
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }

    &.active {
      color: ${(props) => props.theme.colors.text.yellow};
    }
  }

  .search-scopes {
    margin-top: 6px;
    padding: 8px 10px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 6px;
    background: ${(props) => props.theme.sidebar.bg};
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .scope-option {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${(props) => props.theme.sidebar.color};
    cursor: pointer;

    input {
      cursor: pointer;
    }
  }

  .scope-warning {
    font-size: 11px;
    color: ${(props) => props.theme.colors.text.yellow};
  }
`;

export default StyledWrapper;
