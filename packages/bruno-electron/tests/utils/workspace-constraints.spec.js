const path = require('path');
const fs = require('fs');
const os = require('os');
const yaml = require('js-yaml');
const {
  addCollectionToWorkspace,
  removeCollectionFromWorkspace,
  readWorkspaceConfig,
  isWorkspaceCollectionPath
} = require('../../src/utils/workspace-config');

// Workspace-only collection constraints: every collection registered in a
// workspace must live under <workspace>/collections/. External or escaping
// paths are rejected on write and dropped on read, so a hand-edited
// workspace.yml cannot smuggle a path outside the workspace.
describe('workspace-only collection constraints', () => {
  let workspacePath;

  const writeWorkspaceYml = (collections) => {
    const content = [
      'opencollection: 1.0.0',
      'info:',
      '  name: Constraints',
      '  type: workspace',
      'collections:',
      // Single-quoted, because a Windows absolute path inside DOUBLE quotes is
      // a YAML escape sequence: `path: "C:\WINDOWS\..."` fails to parse with
      // "unknown escape sequence", and the test died building its own fixture
      // rather than exercising the code.
      ...collections.flatMap((c) => [`  - name: '${c.name}'`, `    path: '${String(c.path).replace(/'/g, '\'\'')}'`]),
      'specs: []',
      'docs: \'\''
    ].join('\n');
    fs.writeFileSync(path.join(workspacePath, 'workspace.yml'), content);
  };

  const makeCollectionDir = (relativePath) => {
    const dir = path.join(workspacePath, relativePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bruno.json'),
      JSON.stringify({ version: '1', name: path.basename(dir), type: 'collection' })
    );
    return dir;
  };

  const readYmlCollections = () => {
    const raw = fs.readFileSync(path.join(workspacePath, 'workspace.yml'), 'utf8');
    return yaml.load(raw).collections || [];
  };

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-constraints-'));
    writeWorkspaceYml([]);
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  describe('addCollectionToWorkspace (copy-into-workspace registration)', () => {
    it('accepts an absolute path under collections/ and stores it relative', async () => {
      const dir = makeCollectionDir('collections/api');
      const collections = await addCollectionToWorkspace(workspacePath, { name: 'api', path: dir });
      expect(collections).toEqual([{ name: 'api', path: 'collections/api' }]);
      expect(readYmlCollections()).toEqual([{ name: 'api', path: 'collections/api' }]);
    });

    it('rejects an absolute path outside the workspace', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-outside-'));
      try {
        await expect(
          addCollectionToWorkspace(workspacePath, { name: 'x', path: outsideDir })
        ).rejects.toThrow('Workspace collections must use relative paths under collections/.');
        expect(readYmlCollections()).toEqual([]);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('rejects a path inside the workspace but not under collections/', async () => {
      const dir = path.join(workspacePath, 'environments');
      fs.mkdirSync(dir, { recursive: true });
      await expect(
        addCollectionToWorkspace(workspacePath, { name: 'env', path: dir })
      ).rejects.toThrow('Workspace collections must use relative paths under collections/.');
    });

    it('rejects a relative path escaping via ..', async () => {
      await expect(
        addCollectionToWorkspace(workspacePath, { name: 'esc', path: 'collections/../../elsewhere' })
      ).rejects.toThrow('Workspace collections must use relative paths under collections/.');
    });

    it('updates the existing entry instead of duplicating on re-add', async () => {
      const dir = makeCollectionDir('collections/api');
      await addCollectionToWorkspace(workspacePath, { name: 'api', path: dir });
      const collections = await addCollectionToWorkspace(workspacePath, {
        name: 'api',
        path: dir,
        remote: 'https://github.com/x/api'
      });
      expect(collections).toEqual([{ name: 'api', path: 'collections/api', remote: 'https://github.com/x/api' }]);
    });
  });

  describe('readWorkspaceConfig (defense against hand-edited yml)', () => {
    it('drops entries whose path escapes the workspace', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-outside-'));
      try {
        makeCollectionDir('collections/inside');
        writeWorkspaceYml([
          { name: 'inside', path: 'collections/inside' },
          { name: 'external-abs', path: outsideDir },
          { name: 'external-rel', path: 'collections/../../etc' }
        ]);

        const config = readWorkspaceConfig(workspacePath);
        expect(config.collections).toEqual([{ name: 'inside', path: 'collections/inside' }]);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('removeCollectionFromWorkspace', () => {
    it('removes the matching entry and keeps the rest', async () => {
      makeCollectionDir('collections/a');
      makeCollectionDir('collections/b');
      writeWorkspaceYml([
        { name: 'a', path: 'collections/a' },
        { name: 'b', path: 'collections/b' }
      ]);

      const { removedCollection, updatedConfig } = await removeCollectionFromWorkspace(
        workspacePath,
        path.join(workspacePath, 'collections', 'a')
      );

      expect(removedCollection).toEqual({ name: 'a', path: 'collections/a' });
      expect(updatedConfig.collections).toEqual([{ name: 'b', path: 'collections/b' }]);
      expect(readYmlCollections()).toEqual([{ name: 'b', path: 'collections/b' }]);
    });

    it('is a no-op for a path that is not registered', async () => {
      makeCollectionDir('collections/a');
      writeWorkspaceYml([{ name: 'a', path: 'collections/a' }]);

      const { removedCollection } = await removeCollectionFromWorkspace(
        workspacePath,
        path.join(workspacePath, 'collections', 'ghost')
      );

      expect(removedCollection).toBeNull();
      expect(readYmlCollections()).toEqual([{ name: 'a', path: 'collections/a' }]);
    });
  });

  describe('isWorkspaceCollectionPath (folder-deletion guard input)', () => {
    it('accepts only paths under <workspace>/collections', () => {
      expect(isWorkspaceCollectionPath(workspacePath, path.join(workspacePath, 'collections', 'api'))).toBe(true);
      expect(isWorkspaceCollectionPath(workspacePath, path.join(workspacePath, 'environments'))).toBe(false);
      expect(isWorkspaceCollectionPath(workspacePath, os.tmpdir())).toBe(false);
      expect(isWorkspaceCollectionPath(workspacePath, workspacePath)).toBe(false);
    });
  });
});
