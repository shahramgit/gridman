import { graphToSteps } from './graphToSteps';

/**
 * The inverse of the main process's `migrateStepsToGraph`.
 *
 * The load-bearing test is the last group: a graph the user wired in a way a
 * step list cannot express must report `exact: false`, because the assistant's
 * write path REPLACES the flow. Getting that wrong does not throw — it silently
 * deletes the branch the user built.
 */

const chain = (...types) => {
  const nodes = [{ id: 'start', type: 'start', name: 'Start' }];
  const connections = [];
  let prev = { id: 'start', port: 'main' };
  types.forEach((type, i) => {
    const id = `n${i}`;
    nodes.push({ id, type, name: `${type} ${i}`, ...(type === 'request' ? { ref: { collection: '/c', request: `/c/r${i}.bru` } } : {}) });
    connections.push({ id: `c${i}`, source: prev.id, sourcePort: prev.port, target: id });
    prev = { id, port: 'main' };
  });
  return { nodes, connections };
};

describe('linearising a graph the forward direction produced', () => {
  it('reads a straight chain in order', () => {
    const { steps, exact } = graphToSteps(chain('request', 'map', 'setvars'));
    expect(exact).toBe(true);
    expect(steps.map((s) => s.type)).toEqual(['request', 'map', 'setvars']);
    // The reference has to survive verbatim — it is how the step finds the file.
    expect(steps[0].ref).toEqual({ collection: '/c', request: '/c/r0.bru' });
  });

  it('reads a condition as a gate on the steps that follow it', () => {
    const doc = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'cond', type: 'condition', expression: '{{status}} === 200' },
        { id: 'inner', type: 'delay', durationMs: 500 }
      ],
      connections: [
        { source: 'start', sourcePort: 'main', target: 'cond' },
        { source: 'cond', sourcePort: 'true', target: 'inner' }
      ]
    };
    const { steps, exact } = graphToSteps(doc);
    expect(exact).toBe(true);
    // The delay is a SIBLING gated by the condition, not a nested body — that
    // is what migrateStepsToGraph builds and therefore what this must read.
    expect(steps.map((s) => s.type)).toEqual(['condition', 'delay']);
    expect(steps[0].steps).toBeUndefined();
    // No 'false' wire means the false branch stops.
    expect(steps[0].onFalse).toBe('stop');
  });

  it('reads a loop body and its back edge without looping forever', () => {
    const doc = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'loop', type: 'loop', mode: 'list', source: 'items', itemVar: 'item' },
        { id: 'body', type: 'request', ref: { collection: '/c', request: '/c/a.bru' } },
        { id: 'after', type: 'setvars', assignments: [] }
      ],
      connections: [
        { source: 'start', sourcePort: 'main', target: 'loop' },
        { source: 'loop', sourcePort: 'loop', target: 'body' },
        // The back edge the forward direction always emits.
        { source: 'body', sourcePort: 'main', target: 'loop' },
        { source: 'loop', sourcePort: 'done', target: 'after' }
      ]
    };
    const { steps, exact } = graphToSteps(doc);
    expect(exact).toBe(true);
    expect(steps.map((s) => s.type)).toEqual(['loop', 'setvars']);
    expect(steps[0].steps.map((s) => s.type)).toEqual(['request']);
    expect(steps[0].source).toBe('items');
  });
});

describe('a graph a step list cannot express', () => {
  it('refuses when a request error port is wired', () => {
    const doc = chain('request', 'map');
    doc.nodes.push({ id: 'handler', type: 'script', code: '' });
    doc.connections.push({ source: 'n0', sourcePort: 'error', target: 'handler' });

    const { exact, reason } = graphToSteps(doc);
    // Flattening this would drop the user's error handling without a word.
    expect(exact).toBe(false);
    expect(reason).toMatch(/error port/);
  });

  it('refuses when two branches join back together', () => {
    const doc = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'cond', type: 'condition', expression: 'x' },
        { id: 'a', type: 'delay', durationMs: 1 },
        { id: 'join', type: 'setvars', assignments: [] }
      ],
      connections: [
        { source: 'start', sourcePort: 'main', target: 'cond' },
        { source: 'cond', sourcePort: 'true', target: 'a' },
        { source: 'a', sourcePort: 'main', target: 'join' },
        { source: 'cond', sourcePort: 'false', target: 'join' }
      ]
    };
    const { exact } = graphToSteps(doc);
    expect(exact).toBe(false);
  });

  it('refuses when nodes sit off the main chain', () => {
    const doc = chain('request');
    doc.nodes.push({ id: 'orphan', type: 'delay', durationMs: 1 });
    const { exact, reason } = graphToSteps(doc);
    expect(exact).toBe(false);
    expect(reason).toMatch(/not on the main chain/);
  });

  it('does not count sticky notes as orphans', () => {
    // Notes are documentation with no ports; treating them as unreachable nodes
    // would make every annotated workflow permanently unwritable.
    const doc = chain('request');
    doc.nodes.push({ id: 'note', type: 'note', text: 'hello' });
    expect(graphToSteps(doc).exact).toBe(true);
  });

  it('reports no Start node rather than returning an empty flow', () => {
    const { exact, reason } = graphToSteps({ nodes: [{ id: 'a', type: 'delay' }], connections: [] });
    expect(exact).toBe(false);
    expect(reason).toMatch(/Start/);
  });
});

/**
 * THE TWO DIRECTIONS HAVE TO AGREE.
 *
 * This reaches across into the main process's real normaliser on purpose. The
 * forward direction (`migrateStepsToGraph`, via `normalizeWorkflowDoc`) is what
 * an accepted proposal is saved through, and this file is what the assistant
 * reads. If they drift, `read_workflow` describes a different flow than the one
 * on screen and the assistant edits something the user cannot see — which no
 * test of either side alone would catch.
 */
const { normalizeWorkflowDoc } = require('../../../../bruno-electron/src/workflows/index');

describe('steps -> graph -> steps round-trips', () => {
  const STEPS = [
    { type: 'request', name: 'Login', ref: { collection: '/c', request: '/c/login.bru' } },
    { type: 'map', name: 'Grab token', mappings: [{ from: 'body', path: 'data.token', target: 'token' }] },
    // No nested body: a condition gates the steps that FOLLOW it. This fixture
    // deliberately matches migrateStepsToGraph's real semantics rather than the
    // nesting an earlier version of this file assumed — that assumption is what
    // this round-trip caught.
    { type: 'condition', name: 'Got it?', expression: '{{token}}', onFalse: 'stop' },
    { type: 'setvars', name: 'Mark', assignments: [{ name: 'ok', value: 'yes' }] },
    {
      type: 'loop',
      name: 'Each user',
      mode: 'list',
      source: 'users',
      itemVar: 'user',
      steps: [
        { type: 'request', name: 'Fetch', ref: { collection: '/c', request: '/c/user.bru' } },
        { type: 'delay', name: 'Breathe', durationMs: 250 }
      ]
    },
    { type: 'script', name: 'Summarise', code: 'return 1;', assignTo: 'total' }
  ];

  it('survives a flow with a condition, a loop body and a script', () => {
    const doc = normalizeWorkflowDoc({ steps: STEPS });
    const back = graphToSteps(doc);

    expect(back.exact).toBe(true);
    expect(back.steps.map((s) => s.type)).toEqual(['request', 'map', 'condition', 'setvars', 'loop', 'script']);
    expect(back.steps[2].onFalse).toBe('stop');
    // A condition must NOT come back with a body it never had.
    expect(back.steps[2].steps).toBeUndefined();
    expect(back.steps[4].steps.map((s) => s.name)).toEqual(['Fetch', 'Breathe']);
    // The parts a step needs to actually run.
    expect(back.steps[0].ref).toEqual({ collection: '/c', request: '/c/login.bru' });
    expect(back.steps[1].mappings).toEqual([{ from: 'body', path: 'data.token', target: 'token' }]);
    expect(back.steps[4].source).toBe('users');
    expect(back.steps[5]).toMatchObject({ code: 'return 1;', assignTo: 'total' });
  });

  it('is stable on a second pass, so repeated AI edits do not drift', () => {
    const once = graphToSteps(normalizeWorkflowDoc({ steps: STEPS })).steps;
    const twice = graphToSteps(normalizeWorkflowDoc({ steps: once })).steps;
    expect(twice).toEqual(once);
  });
});
