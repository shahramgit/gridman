const Store = require('electron-store');

const MAX_RUNS_PER_WORKFLOW = 20;

/**
 * Persists workflow run history in the app's user data directory (not in
 * the workspace, so Git stays free of run noise). Keyed by the workflow
 * file's absolute pathname.
 */
class WorkflowRunsStore {
  constructor() {
    this.store = new Store({
      name: 'workflow-runs',
      clearInvalidConfig: true
    });
  }

  // electron-store interprets dots as key paths; encode the pathname.
  keyFor(pathname) {
    return Buffer.from(String(pathname)).toString('base64');
  }

  listRuns(pathname) {
    const runs = this.store.get(`runs.${this.keyFor(pathname)}`);
    return Array.isArray(runs) ? runs : [];
  }

  appendRun(pathname, run) {
    const runs = this.listRuns(pathname);
    runs.unshift(run);
    const trimmed = runs.slice(0, MAX_RUNS_PER_WORKFLOW);
    this.store.set(`runs.${this.keyFor(pathname)}`, trimmed);
    return trimmed;
  }

  clearRuns(pathname) {
    this.store.delete(`runs.${this.keyFor(pathname)}`);
  }
}

module.exports = {
  WorkflowRunsStore,
  MAX_RUNS_PER_WORKFLOW
};
