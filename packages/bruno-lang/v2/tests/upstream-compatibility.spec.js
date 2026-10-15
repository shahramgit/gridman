const { bruToJsonV2, bruToEnvJsonV2, envJsonToBruV2, collectionBruToJson, jsonToCollectionBru } = require('../../src');

describe('shared Bruno 4.2 files', () => {
  it('parses NTLM credentials when the optional domain is absent', () => {
    const parsed = bruToJsonV2('auth:ntlm {\n  username: alice\n  password: password\n}\n');
    expect(parsed.auth.ntlm).toEqual({ username: 'alice', password: 'password', domain: '' });
  });

  it.each(['1e+21', '0', '105', '3.5'])('reads maxRedirects %s without exponent truncation', (value) => {
    const parsed = bruToJsonV2('settings {\n  maxRedirects: ' + value + '\n}\n');
    expect(parsed.settings.maxRedirects).toBe(Math.trunc(Number(value)));
  });

  it.each(['-1', 'Infinity', 'NaN', 'invalid', ''])('leaves invalid maxRedirects %s unset', (value) => {
    const parsed = bruToJsonV2('settings {\n  maxRedirects: ' + value + '\n}\n');
    expect(parsed.settings?.maxRedirects).toBeUndefined();
  });

  it('round-trips inheritance references alongside color and variable annotations', () => {
    const references = ['Shared', 'API base', 'name, with delimiter', 'name "quoted"', 'path\\name'];
    const source = envJsonToBruV2({
      extends: references,
      color: '#abc',
      variables: [{ name: 'token', value: '', enabled: true, secret: true, annotations: [{ name: 'description', value: 'API token' }] }]
    });
    const parsed = bruToEnvJsonV2(source);
    expect(parsed.extends).toEqual(references);
    expect(parsed.color).toBe('#abc');
    expect(parsed.variables[0]).toMatchObject({ name: 'token', secret: true, annotations: [{ name: 'description', value: 'API token' }] });
    expect(bruToEnvJsonV2(envJsonToBruV2(parsed))).toEqual(parsed);
  });

  it('accepts a scalar reference after a color line without swallowing it', () => {
    expect(bruToEnvJsonV2('color: blue\nextends: Shared Base\nvars {\n  key: value\n}\n')).toMatchObject({
      color: 'blue', extends: 'Shared Base', variables: [{ name: 'key', value: 'value' }]
    });
  });

  it('round-trips folder tag lists while preserving unknown blocks', () => {
    const source = 'meta {\n  name: Auth\n  seq: 2\n  tags: [\n    smoke\n    regression\n  ]\n}\nfuture {\n  enabled: true\n}\n';
    const parsed = collectionBruToJson(source);
    expect(parsed.meta.tags).toEqual(['smoke', 'regression']);
    const roundTripped = collectionBruToJson(jsonToCollectionBru(parsed));
    expect(roundTripped.meta).toEqual(parsed.meta);
    expect(roundTripped.unknownBlocks).toEqual(parsed.unknownBlocks);
  });
});
