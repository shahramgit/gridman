jest.mock('electron-store', () => {
  return class MemoryStore {
    constructor() {
      this.data = {};
    }

    get(key) {
      return key.split('.').reduce((acc, part) => acc?.[part], this.data);
    }

    set(key, value) {
      const parts = key.split('.');
      let node = this.data;
      for (const part of parts.slice(0, -1)) {
        node[part] = node[part] || {};
        node = node[part];
      }
      node[parts.at(-1)] = value;
    }

    delete(key) {
      const parts = key.split('.');
      let node = this.data;
      for (const part of parts.slice(0, -1)) {
        node = node?.[part];
        if (!node) return;
      }
      delete node[parts.at(-1)];
    }
  };
});

const { WorkflowRunsStore, MAX_RUNS_PER_WORKFLOW } = require('../../src/store/workflow-runs');

describe('WorkflowRunsStore', () => {
  it('appends runs newest-first and caps the history', () => {
    const store = new WorkflowRunsStore();
    const pathname = '/ws/workflows/a.flow.yml';

    for (let i = 0; i < MAX_RUNS_PER_WORKFLOW + 5; i += 1) {
      store.appendRun(pathname, { startedAt: i, status: 'passed' });
    }

    const runs = store.listRuns(pathname);
    expect(runs).toHaveLength(MAX_RUNS_PER_WORKFLOW);
    expect(runs[0].startedAt).toBe(MAX_RUNS_PER_WORKFLOW + 4);
  });

  it('keys by pathname without dot-path collisions', () => {
    const store = new WorkflowRunsStore();
    store.appendRun('/a/b.flow.yml', { startedAt: 1 });
    store.appendRun('/a/c.flow.yml', { startedAt: 2 });

    expect(store.listRuns('/a/b.flow.yml')).toHaveLength(1);
    expect(store.listRuns('/a/c.flow.yml')).toHaveLength(1);
    expect(store.listRuns('/a/d.flow.yml')).toEqual([]);
  });
});
