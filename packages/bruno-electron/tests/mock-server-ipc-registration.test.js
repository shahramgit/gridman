const registered = [];
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel) => registered.push(channel),
    on: (channel) => registered.push(channel),
    emit: () => {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' }
}));

/**
 * THE MOCK IPC IS ACTUALLY REGISTERED.
 *
 * `registerMockServerIpc` being correct is not the same as it being called.
 * The module can be perfect and, if nothing in src/index.js invokes it, every
 * channel the renderer invokes rejects with "no handler registered" — the same
 * shape as the five events that were emitted to nobody in stage three.
 *
 * src/index.js cannot be imported under jest (it builds a BrowserWindow at
 * module scope), so this drives the registrar directly and separately checks
 * that index.js calls it.
 */
const fs = require('fs');
const path = require('path');

const registerMockServerIpc = require('../src/ipc/mock-server');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

describe('mock server IPC registration', () => {
  beforeAll(() => {
    registered.length = 0;
    registerMockServerIpc({ webContents: { send: () => {} }, isDestroyed: () => false });
  });

  it('registers the channels the renderer invokes', () => {
    for (const channel of [
      'renderer:mock-server-start',
      'renderer:mock-server-stop',
      'renderer:mock-server-save-instance',
      'renderer:mock-server-delete',
      'renderer:mock-server-save-response',
      'renderer:mock-server-try-request'
    ]) {
      expect(registered).toContain(channel);
    }
  });

  it('stops every server on quit, so a port is not left bound', () => {
    expect(registered).toContain('main:start-quit-flow');
  });

  it('is wired into the main entry point, not merely importable', () => {
    expect(MAIN).toContain(`require('./ipc/mock-server')`);
    expect(MAIN).toMatch(/registerMockServerIpc\(mainWindow\)/);
  });
});
