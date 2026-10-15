import postmanToBruno, { processAuth } from '../src/postman/postman-to-bruno';
import postmanEnvToBruno from '../src/postman/postman-env-to-bruno-env';
import { brunoToPostman } from '../src/postman/bruno-to-postman';
import { brunoToOpenCollection, openCollectionToBruno, fromOpenCollectionHttpItem, toOpenCollectionHttpItem, fromOpenCollectionGraphqlItem, toOpenCollectionGraphqlItem, fromOpenCollectionGrpcItem, toOpenCollectionGrpcItem, fromOpenCollectionFolder, toOpenCollectionFolder } from '../src/opencollection';
import translate from '../src/utils/postman-to-bruno-translator';

const postmanCollection = (extra = {}) => ({
  info: { name: 'Compatibility', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [],
  ...extra
});

describe('upstream converter corrections', () => {
  it('defaults omitted/null Postman environment flags and keeps explicit false', async () => {
    const env = await postmanEnvToBruno({ name: 'Imported', values: [
      { key: 'omitted', value: 'a' },
      { key: 'null', value: 'b', enabled: null },
      { key: 'disabled', value: 'c', enabled: false }
    ] });
    expect(env.variables.map(({ enabled }) => enabled)).toEqual([true, true, false]);
  });

  it('preserves disabled collection variables through Postman import/export', async () => {
    const imported = await postmanToBruno(postmanCollection({ variable: [
      { key: 'disabled', value: 'a', disabled: true },
      { key: 'enabled', value: 'b', disabled: false },
      { key: 'default', value: 'c' }
    ] }));
    expect(imported.root.request.vars.req.map(({ enabled }) => enabled)).toEqual([false, true, true]);
    const exported = brunoToPostman(imported);
    expect(exported.variable).toEqual([
      { key: 'disabled', value: 'a', type: 'default', disabled: true },
      { key: 'enabled', value: 'b', type: 'default' },
      { key: 'default', value: 'c', type: 'default' }
    ]);
  });

  it.each([
    [{}, 'header', 'Bearer'],
    [{ addTokenTo: 'header' }, 'header', 'Bearer'],
    [{ addTokenTo: 'queryParams' }, 'url', ''],
    [{ addTokenTo: 'header', headerPrefix: '' }, 'header', ''],
    [{ addTokenTo: 'header', headerPrefix: 'Token' }, 'header', 'Token']
  ])('keeps OAuth2 defaults and explicit prefixes for %j', (oauth2, placement, prefix) => {
    const request = { auth: {} };
    processAuth({ type: 'oauth2', oauth2 }, request);
    expect(request.auth.oauth2).toMatchObject({
      tokenPlacement: placement, tokenHeaderPrefix: prefix, tokenQueryKey: 'access_token'
    });
  });

  it.each([0, 105, 1e21, 3.5])('imports a valid Postman redirect count %s', async (value) => {
    const imported = await postmanToBruno(postmanCollection({ item: [{
      name: 'Request', request: { method: 'GET', url: 'https://example.com' }, protocolProfileBehavior: { maxRedirects: value }
    }] }));
    expect(imported.items[0].settings.maxRedirects).toBe(Math.trunc(value));
  });

  it.each([-1, Infinity, NaN, true, 'invalid'])('keeps requests with an invalid Postman redirect count %s', async (value) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const imported = await postmanToBruno(postmanCollection({ item: [{
        name: 'Request', request: { method: 'GET', url: 'https://example.com' }, protocolProfileBehavior: { maxRedirects: value }
      }] }));
      expect(imported.items).toHaveLength(1);
      expect(imported.items[0].settings.maxRedirects).toBeUndefined();
      expect(warn).toHaveBeenCalledWith('Invalid Postman maxRedirects ignored: expected a finite number of 0 or more.');
    } finally {
      warn.mockRestore();
    }
  });

  it('round-trips multipart content types and disabled states through opencollection', () => {
    const source = { info: { name: 'Request' }, http: { method: 'POST', url: 'https://example.com', body: { type: 'multipart-form', data: [
      { name: 'metadata', type: 'text', value: '{}', contentType: 'application/json' },
      { name: 'photo', type: 'file', value: ['photo.png'], contentType: 'image/png', disabled: true },
      { name: 'empty', type: 'text', value: '', contentType: '  ' }
    ] } } };
    const imported = fromOpenCollectionHttpItem(source);
    const exported = toOpenCollectionHttpItem(imported);
    expect(exported.http.body.data).toEqual([
      { name: 'metadata', type: 'text', value: '{}', contentType: 'application/json' },
      { name: 'photo', type: 'file', value: ['photo.png'], contentType: 'image/png', disabled: true },
      { name: 'empty', type: 'text', value: '' }
    ]);
  });

  it('round-trips runtime certificate type names while using OpenCollection certificate names externally', () => {
    const source = { name: 'Certificates', items: [], environments: [], brunoConfig: { clientCertificates: { certs: [
      { type: 'cert', domain: 'api.test', certFilePath: 'client.pem', keyFilePath: 'client.key', passphrase: 'pem-pass', disabled: true },
      { type: 'pfx', domain: 'other.test', pfxFilePath: 'client.pfx', passphrase: 'pfx-pass' }
    ] } } };
    const exported = brunoToOpenCollection(source);
    expect(exported.config.clientCertificates.map(({ type }) => type)).toEqual(['pem', 'pkcs12']);
    const imported = openCollectionToBruno(exported);
    expect(imported.brunoConfig.clientCertificates.certs).toEqual(source.brunoConfig.clientCertificates.certs);
  });

  it('preserves environment inheritance references through OpenCollection conversion', () => {
    const source = { name: 'Environments', items: [], environments: [{ uid: 'env', name: 'Dev', extends: ['Shared', 'Base'], variables: [] }] };
    const exported = brunoToOpenCollection(source);
    const imported = openCollectionToBruno(exported);
    expect(imported.environments[0].extends).toEqual(['Shared', 'Base']);
  });

  it('uses the native folder metadata contract for imported and exported tags', () => {
    const imported = fromOpenCollectionFolder({ info: { name: 'Auth', type: 'folder', tags: ['smoke', 'regression'] } });
    expect(imported.root.meta.tags).toEqual(['smoke', 'regression']);
    expect(toOpenCollectionFolder(imported).info.tags).toEqual(['smoke', 'regression']);
    expect(toOpenCollectionFolder({ ...imported, tags: ['legacy'], root: undefined }).info.tags).toEqual(['legacy']);
  });

  it('preserves all newer gRPC hooks through OpenCollection import/export without execution', () => {
    const hooks = ['before-call-start', 'before-message-send', 'after-message-receive', 'after-call-end'];
    const scripts = hooks.map((hook) => ({ type: 'grpc:' + hook, code: 'console.log("' + hook + '");' }));
    const imported = fromOpenCollectionGrpcItem({ info: { name: 'RPC' }, grpc: { url: 'localhost:50051', method: 'Service/Method' }, runtime: { scripts } });
    const exported = toOpenCollectionGrpcItem(imported);
    expect(exported.runtime.scripts).toEqual(scripts);
  });

  it('preserves lifecycle-only collection and folder defaults through OpenCollection export', () => {
    const scripts = [{ type: 'grpc:before-call-start', code: 'console.log("start");' }];
    const source = {
      opencollection: '1.0.0', info: { name: 'Collection' },
      request: { scripts },
      items: [{ info: { name: 'Folder', type: 'folder' }, request: { scripts } }]
    };
    const imported = openCollectionToBruno(source);
    const exported = brunoToOpenCollection(imported);
    expect(exported.request.scripts).toEqual(scripts);
    expect(exported.items[0].request.scripts).toEqual(scripts);
  });

  for (const [type, fromOpenCollection, toOpenCollection] of [
    ['http', fromOpenCollectionHttpItem, toOpenCollectionHttpItem],
    ['graphql', fromOpenCollectionGraphqlItem, toOpenCollectionGraphqlItem]
  ]) {
    it.each([0, 105, 1e21, 3.5, -1, Infinity, NaN])(type + ' normalizes redirects during import and export: %s', (value) => {
      const imported = fromOpenCollection({ info: { name: 'Request' }, [type]: { method: 'GET', url: 'https://example.com' }, settings: { maxRedirects: value } });
      const expected = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 5;
      expect(imported.settings.maxRedirects).toBe(expected);
      imported.settings.maxRedirects = value;
      const exported = toOpenCollection(imported);
      expect(exported.settings.maxRedirects).toBe(expected);
    });
  }

  it('translates legacy Postman global variable APIs to existing Bruno APIs', () => {
    const source = 'postman.setGlobalVariable("key", "value");\npostman.getGlobalVariable("key");\npostman.clearGlobalVariable("key");\npostman.clearGlobalVariables();\npostman.clearEnvironmentVariables();';
    const result = translate(source);
    for (const method of ['setGlobalEnvVar', 'getGlobalEnvVar', 'deleteGlobalEnvVar', 'deleteAllGlobalEnvVars', 'deleteAllEnvVars']) {
      expect(result).toContain('bru.' + method + '(');
    }
  });
});
