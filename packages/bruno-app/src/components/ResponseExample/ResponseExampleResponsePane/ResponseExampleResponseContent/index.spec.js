import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'providers/Theme';
import { configureStore } from '@reduxjs/toolkit';
import ResponseExampleResponseContent from './index';

// CodeMirror cannot mount in jsdom, and the point of these tests is whether it
// gets mounted at all.
jest.mock('components/CodeEditor', () => ({ value }) => (
  <div data-testid="code-editor">{`chars:${value.length}`}</div>
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

const renderWithProviders = (component) => {
  return render(
    <Provider store={mockStore}>
      <ThemeProvider>
        {component}
      </ThemeProvider>
    </Provider>
  );
};

const mockCollection = { uid: 'col-1', pathname: '/home/user/collection' };

const buildItem = (content) => ({
  uid: 'item-1',
  name: 'get users',
  type: 'http-request',
  examples: [
    {
      uid: 'example-1',
      name: 'success',
      response: {
        status: 200,
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: { type: 'json', content }
      }
    }
  ]
});

describe('ResponseExampleResponseContent', () => {
  it('should render the editor for an example under the size limit', () => {
    const item = buildItem('{"ok":true}');
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    expect(screen.queryByText('Large Response Warning')).not.toBeInTheDocument();
  });

  it('should warn instead of mounting the editor for a multi-MB example', () => {
    const item = buildItem('x'.repeat(10 * 1024 * 1024 + 1));
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument();
    expect(screen.getByText('Large Response Warning')).toBeInTheDocument();
  });

  it('should show the example anyway once the user asks for it', () => {
    const item = buildItem('x'.repeat(10 * 1024 * 1024 + 1));
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByTestId('code-editor')).toBeInTheDocument();
  });

  it('should measure the body in bytes, not in UTF-16 code units', () => {
    // 5.5M Persian characters: under the 10 MB limit by character count, 11 MB
    // once encoded (2 bytes each) — the size the editor actually has to chew
    // through, and the shape of every body in the report this fix came from.
    const item = buildItem('ک'.repeat(5.5 * 1024 * 1024));
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument();
    expect(screen.getByText('Large Response Warning')).toBeInTheDocument();
  });

  it('should not offer a download the example can never satisfy', () => {
    const item = buildItem('x'.repeat(10 * 1024 * 1024 + 1));
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.getByTitle('Copy response to clipboard')).toBeVisible();
    expect(screen.getByTitle('Download response to file')).not.toBeVisible();
  });

  it('should render a body that did not parse into a string', () => {
    // A yml example's content is whatever the parser made of it.
    const item = buildItem({ ok: true });
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.getByTestId('code-editor')).toHaveTextContent(`chars:${JSON.stringify({ ok: true }, null, 2).length}`);
  });

  it('should gate on the example body, not on the request live response', () => {
    const item = {
      ...buildItem('{"ok":true}'),
      response: { size: 30 * 1024 * 1024, data: 'live response' }
    };
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.getByTestId('code-editor')).toBeInTheDocument();
  });

  it('should render an empty editor when the example has no body', () => {
    const item = { uid: 'item-1', examples: [{ uid: 'example-1', response: { status: 200 } }] };
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} onSave={jest.fn()} />
    );
    expect(screen.getByTestId('code-editor')).toHaveTextContent('chars:0');
  });
});
