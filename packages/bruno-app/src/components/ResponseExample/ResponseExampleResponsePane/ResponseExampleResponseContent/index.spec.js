import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'providers/Theme';
import { configureStore } from '@reduxjs/toolkit';
import ResponseExampleResponseContent from './index';
import CodeEditor from 'components/CodeEditor';

// CodeMirror cannot mount in jsdom, and the point of these tests is whether it
// gets mounted at all.
jest.mock('components/CodeEditor', () => jest.fn(({ value }) => (
  <div data-testid="code-editor">{`chars:${value.length}`}</div>
)));

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
  const editorProps = () => CodeEditor.mock.calls.at(-1)[0];
  const escapedJson = String.raw`{"2":2,"1":1,"id":123456789012345678901,"message":"\u062F\u0631\u062E\u0648\u0627\u0633\u062A","literal":"\\u062F"}`;
  const readableJson = String.raw`{"2":2,"1":1,"id":123456789012345678901,"message":"REQUEST","literal":"\\u062F"}`
    .replace('REQUEST', '\u062f\u0631\u062e\u0648\u0627\u0633\u062a');

  it('shows JSON Unicode escapes as readable text without changing keys, numbers or literal backslashes', () => {
    const item = buildItem(escapedJson);
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode={false} />
    );
    expect(editorProps().value).toBe(readableJson);
    expect(item.examples[0].response.body.content).toBe(escapedJson);
  });

  it('decodes pasted JSON in edit mode without rewriting an existing saved buffer on entry', () => {
    renderWithProviders(
      <ResponseExampleResponseContent item={buildItem(escapedJson)} collection={mockCollection} exampleUid="example-1" editMode />
    );
    expect(editorProps().value).toBe(escapedJson);
    expect(editorProps().transformPaste(escapedJson)).toBe(readableJson);
  });

  it('keeps quotes, control escapes and surrogate pairs valid when decoding pasted JSON', () => {
    renderWithProviders(
      <ResponseExampleResponseContent item={buildItem('')} collection={mockCollection} exampleUid="example-1" editMode />
    );
    const source = String.raw`{"value":"\u0022\u000A\u005C\uD83D\uDE00",` + '"invalid":"\\uZZZZ"}';
    const decoded = editorProps().transformPaste(source);
    expect(decoded).toContain(String.raw`"value":"\"\n\\`);
    expect(decoded).toContain('\u{1f600}');
    expect(decoded).toContain('"invalid":"\\uZZZZ"');
  });

  it('does not decode Unicode-like text in a text example', () => {
    const item = buildItem(escapedJson);
    item.examples[0].response.body.type = 'text';
    renderWithProviders(
      <ResponseExampleResponseContent item={item} collection={mockCollection} exampleUid="example-1" editMode />
    );
    expect(editorProps().value).toBe(escapedJson);
    expect(editorProps().transformPaste).toBeUndefined();
  });

  it('leaves an unfinished JSON string with many escaped quotes intact', () => {
    renderWithProviders(
      <ResponseExampleResponseContent item={buildItem('')} collection={mockCollection} exampleUid="example-1" editMode />
    );
    const unfinished = '"\\u062F' + '\\"'.repeat(3000);
    expect(editorProps().transformPaste(unfinished)).toBe(unfinished);
  });

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
