const {
  NODE_OUTPUT_PORTS,
  normalizeWorkflowDoc,
  evaluateWorkflowScript
} = require('../../src/workflows');

// Coverage for the Postman-Flows-inspired batch: request failure port,
// named scenarios, script node, and count-based loops. All schema changes are
// additive — old documents must round-trip unchanged.

const baseDoc = (overrides = {}) => ({
  version: 2,
  name: 'Flow',
  nodes: [{ id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } }],
  connections: [],
  ...overrides
});

describe('request failure (error) port', () => {
  it('declares an error output port for request nodes only', () => {
    expect(NODE_OUTPUT_PORTS.request).toEqual(['main', 'error']);
    expect(NODE_OUTPUT_PORTS.map).toEqual(['main']);
    expect(NODE_OUTPUT_PORTS.condition).toEqual(['true', 'false']);
  });

  it('keeps a connection wired from a request node error port', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'req', type: 'request', name: 'Login', position: { x: 1, y: 0 } },
        { id: 'handler', type: 'setvars', name: 'Handle', position: { x: 2, y: 0 } }
      ],
      connections: [{ source: 'req', sourcePort: 'error', target: 'handler' }]
    }));
    expect(doc.connections).toContainEqual(
      expect.objectContaining({ source: 'req', sourcePort: 'error', target: 'handler' })
    );
  });

  it('drops an error-port connection from a node type that has no error port', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'm', type: 'map', name: 'Map', position: { x: 1, y: 0 } },
        { id: 't', type: 'setvars', name: 'T', position: { x: 2, y: 0 } }
      ],
      connections: [{ source: 'm', sourcePort: 'error', target: 't' }]
    }));
    expect(doc.connections).toHaveLength(0);
  });
});

describe('scenarios', () => {
  it('normalizes scenarios and keeps a matching activeScenario', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      inputs: [{ name: 'env', value: 'dev' }],
      scenarios: [
        { name: 'staging', values: { env: 'staging', token: 'abc' } },
        { name: 'prod', values: { env: 'prod' } }
      ],
      activeScenario: 'prod'
    }));
    expect(doc.scenarios).toEqual([
      { name: 'staging', values: { env: 'staging', token: 'abc' } },
      { name: 'prod', values: { env: 'prod' } }
    ]);
    expect(doc.activeScenario).toBe('prod');
  });

  it('drops a stale activeScenario that names no existing scenario', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      scenarios: [{ name: 'staging', values: {} }],
      activeScenario: 'deleted-one'
    }));
    expect(doc.activeScenario).toBeUndefined();
  });

  it('defaults to an empty scenario list for documents without scenarios', () => {
    const doc = normalizeWorkflowDoc(baseDoc());
    expect(doc.scenarios).toEqual([]);
    expect('activeScenario' in doc).toBe(false);
  });

  it('discards non-object scenario entries', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      scenarios: [null, 'nope', { name: 'ok', values: { a: '1' } }]
    }));
    expect(doc.scenarios).toEqual([{ name: 'ok', values: { a: '1' } }]);
  });
});

describe('script node', () => {
  it('round-trips code and assignTo', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 's', type: 'script', name: 'Sign', code: 'return { sig: 1 }', assignTo: '  out  ', position: { x: 1, y: 0 } }
      ]
    }));
    const script = doc.nodes.find((n) => n.id === 's');
    expect(script.code).toBe('return { sig: 1 }');
    expect(script.assignTo).toBe('out'); // trimmed
    expect(NODE_OUTPUT_PORTS.script).toEqual(['main']);
  });

  it('normalizes non-string code to an empty string instead of crashing', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 's', type: 'script', name: 'S', code: { a: 1 }, position: { x: 1, y: 0 } }
      ]
    }));
    expect(doc.nodes.find((n) => n.id === 's').code).toBe('');
  });
});

describe('evaluateWorkflowScript (vm sandbox)', () => {
  it('evaluates a completion-value expression against res and vars', () => {
    const out = evaluateWorkflowScript('res.body.id + vars.suffix', {
      res: { body: { id: 'user' } },
      vars: { suffix: '-42' }
    });
    expect(out).toBe('user-42');
  });

  it('supports a top-level return that produces an object', () => {
    const out = evaluateWorkflowScript('return { doubled: vars.n * 2 }', { vars: { n: 21 } });
    expect(out).toEqual({ doubled: 42 });
  });

  it('serializes unserializable results to null rather than throwing', () => {
    const out = evaluateWorkflowScript('return function () {}', {});
    expect(out).toBeNull();
  });
});

describe('count-based loop', () => {
  it('keeps count mode with a string count and default itemVar', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'l', type: 'loop', name: 'Poll', mode: 'count', count: 5, position: { x: 1, y: 0 } }
      ]
    }));
    const loop = doc.nodes.find((n) => n.id === 'l');
    expect(loop.mode).toBe('count');
    expect(loop.count).toBe('5'); // coerced to string so {{templates}} round-trip
    expect(loop.itemVar).toBe('item');
  });

  it('preserves a {{template}} count and a breakExpr', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'l', type: 'loop', name: 'Poll', mode: 'count', count: '{{times}}', breakExpr: 'res.status === 200', position: { x: 1, y: 0 } }
      ]
    }));
    const loop = doc.nodes.find((n) => n.id === 'l');
    expect(loop.count).toBe('{{times}}');
    expect(loop.breakExpr).toBe('res.status === 200');
  });

  it('normalizes an unknown loop mode back to list (back-compat)', () => {
    const doc = normalizeWorkflowDoc(baseDoc({
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'l', type: 'loop', name: 'L', mode: 'wobble', source: 'items', position: { x: 1, y: 0 } }
      ]
    }));
    const loop = doc.nodes.find((n) => n.id === 'l');
    expect(loop.mode).toBe('list');
    expect(loop.source).toBe('items');
  });
});
