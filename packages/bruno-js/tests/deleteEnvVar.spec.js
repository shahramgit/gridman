const Bru = require('../src/bru');

// Upstream fix: usebruno/bruno#8315 (87f74262b). Only the two correctness halves are ported —
// the persist-by-default rework of setEnvVar is a deliberate divergence we keep.
describe('Bru.deleteEnvVar / deleteAllEnvVars', () => {
  const makeBru = (envVariables = {}) =>
    new Bru({
      runtime: 'quickjs',
      envVariables,
      runtimeVariables: {},
      processEnvVars: {},
      collectionPath: '/',
      collectionName: 'Test'
    });

  describe('deleteEnvVar', () => {
    test('deletes a normal variable', () => {
      const bru = makeBru({ __name__: 'Staging', token: 'abc' });
      bru.deleteEnvVar('token');
      expect(bru.envVariables.token).toBeUndefined();
    });

    test('ignores __name__ so the environment keeps its name', () => {
      // `__name__` is internal bookkeeping. Deleting it left the environment nameless.
      const bru = makeBru({ __name__: 'Staging', token: 'abc' });
      bru.deleteEnvVar('__name__');
      expect(bru.envVariables.__name__).toBe('Staging');
    });

    test('deleting an absent key is a no-op', () => {
      const bru = makeBru({ __name__: 'Staging' });
      bru.deleteEnvVar('never_set');
      expect(bru.envVariables.__name__).toBe('Staging');
    });
  });

  describe('deleteAllEnvVars', () => {
    test('removes every user variable and preserves __name__', () => {
      const bru = makeBru({ __name__: 'Staging', a: '1', b: '2' });
      bru.deleteAllEnvVars();
      expect(bru.envVariables).toEqual({ __name__: 'Staging' });
    });

    test('works on an environment with no __name__', () => {
      const bru = makeBru({ a: '1', b: '2' });
      bru.deleteAllEnvVars();
      expect(bru.envVariables).toEqual({});
    });

    test('does not throw when a user variable shadows hasOwnProperty', () => {
      // The old loop called `this.envVariables.hasOwnProperty(key)`. A script doing
      // `bru.setEnvVar('hasOwnProperty', 'x')` shadowed Object.prototype.hasOwnProperty,
      // so the loop threw "is not a function" and left the environment half-deleted.
      const bru = makeBru({ __name__: 'Staging', hasOwnProperty: 'shadowed', token: 'abc' });

      expect(() => bru.deleteAllEnvVars()).not.toThrow();
      expect(bru.envVariables).toEqual({ __name__: 'Staging' });
    });

    test('does not throw when a user variable shadows hasOwnProperty with a non-callable', () => {
      const bru = makeBru({ __name__: 'Staging', hasOwnProperty: 42, token: 'abc' });

      expect(() => bru.deleteAllEnvVars()).not.toThrow();
      expect(bru.envVariables).toEqual({ __name__: 'Staging' });
    });
  });

  // Everything left in persistentEnvVariables after the run is merged back into the environment
  // file (bruno-app's mergeAndPersistEnvironment). A delete that only clears envVariables is
  // therefore undone one layer down: the variable is re-added to the .bru file and comes back on
  // the next open, with no error anywhere.
  describe('persisted variables', () => {
    test('deleteEnvVar drops the variable from persistentEnvVariables', () => {
      const bru = makeBru({ __name__: 'Staging' });
      bru.setEnvVar('token', 'abc', { persist: true });

      bru.deleteEnvVar('token');

      expect(bru.envVariables.token).toBeUndefined();
      expect(bru.persistentEnvVariables).toEqual({});
    });

    test('deleteEnvVar leaves other persisted variables alone', () => {
      const bru = makeBru({ __name__: 'Staging' });
      bru.setEnvVar('token', 'abc', { persist: true });
      bru.setEnvVar('refresh', 'xyz', { persist: true });

      bru.deleteEnvVar('token');

      expect(bru.persistentEnvVariables).toEqual({ refresh: 'xyz' });
    });

    test('deleteAllEnvVars clears every persisted variable', () => {
      const bru = makeBru({ __name__: 'Staging' });
      bru.setEnvVar('token', 'abc', { persist: true });
      bru.setEnvVar('refresh', 'xyz', { persist: true });

      bru.deleteAllEnvVars();

      expect(bru.envVariables).toEqual({ __name__: 'Staging' });
      expect(bru.persistentEnvVariables).toEqual({});
    });

    test('deleteAllEnvVars keeps the same persistentEnvVariables object', () => {
      // The runtimes read bru.persistentEnvVariables by reference once the script has finished;
      // clearing must not swap the object out from under them.
      const bru = makeBru({ __name__: 'Staging' });
      const persisted = bru.persistentEnvVariables;
      bru.setEnvVar('token', 'abc', { persist: true });

      bru.deleteAllEnvVars();

      expect(bru.persistentEnvVariables).toBe(persisted);
    });

    test('re-setting a variable after deleting it persists again', () => {
      const bru = makeBru({ __name__: 'Staging' });
      bru.setEnvVar('token', 'abc', { persist: true });
      bru.deleteEnvVar('token');

      bru.setEnvVar('token', 'def', { persist: true });

      expect(bru.persistentEnvVariables).toEqual({ token: 'def' });
    });
  });
});
