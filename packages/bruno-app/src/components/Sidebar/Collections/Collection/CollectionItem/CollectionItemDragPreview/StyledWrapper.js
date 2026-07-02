import styled from 'styled-components';

const StyledWrapper = styled.div`
  .drag-preview {
    background-color: ${(props) => props.theme.sidebar.collection.item.hoverBg};
  }

  .drag-preview-count {
    font-size: 0.6875rem;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 9999px;
    background: ${(props) => props.theme.dragAndDrop.border};
    color: #fff;
  }
`;

export default StyledWrapper;
