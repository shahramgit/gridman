/* global __dirname */
const fs = require('fs');
const path = require('path');

/**
 * A WORKSPACE THAT CANNOT BE OPENED HAS TO REACH THE USER.
 *
 * Two channels carry that news and, until now, neither had a listener:
 * `main:workspace-config-conflicted` had been emitted by the workspace watcher
 * and by git.js since long before this and was heard by nobody, and
 * `main:workspace-open-failed` did not exist — the startup scan skipped a
 * broken workspace with a console line.
 *
 * The result was that a workspace.yml with conflict markers — a git-tracked
 * file, so an ordinary outcome of a merge or a branch switch — made the
 * workspace simply not appear.
 */

const APP = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');

const RENDERER = read('providers', 'App', 'useIpcEvents.js');
const ELECTRON = path.join(APP, '..', '..', 'bruno-electron', 'src');
const readElectron = (...p) => fs.readFileSync(path.join(ELECTRON, ...p), 'utf8');

const CHANNELS = ['main:workspace-open-failed', 'main:workspace-config-conflicted'];

describe('workspace failure reporting', () => {
  it.each(CHANNELS)('%s is emitted by the main process', (channel) => {
    const emitted = [
      readElectron('ipc', 'workspace.js'),
      readElectron('app', 'workspace-watcher.js'),
      readElectron('utils', 'git.js')
    ].join('\n');
    expect(emitted).toContain(`'${channel}'`);
  });

  it.each(CHANNELS)('%s has a renderer listener', (channel) => {
    expect(RENDERER).toContain(`ipcRenderer.on('${channel}'`);
  });

  it.each(CHANNELS)('%s is unsubscribed on teardown', (channel) => {
    // A listener that outlives its effect fires against a dead store.
    const declaration = new RegExp(`const (\\w+) = ipcRenderer\\.on\\('${channel}'`);
    const name = RENDERER.match(declaration)?.[1];
    expect(name).toBeTruthy();
    expect(RENDERER).toContain(`${name}();`);
  });
});
