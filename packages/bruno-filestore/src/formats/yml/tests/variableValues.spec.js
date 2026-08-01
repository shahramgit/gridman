import parseFolder from '../parseFolder';
import stringifyFolder from '../stringifyFolder';
import parseItem from '../parseItem';
import stringifyItem from '../stringifyItem';
import stringifyEnvironment from '../stringifyEnvironment';

const brunoVar = (name, value) => ({ uid: `uid-${name}`, name, value, enabled: true, local: false });

const buildFolderRoot = (reqVars) => ({
  meta: { name: 'My Folder', seq: 1 },
  request: {
    headers: [],
    auth: { mode: 'none' },
    script: { req: null, res: null },
    vars: { req: reqVars, res: [] },
    tests: null
  },
  docs: null
});

const buildHttpItem = (reqVars) => ({
  uid: 'item-uid',
  type: 'http-request',
  name: 'Req',
  seq: 1,
  tags: [],
  request: {
    url: 'https://example.com',
    method: 'GET',
    headers: [],
    params: [],
    auth: { mode: 'none' },
    body: { mode: 'none' },
    script: { req: null, res: null },
    vars: { req: reqVars, res: [] },
    assertions: [],
    tests: null,
    docs: null
  }
});

const byName = (vars) => Object.fromEntries(vars.map((v) => [v.name, v]));

// Scripts can put any value on a collection / folder / request variable, exactly as they
// can on an environment variable (bru.setVar('retries', 0)). The value used to be written
// as `v.value || ''`, so 0 and false became empty strings and objects became
// '[object Object]' - the real value was gone on the next save.
describe('yml variables - non-string values on folder / request vars', () => {
  const nonStringVars = [
    brunoVar('str', 'hello'),
    brunoVar('num', 8080),
    brunoVar('zero', 0),
    brunoVar('flag', true),
    brunoVar('falsy_flag', false),
    brunoVar('obj', { a: 1 }),
    brunoVar('arr', [1, 2, 3]),
    brunoVar('nil', null)
  ];

  it('keeps folder variable values of every type across a round trip', () => {
    const folderRoot = parseFolder(stringifyFolder(buildFolderRoot(nonStringVars)));
    const variables = byName(folderRoot.request.vars.req);

    expect(Object.keys(variables)).toEqual(['str', 'num', 'zero', 'flag', 'falsy_flag', 'obj', 'arr', 'nil']);
    expect(variables.str.value).toBe('hello');
    expect(variables.num.value).toBe('8080');
    expect(variables.zero.value).toBe('0');
    expect(variables.flag.value).toBe('true');
    expect(variables.falsy_flag.value).toBe('false');
    expect(JSON.parse(variables.obj.value)).toEqual({ a: 1 });
    expect(JSON.parse(variables.arr.value)).toEqual([1, 2, 3]);
    expect(variables.nil.value).toBe('');
  });

  it('does not write an object variable out as a nested yml map', () => {
    const ymlString = stringifyFolder(buildFolderRoot([brunoVar('obj', { a: 1 })]));

    expect(ymlString).not.toContain('[object Object]');
    expect(ymlString).not.toMatch(/^\s+a: 1$/m);
  });

  it('keeps request variable values of every type across a round trip', () => {
    const item = parseItem(stringifyItem(buildHttpItem(nonStringVars)));
    const variables = byName(item.request.vars.req);

    expect(variables.zero.value).toBe('0');
    expect(variables.falsy_flag.value).toBe('false');
    expect(JSON.parse(variables.obj.value)).toEqual({ a: 1 });
  });

  it('keeps the datatype annotation and the serialized value together', () => {
    const numberVar = { ...brunoVar('port', 8080), datatype: 'number' };
    const folderRoot = parseFolder(stringifyFolder(buildFolderRoot([numberVar])));

    expect(folderRoot.request.vars.req[0]).toMatchObject({ name: 'port', value: '8080', datatype: 'number' });
  });
});

// A value we cannot encode must abort the save so the previous on-disk value survives.
// Writing a '[object Object]' placeholder instead would silently replace the real value
// with something unrecoverable and indistinguishable from a legitimate string.
describe('yml variables - values that cannot be serialized', () => {
  const circular = () => {
    const value = { name: 'loop' };
    value.self = value;
    return value;
  };

  it('fails the folder save instead of writing a placeholder', () => {
    const folderRoot = buildFolderRoot([brunoVar('cycle', circular())]);

    expect(() => stringifyFolder(folderRoot)).toThrow(/cycle/);
  });

  it('fails the environment save instead of writing a placeholder', () => {
    const environment = {
      uid: 'env-uid',
      name: 'test_env',
      variables: [{ uid: 'v1', name: 'cycle', value: circular(), type: 'text', enabled: true, secret: false }]
    };

    expect(() => stringifyEnvironment(environment)).toThrow(/cycle/);
  });
});
