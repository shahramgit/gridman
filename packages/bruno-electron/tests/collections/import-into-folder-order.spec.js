const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() }, dialog: {}, shell: {} }));

const { writeItemsIntoFolder } = require('../../src/ipc/collection-export-import');
const { sortByNameThenSequence } = require('../../src/utils/collection');

// Reported against 4.1.0-vasl.6: an imported folder landed at the TOP of the
// collection. Import wrote the source file's own numbering (1, 2, ...) and gave
// a folder without a root no folder file — no seq — at all.
const request = (name, seq) => ({
  type: 'http-request', name, seq,
  request: { method: 'GET', url: `https://x.invalid/${name}`, headers: [], params: [], body: { mode: 'none' }, auth: { mode: 'none' } }
});
const importedFolder = (name, seq, items = [], withRoot = true) => ({
  type: 'folder', name, seq, items, ...(withRoot ? { root: { meta: { name } } } : {})
});
const readSeq = (file) => Number((fs.readFileSync(file, 'utf8').match(/^\s*seq:\s*(\d+)/m) || [])[1]);

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-import-order-'));
  // an existing collection: seven folders at seq 1 (as in 022), then up to 137
  for (let i = 0; i < 7; i++) {
    fs.mkdirSync(path.join(dir, `existing ${i}`));
    fs.writeFileSync(path.join(dir, `existing ${i}`, 'folder.bru'), `meta {\n  name: existing ${i}\n  seq: 1\n}\n`);
  }
  fs.mkdirSync(path.join(dir, 'existing last'));
  fs.writeFileSync(path.join(dir, 'existing last', 'folder.bru'), 'meta {\n  name: existing last\n  seq: 137\n}\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const folderOrder = () => {
  const folders = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({
    name: e.name,
    seq: fs.existsSync(path.join(dir, e.name, 'folder.bru')) ? readSeq(path.join(dir, e.name, 'folder.bru')) : undefined
  }));
  return sortByNameThenSequence(folders).map((f) => f.name);
};

it('puts imported folders after every existing one', async () => {
  await writeItemsIntoFolder({
    items: [importedFolder('Imported A', 1, [request('a', 1)]), importedFolder('Imported B', 2, [request('b', 1)])],
    targetDirectory: dir, format: 'bru', appendAfterExisting: true
  });
  expect(folderOrder().slice(-2)).toEqual(['Imported A', 'Imported B']);
  expect(readSeq(path.join(dir, 'Imported A', 'folder.bru'))).toBeGreaterThan(137);
});

it('gives a folder with no root in the source a folder file and a seq', async () => {
  await writeItemsIntoFolder({ items: [importedFolder('Rootless', 1, [], false)], targetDirectory: dir, format: 'bru', appendAfterExisting: true });
  expect(fs.existsSync(path.join(dir, 'Rootless', 'folder.bru'))).toBe(true);
  expect(folderOrder().at(-1)).toBe('Rootless');
});

it('keeps the source\'s own order, not the array\'s (exports list items alphabetically)', async () => {
  await writeItemsIntoFolder({
    items: [importedFolder('Alpha', 2), importedFolder('Zeta', 1)],
    targetDirectory: dir, format: 'bru', appendAfterExisting: true
  });
  expect(folderOrder().slice(-2)).toEqual(['Zeta', 'Alpha']);
});

it('leaves nested levels in their source numbering', async () => {
  await writeItemsIntoFolder({
    items: [importedFolder('Outer', 1, [importedFolder('Inner', 1)])],
    targetDirectory: dir, format: 'bru', appendAfterExisting: true
  });
  expect(readSeq(path.join(dir, 'Outer', 'Inner', 'folder.bru'))).toBe(1);
});
