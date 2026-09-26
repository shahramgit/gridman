const { describe, it, expect } = require('@jest/globals');
const { ScriptRuntime, TestRuntime } = require('../src');

// Safe mode (QuickJS) resolves require() from the generated, gitignored
// src/sandbox/bundle-browser-rollup.js, and its test() shim requires ajv on
// EVERY run. That bundle could not be regenerated on Node 18, so 4.1.0-vasl.3
// through .5 all shipped an April copy without ajv, and every safe-mode script
// failed with "Cannot find module ajv" — including scripts that never mention
// ajv. Nothing else in this suite ran a script through the real bundle, which
// is how 591 green tests coexisted with that.
const request = () => ({ url: 'https://example.invalid/x', method: 'POST', headers: {}, pathname: '/tmp/x.bru' });

const runSafeModeScript = (script) =>
  new ScriptRuntime({ runtime: 'quickjs' }).runRequestScript(
    script,
    request(),
    {},
    {},
    '/tmp',
    () => {},
    {},
    {},
    undefined,
    'nix'
  );

describe('safe-mode scripts against the generated sandbox bundle', () => {
  it('runs a script that uses no library at all (the reported failure)', async () => {
    // Verbatim shape of the reporter's pre-request script.
    const result = await runSafeModeScript(`
      var today = new Date();
      var yyyy = today.getFullYear();
      var mm = String(today.getMonth() + 1).padStart(2, '0');
      bru.setEnvVar("variable_key", yyyy + '' + mm);
    `);

    expect(result.envVariables.variable_key).toMatch(/^\d{6}$/);
  });

  it.each(['ajv', 'ajv-formats', 'chai', 'moment', 'buffer', 'btoa', 'atob', 'crypto-js', 'tv4'])(
    'can require %s',
    async (moduleName) => {
      const result = await runSafeModeScript(`
        const mod = require(${JSON.stringify(moduleName)});
        bru.setEnvVar("loaded", String(mod !== undefined && mod !== null));
      `);

      expect(result.envVariables.loaded).toBe('true');
    }
  );

  it('validates with the jsonSchema assertion, which is what needs ajv', async () => {
    const response = { status: 200, headers: {}, data: { id: 7 }, statusText: 'OK' };
    const result = await new TestRuntime({ runtime: 'quickjs' }).runTests(
      `
        test('matches schema', function () {
          expect(res.getBody()).to.have.jsonSchema({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'number' } }
          });
        });
        test('rejects a mismatch', function () {
          expect({ id: 'seven' }).to.not.have.jsonSchema({
            type: 'object',
            properties: { id: { type: 'number' } }
          });
        });
      `,
      request(),
      response,
      {},
      {},
      '/tmp',
      () => {},
      {},
      {},
      undefined,
      'nix'
    );

    const statuses = result.results.map((entry) => `${entry.description}:${entry.status}`);
    expect(statuses).toEqual(['matches schema:pass', 'rejects a mismatch:pass']);
  });
});
