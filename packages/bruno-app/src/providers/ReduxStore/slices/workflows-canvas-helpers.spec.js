import {
  buildPasteFragment,
  collectClipboardPayload,
  describeDocChange,
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
