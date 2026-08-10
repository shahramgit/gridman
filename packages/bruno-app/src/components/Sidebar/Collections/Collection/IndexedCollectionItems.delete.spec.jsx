import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'providers/Theme';
import IndexedCollectionItems from './IndexedCollectionItems';

/**
 * DELETE ON A NESTED FOLDER.
 *
 * Reported against 4.0.0-vasl.1: a collection can be removed, but Delete on a
 * folder inside a collection "does nothing". Unlike the sibling render spec
 * this one keeps the real MenuDropdown and the real DeleteCollectionItem — the
 * whole question is what those two do — and asserts on the dispatched action
 * rather than on the filesystem.
 */

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

// jsdom gives the scroller zero height, so the real Virtuoso renders no rows at
// all. The sibling render spec avoids this by staying in filter mode (which
// bypasses Virtuoso); this one is about the PLAIN tree, so render every item.
jest.mock('react-virtuoso', () => ({
  __esModule: true,
  Virtuoso: ({ data, itemContent, computeItemKey }) => {
    const R = require('react');
    return R.createElement(
      'div',
      null,
      (data || []).map((node, i) =>
        R.createElement(R.Fragment, { key: computeItemKey ? computeItemKey(i, node) : i }, itemContent(i, node)))
    );
  }
}));

const mockDeleteByPath = jest.fn(() => ({ type: 'noop/deleteCollectionItemByPath' }));
jest.mock('providers/ReduxStore/slices/collections/actions', () => ({
  ...jest.requireActual('providers/ReduxStore/slices/collections/actions'),
  deleteCollectionItemByPath: (...args) => mockDeleteByPath(...args),
  closeTabs: () => ({ type: 'noop/closeTabs' })
}));

const COLLECTION_UID = 'col-1';
const COLLECTION_PATHNAME = '/w/col-1';
const PARENT_UID = 'parent-folder';
const CHILD_FOLDER_UID = 'child-folder';
const PARENT_PATH = `${COLLECTION_PATHNAME}/Parent`;
const CHILD_PATH = `${PARENT_PATH}/Child`;

const index = {
  status: 'ready',
  nodesByUid: {
    [PARENT_UID]: { uid: PARENT_UID, name: 'Parent', pathname: PARENT_PATH, type: 'folder', parentUid: null, depth: 0, seq: 1 },
    [CHILD_FOLDER_UID]: {
      uid: CHILD_FOLDER_UID,
      name: 'Child',
      pathname: CHILD_PATH,
      type: 'folder',
      parentUid: PARENT_UID,
      depth: 1,
      seq: 1
    }
  },
  childrenByParentUid: { root: [PARENT_UID], [PARENT_UID]: [CHILD_FOLDER_UID], [CHILD_FOLDER_UID]: [] },
  uidByPathname: { [PARENT_PATH]: PARENT_UID, [CHILD_PATH]: CHILD_FOLDER_UID },
  totalNodes: 2
};

const dispatched = [];
const makeStore = () =>
  configureStore({
    reducer: (state = {
      app: { sidebarReveal: null, clipboard: { hasCopiedItems: false } },
      collections: {
        collections: [{ uid: COLLECTION_UID, pathname: COLLECTION_PATHNAME, items: [] }],
        collectionIndexes: { [COLLECTION_UID]: index },
        loadedRequestsByPath: {}
      },
      tabs: { tabs: [], activeTabUid: null }
    }, action) => {
      dispatched.push(action);
      return state;
    }
  });

const renderTree = () =>
  render(
    <Provider store={makeStore()}>
      <ThemeProvider>
        <DndProvider backend={HTML5Backend}>
          <IndexedCollectionItems collectionUid={COLLECTION_UID} searchText="" searchMatches={null} />
        </DndProvider>
      </ThemeProvider>
    </Provider>
  );

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({
      matches: false, media: query, addEventListener: jest.fn(), removeEventListener: jest.fn()
    }))
  });
});

beforeEach(() => {
  dispatched.length = 0;
  mockDeleteByPath.mockClear();
});

describe('deleting a folder nested inside another folder', () => {
  // Expansion is internal state, so the nested row only exists after a click.
  // detail: 1 matters — the row handler ignores anything else so a double
  // click does not also fire the single-click open.
  const expandParent = () => {
    fireEvent.click(screen.getByText('Parent'), { detail: 1 });
    return screen.getByText('Child');
  };

  it('renders the nested folder once its parent is expanded', () => {
    renderTree();
    expect(screen.getByText('Parent')).toBeInTheDocument();
    expect(expandParent()).toBeInTheDocument();
  });

  it('deletes the nested folder by its own pathname, not its parent\'s', () => {
    renderTree();
    expandParent();

    fireEvent.contextMenu(screen.getByText('Child'));
    const deleteEntry = screen.getAllByText('Delete').pop();
    fireEvent.click(deleteEntry);

    // The confirmation has to appear; "nothing happens" starts here if it does not.
    expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
    // A folder must be announced as a folder. It said "Delete Request",
    // which is the visible symptom of the misclassification below.
    expect(screen.getByText('Delete Folder')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).pop());

    expect(mockDeleteByPath).toHaveBeenCalledTimes(1);
    expect(mockDeleteByPath).toHaveBeenCalledWith(
      expect.objectContaining({ collectionUid: COLLECTION_UID, sourcePathname: CHILD_PATH, type: 'folder' })
    );
  });
});

/**
 * HIGHLIGHTING A FOLDER.
 *
 * Reported as "after closing search the folder is not highlighted, but an
 * endpoint is". Search was incidental — the active-tab selector returned null
 * for anything that was not a request, so no folder anywhere in the sidebar
 * ever showed as active, whether it was reached through search or by clicking.
 */
describe('the active folder row', () => {
  const renderWithActiveTab = (activeTabUid, tabs) =>
    render(
      <Provider
        store={configureStore({
          reducer: (state = {
            app: { sidebarReveal: null, clipboard: { hasCopiedItems: false } },
            collections: {
              collections: [{ uid: COLLECTION_UID, pathname: COLLECTION_PATHNAME, items: [] }],
              collectionIndexes: { [COLLECTION_UID]: index },
              loadedRequestsByPath: {}
            },
            tabs: { tabs, activeTabUid }
          }) => state
        })}
      >
        <ThemeProvider>
          <DndProvider backend={HTML5Backend}>
            <IndexedCollectionItems collectionUid={COLLECTION_UID} searchText="" searchMatches={null} />
          </DndProvider>
        </ThemeProvider>
      </Provider>
    );

  const rowOf = (label) => screen.getByText(label).closest('.collection-item-name');

  it('marks a folder whose settings tab is active', () => {
    renderWithActiveTab(PARENT_UID, [
      { uid: PARENT_UID, collectionUid: COLLECTION_UID, type: 'folder-settings', itemPathname: PARENT_PATH }
    ]);
    expect(rowOf('Parent')).toHaveClass('item-focused-in-tab');
  });

  it('does not mark a folder whose tab is merely open but not active', () => {
    // The positive control above would pass on a component that highlighted
    // every folder unconditionally; this is what makes it meaningful.
    renderWithActiveTab('some-other-tab', [
      { uid: PARENT_UID, collectionUid: COLLECTION_UID, type: 'folder-settings', itemPathname: PARENT_PATH }
    ]);
    expect(rowOf('Parent')).not.toHaveClass('item-focused-in-tab');
  });

  it('does not mark a folder from a different collection with the same uid', () => {
    renderWithActiveTab(PARENT_UID, [
      { uid: PARENT_UID, collectionUid: 'another-collection', type: 'folder-settings', itemPathname: PARENT_PATH }
    ]);
    expect(rowOf('Parent')).not.toHaveClass('item-focused-in-tab');
  });
});
