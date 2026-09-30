const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextAppendSeq, setFolderSeq } = require('../../src/utils/folder-seq');

// A folder's seq is an ABSOLUTE position (sortByNameThenSequence), so anything
// that writes one lower than its siblings' puts the folder near the top — and
// commits it there for every teammate. Reported against 4.1.0-vasl.5 and .6.
let dir;
const folder = (name, seq, format = 'bru') => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  if (seq !== undefined) {
    const body = format === 'bru'
      ? `meta {\n  name: ${name}\n  seq: ${seq}\n}\n`
      : `info:\n  name: ${name}\n  seq: ${seq}\n`;
    fs.writeFileSync(path.join(dir, name, `folder.${format}`), body);
  }
};
const request = (name, seq) => fs.writeFileSync(path.join(dir, `${name}.bru`), `meta {\n  name: ${name}\n  type: http\n  seq: ${seq}\n}\n\nget {\n  url: https://x.invalid\n}\n`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-folder-seq-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('nextAppendSeq', () => {
  it('goes past duplicate low seqs (collection 022: seven folders at seq 1)', () => {
    for (let i = 0; i < 7; i++) folder(`dup ${i}`, 1);
    folder('mid', 3);
    expect(nextAppendSeq(dir, 'bru')).toBe(9); // 8 siblings, max seq 3
  });

  it('goes past a seq far above the sibling count', () => {
    folder('a', 1);
    folder('b', 137);
    expect(nextAppendSeq(dir, 'bru')).toBe(138);
  });

  it('counts folders without a folder file and requests too', () => {
    folder('no file');
    folder('with file', 2);
    request('req', 5);
    expect(nextAppendSeq(dir, 'bru')).toBe(6);
  });

  it('reads yml folders', () => {
    folder('y', 40, 'yml');
    expect(nextAppendSeq(dir, 'yml')).toBe(41);
  });

  it('leaves out the item being placed', () => {
    folder('a', 1);
    folder('moved', 99);
    expect(nextAppendSeq(dir, 'bru', { exclude: ['moved'] })).toBe(2);
  });

  it('does not take a seq from a request body', () => {
    fs.writeFileSync(path.join(dir, 'r.bru'), 'meta {\n  name: r\n  type: http\n  seq: 2\n}\n\nbody:json {\n  {\n  seq: 900\n  }\n}\n');
    expect(nextAppendSeq(dir, 'bru')).toBe(3);
  });
});

describe('setFolderSeq', () => {
  it('rewrites only the seq, keeping the name and settings', async () => {
    fs.mkdirSync(path.join(dir, 'f'));
    fs.writeFileSync(path.join(dir, 'f', 'folder.bru'), 'meta {\n  name: Display Name\n  seq: 1\n}\n\nauth {\n  mode: inherit\n}\n');
    expect(await setFolderSeq(path.join(dir, 'f'), 'bru', 146)).toBe(true);
    const text = fs.readFileSync(path.join(dir, 'f', 'folder.bru'), 'utf8');
    expect(text).toMatch(/name: Display Name/);
    expect(text).toMatch(/seq: 146/);
  });

  it('names a folder whose file has no name after the folder, never "undefined"', async () => {
    fs.mkdirSync(path.join(dir, 'سامانه'));
    fs.writeFileSync(path.join(dir, 'سامانه', 'folder.bru'), '');
    expect(await setFolderSeq(path.join(dir, 'سامانه'), 'bru', 5)).toBe(true);
    const text = fs.readFileSync(path.join(dir, 'سامانه', 'folder.bru'), 'utf8');
    expect(text).toMatch(/name: سامانه/);
    expect(text).not.toMatch(/undefined/);
  });

  it('creates the folder file when there is none', async () => {
    fs.mkdirSync(path.join(dir, 'bare'));
    await setFolderSeq(path.join(dir, 'bare'), 'bru', 7);
    expect(fs.readFileSync(path.join(dir, 'bare', 'folder.bru'), 'utf8')).toMatch(/seq: 7/);
  });
});
