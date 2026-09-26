import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'providers/Theme';
import RequestTabs from './index';

// Reported against 4.1.0-vasl.5 with a screenshot: with many requests open,
// Overview / Environments / Git scrolled out of reach and users paged back
// through every tab to get to them.

jest.mock('./RequestTab', () => ({
  __esModule: true,
  default: ({ tab, tabIndex, collectionRequestTabs }) => (
    <span data-testid={`tab-${tab.uid}`} data-index={tabIndex} data-group-size={collectionRequestTabs.length}>
      {tab.uid}
    </span>
  )
}));
jest.mock('./CollectionHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('components/CreateTransientRequest', () => ({ __esModule: true, default: () => null }));
jest.mock('components/Sidebar/NewRequest', () => ({ __esModule: true, default: () => null }));

const WORKSPACE_TABS = [
  { uid: 'overview', collectionUid: 'scratch', type: 'workspaceOverview' },
  { uid: 'environments', collectionUid: 'scratch', type: 'workspaceEnvironments' },
  { uid: 'git', collectionUid: 'scratch', type: 'workspaceGit' }
];
const REQUEST_TABS = Array.from({ length: 12 }, (_, i) => ({ uid: `req-${i}`, collectionUid: 'c1', type: 'request' }));

const renderStrip = (tabs) => {
  const store = configureStore({
    reducer: (state = {
      tabs: { tabs, activeTabUid: 'req-11' },
      collections: { collections: [{ uid: 'c1', name: 'nix', items: [] }, { uid: 'scratch', name: 'scratch', items: [] }] },
      app: { leftSidebarWidth: 250, sidebarCollapsed: false, screenWidth: 1400 },
      workspaces: { workspaces: [], activeWorkspaceUid: null }
    }) => state
  });
  return render(
    <Provider store={store}>
      <ThemeProvider>
        <DndProvider backend={HTML5Backend}>
          <RequestTabs />
        </DndProvider>
      </ThemeProvider>
    </Provider>
  );
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener: jest.fn(), removeEventListener: jest.fn() }))
  });
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

it('keeps the workspace tabs outside the scrolling request strip', () => {
  const { container } = renderStrip([WORKSPACE_TABS[0], ...REQUEST_TABS.slice(0, 6), WORKSPACE_TABS[1], ...REQUEST_TABS.slice(6), WORKSPACE_TABS[2]]);

  const pinned = screen.getByTestId('pinned-workspace-tabs');
  const scroller = container.querySelector('.tabs-scroll-container');

  expect(within(pinned).getAllByTestId(/^tab-/).map((node) => node.textContent)).toEqual(['overview', 'environments', 'git']);
  expect(scroller).not.toContainElement(pinned);
  expect(within(scroller).getAllByTestId(/^tab-/)).toHaveLength(12);
  expect(within(scroller).queryByTestId('tab-overview')).toBeNull();
});

it('gives each group its own list, so close-left/right/others stay inside it', () => {
  renderStrip([...WORKSPACE_TABS, ...REQUEST_TABS]);

  expect(screen.getByTestId('tab-git')).toHaveAttribute('data-group-size', '3');
  expect(screen.getByTestId('tab-req-0')).toHaveAttribute('data-group-size', '12');
  expect(screen.getByTestId('tab-req-0')).toHaveAttribute('data-index', '0');
});

it('renders no pinned group when none of the workspace pages are open', () => {
  renderStrip(REQUEST_TABS);
  expect(screen.queryByTestId('pinned-workspace-tabs')).toBeNull();
});
