import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'providers/Theme';
import appReducer from 'providers/ReduxStore/slices/app';
import collectionsReducer, {
  collectionIndexStarted,
  collectionIndexBatchReceived,
  collectionIndexReady
} from 'providers/ReduxStore/slices/collections';
import tabsReducer from 'providers/ReduxStore/slices/tabs';
import IndexedCollectionItems from './IndexedCollectionItems';

// The sibling delete spec runs a no-op reducer and a mocked action, so it
// proves the right action is dispatched but can never see whether the row
// actually leaves the screen. This one keeps the REAL reducers and the REAL
// deleteCollectionItemByPath; only the IPC round trip is stubbed.
//
// Written while chasing "delete in a folder does nothing until restart"
// (4.1.0-vasl.5). This half turned out to be sound — the row goes. The bug was
// the watcher re-adding the file afterwards; see bruno-electron
// tests/collections/delete-during-initial-scan.spec.js.

jest.mock('hooks/useKeybinding', () => ({ __esModule: true, default: () => {} }));
jest.mock('components/Sidebar/SidebarAccordionContext', () => ({
  __esModule: true,
  useSidebarAccordion: () => ({ dropdownContainerRef: { current: null } })
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn(), custom: jest.fn() })
}));
jest.mock('./CollectionItem/RenameCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/CloneCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/RunCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/GenerateCodeItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/CollectionItemInfo', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/ExportFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/ExampleItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./ImportIntoFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/CollectionItemIcon', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/NewRequest', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/NewFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('components/ResponsePane/NetworkError/index', () => ({ __esModule: true, default: () => null }));
jest.mock('utils/terminal', () => ({ openDevtoolsAndSwitchToTerminal: jest.fn() }));
jest.mock('react-virtuoso', () => ({
  __esModule: true,
  Virtuoso: ({ data, itemContent, computeItemKey }) => {
    const R = require('react');
    return R.createElement('div', null, (data || []).map((node, i) =>
      R.createElement(R.Fragment, { key: computeItemKey ? computeItemKey(i, node) : i }, itemContent(i, node))));
  }
}));

const mockCallIpc = jest.fn();
jest.mock('utils/common/ipc', () => ({
  ...jest.requireActual('utils/common/ipc'),
  callIpc: (...args) => mockCallIpc(...args)
}));

const COLLECTION_UID = 'col-1';
const COLLECTION_PATHNAME = '/w/nix/collections/001 (g_taminir)';
const FOLDER_PATH = `${COLLECTION_PATHNAME}/Api`;
const REQUEST_PATH = `${FOLDER_PATH}/serviceID-matching.bru`;
const SIBLING_PATH = `${FOLDER_PATH}/sibling.bru`;

const renderWithRealStore = () => {
  const store = configureStore({
    reducer: { app: appReducer, collections: collectionsReducer, tabs: tabsReducer },
    preloadedState: {
      collections: {
        ...collectionsReducer(undefined, { type: '@@init' }),
        collections: [{
          uid: COLLECTION_UID,
          name: '001 (g_taminir)',
          pathname: COLLECTION_PATHNAME,
          items: [],
          mountStatus: 'mounted',
          collapsed: false
        }]
      }
    },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });

  store.dispatch(collectionIndexStarted({ collectionUid: COLLECTION_UID, loadSessionId: 's1' }));
  store.dispatch(collectionIndexBatchReceived({
    collectionUid: COLLECTION_UID,
    loadSessionId: 's1',
    totalScanned: 3,
    nodes: [
      { uid: 'f-api', name: 'Api', pathname: FOLDER_PATH, type: 'folder', parentUid: null, depth: 0, seq: 1 },
      { uid: 'r-svc', name: 'serviceID-matching', pathname: REQUEST_PATH, type: 'http-request', method: 'POST', parentUid: 'f-api', depth: 1, seq: 1 },
      { uid: 'r-sib', name: 'sibling', pathname: SIBLING_PATH, type: 'http-request', method: 'GET', parentUid: 'f-api', depth: 1, seq: 2 }
    ]
  }));
  store.dispatch(collectionIndexReady({ collectionUid: COLLECTION_UID, loadSessionId: 's1', totalNodes: 3 }));

  render(
    <Provider store={store}>
      <ThemeProvider>
        <DndProvider backend={HTML5Backend}>
          <IndexedCollectionItems collectionUid={COLLECTION_UID} searchText="" searchMatches={null} />
        </DndProvider>
      </ThemeProvider>
    </Provider>
  );
  return store;
};

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener: jest.fn(), removeEventListener: jest.fn() }))
  });
  window.ipcRenderer = { invoke: jest.fn(async () => ({})), on: jest.fn(() => () => {}), send: jest.fn() };
});

beforeEach(() => {
  mockCallIpc.mockReset();
  mockCallIpc.mockImplementation(async (channel, payload) => {
    if (channel === 'renderer:delete-collection-item-by-path') {
      return { pathname: payload.sourcePathname, type: payload.type };
    }
    return {};
  });
});

it('a request deleted inside a folder leaves the sidebar without a restart', async () => {
  const store = renderWithRealStore();

  fireEvent.click(screen.getByText('Api'), { detail: 1 });
  expect(await screen.findByText('serviceID-matching')).toBeInTheDocument();

  fireEvent.contextMenu(screen.getByText('serviceID-matching'));
  fireEvent.click(screen.getAllByText('Delete').pop());
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).pop());
  });

  expect(mockCallIpc).toHaveBeenCalledWith(
    'renderer:delete-collection-item-by-path',
    expect.objectContaining({ sourcePathname: REQUEST_PATH })
  );

  const index = store.getState().collections.collectionIndexes[COLLECTION_UID];
  expect(Object.values(index.nodesByUid).map((node) => node.name).sort()).toEqual(['Api', 'sibling']);

  await waitFor(() => expect(screen.queryByText('serviceID-matching')).not.toBeInTheDocument());
  expect(screen.getByText('sibling')).toBeInTheDocument();
});
