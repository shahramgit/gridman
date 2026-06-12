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
      steps: [
        {
          id: 'step-1',
          type: 'request',
          name: snapshot.name,
          ref: { collection: collectionRelPath, request: requestRelPath },
          snapshotHash: hash,
          snapshot
        }
      ]
    });

    const workflows = await listWorkflows(workspacePath);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe('My Flow');

    // linked while the request is unchanged
    let result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.doc.steps).toHaveLength(1);
    expect(result.drift['step-1'].status).toBe('linked');

    // drifted after the request changes on disk
    fs.writeFileSync(requestPath, REQUEST_BRU.replace('{{userId}}', '{{accountId}}'));
    result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.drift['step-1'].status).toBe('drifted');

    // detached after the request is deleted; the snapshot survives
    fs.unlinkSync(requestPath);
    result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.drift['step-1'].status).toBe('detached');
    expect(JSON.stringify(result.doc.steps[0].snapshot)).toContain('{{baseUrl}}');
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
      steps: [{
        id: 's1',
        type: 'request',
        name: snapshot.name,
        ref: { collection: collectionRelPath, request: requestRelPath },
        snapshotHash: hash,
        snapshot: dirtySnapshot
      }]
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

  it('normalizes phase-2 step types and inputs', () => {
    const doc = normalizeWorkflowDoc({
      name: 'F',
      inputs: [{ name: 'env', value: 'dev' }, null, { name: '' }],
      steps: [
        { type: 'map', mappings: [{ from: 'weird', path: '$.x', target: 't' }, null] },
        { type: 'condition', expression: 'res.status === 200', onFalse: 'nonsense' },
        { type: 'delay', durationMs: 99999999 },
        { type: 'unknown-step' }
      ]
    });

    // blank-name rows survive (the editor adds empty rows the user fills in)
    expect(doc.inputs).toEqual([{ name: 'env', value: 'dev' }, { name: '', value: '' }]);
    expect(doc.steps).toHaveLength(3);
    expect(doc.steps[0].mappings).toEqual([{ from: 'body', path: '$.x', target: 't' }]);
    expect(doc.steps[1].onFalse).toBe('stop');
    expect(doc.steps[2].durationMs).toBe(5 * 60 * 1000);
  });

  it('normalizes loop steps, nests their bodies and rejects nested loops', () => {
    const doc = normalizeWorkflowDoc({
      name: 'L',
      steps: [
        {
          type: 'loop',
          source: 'items',
          maxIterations: 999999,
          steps: [
            { type: 'delay', durationMs: 50 },
            { type: 'loop', source: 'nested', steps: [] },
            { type: 'condition', expression: 'true' }
          ]
        }
      ]
    });

    expect(doc.steps).toHaveLength(1);
    const loop = doc.steps[0];
    expect(loop.type).toBe('loop');
    expect(loop.itemVar).toBe('item');
    expect(loop.maxIterations).toBe(1000);
    // nested loop is dropped; delay + condition survive
    expect(loop.steps.map((s) => s.type)).toEqual(['delay', 'condition']);
  });

  it('computes drift for request steps inside loop bodies', async () => {
    const pathname = await createWorkflow(workspacePath, 'LoopDrift');
    const { snapshot, hash, collectionRelPath, requestRelPath } = await snapshotRequestForWorkflow({
      workspacePath,
      collectionPathname: collectionPath,
      requestPathname: requestPath
    });

    await writeWorkflowFile(pathname, {
      name: 'LoopDrift',
      steps: [{
        id: 'loop-1',
        type: 'loop',
        source: 'items',
        steps: [{
          id: 'nested-req',
          type: 'request',
          name: snapshot.name,
          ref: { collection: collectionRelPath, request: requestRelPath },
          snapshotHash: hash,
          snapshot
        }]
      }]
    });

    const result = await readWorkflowWithDrift(workspacePath, pathname);
    expect(result.doc.steps[0].steps).toHaveLength(1);
    expect(result.drift['nested-req'].status).toBe('linked');
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
