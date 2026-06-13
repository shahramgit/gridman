const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildRequestSnapshot,
  snapshotRequestForWorkflow,
  hashSnapshot,
  listWorkflows,
  readWorkflowWithDrift,
  createWorkflow,
  writeWorkflowFile,
  normalizeWorkflowDoc,
  evaluateWorkflowExpression
} = require('../../src/workflows');

const requestNode = (id, ref, snapshot, hash) => ({
  id,
  type: 'request',
  name: snapshot.name,
  position: { x: 320, y: 200 },
  ref,
  snapshotHash: hash,
  snapshot
});

const REQUEST_BRU = `meta {
  name: Get User
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/users/{{userId}}
  body: none
  auth: none
}

headers {
  x-api-key: {{apiKey}}
}
`;

describe('workflows', () => {
  let workspacePath;
  let collectionPath;
  let requestPath;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-wf-'));
    collectionPath = path.join(workspacePath, 'collections', 'c1');
    fs.mkdirSync(path.join(collectionPath, 'api'), { recursive: true });
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'c1', type: 'collection' }));
    requestPath = path.join(collectionPath, 'api', 'get-user.bru');
    fs.writeFileSync(requestPath, REQUEST_BRU);
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('snapshots keep raw templates and never interpolated values', async () => {
    const result = await buildRequestSnapshot({
      workspacePath,
      collectionRelPath: 'collections/c1',
      requestRelPath: 'api/get-user.bru'
    });

    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).toContain('{{baseUrl}}');
    expect(serialized).toContain('{{apiKey}}');
    expect(result.snapshot.name).toBe('Get User');
    expect(result.snapshot.request.method).toBe('GET');
  });

  it('resolves portable refs from absolute paths', async () => {
    const result = await snapshotRequestForWorkflow({
      workspacePath,
      collectionPathname: collectionPath,
      requestPathname: requestPath
    });

    expect(result.collectionRelPath).toBe('collections/c1');
    expect(result.requestRelPath).toBe('api/get-user.bru');
  });

  it('hash is stable regardless of key order', () => {
    expect(hashSnapshot({ a: 1, b: { c: 2, d: 3 } })).toBe(hashSnapshot({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashSnapshot({ a: 1 })).not.toBe(hashSnapshot({ a: 2 }));
  });

  it('create + list + read roundtrip with drift states', async () => {
    const pathname = await createWorkflow(workspacePath, 'My Flow');
    const { snapshot, hash, collectionRelPath, requestRelPath } = await snapshotRequestForWorkflow({
      workspacePath,
      collectionPathname: collectionPath,
      requestPathname: requestPath
    });

    await writeWorkflowFile(pathname, {
      name: 'My Flow',
      nodes: [requestNode('node-1', { collection: collectionRelPath, request: requestRelPath }, snapshot, hash)],
      connections: []
    });

    const workflows = await listWorkflows(workspacePath);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe('My Flow');

    // linked while the request is unchanged (Start node is auto-added)
    let result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.doc.nodes.some((n) => n.type === 'start')).toBe(true);
    expect(result.doc.nodes.find((n) => n.id === 'node-1')).toBeTruthy();
    expect(result.drift['node-1'].status).toBe('linked');

    // drifted after the request changes on disk
    fs.writeFileSync(requestPath, REQUEST_BRU.replace('{{userId}}', '{{accountId}}'));
    result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.drift['node-1'].status).toBe('drifted');

    // detached after the request is deleted; the snapshot survives
    fs.unlinkSync(requestPath);
    result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.drift['node-1'].status).toBe('detached');
    expect(JSON.stringify(result.doc.nodes.find((n) => n.id === 'node-1').snapshot)).toContain('{{baseUrl}}');
  });

  it('snapshots stay linked after a yaml roundtrip even with undefined fields', async () => {
    const pathname = await createWorkflow(workspacePath, 'Roundtrip');
    const { snapshot, hash, collectionRelPath, requestRelPath } = await snapshotRequestForWorkflow({
      workspacePath,
      collectionPathname: collectionPath,
      requestPathname: requestPath
    });

    // simulate parser artifacts that yaml cannot represent
    const dirtySnapshot = { ...snapshot, settings: { ...snapshot.settings, ghost: undefined } };

    await writeWorkflowFile(pathname, {
      name: 'Roundtrip',
      nodes: [requestNode('s1', { collection: collectionRelPath, request: requestRelPath }, dirtySnapshot, hash)],
      connections: []
    });

    const result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.drift['s1'].status).toBe('linked');
  });

  it('yml-format requests hash deterministically despite parser-generated uids', async () => {
    const { stringifyRequest } = require('@usebruno/filestore');
    const ymlCollectionPath = path.join(workspacePath, 'collections', 'c-yml');
    fs.mkdirSync(ymlCollectionPath, { recursive: true });
    fs.writeFileSync(path.join(ymlCollectionPath, 'opencollection.yml'), 'name: c-yml\n');
    const content = await stringifyRequest({
      name: 'y',
      type: 'http-request',
      seq: 1,
      request: {
        url: 'http://h/p?a=1',
        method: 'GET',
        headers: [{ name: 'h1', value: 'v1', enabled: true }],
        params: [{ name: 'a', value: '1', type: 'query', enabled: true }],
        body: { mode: 'none' },
        auth: { mode: 'none' }
      }
    }, { format: 'yml' });
    fs.writeFileSync(path.join(ymlCollectionPath, 'y.yml'), content);

    const first = await buildRequestSnapshot({
      workspacePath,
      collectionRelPath: 'collections/c-yml',
      requestRelPath: 'y.yml'
    });
    const second = await buildRequestSnapshot({
      workspacePath,
      collectionRelPath: 'collections/c-yml',
      requestRelPath: 'y.yml'
    });

    expect(first.hash).toBe(second.hash);
    expect(JSON.stringify(first.snapshot)).not.toContain('"uid"');
  });

  it('normalizes v2 node types, inputs and connections', () => {
    const doc = normalizeWorkflowDoc({
      version: 2,
      name: 'F',
      inputs: [{ name: 'env', value: 'dev' }, null, { name: '' }],
      nodes: [
        { id: 'm', type: 'map', mappings: [{ from: 'weird', path: '$.x', target: 't' }, null] },
        { id: 'c', type: 'condition', expression: 'res.status === 200' },
        { id: 'd', type: 'delay', durationMs: 99999999 },
        { id: 'bad', type: 'unknown-node' }
      ],
      connections: [
        { source: 'm', sourcePort: 'main', target: 'c' },
        { source: 'm', sourcePort: 'main', target: 'd' }, // dup port -> dropped
        { source: 'c', sourcePort: 'nope', target: 'd' }, // invalid port -> dropped
        { source: 'c', sourcePort: 'false', target: 'd' }
      ]
    });

    // blank-name input rows survive
    expect(doc.inputs).toEqual([{ name: 'env', value: 'dev' }, { name: '', value: '' }]);
    // unknown node dropped; Start node auto-added
    expect(doc.nodes.some((n) => n.type === 'start')).toBe(true);
    expect(doc.nodes.find((n) => n.id === 'bad')).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === 'm').mappings).toEqual([{ from: 'body', path: '$.x', target: 't' }]);
    expect(doc.nodes.find((n) => n.id === 'c').onFalse).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === 'd').durationMs).toBe(5 * 60 * 1000);
    // one connection per (source, port); invalid port dropped
    expect(doc.connections.filter((c) => c.source === 'm')).toHaveLength(1);
    expect(doc.connections.filter((c) => c.source === 'c')).toHaveLength(1);
    expect(doc.connections.find((c) => c.source === 'c').sourcePort).toBe('false');
  });

  it('migrates a v1 ordered-steps document (with a loop) into a connected graph', () => {
    const doc = normalizeWorkflowDoc({
      name: 'Legacy',
      steps: [
        { id: 'req', type: 'request', name: 'r', ref: { collection: 'c', request: 'r.bru' }, snapshot: { name: 'r', type: 'http-request', request: {} }, snapshotHash: 'h' },
        { id: 'lp', type: 'loop', source: 'items', steps: [{ id: 'body', type: 'delay', durationMs: 10 }] },
        { id: 'tail', type: 'delay', durationMs: 5 }
      ]
    });

    expect(doc.version).toBe(2);
    const ids = doc.nodes.map((n) => n.type === 'start' ? 'start' : n.id);
    expect(ids).toEqual(expect.arrayContaining(['start', 'req', 'lp', 'body', 'tail']));

    const start = doc.nodes.find((n) => n.type === 'start');
    const edge = (source, port) => doc.connections.find((c) => c.source === source && c.sourcePort === port)?.target;
    expect(edge(start.id, 'main')).toBe('req');
    expect(edge('req', 'main')).toBe('lp');
    expect(edge('lp', 'loop')).toBe('body');
    expect(edge('body', 'main')).toBe('lp'); // body wires back to advance the loop
    expect(edge('lp', 'done')).toBe('tail');
  });

  it('computes drift for request nodes in a graph', async () => {
    const pathname = await createWorkflow(workspacePath, 'GraphDrift');
    const { snapshot, hash, collectionRelPath, requestRelPath } = await snapshotRequestForWorkflow({
      workspacePath,
      collectionPathname: collectionPath,
      requestPathname: requestPath
    });

    await writeWorkflowFile(pathname, {
      name: 'GraphDrift',
      nodes: [requestNode('req-1', { collection: collectionRelPath, request: requestRelPath }, snapshot, hash)],
      connections: []
    });

    const result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.drift['req-1'].status).toBe('linked');
  });

  it('evaluates condition expressions against res and vars', () => {
    const res = { status: 200, headers: { 'x-a': '1' }, body: { ok: true } };
    expect(evaluateWorkflowExpression('res.status === 200 && res.body.ok', { res, vars: {} })).toBe(true);
    expect(evaluateWorkflowExpression('vars.token', { res, vars: { token: '' } })).toBe(false);
    expect(evaluateWorkflowExpression('vars.count > 2', { res, vars: { count: 5 } })).toBe(true);
    expect(() => evaluateWorkflowExpression('not valid js (', {})).toThrow();
  });

  it('rejects paths escaping the workspace', async () => {
    await expect(buildRequestSnapshot({
      workspacePath,
      collectionRelPath: '../outside',
      requestRelPath: 'x.bru'
    })).rejects.toThrow(/inside the workspace/);
  });
});
