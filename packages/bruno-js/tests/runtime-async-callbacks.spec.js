const { describe, it, expect } = require('@jest/globals');
const ScriptRuntime = require('../src/runtime/script-runtime');
const TestRuntime = require('../src/runtime/test-runtime');

const makeRequest = () => ({
  url: 'http://localhost/',
  headers: {},
  globalEnvironmentVariables: {}
});
const response = { status: 200, headers: {}, data: 'ok' };
const logger = () => {};

describe.each(['nodevm', 'quickjs'])('asynchronous test callbacks in %s', (runtime) => {
  const runPhase = (phase, script) => {
    const request = makeRequest();
    if (phase === 'tests') {
      return new TestRuntime({ runtime }).runTests(script, request, response, {}, {}, '.', logger, {});
    }
    const scripts = new ScriptRuntime({ runtime });
    return phase === 'pre-request'
      ? scripts.runRequestScript(script, request, {}, {}, '.', logger, {})
      : scripts.runResponseScript(script, request, response, {}, {}, '.', logger, {});
  };

  it.each(['pre-request', 'post-response', 'tests'])('waits for un-awaited test callbacks in %s', async (phase) => {
    const result = await runPhase(phase, `
      test('delayed callback', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        bru.setVar('finished', true);
        expect(true).to.equal(true);
      });
    `);
    expect(result.runtimeVariables.finished).toBe(true);
    expect(result.results).toEqual([expect.objectContaining({ description: 'delayed callback', status: 'pass' })]);
  });

  it.each(['pre-request', 'post-response', 'tests'])('keeps completed tests when %s throws', async (phase) => {
    const error = await runPhase(phase, `
      test('completed after error', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        bru.setVar('finished', true);
      });
      throw new Error('script error');
    `).then(() => null, (error) => error);
    expect(error.message).toBe('script error');
    expect(error.partialResults.runtimeVariables.finished).toBe(true);
    expect(error.partialResults.results).toEqual([expect.objectContaining({ description: 'completed after error', status: 'pass' })]);
  });

  it('records delayed assertion failures before returning', async () => {
    const result = await runPhase('tests', `
      test('delayed failure', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(1).to.equal(2);
      });
    `);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ description: 'delayed failure', status: 'fail' });
  });
});

describe('req.onFail variables', () => {
  it('returns fresh variables after the callback, preserving opt-in persistence', async () => {
    const request = makeRequest();
    const initial = await new ScriptRuntime({ runtime: 'nodevm' }).runRequestScript(`
      req.onFail(async (error) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        bru.setVar('runtime', error.message);
        bru.setEnvVar('transient', 'memory only');
        bru.setEnvVar('persistent', 'save explicitly', { persist: true });
        bru.setGlobalEnvVar('global', 'global value');
        test('onFail callback', async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          bru.setVar('callbackTestFinished', true);
        });
      });
    `, request, {}, {}, '.', logger, {});
    expect(initial.envVariables).toEqual({});
    const result = await request.onFailHandler(new Error('request failed'));
    expect(result.runtimeVariables).toEqual({ runtime: 'request failed', callbackTestFinished: true });
    expect(result.envVariables).toEqual({ transient: 'memory only', persistent: 'save explicitly' });
    expect(result.persistentEnvVariables).toEqual({ persistent: 'save explicitly' });
    expect(result.globalEnvironmentVariables).toEqual({ global: 'global value' });
    expect(result.results).toEqual([expect.objectContaining({ description: 'onFail callback', status: 'pass' })]);
  });
});
