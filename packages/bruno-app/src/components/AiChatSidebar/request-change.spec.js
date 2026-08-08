import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';
import AiChatSidebar from './index';

/**
 * THE APPROVAL SIDE OF create_request / update_request.
 *
 * The main-process suite (bruno-electron tests/ai/request-tools.spec.js) proves
 * the tools only PROPOSE. This one proves the other half: a proposal reaches
 * the user as a card they have to accept, and accepting routes to the actions
 * that produce an UNSAVED request or an unsaved draft — never a write.
 */

jest.mock('idb', () => ({ openDB: jest.fn(() => Promise.resolve(null)) }));

const mockGetAiStatus = jest.fn();
jest.mock('providers/ReduxStore/slices/ai', () => {
  const actual = jest.requireActual('providers/ReduxStore/slices/ai');
  return {
    ...actual,
    getAiStatus: (...args) => mockGetAiStatus(...args),
    // Persistence writes to IndexedDB; the status marker is asserted on the
    // store, not on disk.
    setMessageCodeStatus: (params) => actual.markAiMessageCodeStatus(params)
  };
});

const mockNewHttpRequest = jest.fn(() => () => Promise.resolve());
jest.mock('providers/ReduxStore/slices/collections/actions', () => ({
  ...jest.requireActual('providers/ReduxStore/slices/collections/actions'),
  newHttpRequest: (...args) => mockNewHttpRequest(...args)
}));

const ITEM = {
  uid: 'tab-1',
  type: 'http-request',
  name: 'Get Users',
  pathname: '/demo/Get Users.bru',
  request: {
    method: 'GET',
    url: 'https://api.example.test/users',
    headers: [],
    params: [],
    docs: '',
    body: { mode: 'none' },
    auth: { mode: 'none' }
  }
};

const collection = { uid: 'col-1', name: 'Demo', pathname: '/demo', items: [ITEM] };

const assistantMessage = (requestChanges) => ({
  role: 'assistant',
  content: 'Here you go.',
  isStreaming: false,
  requestChanges
});

const makeStore = (messages) =>
  configureStore({
    reducer: {
      ai: jest.requireActual('providers/ReduxStore/slices/ai').default,
      app: (state = { preferences: { ai: { enabled: true } } }) => state,
      tabs: (state = { tabs: [{ uid: 'tab-1', collectionUid: 'col-1', requestPaneTab: 'docs' }], activeTabUid: 'tab-1' }) =>
        state,
      collections: (state = { collections: [collection] }, action) =>
        jest.requireActual('providers/ReduxStore/slices/collections').default(state, action)
    },
    preloadedState: {
      ai: {
        isOpen: true,
        chats: {
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
      }
    }
  });

const renderWith = (requestChanges) => {
  const store = makeStore([assistantMessage(requestChanges)]);
  const utils = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <AiChatSidebar collection={collection} />
      </ThemeProvider>
    </Provider>
  );
  return { store, ...utils };
};

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

describe('a proposed request needs the user', () => {
  it('shows the request as a card rather than applying it', () => {
    renderWith([
      { op: 'create', name: 'Tehran Weather', method: 'GET', url: 'https://api.open-meteo.com/v1/forecast?x=1' }
    ]);

    expect(screen.getByTestId('ai-request-change')).toBeInTheDocument();
    expect(screen.getByText('Tehran Weather')).toBeInTheDocument();
    // The URL is the thing being approved — it must be legible in the card, not
    // summarised away.
    expect(screen.getByText('https://api.open-meteo.com/v1/forecast?x=1')).toBeInTheDocument();
    // Rendering the card is not accepting it.
    expect(mockNewHttpRequest).not.toHaveBeenCalled();
  });

  it('creates it UNSAVED when accepted, so nothing lands in the collection', () => {
    renderWith([{ op: 'create', name: 'Tehran Weather', method: 'GET', url: 'https://api.open-meteo.com/v1/forecast' }]);

    fireEvent.click(screen.getByTestId('ai-request-change-accept'));

    expect(mockNewHttpRequest).toHaveBeenCalledTimes(1);
    const params = mockNewHttpRequest.mock.calls[0][0];
    expect(params).toMatchObject({
      requestName: 'Tehran Weather',
      requestMethod: 'GET',
      requestUrl: 'https://api.open-meteo.com/v1/forecast',
      collectionUid: 'col-1',
      // The whole safety story: an accepted proposal is still the user's to
      // save. Flipping this to false writes a file into their collection — and
      // into their git working tree — on one click.
      isTransient: true
    });
  });

  it('does nothing at all when dismissed', () => {
    const { store } = renderWith([
      { op: 'create', name: 'Tehran Weather', method: 'GET', url: 'https://api.open-meteo.com/v1/forecast' }
    ]);

    fireEvent.click(screen.getByTitle('Dismiss'));

    expect(mockNewHttpRequest).not.toHaveBeenCalled();
    expect(store.getState().ai.chats['tab-1'].messages[0].requestChanges[0].status).toBe('rejected');
  });
});

describe('an update proposal', () => {
  it('shows the old value beside the new one', () => {
    renderWith([{ op: 'update', url: 'https://api.example.test/v2/users' }]);

    expect(screen.getByText('https://api.example.test/users')).toBeInTheDocument();
    expect(screen.getByText('https://api.example.test/v2/users')).toBeInTheDocument();
  });

  it('applies as an unsaved draft, leaving the saved request untouched', () => {
    const { store } = renderWith([{ op: 'update', url: 'https://api.example.test/v2/users' }]);

    fireEvent.click(screen.getByTestId('ai-request-change-accept'));

    const item = store.getState().collections.collections[0].items[0];
    expect(item.draft.request.url).toBe('https://api.example.test/v2/users');
    // Untouched: the user still has to save. Anything that wrote through to
    // `item.request` here would have skipped the save they never performed.
    expect(item.request.url).toBe('https://api.example.test/users');
  });

  it('hides fields that do not actually change', () => {
    // The model echoing the current method back is not a change, and showing it
    // as one makes the review dishonest.
    renderWith([{ op: 'update', method: 'GET', url: 'https://api.example.test/v2/users' }]);

    expect(screen.getByText('URL')).toBeInTheDocument();
    expect(screen.queryByText('Method')).not.toBeInTheDocument();
  });
});
