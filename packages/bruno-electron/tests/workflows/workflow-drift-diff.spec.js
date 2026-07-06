const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildRequestSnapshot,
  computeWorkflowNodeDriftDiff,
  createWorkflow,
  diffSnapshots,
  readWorkflowWithDrift,
  snapshotRequestForWorkflow,
  writeWorkflowFile
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

describe('diffSnapshots (pure)', () => {
  it('returns an empty diff for identical documents (key order irrelevant)', () => {
    const a = { name: 'r', request: { url: 'http://x', headers: [{ name: 'h', value: 'v' }] } };
    const b = { request: { headers: [{ name: 'h', value: 'v' }], url: 'http://x' }, name: 'r' };
    expect(diffSnapshots(a, b)).toEqual([]);
  });

  it('reports changed values at nested paths', () => {
    const before = { request: { url: 'http://a', auth: { mode: 'none' } } };
    const after = { request: { url: 'http://b', auth: { mode: 'bearer' } } };
    expect(diffSnapshots(before, after)).toEqual([
      { path: 'request.auth.mode', kind: 'changed', before: 'none', after: 'bearer' },
      { path: 'request.url', kind: 'changed', before: 'http://a', after: 'http://b' }
    ]);
  });

  it('reports added and removed keys at nested paths', () => {
    const before = { request: { script: { req: 'x', res: 'y' } } };
    const after = { request: { script: { res: 'y' }, docs: 'hello' } };
    const entries = diffSnapshots(before, after);
    expect(entries).toContainEqual({ path: 'request.docs', kind: 'added', before: null, after: 'hello' });
    expect(entries).toContainEqual({ path: 'request.script.req', kind: 'removed', before: 'x', after: null });
  });

  it('reports a fully removed subtree as one entry at its root', () => {
    const entries = diffSnapshots({ request: { script: { req: 'x' } } }, { request: {} });
    expect(entries).toEqual([
      { path: 'request.script', kind: 'removed', before: '{"req":"x"}', after: null }
    ]);
  });

  it('walks arrays by index and previews added/removed subtrees', () => {
    const before = { request: { headers: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] } };
    const after = { request: { headers: [{ name: 'a', value: 'CHANGED' }] } };
    const entries = diffSnapshots(before, after);
    expect(entries).toContainEqual({
      path: 'request.headers[0].value',
      kind: 'changed',
      before: '1',
      after: 'CHANGED'
    });
    // whole element removed -> single entry with a stringified preview
    const removed = entries.find((entry) => entry.path === 'request.headers[1]');
    expect(removed.kind).toBe('removed');
    expect(removed.before).toContain('"name":"b"');
    expect(removed.after).toBeNull();

    // and the reverse direction reports it as added
    const reversed = diffSnapshots(after, before);
    const added = reversed.find((entry) => entry.path === 'request.headers[1]');
    expect(added.kind).toBe('added');
    expect(added.after).toContain('"value":"2"');
  });

  it('treats a container/primitive shape change as changed', () => {
    const entries = diffSnapshots({ body: { mode: 'json' } }, { body: 'raw' });
    expect(entries).toEqual([
      { path: 'body', kind: 'changed', before: '{"mode":"json"}', after: 'raw' }
    ]);
  });

  it('caps values at 500 chars with an ellipsis', () => {
    const long = 'x'.repeat(600);
    const [entry] = diffSnapshots({ body: 'short' }, { body: long });
    expect(entry.after).toHaveLength(501);
    expect(entry.after.endsWith('…')).toBe(true);
    expect(entry.after.startsWith('xxx')).toBe(true);
    expect(entry.before).toBe('short');
  });

  it('caps entries at 200 and appends a truncation marker', () => {
    const before = {};
    const after = {};
    for (let i = 0; i < 250; i += 1) {
      before[`key${String(i).padStart(3, '0')}`] = 'a';
      after[`key${String(i).padStart(3, '0')}`] = 'b';
    }
    const entries = diffSnapshots(before, after);
    const real = entries.filter((entry) => entry.kind !== 'truncated');
    expect(real).toHaveLength(200);
    const marker = entries[entries.length - 1];
    expect(marker.kind).toBe('truncated');
    expect(marker.omitted).toBe(50);
  });
});

describe('computeWorkflowNodeDriftDiff (against the real snapshot normalizer)', () => {
  let workspacePath;
  let collectionPath;
  let requestPath;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-wf-diff-'));
    collectionPath = path.join(workspacePath, 'collections', 'c1');
    fs.mkdirSync(path.join(collectionPath, 'api'), { recursive: true });
    fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'c1', type: 'collection' }));
    requestPath = path.join(collectionPath, 'api', 'get-user.bru');
    fs.writeFileSync(requestPath, REQUEST_BRU);
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  const writeWorkflowWithNode = async () => {
    const pathname = await createWorkflow(workspacePath, 'Diff Flow');
    const { snapshot, hash, collectionRelPath, requestRelPath } = await snapshotRequestForWorkflow({
      workspacePath,
      collectionPathname: collectionPath,
      requestPathname: requestPath
    });
    await writeWorkflowFile(pathname, {
      name: 'Diff Flow',
      nodes: [requestNode('node-1', { collection: collectionRelPath, request: requestRelPath }, snapshot, hash)],
      connections: []
    });
    return pathname;
  };

  it('diff is nonempty iff the drift flag is set', async () => {
    const pathname = await writeWorkflowWithNode();

    // linked -> empty diff
    let driftState = await readWorkflowWithDrift(workspacePath, pathname);
    expect(driftState.drift['node-1'].status).toBe('linked');
    let result = await computeWorkflowNodeDriftDiff(workspacePath, pathname, 'node-1');
    expect(result.status).toBe('linked');
    expect(result.entries).toEqual([]);

    // change the request on disk -> drifted and a nonempty diff, in agreement
    fs.writeFileSync(requestPath, REQUEST_BRU.replace('{{userId}}', '{{accountId}}'));
    driftState = await readWorkflowWithDrift(workspacePath, pathname);
    expect(driftState.drift['node-1'].status).toBe('drifted');
    result = await computeWorkflowNodeDriftDiff(workspacePath, pathname, 'node-1');
    expect(result.status).toBe('drifted');
    expect(result.entries.length).toBeGreaterThan(0);
    const urlEntry = result.entries.find((entry) => entry.path === 'request.url');
    expect(urlEntry).toEqual({
      path: 'request.url',
      kind: 'changed',
      before: '{{baseUrl}}/users/{{userId}}',
      after: '{{baseUrl}}/users/{{accountId}}'
    });
    expect(result.liveHash).not.toBe(result.snapshotHash);
  });

  it('uses the same normalization as drift hashing (uid noise never shows up)', async () => {
    const pathname = await writeWorkflowWithNode();

    // Re-snapshot the same file: the yml/bru parser assigns fresh uids on every
    // parse; the diff must be empty because both sides are stripped.
    const live = await buildRequestSnapshot({
      workspacePath,
      collectionRelPath: 'collections/c1',
      requestRelPath: 'api/get-user.bru'
    });
    expect(JSON.stringify(live.snapshot)).not.toContain('"uid"');

    const result = await computeWorkflowNodeDriftDiff(workspacePath, pathname, 'node-1');
    expect(result.entries).toEqual([]);
  });

  it('returns detached with no entries when the request file is gone', async () => {
    const pathname = await writeWorkflowWithNode();
    fs.unlinkSync(requestPath);

    const result = await computeWorkflowNodeDriftDiff(workspacePath, pathname, 'node-1');
    expect(result.status).toBe('detached');
    expect(result.entries).toEqual([]);
  });

  it('throws for an unknown node id', async () => {
    const pathname = await writeWorkflowWithNode();
    await expect(computeWorkflowNodeDriftDiff(workspacePath, pathname, 'nope')).rejects.toThrow(
      'Request node not found'
    );
  });
});
