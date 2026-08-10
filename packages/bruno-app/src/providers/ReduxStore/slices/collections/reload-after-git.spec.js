/**
 * AFTER A GIT OPERATION, THE OPEN TABS HAVE TO CATCH UP.
 *
 * The watcher suppresses per-file events for the whole of a git operation and
 * reindexes once at the end. That reindex rebuilds the sidebar tree only, and
 * an open request panel renders from `loadedRequestsByPath` — so a discard or
 * pull left every open tab showing pre-operation content until the app was
 * restarted. Reported against 4.0.0-vasl.1 as "discard changes does nothing for
 * ~5 minutes and only applies after close and open".
 *
 * The second test is the one that must never be "fixed" by making it pass more
 * eagerly: a request with unsaved changes is left alone on purpose.
 */

const COLLECTION_UID = 'col-1';

// Drive the REAL loadRequest through a stubbed ipcRenderer rather than mocking
// the module's export: reloadOpenRequestsAfterGit calls loadRequest through
// module scope, so an export-level mock never reaches it and the first version
// of this suite hung against the unmocked one.
let invokeCalls = [];
beforeEach(() => {
  invokeCalls = [];
  window.ipcRenderer = {
    invoke: (channel, payload) => {
      invokeCalls.push({ channel, payload });
      return Promise.resolve({ meta: { collectionUid: COLLECTION_UID, pathname: payload.pathname } });
    }
  };
});
afterEach(() => {
  delete window.ipcRenderer;
});

const rereadPaths = () => invokeCalls
  .filter((c) => c.channel === 'renderer:load-request')
  .map((c) => c.payload.pathname);

const buildState = (loadedEntries, items = []) => ({
  collections: {
    collections: [{ uid: COLLECTION_UID, pathname: '/w/c', items }],
    loadedRequestsByPath: { [COLLECTION_UID]: loadedEntries }
  }
});

const { reloadOpenRequestsAfterGit } = require('./actions');

const runThunk = async (state) => {
  const dispatch = jest.fn((action) => (typeof action === 'function' ? action(dispatch, () => state) : action));
  await reloadOpenRequestsAfterGit({ collectionUid: COLLECTION_UID })(dispatch, () => state);
  return dispatch;
};

describe('reloadOpenRequestsAfterGit', () => {
  it('re-reads the requests the user has open', async () => {
    await runThunk(
      buildState({
        '/w/c/a.bru': { pathname: '/w/c/a.bru', request: { method: 'GET' } },
        '/w/c/b.bru': { pathname: '/w/c/b.bru', request: { method: 'POST' } }
      })
    );

    expect(rereadPaths().sort()).toEqual(['/w/c/a.bru', '/w/c/b.bru']);
  });

  it('leaves a request with unsaved changes alone', async () => {
    await runThunk(
      buildState({
        '/w/c/a.bru': { pathname: '/w/c/a.bru', request: { method: 'GET' }, draft: { request: {} } },
        '/w/c/b.bru': { pathname: '/w/c/b.bru', request: { method: 'POST' } }
      })
    );

    // Overwriting an in-progress edit because git touched the same file is data
    // loss; a stale buffer the user can close is the better failure.
    expect(rereadPaths()).toEqual(['/w/c/b.bru']);
  });

  it('respects a draft held on the tree item rather than the loaded entry', async () => {
    await runThunk(
      buildState(
        { '/w/c/a.bru': { pathname: '/w/c/a.bru', request: { method: 'GET' } } },
        [{ uid: 'i1', pathname: '/w/c/a.bru', type: 'http-request', request: {}, draft: { request: {} } }]
      )
    );

    // Once a request is open in a tab, that is where its draft lives.
    expect(rereadPaths()).toEqual([]);
  });

  it('does nothing for a collection with no open requests', async () => {
    await runThunk({ collections: { collections: [], loadedRequestsByPath: {} } });
    expect(rereadPaths()).toEqual([]);
  });
});
