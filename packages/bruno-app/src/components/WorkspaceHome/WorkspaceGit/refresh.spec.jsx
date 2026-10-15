import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'providers/Theme';
import toast from 'react-hot-toast';
import WorkspaceGit from './index';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));

const workspace = { pathname: '/test/workspace', collections: [] };
const gitData = {
  isGitRepository: true,
  gitRootPath: workspace.pathname,
  currentBranch: 'main',
  hasCommits: true,
  hasUpstream: true,
  trackingBranch: 'origin/main',
  remotes: [{ name: 'origin', refs: { fetch: 'https://example.com/repo.git' } }]
};

beforeEach(() => {
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  window.ipcRenderer = {
    invoke: jest.fn(async (channel) => {
      if (channel === 'renderer:get-workspace-git-data') return gitData;
      if (channel === 'renderer:list-workspace-git-discards') return [];
      return {};
    }),
    on: jest.fn(),
    send: jest.fn(),
    removeListener: jest.fn()
  };
});

it.each(['Refresh status', 'Refresh'])('shares loading feedback and prevents repeat clicks from %s', async (label) => {
  render(<ThemeProvider><WorkspaceGit workspace={workspace} /></ThemeProvider>);
  const top = await screen.findByRole('button', { name: 'Refresh status' });
  const bottom = screen.getByRole('button', { name: 'Refresh', exact: true });
  await waitFor(() => expect(bottom).toBeEnabled());

  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  window.ipcRenderer.invoke.mockImplementation(async (channel) => {
    if (channel === 'renderer:get-workspace-git-data') return pending;
    return {};
  });
  window.ipcRenderer.invoke.mockClear();
  fireEvent.click(label === 'Refresh' ? bottom : top);

  expect(top).toBeDisabled();
  expect(bottom).toBeDisabled();
  expect(top.querySelector('.spinner-icon')).not.toBeNull();
  expect(bottom.querySelector('.spinner-icon')).not.toBeNull();
  fireEvent.click(top);
  fireEvent.click(bottom);
  expect(window.ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === 'renderer:get-workspace-git-data')).toHaveLength(1);

  await act(async () => finish(gitData));
  expect(top).toBeEnabled();
  expect(bottom).toBeEnabled();
});

it('clears both busy indicators after a failed remote refresh', async () => {
  render(<ThemeProvider><WorkspaceGit workspace={workspace} /></ThemeProvider>);
  const top = await screen.findByRole('button', { name: 'Refresh status' });
  const bottom = screen.getByRole('button', { name: 'Refresh', exact: true });
  await waitFor(() => expect(bottom).toBeEnabled());
  window.ipcRenderer.invoke.mockRejectedValueOnce(new Error('Remote unavailable'));
  fireEvent.click(top);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Remote unavailable'));
  expect(top).toBeEnabled();
  expect(bottom).toBeEnabled();
});
