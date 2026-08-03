import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'providers/Theme';
import IndexedCollectionItems from './IndexedCollectionItems';

// Render accounting for the indexed sidebar rows. Every row renders exactly one
// SearchHighlight (its name), so counting those renders counts row renders.
global.__rowRenders = [];
jest.mock('../SearchHighlight', () => ({
  __esModule: true,
  default: ({ text }) => {
    const ReactModule = require('react');
    global.__rowRenders.push(text);
    return ReactModule.createElement('span', null, text);
  }
}));

jest.mock('hooks/useKeybinding', () => ({
  __esModule: true,
  default: () => {}
}));

jest.mock('ui/MenuDropdown', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('components/Sidebar/SidebarAccordionContext', () => ({
  __esModule: true,
  useSidebarAccordion: () => ({ dropdownContainerRef: { current: null } })
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn(), custom: jest.fn() })
}));

// Modal children are never opened here; stub them so the spec doesn't drag in
// codemirror and the rest of the request-pane tree.
jest.mock('./CollectionItem/RenameCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/CloneCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/DeleteCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/RunCollectionItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/GenerateCodeItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/CollectionItemInfo', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/ExportFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('./CollectionItem/ExampleItem', () => ({ __esModule: true, default: () => null }));
jest.mock('./ImportIntoFolder', () => ({ __esModule: true, default: () => null }));
// The icon is a pure leaf here (and its module relies on the automatic JSX
// runtime, which this jest babel config does not use).
jest.mock('./CollectionItem/CollectionItemIcon', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/NewRequest', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/NewFolder', () => ({ __esModule: true, default: () => null }));
jest.mock('components/ResponsePane/NetworkError/index', () => ({ __esModule: true, default: () => null }));

// Pulls in xterm (and its raw .css) through the Devtools console tree.
jest.mock('utils/terminal', () => ({ openDevtoolsAndSwitchToTerminal: jest.fn() }));

beforeAll(() => {
  // jsdom implements neither; the reveal path calls scrollIntoView on the row.
  Element.prototype.scrollIntoView = jest.fn();
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
const COLLECTION_PATHNAME = '/w/col-1';

const FOLDER_UID = 'folder-0';

const buildIndex = (rowCount, { withFolder = false } = {}) => {
  const nodesByUid = {};
  const childrenByParentUid = {};
  const childUids = [];
  const uidByPathname = {};

  if (withFolder) {
    const folderPathname = `${COLLECTION_PATHNAME}/req-folder`;
    nodesByUid[FOLDER_UID] = {
      uid: FOLDER_UID,
      name: 'req-folder',
      pathname: folderPathname,
      type: 'folder',
      parentUid: null,
      depth: 0,
      seq: 1
    };
    childUids.push(FOLDER_UID);
    uidByPathname[folderPathname] = FOLDER_UID;
    childrenByParentUid[FOLDER_UID] = [];
    for (let i = 0; i < 2; i += 1) {
      const uid = `child-${i}`;
      const pathname = `${folderPathname}/req-child-${i}.bru`;
      nodesByUid[uid] = {
        uid,
        name: `req-child-${i}`,
        filename: `req-child-${i}.bru`,
        pathname,
        type: 'http',
        method: 'get',
        url: 'https://example.com',
        parentUid: FOLDER_UID,
        depth: 1,
        seq: i + 1
      };
      childrenByParentUid[FOLDER_UID].push(uid);
      uidByPathname[pathname] = uid;
    }
  }

  for (let i = 0; i < rowCount; i += 1) {
    const uid = `node-${i}`;
    const pathname = `${COLLECTION_PATHNAME}/req-${i}.bru`;
    nodesByUid[uid] = {
      uid,
      name: `req-${i}`,
      filename: `req-${i}.bru`,
      pathname,
      type: 'http',
      method: 'get',
      url: 'https://example.com',
      parentUid: null,
      depth: 0,
      seq: i + 1
    };
    childUids.push(uid);
    uidByPathname[pathname] = uid;
  }

  childrenByParentUid.root = childUids;

  return {
    status: 'ready',
    nodesByUid,
    childrenByParentUid,
    uidByPathname,
    totalNodes: Object.keys(nodesByUid).length
  };
};

const buildInitialState = (rowCount, indexOptions) => ({
  app: {
    sidebarReveal: null,
    clipboard: { hasCopiedItems: false }
  },
  collections: {
    collections: [{ uid: COLLECTION_UID, pathname: COLLECTION_PATHNAME, items: [] }],
    collectionIndexes: { [COLLECTION_UID]: buildIndex(rowCount, indexOptions) },
    loadedRequestsByPath: {}
  },
  tabs: { tabs: [], activeTabUid: null }
});

// Mirrors the two real reducers this component interacts with: both
// revealRequestInSidebar and clearSidebarReveal write a FRESH sidebarReveal
// object (see slices/app.js), which is exactly what the row subscription has to
// survive without re-rendering every mounted row.
const makeStore = (rowCount, indexOptions) =>
  configureStore({
    reducer: (state, action) => {
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
                ensureVisible: Boolean(action.payload.ensureVisible)
              }
            }
          };
        case 'app/clearSidebarReveal':
          return state.app.sidebarReveal
            ? { ...state, app: { ...state.app, sidebarReveal: { ...state.app.sidebarReveal, pending: false } } }
            : state;
        case 'tabs/setActiveTab':
          return { ...state, tabs: { ...state.tabs, activeTabUid: action.payload } };
        case 'test/setTabs':
          return { ...state, tabs: action.payload };
        case 'test/noop':
          return { ...state };
        default:
          return state || buildInitialState(rowCount, indexOptions);
      }
    },
    preloadedState: buildInitialState(rowCount, indexOptions),
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });

const renderRows = ({ rowCount, filterRowAllowance = null, withFolder = false }) => {
  const store = makeStore(rowCount, { withFolder });
  const utils = render(
    <Provider store={store}>
      <ThemeProvider>
        <DndProvider backend={HTML5Backend}>
          <IndexedCollectionItems
            collectionUid={COLLECTION_UID}
            searchText="req-"
            searchMatches={null}
            filterRowAllowance={filterRowAllowance}
            multiSelect={undefined}
          />
        </DndProvider>
      </ThemeProvider>
    </Provider>
  );
  return { store, ...utils };
};

const countRowsIn = (fn) => {
  global.__rowRenders = [];
  fn();
  const renders = global.__rowRenders;
  return { total: renders.length, distinct: new Set(renders).size };
};

let rafQueue = [];

beforeEach(() => {
  global.__rowRenders = [];
  rafQueue = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  window.requestAnimationFrame.mockRestore?.();
  window.cancelAnimationFrame.mockRestore?.();
});

const flushFrame = () => {
  const queued = rafQueue;
  rafQueue = [];
  act(() => {
    queued.forEach((cb) => cb(0));
  });
};

// Row-render counts measured against this harness, HEAD vs. the narrowed
// subscriptions + resolved isExpanded prop (20 mounted rows unless stated):
//   reveal + the clearSidebarReveal it triggers   60 renders / 20 rows -> 2 / 1
//   clearSidebarReveal on its own                 20 / 20              -> 0
//   activeTabUid change                           20 / 20              -> 2 / 2
//   folder collapse (5 mounted rows)               3 / 3               -> 1 / 1
//   "show more" click commit (300 rows, cap 10)  290 mounts            -> 60
describe('IndexedCollectionItems render cost', () => {
  it('a sidebar reveal only re-renders the revealed row', () => {
    const ROWS = 20;
    const { store } = renderRows({ rowCount: ROWS });
    expect(screen.getAllByTestId('sidebar-collection-item-row')).toHaveLength(ROWS);

    const rerenders = countRowsIn(() => {
      act(() => {
        store.dispatch({
          type: 'app/revealRequestInSidebar',
          payload: { collectionUid: COLLECTION_UID, pathname: `${COLLECTION_PATHNAME}/req-0.bru` }
        });
      });
    });

    // Only the revealed row (it renders twice: the reveal itself, then its
    // reveal-flash state).
    expect(rerenders.distinct).toBe(1);
    expect(rerenders.total).toBeLessThanOrEqual(2);
  });

  it('consuming a reveal (clearSidebarReveal) does not re-render any row', () => {
    const ROWS = 20;
    const { store } = renderRows({ rowCount: ROWS });

    act(() => {
      store.dispatch({
        type: 'app/revealRequestInSidebar',
        payload: { collectionUid: COLLECTION_UID, pathname: `${COLLECTION_PATHNAME}/req-0.bru` }
      });
    });

    const rerenders = countRowsIn(() => {
      act(() => {
        store.dispatch({ type: 'app/clearSidebarReveal' });
      });
    });

    expect(rerenders.total).toBe(0);
  });

  it('activating a tab only re-renders the rows whose active state changed', () => {
    const ROWS = 20;
    const { store } = renderRows({ rowCount: ROWS });

    act(() => {
      store.dispatch({
        type: 'test/setTabs',
        payload: {
          activeTabUid: 'tab-0',
          tabs: [
            { uid: 'tab-0', collectionUid: COLLECTION_UID, type: 'request', itemPathname: `${COLLECTION_PATHNAME}/req-0.bru` },
            { uid: 'tab-1', collectionUid: COLLECTION_UID, type: 'request', itemPathname: `${COLLECTION_PATHNAME}/req-1.bru` }
          ]
        }
      });
    });

    const rerenders = countRowsIn(() => {
      act(() => {
        store.dispatch({ type: 'tabs/setActiveTab', payload: 'tab-1' });
      });
    });

    // Only the previously active row and the newly active row change.
    expect(rerenders.distinct).toBeLessThanOrEqual(2);
    expect(rerenders.total).toBeLessThanOrEqual(2);
  });

  it('an unrelated dispatch re-renders no row', () => {
    const ROWS = 20;
    const { store } = renderRows({ rowCount: ROWS });

    const rerenders = countRowsIn(() => {
      act(() => {
        store.dispatch({ type: 'test/noop' });
      });
    });

    expect(rerenders.total).toBe(0);
  });

  it('collapsing a folder during a search hides its children and re-renders only that row', () => {
    const { container } = renderRows({ rowCount: 2, withFolder: true });
    // folder + its 2 children + 2 root requests
    expect(screen.getAllByTestId('sidebar-collection-item-row')).toHaveLength(5);
    const folderRow = container.querySelector(`[title="${COLLECTION_PATHNAME}/req-folder"]`);
    expect(folderRow.querySelector('.chevron-icon')).toHaveClass('rotate-90');

    const rerenders = countRowsIn(() => {
      fireEvent.click(folderRow.querySelector('.flex-grow'), { detail: 1 });
    });

    expect(screen.getAllByTestId('sidebar-collection-item-row')).toHaveLength(3);
    expect(folderRow.querySelector('.chevron-icon')).not.toHaveClass('rotate-90');
    // Only the folder row changed; the untouched sibling rows must not re-render.
    expect(rerenders.total).toBe(1);

    fireEvent.click(folderRow.querySelector('.flex-grow'), { detail: 1 });
    expect(screen.getAllByTestId('sidebar-collection-item-row')).toHaveLength(5);
    expect(folderRow.querySelector('.chevron-icon')).toHaveClass('rotate-90');
  });

  it('"show more matches" mounts the rest progressively, not in one commit', () => {
    const ROWS = 300;
    const CAP = 10;
    renderRows({ rowCount: ROWS, filterRowAllowance: CAP });
    expect(screen.getAllByTestId('sidebar-collection-item-row')).toHaveLength(CAP);

    const mountedInClickCommit = countRowsIn(() => {
      fireEvent.click(screen.getByTestId('filtered-rows-show-more'));
    });

    // The click commit must stay bounded — not ROWS - CAP rows at once.
    expect(mountedInClickCommit.total).toBeLessThan(ROWS - CAP);
    expect(screen.getAllByTestId('sidebar-collection-item-row').length).toBeLessThan(ROWS);

    // …and subsequent frames keep growing the list until everything is mounted.
    for (let frame = 0; frame < 40 && rafQueue.length; frame += 1) {
      flushFrame();
    }
    expect(screen.getAllByTestId('sidebar-collection-item-row')).toHaveLength(ROWS);
    expect(screen.queryByTestId('filtered-rows-show-more')).toBeNull();
  });
});
