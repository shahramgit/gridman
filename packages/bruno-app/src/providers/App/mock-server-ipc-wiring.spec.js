/* global __dirname */
const fs = require('fs');
const path = require('path');

/**
 * BOTH ENDS OF THE MOCK-SERVER IPC HAVE TO EXIST.
 *
 * The two halves live in different processes and neither imports the other, so
 * a channel can be emitted forever with nobody listening, or invoked forever
 * with nobody handling — silently, with no error anywhere. That is exactly
 * what shipped in stage three of this port: the workspace watcher emitted
 * add/change/delete for mocks/*.yml and the server emitted status and
 * request-log batches, and not one of those channels had a listener.
 *
 * These read the real sources and pin the contract in both directions.
 */

const APP = path.join(__dirname, '..', '..');
const ELECTRON = path.join(__dirname, '..', '..', '..', '..', 'bruno-electron', 'src');

const readAll = (dir, acc = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readAll(full, acc);
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.spec\./.test(entry.name)) acc.push(fs.readFileSync(full, 'utf8'));
  }
  return acc;
};

const APP_MOCK_SOURCES = [
  ...readAll(path.join(APP, 'components', 'MockServer')),
  ...readAll(path.join(APP, 'utils', 'mock-server')),
  ...readAll(path.join(APP, 'providers', 'ReduxStore', 'slices', 'mock-server')),
  fs.readFileSync(path.join(APP, 'providers', 'App', 'useIpcEvents.js'), 'utf8')
].join('\n');

const ELECTRON_MOCK_SOURCES = [
  ...readAll(path.join(ELECTRON, 'app', 'mock-server')),
  ...readAll(path.join(ELECTRON, 'ipc', 'mock-server')),
  fs.readFileSync(path.join(ELECTRON, 'app', 'workspace-watcher.js'), 'utf8')
].join('\n');

const unique = (matches) => [...new Set(matches)].sort();
const invokedChannels = unique([...APP_MOCK_SOURCES.matchAll(/invoke\('(renderer:mock-server[^']*)'/g)].map((m) => m[1]));
const handledChannels = unique([...ELECTRON_MOCK_SOURCES.matchAll(/ipcMain\.handle\('(renderer:mock-server[^']*)'/g)].map((m) => m[1]));
const emittedEvents = unique([...ELECTRON_MOCK_SOURCES.matchAll(/'(main:[a-z-]*mock[a-z-]*)'/g)].map((m) => m[1]));
const listenedEvents = unique([...APP_MOCK_SOURCES.matchAll(/ipcRenderer\.on\('(main:[a-z-]*mock[a-z-]*)'/g)].map((m) => m[1]));

describe('mock-server IPC is wired at both ends', () => {
  it('found channels to check, so this cannot pass by matching nothing', () => {
    expect(invokedChannels.length).toBeGreaterThan(10);
    expect(emittedEvents.length).toBeGreaterThan(3);
  });

  it.each(invokedChannels)('%s has a main-process handler', (channel) => {
    expect(handledChannels).toContain(channel);
  });

  it.each(emittedEvents)('%s has a renderer listener', (event) => {
    expect(listenedEvents).toContain(event);
  });

  it('has no handler for a channel nobody invokes', () => {
    // An orphan handler is dead code that reads as a working feature.
    expect(handledChannels.filter((c) => !invokedChannels.includes(c))).toEqual([]);
  });
});
