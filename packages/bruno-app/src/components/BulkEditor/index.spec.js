import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'providers/Theme';
import { configureStore } from '@reduxjs/toolkit';
import BulkEditor from './index';

// CodeMirror cannot mount in jsdom. Stand in a textarea that mirrors the two
// things this component relies on: the serialized text goes in as `value`, and
// `onEdit` is read off props at call time (so a fresh closure per render wins).
jest.mock('components/CodeEditor', () => ({ value, onEdit }) => (
  <textarea data-testid="code-editor" value={value} onChange={(e) => onEdit(e.target.value)} readOnly={!onEdit} />
));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }))
  });
});

const mockStore = configureStore({
  reducer: {
    app: (state = { preferences: { font: {} } }) => state,
    collections: (state = { collections: [] }) => state
  }
});

const renderWithProviders = (component) =>
  render(
    <Provider store={mockStore}>
      <ThemeProvider>{component}</ThemeProvider>
    </Provider>
  );

const editor = () => screen.getByTestId('code-editor');

describe('BulkEditor', () => {
  it('serializes the rows it is given', () => {
    renderWithProviders(
      <BulkEditor
        params={[
          { uid: 'u1', name: 'Accept', value: 'application/json', description: 'd', enabled: true },
          { uid: 'u2', name: 'X-Trace', value: 'off', description: 'd', enabled: false }
        ]}
        onChange={() => {}}
        onToggle={() => {}}
      />
    );

    expect(editor()).toHaveValue('Accept:application/json\n//X-Trace:off');
  });

  it('keeps uid and description when a name is edited', () => {
    const onChange = jest.fn();
    renderWithProviders(
      <BulkEditor
        params={[{ uid: 'u1', name: 'Authorization', value: 'Bearer x', description: 'auth header', enabled: true }]}
        onChange={onChange}
        onToggle={() => {}}
      />
    );

    fireEvent.change(editor(), { target: { value: 'Authorisation:Bearer x' } });

    expect(onChange).toHaveBeenCalledWith([
      { uid: 'u1', name: 'Authorisation', value: 'Bearer x', description: 'auth header', enabled: true }
    ]);
  });

  it('matches against the current rows, not the rows it was mounted with', () => {
    // The URL bar rewrites request.params (uids and all) and the file watcher
    // replaces them after an external edit or a `git pull`, both while this
    // editor stays mounted. Matching a stale snapshot would re-attach dead uids
    // and resurrect rows the update removed.
    const onChange = jest.fn();
    const { rerender } = renderWithProviders(
      <BulkEditor
        params={[
          { uid: 'stale-1', name: 'Accept', value: 'application/json', description: 'stale', enabled: true },
          { uid: 'stale-2', name: 'X-Gone', value: 'gone', description: 'stale', enabled: true }
        ]}
        onChange={onChange}
        onToggle={() => {}}
      />
    );

    // an external update drops X-Gone and re-issues Accept with a new uid
    rerender(
      <Provider store={mockStore}>
        <ThemeProvider>
          <BulkEditor
            params={[{ uid: 'fresh-1', name: 'Accept', value: 'application/json', description: 'fresh', enabled: true }]}
            onChange={onChange}
            onToggle={() => {}}
          />
        </ThemeProvider>
      </Provider>
    );

    expect(editor()).toHaveValue('Accept:application/json');

    fireEvent.change(editor(), { target: { value: 'Accept:application/xml' } });

    expect(onChange).toHaveBeenCalledWith([
      { uid: 'fresh-1', name: 'Accept', value: 'application/xml', description: 'fresh', enabled: true }
    ]);
  });
});
