import parseEnvironment from '../parseEnvironment';
import stringifyEnvironment from '../stringifyEnvironment';

const byName = (env) => Object.fromEntries(env.variables.map((v) => [v.name, v]));

// Scripts can put non-strings into an environment (bru.setEnvVar('port', 8080)).
// These used to be filtered out of the yml, deleting the variable from the file.
describe('yml stringifyEnvironment - non-string values', () => {
  it('keeps every variable on a round trip, whatever the value type is', () => {
    const environment = {
      uid: 'env-uid',
      name: 'test_env',
      variables: [
        { uid: 'v1', name: 'str', value: 'hello', type: 'text', enabled: true, secret: false },
        { uid: 'v2', name: 'num', value: 8080, type: 'text', enabled: true, secret: false },
        { uid: 'v3', name: 'zero', value: 0, type: 'text', enabled: true, secret: false },
        { uid: 'v4', name: 'bool', value: true, type: 'text', enabled: true, secret: false },
        { uid: 'v5', name: 'falsy_bool', value: false, type: 'text', enabled: true, secret: false },
        { uid: 'v6', name: 'obj', value: { scope: 'env' }, type: 'text', enabled: true, secret: false },
        { uid: 'v7', name: 'arr', value: [1, 2, 3], type: 'text', enabled: true, secret: false },
        { uid: 'v8', name: 'nil', value: null, type: 'text', enabled: true, secret: false }
      ]
    };

    const variables = byName(parseEnvironment(stringifyEnvironment(environment)));

    expect(Object.keys(variables)).toEqual(['str', 'num', 'zero', 'bool', 'falsy_bool', 'obj', 'arr', 'nil']);
    expect(variables.str.value).toBe('hello');
    expect(variables.num.value).toBe('8080');
    expect(variables.zero.value).toBe('0');
    expect(variables.bool.value).toBe('true');
    expect(variables.falsy_bool.value).toBe('false');
    expect(JSON.parse(variables.obj.value)).toEqual({ scope: 'env' });
    expect(JSON.parse(variables.arr.value)).toEqual([1, 2, 3]);
    expect(variables.nil.value).toBe('');
  });

  it('preserves the disabled flag on a non-string variable', () => {
    const environment = {
      uid: 'env-uid',
      name: 'test_env',
      variables: [{ uid: 'v1', name: 'num', value: 42, type: 'text', enabled: false, secret: false }]
    };

    const variables = byName(parseEnvironment(stringifyEnvironment(environment)));

    expect(variables.num).toMatchObject({ value: '42', enabled: false });
  });

  it('still writes a datatype annotated value as { type, data } when the value is not a string', () => {
    const environment = {
      uid: 'env-uid',
      name: 'test_env',
      variables: [
        { uid: 'v1', name: 'num', value: 300, type: 'text', enabled: true, secret: false, datatype: 'number' }
      ]
    };

    const ymlString = stringifyEnvironment(environment);
    expect(ymlString).toContain('type: number');

    const variables = byName(parseEnvironment(ymlString));
    expect(variables.num).toMatchObject({ value: '300', datatype: 'number' });
  });
});
