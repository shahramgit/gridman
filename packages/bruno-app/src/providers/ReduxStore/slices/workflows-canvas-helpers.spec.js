import {
  buildPasteFragment,
  buildRunSeedVars,
  caretIndexFromOffset,
  collectClipboardPayload,
  describeDocChange,
  interpolateTemplate,
  isSuccessHttpStatus,
  resolveLoopPlan,
  resolveRequestOutcomePort,
  resolveScriptVars,
  shouldCoalesceHistoryEntry
} from './workflows-canvas-helpers';

const makeDoc = () => ({
  name: 'wf',
  nodes: [
    { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
    {
      id: 'req1',
      type: 'request',
      name: 'Login',
      position: { x: 200, y: 0 },
      pinned: true,
      ref: { collection: 'col', request: 'login.bru' },
      snapshotHash: 'abc',
      snapshot: { request: { method: 'POST' } }
    },
    { id: 'map1', type: 'map', name: 'Map', position: { x: 400, y: 0 }, mappings: [{ from: 'body', path: '$.token', target: 'token' }] },
    { id: 'cond1', type: 'condition', name: 'Check', position: { x: 600, y: 0 }, expression: 'res.status === 200' }
  ],
  connections: [
    { id: 'c1', source: 'start', sourcePort: 'main', target: 'req1' },
    { id: 'c2', source: 'req1', sourcePort: 'main', target: 'map1' },
    { id: 'c3', source: 'map1', sourcePort: 'main', target: 'cond1' }
  ]
});

describe('collectClipboardPayload', () => {
  it('copies the requested nodes and only the connections internal to the selection', () => {
    const payload = collectClipboardPayload(makeDoc(), ['req1', 'map1']);
    expect(payload.nodes.map((n) => n.id)).toEqual(['req1', 'map1']);
    // c1 (start->req1) and c3 (map1->cond1) cross the selection boundary
    expect(payload.connections.map((c) => c.id)).toEqual(['c2']);
  });

  it('never copies the Start node', () => {
    const payload = collectClipboardPayload(makeDoc(), ['start', 'req1']);
    expect(payload.nodes.map((n) => n.id)).toEqual(['req1']);
    expect(payload.connections).toEqual([]);
  });

  it('deep copies so later doc mutations do not leak into the clipboard', () => {
    const doc = makeDoc();
    const payload = collectClipboardPayload(doc, ['req1']);
    doc.nodes[1].snapshot.request.method = 'GET';
    expect(payload.nodes[0].snapshot.request.method).toBe('POST');
  });
});

describe('buildPasteFragment', () => {
  const generateId = (() => {
    let n = 0;
    return () => `new-${++n}`;
  })();

  it('remaps node uids and internal connection endpoints onto fresh ids', () => {
    const clipboard = collectClipboardPayload(makeDoc(), ['req1', 'map1']);
    const fragment = buildPasteFragment({ ...clipboard, generateId });

    expect(fragment.nodes).toHaveLength(2);
    const [reqCopy, mapCopy] = fragment.nodes;
    expect(reqCopy.id).not.toBe('req1');
    expect(mapCopy.id).not.toBe('map1');
    expect(fragment.idMap).toEqual({ req1: reqCopy.id, map1: mapCopy.id });

    expect(fragment.connections).toHaveLength(1);
    expect(fragment.connections[0].id).not.toBe('c2');
    expect(fragment.connections[0].source).toBe(reqCopy.id);
    expect(fragment.connections[0].target).toBe(mapCopy.id);
    expect(fragment.connections[0].sourcePort).toBe('main');
  });

  it('offsets positions by the given amount (default +32/+32)', () => {
    const clipboard = collectClipboardPayload(makeDoc(), ['req1']);
    const defaultOffset = buildPasteFragment({ ...clipboard, generateId });
    expect(defaultOffset.nodes[0].position).toEqual({ x: 232, y: 32 });

    const doubled = buildPasteFragment({ ...clipboard, offset: { x: 64, y: 64 }, generateId });
    expect(doubled.nodes[0].position).toEqual({ x: 264, y: 64 });
  });

  it('preserves request refs and snapshot/pin state on the copies', () => {
    const clipboard = collectClipboardPayload(makeDoc(), ['req1']);
    const fragment = buildPasteFragment({ ...clipboard, generateId });
    const copy = fragment.nodes[0];
    expect(copy.ref).toEqual({ collection: 'col', request: 'login.bru' });
    expect(copy.snapshotHash).toBe('abc');
    expect(copy.snapshot).toEqual({ request: { method: 'POST' } });
    expect(copy.pinned).toBe(true);
  });

  it('drops any start node and connections that reference nodes outside the fragment', () => {
    const fragment = buildPasteFragment({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'a', type: 'delay', name: 'Delay', position: { x: 10, y: 10 }, durationMs: 5 }
      ],
      connections: [{ id: 'x', source: 'start', sourcePort: 'main', target: 'a' }],
      generateId
    });
    expect(fragment.nodes).toHaveLength(1);
    expect(fragment.nodes[0].type).toBe('delay');
    expect(fragment.connections).toEqual([]);
  });
});

describe('describeDocChange', () => {
  it('flags a pure move and reports the moved node ids sorted', () => {
    const prev = makeDoc();
    const next = makeDoc();
    next.nodes[2].position = { x: 410, y: 12 };
    next.nodes[1].position = { x: 210, y: 12 };
    expect(describeDocChange(prev, next)).toEqual({ positionOnly: true, movedIds: ['map1', 'req1'] });
  });

  it('reports identical docs as a position-only change with no moved ids', () => {
    expect(describeDocChange(makeDoc(), makeDoc())).toEqual({ positionOnly: true, movedIds: [] });
  });

  it('is not position-only when anything else changes', () => {
    const renamed = makeDoc();
    renamed.nodes[1].name = 'Login v2';
    expect(describeDocChange(makeDoc(), renamed).positionOnly).toBe(false);

    const rewired = makeDoc();
    rewired.connections.pop();
    expect(describeDocChange(makeDoc(), rewired).positionOnly).toBe(false);

    const added = makeDoc();
    added.nodes.push({ id: 'd1', type: 'delay', name: 'Delay', position: { x: 0, y: 0 }, durationMs: 1 });
    expect(describeDocChange(makeDoc(), added).positionOnly).toBe(false);
  });
});

describe('caretIndexFromOffset', () => {
  // Monotonic mock: every character is exactly 10px wide.
  const measure = (s) => s.length * 10;

  it('clamps to 0 at or before the left edge', () => {
    expect(caretIndexFromOffset('hello', 0, measure)).toBe(0);
    expect(caretIndexFromOffset('hello', -25, measure)).toBe(0);
  });

  it('clamps to the text length past the right edge', () => {
    expect(caretIndexFromOffset('hello', 50, measure)).toBe(5);
    expect(caretIndexFromOffset('hello', 9999, measure)).toBe(5);
  });

  it('snaps to the nearest character boundary (midpoint rule)', () => {
    // char 1 spans 0..10 -> boundary flips at 5
    expect(caretIndexFromOffset('hello', 4.9, measure)).toBe(0);
    expect(caretIndexFromOffset('hello', 5, measure)).toBe(1);
    // char 3 spans 20..30 -> boundary flips at 25
    expect(caretIndexFromOffset('hello', 24, measure)).toBe(2);
    expect(caretIndexFromOffset('hello', 26, measure)).toBe(3);
  });

  it('works with a non-uniform monotonic width function', () => {
    // widths: 'a'=4, 'ab'=20, 'abc'=22
    const widths = new Map([['', 0], ['a', 4], ['ab', 20], ['abc', 22]]);
    const uneven = (s) => widths.get(s);
    expect(caretIndexFromOffset('abc', 1, uneven)).toBe(0); // < 2 (mid of 0..4)
    expect(caretIndexFromOffset('abc', 3, uneven)).toBe(1); // > 2, < 12 (mid of 4..20)
    expect(caretIndexFromOffset('abc', 15, uneven)).toBe(2); // > 12, < 21 (mid of 20..22)
    expect(caretIndexFromOffset('abc', 21.5, uneven)).toBe(3);
  });

  it('handles empty and nullish text', () => {
    expect(caretIndexFromOffset('', 25, measure)).toBe(0);
    expect(caretIndexFromOffset(null, 25, measure)).toBe(0);
    expect(caretIndexFromOffset(undefined, 25, measure)).toBe(0);
  });

  it('ignores a missing drop offset', () => {
    expect(caretIndexFromOffset('hello', NaN, measure)).toBe(0);
  });
});

describe('shouldCoalesceHistoryEntry', () => {
  const moveMeta = (at, movedIds = ['a', 'b']) => ({ positionOnly: true, movedIds, at });

  it('coalesces consecutive moves of the same node set within the window', () => {
    expect(shouldCoalesceHistoryEntry(moveMeta(1000), moveMeta(1800))).toBe(true);
    expect(shouldCoalesceHistoryEntry(moveMeta(1000), moveMeta(2000))).toBe(true);
  });

  it('does not coalesce outside the time window', () => {
    expect(shouldCoalesceHistoryEntry(moveMeta(1000), moveMeta(2001))).toBe(false);
  });

  it('does not coalesce moves of a different node set', () => {
    expect(shouldCoalesceHistoryEntry(moveMeta(1000, ['a']), moveMeta(1100, ['b']))).toBe(false);
    expect(shouldCoalesceHistoryEntry(moveMeta(1000, ['a']), moveMeta(1100, ['a', 'b']))).toBe(false);
  });

  it('does not coalesce non-move changes', () => {
    expect(shouldCoalesceHistoryEntry({ positionOnly: false, movedIds: [], at: 1000 }, moveMeta(1100))).toBe(false);
    expect(shouldCoalesceHistoryEntry(moveMeta(1000), { positionOnly: false, movedIds: [], at: 1100 })).toBe(false);
    expect(shouldCoalesceHistoryEntry(undefined, moveMeta(1100))).toBe(false);
  });

  it('respects a custom window', () => {
    expect(shouldCoalesceHistoryEntry(moveMeta(1000), moveMeta(1400), 300)).toBe(false);
    expect(shouldCoalesceHistoryEntry(moveMeta(1000), moveMeta(1200), 300)).toBe(true);
  });
});

// --- Postman-Flows-inspired batch: run-time decision logic ---

describe('buildRunSeedVars (scenario seeding)', () => {
  it('seeds from doc.inputs when no scenario is active', () => {
    const doc = { inputs: [{ name: 'env', value: 'dev' }, { name: 'n', value: '1' }] };
    expect(buildRunSeedVars(doc)).toEqual({ env: 'dev', n: '1' });
  });

  it('layers the active scenario over the inputs (scenario wins per key)', () => {
    const doc = {
      inputs: [{ name: 'env', value: 'dev' }, { name: 'keep', value: 'yes' }],
      scenarios: [{ name: 'prod', values: { env: 'prod', extra: 'x' } }],
      activeScenario: 'prod'
    };
    expect(buildRunSeedVars(doc)).toEqual({ env: 'prod', keep: 'yes', extra: 'x' });
  });

  it('ignores an active scenario that does not exist', () => {
    const doc = { inputs: [{ name: 'env', value: 'dev' }], scenarios: [], activeScenario: 'ghost' };
    expect(buildRunSeedVars(doc)).toEqual({ env: 'dev' });
  });

  it('returns an empty object for an empty doc', () => {
    expect(buildRunSeedVars(undefined)).toEqual({});
    expect(buildRunSeedVars({})).toEqual({});
  });
});

describe('resolveRequestOutcomePort (failure port routing)', () => {
  it('routes a success out the main port', () => {
    expect(resolveRequestOutcomePort({ ok: true, hasErrorConnection: true }))
      .toEqual({ port: 'main', stepStatus: 'passed', handled: false, halt: false });
  });

  it('routes a failure out the error port when wired (handled, no halt)', () => {
    expect(resolveRequestOutcomePort({ ok: false, hasErrorConnection: true }))
      .toEqual({ port: 'error', stepStatus: 'failed', handled: true, halt: false });
  });

  it('halts the run on a failure with no error wiring (legacy behavior)', () => {
    expect(resolveRequestOutcomePort({ ok: false, hasErrorConnection: false }))
      .toEqual({ port: null, stepStatus: 'failed', handled: false, halt: true });
  });
});

describe('isSuccessHttpStatus', () => {
  it('treats 2xx/3xx as success and everything else as failure', () => {
    expect([200, 201, 299, 300, 302, 399].map(isSuccessHttpStatus)).toEqual([true, true, true, true, true, true]);
    expect([100, 199, 400, 404, 500].map(isSuccessHttpStatus)).toEqual([false, false, false, false, false]);
  });
});

describe('resolveScriptVars', () => {
  it('merges a plain object result into flow vars', () => {
    expect(resolveScriptVars({ a: 1, b: 2 }, 'ignored')).toEqual({ a: 1, b: 2 });
  });

  it('stores a primitive under assignTo when set', () => {
    expect(resolveScriptVars('sig', 'signature')).toEqual({ signature: 'sig' });
    expect(resolveScriptVars(42, 'n')).toEqual({ n: 42 });
  });

  it('stores an array under assignTo (arrays are not plain-object merges)', () => {
    expect(resolveScriptVars([1, 2], 'list')).toEqual({ list: [1, 2] });
  });

  it('writes nothing for a primitive without assignTo, or for null/undefined', () => {
    expect(resolveScriptVars('x', '')).toEqual({});
    expect(resolveScriptVars(null, 'a')).toEqual({});
    expect(resolveScriptVars(undefined, 'a')).toEqual({});
  });
});

describe('interpolateTemplate', () => {
  it('resolves {{var}} placeholders and blanks missing ones', () => {
    expect(interpolateTemplate('{{a}}/{{b}}', { a: 'x', b: 'y' })).toBe('x/y');
    expect(interpolateTemplate('{{missing}}!', {})).toBe('!');
    expect(interpolateTemplate('n={{n}}', { n: 3 })).toBe('n=3');
  });
});

describe('resolveLoopPlan', () => {
  it('plans a count loop from a literal count', () => {
    expect(resolveLoopPlan({ mode: 'count', count: '3' }, {})).toEqual({ total: 3, items: null });
  });

  it('interpolates a {{template}} count against vars', () => {
    expect(resolveLoopPlan({ mode: 'count', count: '{{times}}' }, { times: 4 })).toEqual({ total: 4, items: null });
  });

  it('caps a count loop at maxIterations', () => {
    expect(resolveLoopPlan({ mode: 'count', count: '999', maxIterations: 10 }, {})).toEqual({ total: 10, items: null });
  });

  it('errors on a non-integer / negative count', () => {
    expect(resolveLoopPlan({ mode: 'count', count: 'abc' }, {}).error).toMatch(/not a non-negative integer/);
    expect(resolveLoopPlan({ mode: 'count', count: '-1' }, {}).error).toBeTruthy();
  });

  it('plans a list loop from an array flow var and caps it', () => {
    expect(resolveLoopPlan({ mode: 'list', source: 'xs' }, { xs: ['a', 'b'] })).toEqual({ total: 2, items: ['a', 'b'] });
    expect(resolveLoopPlan({ mode: 'list', source: 'xs', maxIterations: 1 }, { xs: ['a', 'b'] }))
      .toEqual({ total: 1, items: ['a', 'b'] });
  });

  it('errors when the list source is not an array', () => {
    expect(resolveLoopPlan({ mode: 'list', source: 'xs' }, { xs: 'nope' }).error).toMatch(/not an array/);
  });
});
