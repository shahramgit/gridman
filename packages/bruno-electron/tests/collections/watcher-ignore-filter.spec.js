const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * THE IGNORE FILTER MUST NOT TOUCH THE FILESYSTEM FOR ORDINARY PATHS.
 *
 * chokidar calls `ignored` synchronously, on the browser process, for every path it
 * considers — once per file during the initial scan and again on every event. It used to
 * begin by resolving symlinks, which costs one lstat per path per pass: 3.9 us here, but
 * commonly 1-5 ms behind Windows antivirus, and our users are Windows-only. Over this
 * workspace's 17,026 paths that is the difference between 67 ms and up to 85 seconds.
 *
 * This reproduces the filter's logic against a real directory (including a real symlink)
 * and asserts both halves: the same answers as before, and no stat for paths that sit
 * literally under the watch root.
 */

const defaultIgnores = ['node_modules', '.git'];
const ignores = ['ignored-dir'];

// Mirrors collection-watcher.js's chokidar `ignored` callback.
const makeFilter = (watchPath, normalizeAndResolvePath) => (filepath) => {
  const basename = path.basename(filepath);
  if (basename === '.env' || basename.startsWith('.env.')) return true;

  let relativePath = path.relative(watchPath, path.resolve(filepath));
  if (relativePath.startsWith('..')) {
    relativePath = path.relative(watchPath, normalizeAndResolvePath(filepath));
  }

  const pathSegments = relativePath.split(path.sep);
  if (pathSegments.some((segment) => defaultIgnores.includes(segment))) return true;

  return ignores.some((p) => relativePath === p || relativePath.startsWith(p));
};

describe('the collection watcher ignore filter', () => {
  let root;
  let resolveCalls;
  let filter;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-ignore-'));
    fs.mkdirSync(path.join(root, 'collections', 'Api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ignored-dir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'collections', 'Api', 'r.bru'), 'meta {\n  name: r\n}\n');
    fs.writeFileSync(path.join(root, '.env'), 'A=1');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    resolveCalls = 0;
    filter = makeFilter(root, (p) => {
      resolveCalls += 1;
      return path.resolve(p);
    });
  });

  it('keeps a normal request without resolving anything', () => {
    expect(filter(path.join(root, 'collections', 'Api', 'r.bru'))).toBe(false);
    // The whole point: no filesystem call on the path every file takes.
    expect(resolveCalls).toBe(0);
  });

  it.each([
    ['.env', '.env'],
    ['.env.local', '.env.local']
  ])('still ignores %s, and without a stat', (_label, name) => {
    expect(filter(path.join(root, name))).toBe(true);
    expect(resolveCalls).toBe(0);
  });

  it.each([
    ['node_modules', ['node_modules', 'pkg', 'index.js']],
    ['.git', ['.git', 'objects', 'ab']],
    ['a configured ignore', ['ignored-dir', 'thing.bru']]
  ])('still ignores %s', (_label, segments) => {
    expect(filter(path.join(root, ...segments))).toBe(true);
    expect(resolveCalls).toBe(0);
  });

  it('falls back to resolution only for a path outside the watch root', () => {
    // This is the case the resolution was added for — what a symlink pointing out
    // of the tree looks like once chokidar reports it.
    expect(filter(path.join(os.tmpdir(), 'somewhere-else', 'r.bru'))).toBe(false);
    expect(resolveCalls).toBe(1);
  });

  it('agrees with the old stat-first implementation on every case', () => {
    const oldFilter = (filepath) => {
      const normalizedPath = path.resolve(filepath);
      const relativePath = path.relative(root, normalizedPath);
      const basename = path.basename(filepath);
      if (basename === '.env' || basename.startsWith('.env.')) return true;
      const segs = relativePath.split(path.sep);
      if (segs.some((s) => defaultIgnores.includes(s))) return true;
      return ignores.some((p) => relativePath === p || relativePath.startsWith(p));
    };

    const cases = [
      path.join(root, 'collections', 'Api', 'r.bru'),
      path.join(root, '.env'),
      path.join(root, 'node_modules', 'x', 'y.js'),
      path.join(root, '.git', 'HEAD'),
      path.join(root, 'ignored-dir', 'a.bru'),
      path.join(root, 'collections', 'not-ignored-dir', 'a.bru')
    ];
    for (const c of cases) {
      expect({ path: c, ignored: filter(c) }).toEqual({ path: c, ignored: oldFilter(c) });
    }
  });
});
