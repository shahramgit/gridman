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
  writeWorkflowFile
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

  it('rejects paths escaping the workspace', async () => {
    await expect(buildRequestSnapshot({
      workspacePath,
      collectionRelPath: '../outside',
      requestRelPath: 'x.bru'
    })).rejects.toThrow(/inside the workspace/);
  });
});
