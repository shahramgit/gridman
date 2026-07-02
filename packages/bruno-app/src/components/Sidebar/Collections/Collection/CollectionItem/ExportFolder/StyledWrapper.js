import styled from 'styled-components';

const StyledWrapper = styled.div`
  .format-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .format-card {
    display: flex;
    flex-direction: column;
    border-radius: ${(props) => props.theme.border.radius.base};
    padding: 1rem;
    border: 2px solid ${(props) => props.theme.border.border0};
    background-color: ${(props) => props.theme.background.base};
    cursor: pointer;
    transition: border-color 0.15s ease;

    &:hover:not(.selected) {
      border-color: ${(props) => props.theme.border.border2};
    }

    &.selected {
      border-color: ${(props) => props.theme.primary.solid};
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;

      .card-title {
        font-weight: 600;
        font-size: 0.9375rem;
      }
    }

    .card-description {
      font-size: 0.8125rem;
      color: ${(props) => props.theme.colors.text.subtext0};
    }
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid ${(props) => props.theme.border.border0};
  }
`;

export default StyledWrapper;
