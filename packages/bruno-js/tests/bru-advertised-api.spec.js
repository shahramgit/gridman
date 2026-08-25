const path = require('path');
const fs = require('fs');
const Bru = require('../src/bru');
const { bindRunRequest } = require('../src/runtime/scripted-entries');
const { setupBruTestMethods } = require('../src/utils/results');

/**
 * THE SANDBOX MUST NOT CALL A METHOD THAT DOES NOT EXIST.
 *
 * The quickjs shim builds a `bru` object by handing the VM one function per
 * method, each calling straight through to the real Bru instance. Two of those
 * calls had no method behind them — `bru.visualize` and `bru.getSecretVar`
 * were never defined on the class, here or upstream — so a script using either
 * one died with a TypeError several frames deep in the shim, and on the nodevm
 * runtime the name was simply absent.
 *
 * What is pinned is the CALL, not the exposed name: `_sendRequest` is exposed
 * under that name but calls `bru.sendRequest`, and reading the exposed name
 * would have flagged it wrongly. Commented-out blocks are stripped first —
 * setCollectionVar and friends are deliberately disabled on both sides, with
 * the reason in a TODO, and are not broken.
 */

const SHIM_PATH = path.join(__dirname, '..', 'src', 'sandbox', 'quickjs', 'shims', 'bru.js');

// Strip line comments so the deliberately-disabled blocks do not register as
// live API — matching them is how the first version of this suite produced ten
// false failures.
const SHIM = fs.readFileSync(SHIM_PATH, 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

const buildBru = () => {
  const bru = new Bru({
    runtime: 'nodevm',
    envVariables: { token: 's3cret' },
    collectionPath: path.join('/', 'w', 'c')
  });
  // Two methods are attached per run rather than declared on the class.
  bindRunRequest(bru, async () => ({}));
  setupBruTestMethods(bru, { getResults: async () => [] }, []);
  return bru;
};

// Every `bru.method(` the shim invokes on the HOST instance, including through
// `bru?.x` chains. `globalThis.bru.x` is excluded: that appears inside the
// sandboxed script text and refers to the object INSIDE the VM, which is the
// one this shim is building — reading it flagged `_sendRequest`, a name the
// shim exposes while calling the real `bru.sendRequest` behind it.
const calledOnBru = [...new Set(
  [...SHIM.matchAll(/(globalThis\s*\.\s*)?\bbru\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g)]
    .filter((m) => !m[1])
    .map((m) => m[2])
)].sort();

describe('every method the quickjs shim calls exists on Bru', () => {
  it('found methods to check, so this cannot pass by matching nothing', () => {
    expect(calledOnBru.length).toBeGreaterThan(20);
    expect(calledOnBru).toEqual(expect.arrayContaining(['getSecretVar', 'visualize', 'getEnvVar', 'sendRequest']));
  });

  it.each(calledOnBru)('bru.%s is a function', (name) => {
    expect(typeof buildBru()[name]).toBe('function');
  });
});

describe('the two that were missing', () => {
  it('getSecretVar reads a secret, which lives in the environment map', () => {
    // getEnvVars merges secrets into the same map as plain variables (secrets
    // last), so there is no separate store for this to read.
    expect(buildBru().getSecretVar('token')).toBe('s3cret');
  });

  it('returns undefined for a name that is not set, rather than throwing', () => {
    expect(buildBru().getSecretVar('nope')).toBeUndefined();
  });

  it('visualize refuses clearly instead of failing deep inside the shim', () => {
    expect(() => buildBru().visualize('<b>x</b>')).toThrow(/not supported/i);
  });
});
