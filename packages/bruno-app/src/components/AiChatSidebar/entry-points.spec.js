import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';
import aiReducer, { closeAiPanel, toggleAiPanel } from 'providers/ReduxStore/slices/ai';
import Surface from './Surface';
import ToggleButton from './ToggleButton';

// The panel itself is exercised through the slice tests; here we only care
// that nothing downstream of the ai.enabled gate is ever constructed.
jest.mock('./index', () => () => <div data-testid="ai-docked-panel" />);
jest.mock('idb', () => ({ openDB: jest.fn(() => Promise.resolve(null)) }));

const collection = { uid: 'col-1', name: 'Demo', items: [] };

const makeStore = ({ aiEnabled = false, isOpen = false } = {}) =>
  configureStore({
    reducer: {
      ai: aiReducer,
      app: (state = { preferences: { ai: { enabled: aiEnabled } } }) => state,
      tabs: (state = { tabs: [{ uid: 'tab-1', collectionUid: 'col-1' }], activeTabUid: 'tab-1' }) => state,
      collections: (state = { collections: [collection] }) => state
    },
    preloadedState: { ai: { isOpen, chats: {} } }
  });

// A store that has NOT registered the ai slice — the shape a component sees if
// it mounts before (or without) the reducer being wired in.
const makeStoreWithoutAiSlice = ({ aiEnabled = true } = {}) =>
  configureStore({
    reducer: {
      app: (state = { preferences: { ai: { enabled: aiEnabled } } }) => state,
      tabs: (state = { tabs: [{ uid: 'tab-1', collectionUid: 'col-1' }], activeTabUid: 'tab-1' }) => state,
      collections: (state = { collections: [collection] }) => state
    }
  });

const renderWith = (store, ui) =>
  render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>{ui}</ThemeProvider>
    </Provider>
  );

describe('AI entry points respect ai.enabled', () => {
  describe('Surface', () => {
    it('renders nothing when AI is disabled, even if the panel is flagged open', () => {
      const { container } = renderWith(makeStore({ aiEnabled: false, isOpen: true }), <Surface />);
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('ai-docked-panel')).not.toBeInTheDocument();
    });

    it('renders nothing when AI is enabled but the panel is closed', () => {
      const { container } = renderWith(makeStore({ aiEnabled: true, isOpen: false }), <Surface />);
      expect(container.firstChild).toBeNull();
    });

    it('renders the docked panel when enabled and open', () => {
      renderWith(makeStore({ aiEnabled: true, isOpen: true }), <Surface />);
      expect(screen.getByTestId('ai-docked-panel')).toBeInTheDocument();
    });
  });

  describe('ToggleButton', () => {
    it('renders no button at all when AI is disabled', () => {
      const { container } = renderWith(makeStore({ aiEnabled: false }), <ToggleButton />);
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('ai-toggle-button')).not.toBeInTheDocument();
    });

    it('renders the button when AI is enabled', () => {
      renderWith(makeStore({ aiEnabled: true }), <ToggleButton />);
      expect(screen.getByTestId('ai-toggle-button')).toBeInTheDocument();
    });

    it('opens the panel on click', () => {
      const store = makeStore({ aiEnabled: true });
      renderWith(store, <ToggleButton />);
      fireEvent.click(screen.getByTestId('ai-toggle-button'));
      expect(store.getState().ai.isOpen).toBe(true);
    });

    it('says Gridman, never Bruno', () => {
      renderWith(makeStore({ aiEnabled: true }), <ToggleButton />);
      const button = screen.getByTestId('ai-toggle-button');
      expect(button).toHaveAttribute('title', 'Open Gridman AI');
      expect(button.getAttribute('aria-label')).not.toMatch(/bruno/i);
    });
  });
});

/**
 * Mounting order must not be able to take the app down over an optional
 * feature. Both entry points read `state.ai` — before this pass they read it
 * BEFORE the aiEnabled guard and threw on an undefined slice.
 */
describe('AI entry points survive a store with no ai slice', () => {
  it('Surface renders null instead of throwing', () => {
    const { container } = renderWith(makeStoreWithoutAiSlice({ aiEnabled: true }), <Surface />);
    expect(container.firstChild).toBeNull();
  });

  it('ToggleButton renders without throwing', () => {
    renderWith(makeStoreWithoutAiSlice({ aiEnabled: true }), <ToggleButton />);
    expect(screen.getByTestId('ai-toggle-button')).toBeInTheDocument();
  });

  it('ToggleButton renders null when AI is off and the slice is missing', () => {
    const { container } = renderWith(makeStoreWithoutAiSlice({ aiEnabled: false }), <ToggleButton />);
    expect(container.firstChild).toBeNull();
  });
});

/**
 * The REAL app store, not its source text.
 *
 * The previous version of this block read providers/ReduxStore as a string and
 * regex-matched `ai: aiReducer`, because that module used `import.meta.env`
 * and babel-jest could not evaluate it. That made the test vacuous: commenting
 * the registration out (`// ai: aiReducer`) left every test green while
 * `state.ai` was undefined for every user. The store now reads its build mode
 * through `process.env.NODE_ENV` (see providers/ReduxStore/index.js), so it
 * can be imported and interrogated for real.
 */
describe('the ai reducer is registered in the app store', () => {
  // Required late: importing the app store pulls in the whole middleware
  // stack, and only this block needs it.
  const appStore = require('providers/ReduxStore').default;

  it('exposes state.ai', () => {
    expect(appStore.getState().ai).toEqual({ isOpen: false, chats: {} });
  });

  it('responds to an ai action', () => {
    const before = appStore.getState().ai.isOpen;
    appStore.dispatch(toggleAiPanel());
    expect(appStore.getState().ai.isOpen).toBe(!before);
    appStore.dispatch(closeAiPanel());
    expect(appStore.getState().ai.isOpen).toBe(false);
  });

  it('does not leave the slice out of the reducer map', () => {
    // A store with no `ai` reducer answers an unknown-slice action by leaving
    // state untouched AND warns; this asserts the key is genuinely owned.
    expect(Object.keys(appStore.getState())).toContain('ai');
  });
});

/**
 * THE BUILD-MODE SWAP THAT RIDES ALONG WITH THIS CHANGE.
 *
 * Making the store importable meant replacing `import.meta.env.MODE` with
 * `process.env.NODE_ENV`, and that expression gates the redux debug middleware
 * and initPerfLogging for the WHOLE app — not just for AI. Get it wrong and
 * dev-only instrumentation silently changes behaviour in production, which is a
 * far worse outcome than an untestable store.
 *
 * Two halves, and only one of them is testable from jest — said plainly so the
 * block below is not mistaken for proof of the other:
 *  - THE BUNDLER half — that rspack replaces `process.env.NODE_ENV` with a
 *    literal — cannot be observed from jest at all. It was established by
 *    reading the pinned @rsbuild/core 1.1.2 and @rspack/core 1.1.8 in this
 *    repo, with the file:line chain written out in
 *    providers/ReduxStore/index.js. No test here asserts it.
 *  - THE SOURCE half is this block: whatever string the bundler substitutes,
 *    only 'development' may switch the debug middleware on. A `buildMode()`
 *    that returned a constant, or read the wrong variable, fails here.
 */
describe('the store reads its build mode from NODE_ENV', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  const loadStoreWith = (nodeEnv) => {
    let store;
    jest.isolateModules(() => {
      process.env.NODE_ENV = nodeEnv;
      window.localStorage.setItem('gridman.debugRedux', '1');
      store = require('providers/ReduxStore').default;
    });
    return store;
  };

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    window.localStorage.removeItem('gridman.debugRedux');
    jest.restoreAllMocks();
  });

  it('attaches the debug middleware under development', () => {
    const store = loadStoreWith('development');
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    store.dispatch(toggleAiPanel());
    expect(debug).toHaveBeenCalled();
    store.dispatch(closeAiPanel());
  });

  it.each(['production', 'test'])('leaves the debug middleware off under %s', (nodeEnv) => {
    const store = loadStoreWith(nodeEnv);
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    store.dispatch(toggleAiPanel());
    expect(debug).not.toHaveBeenCalled();
    store.dispatch(closeAiPanel());
  });
});

/** The popout was cut from this pass — see AiChatSidebar/index.js. */
describe('no popout is shipped', () => {
  it('has no Popout or PopoutWindow component', () => {
    expect(() => require.resolve('./Popout')).toThrow();
    expect(() => require.resolve('./PopoutWindow')).toThrow();
  });
});
