import '@testing-library/jest-dom';
import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'providers/Theme';
import { configureStore } from '@reduxjs/toolkit';
import toast from 'react-hot-toast';
import RequestTab from './index';

// The shortcut handlers are the subject here; capture them instead of driving
// Mousetrap through jsdom.
const boundHandlers = {};
jest.mock('hooks/useKeybinding', () => ({
  __esModule: true,
  default: (action, handler, options) => {
    if (options?.enabled !== false) {
      boundHandlers[action] = handler;
    }
  }
}));

const mockSaveRequest = jest.fn(() => ({ type: 'saveRequest' }));
jest.mock('providers/ReduxStore/slices/collections/actions', () => ({
  saveRequest: (...args) => mockSaveRequest(...args),
  saveCollectionRoot: jest.fn(() => ({ type: 'saveCollectionRoot' })),
  saveFolderRoot: jest.fn(() => ({ type: 'saveFolderRoot' })),
  saveEnvironment: jest.fn(() => ({ type: 'saveEnvironment' })),
  saveCollectionSettings: jest.fn(() => ({ type: 'saveCollectionSettings' })),
  closeTabs: jest.fn(() => ({ type: 'closeTabs' })),
  revertRequestToLastCommit: jest.fn(() => ({ type: 'revertRequestToLastCommit' }))
}));

jest.mock('./GradientCloseButton', () => ({
  __esModule: true,
  default: () => <button type="button">close</button>
}));

jest.mock('ui/MenuDropdown', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() })
}));

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

// The map is module scoped, so a handler bound by one test would otherwise be
// re-run by the next one (jest's clearMocks does not touch it).
beforeEach(() => {
  Object.keys(boundHandlers).forEach((action) => delete boundHandlers[action]);
});

const collectionUid = 'col-1';
const pathname = '/home/user/collection/get users.bru';

const buildStore = (loadedRequestsByPath = {}) => configureStore({
  reducer: {
    app: (state = { preferences: {} }) => state,
    tabs: (state = { tabs: [], activeTabUid: 'tab-1' }) => state,
    collections: (state = { collections: [], loadedRequestsByPath }) => state,
    globalEnvironments: (state = { globalEnvironmentDraft: null }) => state
  }
});

const tab = { uid: 'tab-1', type: 'request', collectionUid, itemPathname: pathname };

const buildCollection = (item) => ({ uid: collectionUid, name: 'my collection', pathname: '/home/user/collection', items: [item] });

const renderTab = (collection, loadedRequestsByPath) => render(
  <Provider store={buildStore(loadedRequestsByPath)}>
    <ThemeProvider>
      <RequestTab tab={tab} collection={collection} tabIndex={0} collectionRequestTabs={[tab]} />
    </ThemeProvider>
  </Provider>
);

describe('RequestTab save shortcut', () => {
  it('should save a hydrated request with the resolved item uid', () => {
    const item = { uid: 'item-1', name: 'get users', type: 'http-request', pathname, request: { method: 'GET', url: 'https://x' } };
    renderTab(buildCollection(item));

    boundHandlers.save();

    expect(mockSaveRequest).toHaveBeenCalledWith('item-1', collectionUid);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a large file that was never parsed', { partial: true }],
    ['a request whose file is still being read', { loading: true }],
    ['an index-only placeholder', { gridmanIndexOnly: true }]
  ])('should refuse to save %s and say so', (_label, stubFlags) => {
    const item = {
      uid: 'item-1',
      name: 'get users',
      type: 'http-request',
      pathname,
      request: { method: 'GET', url: '' },
      ...stubFlags
    };
    renderTab(buildCollection(item));

    boundHandlers.save();

    expect(mockSaveRequest).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('This request isn\'t loaded yet — nothing was saved');
  });

  it.each([
    ['a large file that was never parsed', { partial: true }],
    ['a request whose file is still being read', { loading: true }]
  ])('should prefer the hydrated snapshot over %s in the tree', (_label, stubFlags) => {
    // parseBruFileMeta gives a stub a non-empty placeholder request, so the
    // readiness check has to look past `request` being present.
    const stub = {
      uid: 'item-1',
      name: 'get users',
      type: 'http-request',
      pathname,
      request: { method: '', url: '' },
      ...stubFlags
    };
    const hydrated = { uid: 'item-1-loaded', name: 'get users', type: 'http-request', pathname, request: { method: 'GET', url: 'https://x' } };
    renderTab(buildCollection(stub), { [collectionUid]: { [pathname]: hydrated } });

    boundHandlers.save();

    expect(mockSaveRequest).toHaveBeenCalledWith('item-1-loaded', collectionUid);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('should say the request is not loaded when nothing resolved at all', () => {
    // The strip renders tabs for collections that are not loaded yet, so the
    // tree item and the by-path snapshot are both missing.
    renderTab(null);

    boundHandlers.save();

    expect(mockSaveRequest).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('This request isn\'t loaded yet — nothing was saved');
  });

  it('should stay silent on a tab type that is not a request', () => {
    render(
      <Provider store={buildStore()}>
        <ThemeProvider>
          <RequestTab
            tab={{ uid: 'tab-1', type: 'collection-overview', collectionUid }}
            collection={buildCollection({ uid: 'item-1', pathname, request: {} })}
            tabIndex={0}
            collectionRequestTabs={[tab]}
          />
        </ThemeProvider>
      </Provider>
    );

    boundHandlers.save();

    expect(mockSaveRequest).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
