import '@testing-library/jest-dom';
import React from 'react';
import { act, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'providers/Theme';
import Collection from './index';

// One Collection render === one render of its (stubbed) items child, so this
// counts renders of the whole collection block.
global.__collectionRenders = 0;
jest.mock('./IndexedCollectionItems', () => ({
  __esModule: true,
  default: () => {
    global.__collectionRenders += 1;
    return null;
  },
  sortIndexedChildren: jest.fn()
}));

// jest.config.js maps 'components/…', 'utils/…' etc. but not the bare 'src/…'
// alias rsbuild provides, so this import has to be mocked virtually.
jest.mock('src/selectors/tab', () => ({
  isTabForItemActive: () => () => false
}), { virtual: true });

jest.mock('hooks/useKeybinding', () => ({ __esModule: true, default: () => {} }));
jest.mock('ui/MenuDropdown', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/SidebarAccordionContext', () => ({
  __esModule: true,
  useSidebarAccordion: () => ({ dropdownContainerRef: { current: null } })
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() })
}));
jest.mock('utils/terminal', () => ({ openDevtoolsAndSwitchToTerminal: jest.fn() }));
jest.mock('components/Sidebar/NewRequest', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/NewFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('./ImportIntoFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('./RemoveCollection', () => ({ __esModule: true, default: () => null }));
jest.mock('./CloneCollection', () => ({ __esModule: true, default: () => null }));
jest.mock('./GenerateDocumentation', () => ({ __esModule: true, default: () => null }));
jest.mock('components/ShareCollection/index', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/CollectionItemDragPreview/index', () => ({
  __esModule: true,
  CollectionItemDragPreview: () => null
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

const COLLECTION_UID = 'col-1';
const OTHER_COLLECTION_UID = 'col-2';
const COLLECTION_PATHNAME = '/w/col-1';

const collection = {
  uid: COLLECTION_UID,
  name: 'my collection',
  pathname: COLLECTION_PATHNAME,
  collapsed: false,
  mountStatus: 'mounted',
  items: []
};

const initialState = {
  app: {
    sidebarReveal: null,
    clipboard: { hasCopiedItems: false },
    preferences: {}
  },
  collections: {
    collections: [collection],
    collectionIndexes: { [COLLECTION_UID]: { status: 'ready', nodesByUid: {}, childrenByParentUid: {}, totalNodes: 0 } }
  },
  tabs: { tabs: [], activeTabUid: null }
};

// Mirrors slices/app.js: both reveal writes replace the sidebarReveal object.
const makeStore = () => configureStore({
  reducer: (state = initialState, action) => {
    switch (action.type) {
      case 'app/revealRequestInSidebar':
        return {
          ...state,
          app: {
            ...state.app,
            sidebarReveal: {
              nonce: Date.now() + Math.random(),
              collectionUid: action.payload.collectionUid,
              pathname: action.payload.pathname,
              pending: true,
              ensureVisible: false
            }
          }
        };
      case 'app/clearSidebarReveal':
        return state.app.sidebarReveal
          ? { ...state, app: { ...state.app, sidebarReveal: { ...state.app.sidebarReveal, pending: false } } }
          : state;
      default:
        return state;
    }
  },
  preloadedState: initialState,
  middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
});

const renderCollection = () => {
  const store = makeStore();
  render(
    <Provider store={store}>
      <ThemeProvider>
        <DndProvider backend={HTML5Backend}>
          <Collection collection={collection} searchText="" />
        </DndProvider>
      </ThemeProvider>
    </Provider>
  );
  return store;
};

const countRendersIn = (fn) => {
  global.__collectionRenders = 0;
  fn();
  return global.__collectionRenders;
};

describe('Collection block render cost', () => {
  // A workspace has ~112 collection blocks mounted, so anything that re-renders
  // "every collection" costs 112x. A reveal aimed elsewhere must cost 0 here.
  it('does not re-render for a reveal aimed at another collection', () => {
    const store = renderCollection();

    const rerenders = countRendersIn(() => {
      act(() => {
        store.dispatch({
          type: 'app/revealRequestInSidebar',
          payload: { collectionUid: OTHER_COLLECTION_UID, pathname: '/w/col-2/req.bru' }
        });
      });
    });

    expect(rerenders).toBe(0);
  });

  it('does not re-render when a reveal aimed elsewhere is consumed', () => {
    const store = renderCollection();
    act(() => {
      store.dispatch({
        type: 'app/revealRequestInSidebar',
        payload: { collectionUid: OTHER_COLLECTION_UID, pathname: '/w/col-2/req.bru' }
      });
    });

    const rerenders = countRendersIn(() => {
      act(() => {
        store.dispatch({ type: 'app/clearSidebarReveal' });
      });
    });

    expect(rerenders).toBe(0);
  });

  it('still reacts to a reveal aimed at itself', () => {
    const store = renderCollection();

    const rerenders = countRendersIn(() => {
      act(() => {
        store.dispatch({
          type: 'app/revealRequestInSidebar',
          payload: { collectionUid: COLLECTION_UID, pathname: `${COLLECTION_PATHNAME}/req.bru` }
        });
      });
    });

    expect(rerenders).toBeGreaterThan(0);
  });
});
