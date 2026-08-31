import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';

/**
 * RENAMING A FOLDER MUST EITHER WORK OR SAY WHY NOT.
 *
 * Reported from Windows: renaming a sub-folder from the sidebar's ... menu
 * does nothing — no error, no change, and still nothing after restarting the
 * app — while renaming from the folder's own tab works.
 *
 * Two defects behind that shape, both provable here because neither depends on
 * the platform:
 *
 * 1. The filesystem-name field lives inside a collapsed "Options" section, and
 *    its validation error was only rendered INSIDE that section. A folder whose
 *    name fails the check therefore blocked submit with nothing on screen.
 * 2. `path.parse(name).name` was used to derive that filename — folders have no
 *    extension, so `Reports.2024` became `Reports`, and renaming from it would
 *    have moved the directory to the truncated name.
 */

jest.mock('components/Portal', () => ({ __esModule: true, default: ({ children }) => children }));
jest.mock('components/Modal', () => ({
  __esModule: true,
  default: ({ children, title }) => require('react').createElement('div', null, title, children)
}));

import RenameCollectionItem from './index';

const renderModal = ({ filename, name, onRename = jest.fn() }) => {
  const collection = { uid: 'col-1', pathname: '/w/c', items: [] };
  const store = configureStore({
    reducer: { collections: (state = { collections: [collection] }) => state }
  });
  const item = { uid: 'f1', name, filename, type: 'folder', items: [] };
  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <RenameCollectionItem collectionUid="col-1" item={item} onClose={() => {}} onRename={onRename} />
      </ThemeProvider>
    </Provider>
  );
  return { onRename };
};

const submit = () => fireEvent.click(screen.getByRole('button', { name: /rename/i }));
const typeName = (value) => fireEvent.change(screen.getByLabelText(/folder name/i), { target: { value } });

describe('renaming a folder from the sidebar', () => {
  it('renames the directory of a folder whose name contains a dot', async () => {
    // `path.parse('Reports.2024').name` is 'Reports' — folders have no
    // extension. The form therefore believed the directory was already called
    // 'Reports', so renaming TO 'Reports' compared equal and the filename was
    // sent as undefined: the display name changed and the directory on disk
    // did not, silently.
    const { onRename } = renderModal({ name: 'Reports 2024', filename: 'Reports.2024' });
    typeName('Reports');
    submit();

    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(onRename.mock.calls[0][0]).toEqual({ name: 'Reports', filename: 'Reports' });
  });

  it('carries the whole name through a rename', async () => {
    const { onRename } = renderModal({ name: 'Reports 2024', filename: 'Reports.2024' });
    typeName('Reports 2025');
    submit();

    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(onRename.mock.calls[0][0].name).toBe('Reports 2025');
  });

  it('renames a plain folder', async () => {
    const { onRename } = renderModal({ name: 'Auth', filename: 'Auth' });
    typeName('Authentication');
    submit();

    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(onRename.mock.calls[0][0].name).toBe('Authentication');
  });

  it('says why it refused instead of doing nothing', async () => {
    // A reserved device name is the check that fires on Windows; before this
    // the message was rendered only inside the collapsed section, so pressing
    // Rename did nothing at all and said nothing.
    const { onRename } = renderModal({ name: 'Auth', filename: 'Auth' });
    typeName('CON');
    submit();

    expect(await screen.findByTestId('rename-filename-error')).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('shows the offending value in the message, not just the rule', async () => {
    const { onRename } = renderModal({ name: 'Auth', filename: 'Auth' });
    typeName('folder');
    submit();

    const error = await screen.findByTestId('rename-filename-error');
    expect(error).toHaveTextContent('folder');
    expect(onRename).not.toHaveBeenCalled();
  });
});
