const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCollectionIndex } = require('../../src/app/collection-indexer');

/**
 * THE INDEX MUST NOT READ WHOLE FILES TO GET FIVE FIELDS OUT OF THE FIRST 8 KB.
 *
 * `extractRequestMeta` needs name, type, seq, method and url, and on all 12,088
 * files of the reported workspace every one of those is near the top. Reading
 * the file whole cost 210 MB of I/O per full scan against 25 MB for the head —
 * and I/O is what a Windows virus scanner charges for.
 *
 * The reader is therefore tiered: whole file up to 64 KB, first 8 KB above it.
 * These check the boundary from both sides, because getting it wrong is silent:
 * too small a head and a real request loses its method and url, too eager a
 * truncation and a small file loses its example count.
 */

let root;
let nextDir = 0;

const makeCollection = () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), `gridman-index-${nextDir++}-`));
  fs.writeFileSync(path.join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  return root;
};

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

// Blocks may appear in any order in a .bru file, and `lead` deliberately puts
// bytes BEFORE the method block: with the method block in the first 200 bytes
// no assertion here could tell an 8 KB head from a 512-byte one.
const request = ({ name, method = 'get', url, lead = '', filler = '', trailer = '' }) => `meta {
  name: ${name}
  type: http
  seq: 1
}
${lead ? `\ndocs {\n${lead}}\n` : ''}
${method} {
  url: ${url}
  body: none
  auth: none
}

script:pre-request {
${filler}
}
${trailer}`;

const EXAMPLE_BLOCK = `
example {
  meta {
    name: saved
  }
}
`;

const indexNodes = async (collectionPathname) => {
  const nodes = [];
  const win = {
    webContents: {
      send: (channel, payload) => {
        if (channel === 'main:collection-index-batch') nodes.push(...payload.nodes);
      }
    }
  };
  await new Promise((resolve, reject) => {
    startCollectionIndex(win, {
      collectionUid: 'col-1',
      collectionPathname,
      brunoConfig: {},
      loadSessionId: 's1',
      onReady: resolve,
      onFailed: reject
    });
  });
  return nodes;
};

const byName = (nodes, name) => nodes.find((n) => n.name === name);

describe('the collection index reads only as much of a file as it needs', () => {
  it('still gets name, method and url off a file far bigger than the head', async () => {
    const dir = makeCollection();
    // 2 MB of body after the blocks the index cares about, and 4 KB of docs
    // BEFORE them, so the method block sits deep enough in the head that
    // shrinking HEAD_READ_BYTES actually breaks this.
    fs.writeFileSync(
      path.join(dir, 'huge.bru'),
      request({
        name: 'Huge Request',
        method: 'post',
        url: 'https://api.example.internal/v1/huge',
        lead: '  lead lead lead lead\n'.repeat(200),
        filler: '  x'.repeat(700000)
      })
    );

    const node = byName(await indexNodes(dir), 'Huge Request');
    expect(node).toBeDefined();
    expect(node.method).toBe('POST');
    expect(node.url).toBe('https://api.example.internal/v1/huge');
    expect(node.type).toBe('http-request');
  });

  it('never reports a value it only read half of', async () => {
    const dir = makeCollection();
    // Position the url line so the 8 KB cut lands INSIDE it, and make the url
    // Persian so the cut also lands inside a multi-byte character — which is
    // the normal case in the reported workspace, not an edge case.
    //
    // Two ways to get this wrong, both silent. `^\s*url:\s*(.+?)\s*$` matches
    // a half-read line because the end of the buffer looks like the end of a
    // line, so the sidebar shows a truncated url and search matches on it. And
    // decoding a buffer cut mid-character appends U+FFFD, which then travels
    // into the row. Dropping back to the last complete line prevents both.
    const url = `https://api.example.internal/${'راهنما/'.repeat(30)}پایان`;
    const head = 8 * 1024;
    const prefix = (pad) =>
      `meta {\n  name: Straddle\n  type: http\n  seq: 1\n}\n\ndocs {\n${'  f\n'.repeat(pad)}}\n\nget {\n  url: `;
    // Grow the lead until the url line starts ~20 bytes short of the cut.
    let pad = 0;
    while (Buffer.byteLength(prefix(pad)) < head - 20) pad += 1;
    expect(Buffer.byteLength(prefix(pad))).toBeLessThan(head);
    expect(Buffer.byteLength(prefix(pad)) + Buffer.byteLength(url)).toBeGreaterThan(head);

    // Past the full-read tier, or the whole file is read and there is no cut
    // to get wrong — which is how the first version of this test passed
    // against a deliberately broken reader.
    const tail = `\n\nscript:pre-request {\n${'  // t\n'.repeat(9000)}}\n`;
    fs.writeFileSync(path.join(dir, 'straddle.bru'), `${prefix(pad)}${url}\n  body: none\n  auth: none\n}${tail}`);
    expect(fs.statSync(path.join(dir, 'straddle.bru')).size).toBeGreaterThan(64 * 1024);

    const node = byName(await indexNodes(dir), 'Straddle');
    expect(node).toBeDefined();
    expect(node.url).not.toContain('\uFFFD');
    expect([url, '']).toContain(node.url);
  });

  it('counts examples in a small file, where they can be anywhere', async () => {
    const dir = makeCollection();
    // 40 KB — under the full-read tier, so the example at the very end still
    // counts and the sidebar chevron shows before the request hydrates.
    fs.writeFileSync(
      path.join(dir, 'small.bru'),
      request({ name: 'Small', url: 'https://api.example.internal/small', filler: '  y'.repeat(13000), trailer: EXAMPLE_BLOCK })
    );

    expect(byName(await indexNodes(dir), 'Small').exampleCount).toBe(1);
  });

  it('reads a file at the tier boundary whole', async () => {
    const dir = makeCollection();
    const base = request({ name: 'Edge', url: 'https://api.example.internal/edge', trailer: EXAMPLE_BLOCK });
    // Pad to just under 64 KB so the example lands past the 8 KB head but
    // inside the full-read tier — the case that proves the tier is the file
    // SIZE and not the head length.
    const pad = 64 * 1024 - Buffer.byteLength(base) - 16;
    fs.writeFileSync(
      path.join(dir, 'edge.bru'),
      request({ name: 'Edge', url: 'https://api.example.internal/edge', filler: 'z'.repeat(pad), trailer: EXAMPLE_BLOCK })
    );

    const node = byName(await indexNodes(dir), 'Edge');
    expect(node.exampleCount).toBe(1);
    expect(node.url).toBe('https://api.example.internal/edge');
  });

  it('indexes an empty file as a row rather than dropping it', async () => {
    const dir = makeCollection();
    fs.writeFileSync(path.join(dir, 'empty.bru'), '');

    // Falls back to the filename, exactly as the full read did.
    const node = byName(await indexNodes(dir), 'empty');
    expect(node).toBeDefined();
    expect(node.type).toBe('http-request');
  });
});
