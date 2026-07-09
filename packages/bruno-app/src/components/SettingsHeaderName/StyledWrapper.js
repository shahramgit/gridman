import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;

  /* Click-to-rename name (Postman-style), mirrors CollectionHeader */
  .settings-name-editable {
    max-width: 480px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 6px;
    margin-left: -6px;
    border-radius: 4px;
    font-size: 0.9375rem;
    font-weight: 600;
    color: ${(props) => props.theme.text};
    cursor: text;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};
    }
  }

  .settings-name-input {
    font-size: 0.9375rem;
    font-weight: 600;
    padding: 1px 5px;
    margin-left: -6px;
    border: 1px solid ${(props) => props.theme.input.border};
    border-radius: 3px;
    background: ${(props) => props.theme.input.bg};
    color: ${(props) => props.theme.text};
    outline: none;
    min-width: 220px;
    max-width: 480px;

    &:focus {
      border-color: ${(props) => props.theme.input.focusBorder};
    }
  }
`;

export default StyledWrapper;
