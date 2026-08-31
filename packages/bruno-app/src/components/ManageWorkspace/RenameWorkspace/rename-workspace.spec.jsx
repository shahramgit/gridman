import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';

/**
 * THE RENAME DIALOG SAYS WHAT IT CHANGES.
 *
 * Renaming a workspace edits `info.name` in workspace.yml and leaves the
 * directory alone. That is deliberate — the yml is git-tracked, so the name is
 * the workspace's name for everyone who pulls, while the folder is local to
 * each machine — but with nothing on screen saying so, a user who sees the
 * folder name unchanged concludes the rename failed. Which is exactly what was
 * asked after the rename started working.
 */

jest.mock('components/Portal/index', () => ({ __esModule: true, default: ({ children }) => children }));
jest.mock('components/Modal/index', () => ({
  __esModule: true,
  default: ({ children, title }) => require('react').createElement('div', null, title, children)
}));

import RenameWorkspace from './index';

const renderDialog = (workspace) => {
  const store = configureStore({
    reducer: { workspaces: (state = { workspaces: [workspace] }) => state }
  });
  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <RenameWorkspace workspace={workspace} onClose={() => {}} />
      </ThemeProvider>
    </Provider>
  );
};

describe('the rename workspace dialog', () => {
  it('shows the folder it is not going to rename', () => {
    renderDialog({ uid: 'w1', name: 'GSB', pathname: '/Users/me/gridman/GSB' });

    const note = screen.getByTestId('rename-workspace-folder-note');
    expect(note).toHaveTextContent('not renamed');
    expect(note).toHaveTextContent('/Users/me/gridman/GSB');
  });

  it('prefills the current name', () => {
    renderDialog({ uid: 'w1', name: 'GSB', pathname: '/Users/me/gridman/GSB' });
    expect(screen.getByLabelText(/workspace name/i)).toHaveValue('GSB');
  });

  it('does not claim anything about a workspace with no path', () => {
    renderDialog({ uid: 'w1', name: 'GSB' });
    expect(screen.queryByTestId('rename-workspace-folder-note')).not.toBeInTheDocument();
  });
});
