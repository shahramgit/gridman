import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import toast from 'react-hot-toast';
import RequestNotLoaded from './index';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() })
}));

const theme = {
  requestTabPanel: {
    card: { bg: '#fff', border: '#e0e0e0', hr: '#e0e0e0' }
  }
};

const mockStore = configureStore({
  reducer: {
    collections: (state = { collections: [] }) => state
  }
});

const renderWithProviders = (component) => {
  return render(
    <Provider store={mockStore}>
      <ThemeProvider theme={theme}>
        {component}
      </ThemeProvider>
    </Provider>
  );
};

const mockCollection = { uid: 'col-1', pathname: '/home/user/collection' };

describe('RequestNotLoaded', () => {
  beforeEach(() => {
    window.ipcRenderer = { invoke: jest.fn(() => Promise.resolve()) };
  });

  it('should offer the retry for a file skipped because of its size', () => {
    const item = { name: 'big.bru', pathname: '/home/user/collection/big.bru', size: 12.5, partial: true };
    renderWithProviders(<RequestNotLoaded item={item} collection={mockCollection} />);
    expect(screen.getByText(/wasn't loaded due to its large size/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Request' })).toBeInTheDocument();
  });

  it('should still offer the retry when the file failed to parse', () => {
    const item = {
      name: 'broken.bru',
      pathname: '/home/user/collection/broken.bru',
      size: 0.01,
      partial: true,
      error: { message: 'Unexpected token at line 3' }
    };
    renderWithProviders(<RequestNotLoaded item={item} collection={mockCollection} />);
    expect(screen.getByText(/Unexpected token at line 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Request' })).toBeInTheDocument();
  });

  it('should show a parse message when the error carries no detail', () => {
    const item = { name: 'broken.bru', pathname: '/x/broken.bru', size: 0.01, partial: true, error: true };
    renderWithProviders(<RequestNotLoaded item={item} collection={mockCollection} />);
    expect(screen.getByText(/The request couldn't be parsed\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Request' })).toBeInTheDocument();
  });

  it('should load the request through the regex parser when the retry is clicked', async () => {
    const item = { name: 'broken.bru', pathname: '/x/broken.bru', size: 0.01, partial: true, error: true };
    renderWithProviders(<RequestNotLoaded item={item} collection={mockCollection} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Request' }));
    expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:load-large-request', {
      collectionUid: 'col-1',
      pathname: '/x/broken.bru'
    });
    await waitFor(() => expect(toast.error).not.toHaveBeenCalled());
  });

  it('should report the failure when the retry cannot parse the file either', async () => {
    // The main process re-sends the file as partial with no error and then
    // rejects, so the pane silently reverts to the "too large" message unless
    // the rejection is caught and surfaced.
    window.ipcRenderer.invoke = jest.fn(() => Promise.reject(new Error('Unexpected token at line 3')));
    const item = { name: 'broken.bru', pathname: '/x/broken.bru', size: 0.01, partial: true, error: true };
    renderWithProviders(<RequestNotLoaded item={item} collection={mockCollection} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load Request' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unexpected token at line 3'));
  });

  it('should still report a failure that carries no message', async () => {
    window.ipcRenderer.invoke = jest.fn(() => Promise.reject(new Error('')));
    const item = { name: 'broken.bru', pathname: '/x/broken.bru', size: 0.01, partial: true, error: true };
    renderWithProviders(<RequestNotLoaded item={item} collection={mockCollection} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load Request' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The request could not be parsed'));
  });
});
