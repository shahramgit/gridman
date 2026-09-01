const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  WORKFLOW_EXTENSION,
  createWorkflow,
  writeWorkflowFile,
  readWorkflowWithDrift,
  exportWorkflowToPath,
  importWorkflowFromPath
} = require('../../src/workflows');

const workflowsDirOf = (workspacePath) => path.join(workspacePath, 'workflows');

describe('workflow export / import', () => {
  let workspacePath;
  let outsidePath; // export targets and import sources live outside the workspace

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-wf-ws-'));
    outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-wf-out-'));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { recursive: true, force: true });
  });

  describe('export', () => {
    it('strips pinnedOutput from every node but keeps the rest of the doc', async () => {
      const pathname = await createWorkflow(workspacePath, 'Pinned Flow');
      await writeWorkflowFile(pathname, {
        name: 'Pinned Flow',
        inputs: [{ name: 'env', value: 'dev' }],
        nodes: [
          { id: 'd1', type: 'delay', name: 'Delay', position: { x: 0, y: 0 }, durationMs: 25, pinnedOutput: { delayedMs: 25 } },
          { id: 'm1', type: 'map', name: 'Map', position: { x: 10, y: 0 }, mappings: [{ from: 'body', path: '$.token', target: 'token' }], pinnedOutput: { token: 'super-secret' } }
        ],
        connections: [{ id: 'c1', source: 'd1', sourcePort: 'main', target: 'm1' }]
      });

      const targetPath = path.join(outsidePath, 'Pinned Flow.flow.yml');
      const result = await exportWorkflowToPath(workspacePath, pathname, targetPath);
      expect(result.filePath).toBe(targetPath);

      const exported = yaml.load(fs.readFileSync(targetPath, 'utf8'));
      expect(exported.name).toBe('Pinned Flow');
      expect(exported.inputs).toEqual([{ name: 'env', value: 'dev' }]);
      expect(exported.nodes.find((n) => n.id === 'd1').durationMs).toBe(25);
      expect(exported.nodes.find((n) => n.id === 'm1').mappings).toHaveLength(1);
      for (const node of exported.nodes) {
        expect(node).not.toHaveProperty('pinnedOutput');
      }
      expect(fs.readFileSync(targetPath, 'utf8')).not.toContain('super-secret');
      expect(exported.connections).toHaveLength(1);
    });

    it('does not touch the workspace copy (pinnedOutput stays in the source file)', async () => {
      const pathname = await createWorkflow(workspacePath, 'Keep Pins');
      await writeWorkflowFile(pathname, {
        name: 'Keep Pins',
        nodes: [{ id: 'd1', type: 'delay', name: 'Delay', position: { x: 0, y: 0 }, durationMs: 5, pinnedOutput: { delayedMs: 5 } }],
        connections: []
      });

      await exportWorkflowToPath(workspacePath, pathname, path.join(outsidePath, 'keep.flow.yml'));

      const source = yaml.load(fs.readFileSync(pathname, 'utf8'));
      expect(source.nodes.find((n) => n.id === 'd1').pinnedOutput).toEqual({ delayedMs: 5 });
    });

    it('rejects source paths outside the workspace', async () => {
      const stray = path.join(outsidePath, `stray${WORKFLOW_EXTENSION}`);
      fs.writeFileSync(stray, 'name: stray\nnodes: []\n');

      await expect(
        exportWorkflowToPath(workspacePath, stray, path.join(outsidePath, 'target.flow.yml'))
      ).rejects.toThrow(/inside the workspace/);
    });

    it('rejects non-workflow files inside the workspace', async () => {
      const notAWorkflow = path.join(workspacePath, 'notes.txt');
      fs.writeFileSync(notAWorkflow, 'hello');

      await expect(
        exportWorkflowToPath(workspacePath, notAWorkflow, path.join(outsidePath, 'target.flow.yml'))
      ).rejects.toThrow(/Not a workflow file/);
    });
  });

  describe('import', () => {
    const writeSource = (filename, doc) => {
      const sourcePath = path.join(outsidePath, filename);
      fs.writeFileSync(sourcePath, typeof doc === 'string' ? doc : yaml.dump(doc));
      return sourcePath;
    };

    it('validates + normalizes through the standard read path and strips pinnedOutput', async () => {
      const sourcePath = writeSource('My Flow.yml', {
        name: 'My Flow',
        nodes: [
          // pinned output must be stripped even if present in the file
          { id: 'd1', type: 'delay', durationMs: 99999999, pinnedOutput: { delayedMs: 1, token: 'leaked' } },
          // unknown node types are dropped by normalization
          { id: 'bad', type: 'unknown-node' }
        ],
        connections: [{ source: 'd1', sourcePort: 'nope', target: 'bad' }]
      });

      const { pathname, name } = await importWorkflowFromPath(workspacePath, sourcePath);
      expect(name).toBe('My Flow');
      expect(pathname.startsWith(workflowsDirOf(workspacePath) + path.sep)).toBe(true);
      expect(path.basename(pathname)).toBe(`My Flow${WORKFLOW_EXTENSION}`);

      const written = yaml.load(fs.readFileSync(pathname, 'utf8'));
      expect(written.version).toBe(2);
      // normalization ran: start node added, delay clamped, junk dropped
      expect(written.nodes.some((n) => n.type === 'start')).toBe(true);
      expect(written.nodes.find((n) => n.id === 'd1').durationMs).toBe(5 * 60 * 1000);
      expect(written.nodes.find((n) => n.id === 'bad')).toBeUndefined();
      expect(written.connections).toEqual([]);
      for (const node of written.nodes) {
        expect(node).not.toHaveProperty('pinnedOutput');
      }
      expect(fs.readFileSync(pathname, 'utf8')).not.toContain('leaked');
    });

    it('auto-renames on filename collision (name, name-2, name-3)', async () => {
      const sourcePath = writeSource('smoke-test.yml', { name: 'Smoke', nodes: [] });

      const first = await importWorkflowFromPath(workspacePath, sourcePath);
      const second = await importWorkflowFromPath(workspacePath, sourcePath);
      const third = await importWorkflowFromPath(workspacePath, sourcePath);

      expect(path.basename(first.pathname)).toBe(`smoke-test${WORKFLOW_EXTENSION}`);
      expect(path.basename(second.pathname)).toBe(`smoke-test-2${WORKFLOW_EXTENSION}`);
      expect(path.basename(third.pathname)).toBe(`smoke-test-3${WORKFLOW_EXTENSION}`);

      const files = fs.readdirSync(workflowsDirOf(workspacePath)).sort();
      expect(files).toEqual([
        `smoke-test-2${WORKFLOW_EXTENSION}`,
        `smoke-test-3${WORKFLOW_EXTENSION}`,
        `smoke-test${WORKFLOW_EXTENSION}`
      ]);
    });

    it('does not stack extensions when importing an exported .flow.yml file', async () => {
      const sourcePath = writeSource(`exported${WORKFLOW_EXTENSION}`, { name: 'Exported', nodes: [] });
      const { pathname } = await importWorkflowFromPath(workspacePath, sourcePath);
      expect(path.basename(pathname)).toBe(`exported${WORKFLOW_EXTENSION}`);
    });

    // sanitizeWorkflowFilename replaces <>:"/\|?* and control characters —
    // which is exactly the set Windows forbids in a filename. A fixture that
    // exercises that branch therefore cannot be created on Windows at all, so
    // each platform tests the branch it can actually reach: the illegal
    // character on unix, whitespace collapsing on Windows.
    const HOSTILE = process.platform === 'win32'
      ? { source: 'we  ird name.yml', expected: 'we ird name' }
      : { source: 'we ird?name.yml', expected: 'we ird-name' };

    it('sanitizes hostile filenames', async () => {
      const sourcePath = writeSource(HOSTILE.source, { name: 'Weird', nodes: [] });
      const { pathname } = await importWorkflowFromPath(workspacePath, sourcePath);
      expect(path.basename(pathname)).toBe(`${HOSTILE.expected}${WORKFLOW_EXTENSION}`);
      expect(pathname.startsWith(workflowsDirOf(workspacePath) + path.sep)).toBe(true);
    });

    it('accepts legacy v1 step documents and migrates them to a graph', async () => {
      const sourcePath = writeSource('legacy.yml', {
        name: 'Legacy',
        steps: [{ id: 'd1', type: 'delay', durationMs: 10 }]
      });

      const { pathname } = await importWorkflowFromPath(workspacePath, sourcePath);
      const written = yaml.load(fs.readFileSync(pathname, 'utf8'));
      expect(written.version).toBe(2);
      expect(written.nodes.some((n) => n.type === 'start')).toBe(true);
      expect(written.nodes.find((n) => n.id === 'd1')).toBeTruthy();
      expect(written.connections).toHaveLength(1);
    });

    it('rejects malformed yaml without writing anything', async () => {
      const sourcePath = writeSource('broken.yml', 'nodes: [1, 2\nname: "unclosed');

      await expect(importWorkflowFromPath(workspacePath, sourcePath))
        .rejects.toThrow(/Not a valid workflow file/);
      expect(fs.existsSync(workflowsDirOf(workspacePath))).toBe(false);
    });

    it('rejects yaml that is not a workflow document', async () => {
      const scalar = writeSource('scalar.yml', 'just a string\n');
      await expect(importWorkflowFromPath(workspacePath, scalar))
        .rejects.toThrow(/Not a valid workflow file/);

      const noNodes = writeSource('no-nodes.yml', { name: 'Empty' });
      await expect(importWorkflowFromPath(workspacePath, noNodes))
        .rejects.toThrow(/no workflow nodes/);

      expect(fs.existsSync(workflowsDirOf(workspacePath))).toBe(false);
    });

    it('imported workflows with unresolvable request refs open as detached (no crash)', async () => {
      const sourcePath = writeSource('detached.yml', {
        name: 'Detached',
        nodes: [
          {
            id: 'r1',
            type: 'request',
            name: 'Ghost',
            position: { x: 0, y: 0 },
            ref: { collection: 'collections/missing', request: 'nope.bru' },
            snapshotHash: 'deadbeef',
            snapshot: { name: 'Ghost', type: 'http-request', request: { url: 'http://x', method: 'GET' } }
          }
        ],
        connections: []
      });

      const { pathname } = await importWorkflowFromPath(workspacePath, sourcePath);
      const { doc, drift } = await readWorkflowWithDrift(workspacePath, pathname);
      expect(doc.nodes.find((n) => n.id === 'r1')).toBeTruthy();
      expect(drift['r1'].status).toBe('detached');
    });
  });
});
