/**
 * THE WS PANE MUST SHOW EVERY MESSAGE THE CONNECTION WILL SEND.
 *
 * `renderer:ws:start-connection` queues EVERY entry in `body.ws`
 * (ws-event-handlers.js — `preparedRequest.body.ws.forEach(queueMessage)`),
 * and both storage formats round-trip a list: `.bru` writes one `body:ws`
 * block per message, and the yml writer emits a variant list. The pane was the
 * only layer that disagreed — `canClientSendMultipleMessages` was pinned to
 * `false` by upstream's revert of its own multi-message PR (7c2b64731), which
 * we inherited, so a three-message request rendered one editor and sent three.
 *
 * These render the real WsBody against a three-message body. Re-pinning the
 * flag fails the first two.
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';

// CodeMirror cannot mount in jsdom and is not what is under test; the marker
// carries the message content so the assertions stay about the messages.
jest.mock('components/CodeEditor', () => ({ value }) => <div data-testid="ws-editor">{value}</div>);
jest.mock('providers/Theme', () => ({ useTheme: () => ({ displayedTheme: 'dark' }) }));

import WSBody from './index';

const MESSAGES = [
  { name: 'subscribe', type: 'text', content: '{"op":"sub"}' },
  { name: 'ping', type: 'text', content: 'ping' },
  { name: 'unsubscribe', type: 'text', content: '{"op":"unsub"}' }
];

const renderBody = (ws) => {
  const collection = { uid: 'col-1', pathname: '/w/c' };
  const item = { uid: 'req-1', request: { body: { mode: 'ws', ws } } };
  const store = configureStore({
    reducer: { app: () => ({ preferences: { font: {} } }) }
  });
  return render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <WSBody item={item} collection={collection} handleRun={() => {}} />
      </ThemeProvider>
    </Provider>
  );
};

describe('the WebSocket body pane', () => {
  it('renders an editor for every message, not just the first', () => {
    renderBody(MESSAGES);
    expect(screen.getAllByTestId('ws-editor')).toHaveLength(MESSAGES.length);
  });

  it('shows the content of the later messages, which used to be invisible', () => {
    renderBody(MESSAGES);
    for (const { content } of MESSAGES) expect(screen.getByText(content)).toBeInTheDocument();
    // Labelled by position, so the second and third are distinguishable.
    expect(screen.getByText('Message 3')).toBeInTheDocument();
  });

  it('offers a way to add another one', () => {
    renderBody(MESSAGES);
    expect(screen.getByRole('button', { name: /add message/i })).toBeInTheDocument();
  });

  it('still renders a single-message request as one editor', () => {
    renderBody([MESSAGES[0]]);
    expect(screen.getAllByTestId('ws-editor')).toHaveLength(1);
  });
});
