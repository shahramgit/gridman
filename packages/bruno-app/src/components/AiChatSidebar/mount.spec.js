/**
 * THE FEATURE IS ACTUALLY MOUNTED.
 *
 * Nothing in the app rendered AiChatSurface or AiToggleButton: every unit test
 * for them passed while the only reachable AI UI was the Preferences tab. So
 * this suite renders the REAL `pages/Bruno` — the app's single mount point —
 * rather than asserting on its source, which is the failure mode the
 * reducer-registration test already fell into.
 *
 * Deleting either mount line from pages/Bruno/index.js fails this suite.
 *
 * The heavy siblings are stubbed so jsdom can render the page at all. The
 * component under test — pages/Bruno itself — is NOT stubbed.
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';
import aiReducer from 'providers/ReduxStore/slices/ai';

// Stylesheets pulled in for the CodeMirror editors; jest has no CSS transform.
jest.mock('codemirror/theme/material.css', () => ({}), { virtual: true });
jest.mock('codemirror/theme/monokai.css', () => ({}), { virtual: true });
jest.mock('codemirror/addon/scroll/simplescrollbars.css', () => ({}), { virtual: true });
jest.mock('swagger-ui-react/swagger-ui.css', () => ({}), { virtual: true });

// The collection sidebar is the fork's rewritten indexed renderer and is off
// limits to this change; it is stubbed with a marker so the assertions below
// can prove the AI surfaces are mounted OUTSIDE it.
jest.mock('components/Sidebar', () => () => <div data-testid="collection-sidebar" />);
jest.mock('components/ManageWorkspace', () => () => null);
jest.mock('components/RequestTabs', () => () => null);
jest.mock('components/RequestTabPanel', () => () => <div data-testid="request-tab-panel" />);
jest.mock('components/StatusBar', () => () => null);
jest.mock('components/AppTitleBar', () => () => null);
jest.mock('components/ApiSpecPanel', () => () => null);
jest.mock('components/RequestTabPanel/TabPanelErrorBoundary', () => ({ children }) => children);
jest.mock('components/Devtools', () => () => null);
jest.mock('components/Portal', () => ({ children }) => children);
jest.mock('components/SaveTransientRequest/Container', () => () => null);
jest.mock('components/SaveTransientRequest', () => () => null);
jest.mock('utils/network/grpc-event-listeners', () => () => {});
jest.mock('utils/network/ws-event-listeners', () => () => {});

// The panel body is exercised by its own suites; here we only care that the
// gate lets it be constructed at all.
jest.mock('./index', () => () => <div data-testid="ai-docked-panel" />);
jest.mock('idb', () => ({ openDB: jest.fn(() => Promise.resolve(null)) }));

const Main = require('pages/Bruno').default;

const collection = { uid: 'col-1', name: 'Demo', pathname: '/c', items: [] };

const makeStore = ({ aiEnabled, isOpen = false, tabCollectionUid = 'col-1' } = {}) =>
  configureStore({
    reducer: {
      ai: aiReducer,
      app: (
        state = {
          preferences: { ai: { enabled: aiEnabled } },
          isDragging: false,
          showApiSpecPage: false,
          showManageWorkspacePage: false
        }
      ) => state,
      tabs: (state = { tabs: [{ uid: 'tab-1', collectionUid: tabCollectionUid }], activeTabUid: 'tab-1' }) => state,
      collections: (state = { collections: [collection], saveTransientRequestModals: [] }) => state,
      apiSpec: (state = { activeApiSpecUid: null }) => state,
      logs: (state = { isConsoleOpen: false }) => state
    },
    preloadedState: { ai: { isOpen, chats: {} } }
  });

const renderApp = (options) => {
  const store = makeStore(options);
  const utils = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <Main />
      </ThemeProvider>
    </Provider>
  );
  return { store, ...utils };
};

describe('the AI feature is mounted in the app', () => {
  it('renders the toggle when ai.enabled is true', () => {
    renderApp({ aiEnabled: true });
    expect(screen.getByTestId('ai-toggle-button')).toBeInTheDocument();
  });

  // A workflow tab carries the WORKSPACE uid as its collectionUid, so it
  // resolves to no collection. The panel already bailed on that; the button did
  // not, which is how a visible toggle came to open nothing.
  it('renders NO toggle on a tab that resolves to no collection', () => {
    renderApp({ aiEnabled: true, tabCollectionUid: 'workspace-1' });
    expect(screen.queryByTestId('ai-toggle-button')).not.toBeInTheDocument();
  });

  it('keeps the button and the panel in agreement on such a tab', () => {
    // The failure this locks out: button rendered, panel did not.
    renderApp({ aiEnabled: true, isOpen: true, tabCollectionUid: 'workspace-1' });
    expect(screen.queryByTestId('ai-toggle-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-docked-panel')).not.toBeInTheDocument();
  });

  it('renders the docked panel when the feature is on and the panel is open', () => {
    renderApp({ aiEnabled: true, isOpen: true });
    expect(screen.getByTestId('ai-docked-panel')).toBeInTheDocument();
  });

  it('opens the panel from the toggle, with no other wiring', () => {
    const { store } = renderApp({ aiEnabled: true });
    expect(screen.queryByTestId('ai-docked-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-toggle-button'));

    expect(store.getState().ai.isOpen).toBe(true);
    expect(screen.getByTestId('ai-docked-panel')).toBeInTheDocument();
  });

  it('mounts it as a right-side surface, outside the collection sidebar', () => {
    renderApp({ aiEnabled: true, isOpen: true });
    const sidebar = screen.getByTestId('collection-sidebar');
    const panel = screen.getByTestId('ai-docked-panel');
    const toggle = screen.getByTestId('ai-toggle-button');

    expect(sidebar.contains(panel)).toBe(false);
    expect(sidebar.contains(toggle)).toBe(false);
    // …and after the request pane in document order, i.e. to its right.
    const requestPane = screen.getByTestId('request-tab-panel');

    expect(requestPane.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the AI feature is invisible while ai.enabled is false', () => {
  it('renders no toggle, no rail and no panel', () => {
    const { container } = renderApp({ aiEnabled: false, isOpen: true });

    expect(screen.queryByTestId('ai-toggle-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-docked-panel')).not.toBeInTheDocument();
    // The rail is styling on the toggle's own wrapper, so "nothing renders"
    // has to mean no element at all, not an empty bordered column.
    expect(container.querySelector('.ai-rail')).toBeNull();
  });

  it('still renders the rest of the app', () => {
    renderApp({ aiEnabled: false });
    expect(screen.getByTestId('collection-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('request-tab-panel')).toBeInTheDocument();
  });

  it('dispatches nothing into the ai slice', () => {
    const { store } = renderApp({ aiEnabled: false });
    expect(store.getState().ai).toEqual({ isOpen: false, chats: {} });
  });
});
