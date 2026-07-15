import styled from 'styled-components';

const StyledWrapper = styled.div`
  .empty-message {
    padding: 8px 12px;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .day-label {
    padding: 6px 12px 2px;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .history-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px;
    cursor: pointer;
    font-size: 0.75rem;

    &:hover {
      background: ${(props) => props.theme.sidebar.collection.item.hoverBg};

      .remove-icon {
        opacity: 1;
      }
    }
  }

  .method {
    flex-shrink: 0;
    width: 40px;
    font-size: 0.625rem;
    font-weight: 700;
  }

  .method-get { color: ${(props) => props.theme.request.methods.get}; }
  .method-post { color: ${(props) => props.theme.request.methods.post}; }
  .method-put { color: ${(props) => props.theme.request.methods.put}; }
  .method-delete { color: ${(props) => props.theme.request.methods.delete}; }
  .method-patch { color: ${(props) => props.theme.request.methods.patch}; }

  .entry-name {
    flex: 1;
    min-width: 0;
  }

  .status {
    flex-shrink: 0;
    font-size: 0.625rem;
    font-weight: 600;
  }

  .status-ok { color: ${(props) => props.theme.colors.text.green}; }
  .status-redirect { color: ${(props) => props.theme.colors.text.yellow}; }
  .status-error { color: ${(props) => props.theme.colors.text.danger}; }

  .entry-time {
    flex-shrink: 0;
    font-size: 0.625rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .remove-icon {
    opacity: 0;
    flex-shrink: 0;
  }
`;

export default StyledWrapper;
