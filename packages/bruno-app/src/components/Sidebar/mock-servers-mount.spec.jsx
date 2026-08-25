/**
 * THE MOCK SERVER SECTION IS ACTUALLY MOUNTED, AND ONLY WHEN OPTED IN.
 *
 * Every unit test for a ported component can pass while nothing renders it —
 * which is exactly how an unreachable AI content type survived here for a
 * release. So this renders the REAL Sidebar and looks for the section, rather
 * than asserting on the source of the sections array.
 *
 * The second half matters as much as the first. A mock server binds a port and
 * answers HTTP requests; the main process refuses to start one unless
 * `beta.mock-server` is set, and the sidebar must not offer a button that the
 * back end will reject.
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';

jest.mock('hooks/useKeybinding', () => ({ __esModule: true, default: () => {} }));

// The section bodies have their own suites; markers keep the assertions about
// which sections are mounted. createElement rather than JSX because a
// jest.mock factory is hoisted above the imports in this file.
const sectionStub = (testId) => ({
  __esModule: true,
  default: () => require('react').createElement('div', { 'data-testid': testId })
});
jest.mock('./Sections/CollectionsSection/index', () => sectionStub('section-collections'));
jest.mock('./Sections/WorkflowsSection/index', () => sectionStub('section-workflows'));
jest.mock('./Sections/HistorySection/index', () => sectionStub('section-history'));
jest.mock('./Sections/ApiSpecsSection/index', () => sectionStub('section-api-specs'));
jest.mock('./Sections/MockServersSection/index', () => sectionStub('section-mock-servers'));

import Sidebar from './index';

const renderSidebar = ({ mockServerBeta }) => {
  const store = configureStore({
    reducer: {
      app: (
        state = {
          leftSidebarWidth: 260,
          sidebarCollapsed: false,
          isDragging: false,
          sidebarReveal: null,
          preferences: { features: { apiSpec: true }, beta: { 'mock-server': mockServerBeta } }
        }
      ) => state
    }
  });
  return render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <Sidebar />
      </ThemeProvider>
    </Provider>
  );
};

describe('the Mock Servers sidebar section', () => {
  it('is mounted when the beta flag is on', () => {
    renderSidebar({ mockServerBeta: true });
    expect(screen.getByTestId('section-mock-servers')).toBeInTheDocument();
  });

  it('is absent when the flag is off, which is the default', () => {
    renderSidebar({ mockServerBeta: false });
    expect(screen.queryByTestId('section-mock-servers')).not.toBeInTheDocument();
  });

  it('is absent when preferences carry no beta block at all', () => {
    // An existing install upgrading into this build has no `beta.mock-server`
    // key; it must read as off rather than as undefined-and-therefore-shown.
    const store = configureStore({
      reducer: {
        app: (state = {
          leftSidebarWidth: 260, sidebarCollapsed: false, isDragging: false, sidebarReveal: null,
          preferences: { features: { apiSpec: true } }
        }) => state
      }
    });
    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <Sidebar />
        </ThemeProvider>
      </Provider>
    );
    expect(screen.queryByTestId('section-mock-servers')).not.toBeInTheDocument();
  });

  it('does not disturb the sections that were already there', () => {
    renderSidebar({ mockServerBeta: false });
    for (const id of ['collections', 'workflows', 'history', 'api-specs']) {
      expect(screen.getByTestId(`section-${id}`)).toBeInTheDocument();
    }
  });
});
