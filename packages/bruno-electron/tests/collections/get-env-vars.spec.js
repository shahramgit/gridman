const { getEnvVars } = require('../../src/utils/collection');

// A plain variable and a secret can legitimately carry the same name — they live
// on separate tabs in the environment editor, so nothing stops a user (or a merged
// environment file) from having both. getEnvVars flattens them into one last-wins
// map that interpolation resolves against, so the ordering decides which value the
// request actually sends. upstream bruno #8679 (ef19c6995)
describe('getEnvVars — a secret always wins a name collision', () => {
  it('resolves to the secret when the plain variable comes last in the file', () => {
    const environment = {
      name: 'Local',
      variables: [
        { name: 'token', value: 'super-secret-value', secret: true, enabled: true },
        { name: 'token', value: '', secret: false, enabled: true }
      ]
    };

    // Without secret-last ordering this is '' and the request goes out
    // unauthenticated.
    expect(getEnvVars(environment).token).toBe('super-secret-value');
  });

  it('resolves to the secret when the plain variable comes first in the file', () => {
    const environment = {
      name: 'Local',
      variables: [
        { name: 'token', value: 'placeholder', secret: false, enabled: true },
        { name: 'token', value: 'super-secret-value', secret: true, enabled: true }
      ]
    };

    expect(getEnvVars(environment).token).toBe('super-secret-value');
  });

  it('leaves unrelated variables and the disabled rule alone', () => {
    const environment = {
      name: 'Local',
      variables: [
        { name: 'host', value: 'https://api.example.com', enabled: true },
        { name: 'unused', value: 'nope', enabled: false },
        { name: 'token', value: 'secret', secret: true, enabled: true }
      ]
    };

    const vars = getEnvVars(environment);
    expect(vars.host).toBe('https://api.example.com');
    expect(vars.unused).toBeUndefined();
    expect(vars.__name__).toBe('Local');
  });

  it('a disabled secret does not blank an enabled plain variable of the same name', () => {
    const environment = {
      name: 'Local',
      variables: [
        { name: 'token', value: 'plain-value', enabled: true },
        { name: 'token', value: '', secret: true, enabled: false }
      ]
    };

    expect(getEnvVars(environment).token).toBe('plain-value');
  });
});
