import { parseEnvironment, stringifyEnvironment, parseFolder, stringifyFolder, parseRequest, stringifyRequest, parseCollection, stringifyCollection } from './index';

describe('native format forward compatibility', () => {
  it('keeps native YAML client certificate type maps and disabled flags', async () => {
    const config = { name: 'Certificates', clientCertificates: { certs: [
      { type: 'cert', domain: 'api.test', certFilePath: 'client.pem', keyFilePath: 'client.key', passphrase: 'pem-pass', disabled: true },
      { type: 'pfx', domain: 'other.test', pfxFilePath: 'client.pfx', passphrase: 'pfx-pass', disabled: true }
    ] } };
    const source = stringifyCollection({} as any, config, { format: 'yml' });
    const parsed = await parseCollection(source, { format: 'yml' });
    expect(parsed.brunoConfig.clientCertificates).toEqual(config.clientCertificates);
  });

  for (const format of ['bru', 'yml'] as const) {
    it(format + ' preserves environment inheritance metadata across real filestore saves', async () => {
      const source = format === 'bru'
        ? 'color: blue\nextends [\n  Shared Base,\n  "API, team"\n]\nvars {\n  key: value\n}\n'
        : 'name: Development\ncolor: blue\nextends:\n  - Shared Base\n  - API, team\nvariables:\n  - name: key\n    value: value\n';
      const parsed = await parseEnvironment(source, { format });
      parsed.name = 'Development';
      parsed.variables[0].value = 'edited';
      const result = await parseEnvironment(stringifyEnvironment(parsed, { format }), { format });
      expect(result.extends).toEqual(['Shared Base', 'API, team']);
      expect(result.color).toBe('blue');
      expect(result.variables[0].value).toBe('edited');
    });

    it(format + ' preserves new folder tags during unrelated saves', async () => {
      const source = format === 'bru'
        ? 'meta {\n  name: Auth\n  seq: 2\n  tags: [\n    smoke\n    regression\n  ]\n}\n'
        : 'info:\n  name: Auth\n  type: folder\n  seq: 2\n  tags:\n    - smoke\n    - regression\n';
      const parsed = await parseFolder(source, { format });
      parsed.docs = 'edited docs';
      const result = await parseFolder(stringifyFolder(parsed, { format }), { format });
      expect(result.meta.tags).toEqual(['smoke', 'regression']);
      expect(result.docs).toBe('edited docs');
    });
  }

  it('preserves unsupported gRPC hooks through .bru/YAML conversions without duplicate blocks', async () => {
    const raw = 'script:grpc:before-call-start {\n  console.log("before");\n}';
    const parsed = await parseRequest('meta {\n  name: RPC\n  type: grpc\n  seq: 1\n}\ngrpc {\n  url: localhost:50051\n  method: Service/Method\n}\n' + raw, { format: 'bru' });
    expect(parsed.request.script.beforeCallStart).toBe('console.log("before");');
    const result = await parseRequest(stringifyRequest(parsed, { format: 'bru' }), { format: 'bru' });
    expect(result.request.script.beforeCallStart).toBe(parsed.request.script.beforeCallStart);
    const asYml = await parseRequest(stringifyRequest(parsed, { format: 'yml' }), { format: 'yml' });
    expect(asYml.request.script.beforeCallStart).toBe(parsed.request.script.beforeCallStart);
    const bru = stringifyRequest(asYml, { format: 'bru' });
    expect(bru.match(/script:grpc:before-call-start/g)).toHaveLength(1);
    expect((await parseRequest(bru, { format: 'bru' })).request.script.beforeCallStart).toBe(parsed.request.script.beforeCallStart);
  });

  it('preserves unsupported gRPC YAML hooks and leaves the normal scripts intact', async () => {
    const source = 'info:\n  name: RPC\n  type: grpc\ngrpc:\n  url: localhost:50051\n  method: Service/Method\nruntime:\n  scripts:\n    - type: grpc:before-call-start\n      code: console.log("before");\n    - type: grpc:after-message-receive\n      code: console.log("message");\n    - type: before-request\n      code: console.log("normal");\n';
    const parsed = await parseRequest(source, { format: 'yml' });
    const result = await parseRequest(stringifyRequest(parsed, { format: 'yml' }), { format: 'yml' });
    expect(result.request.script).toEqual({
      req: 'console.log("normal");', res: null,
      beforeCallStart: 'console.log("before");',
      afterMessageReceive: 'console.log("message");'
    });
  });

  it('preserves all four gRPC hook bodies across native formats', async () => {
    const hooks = [
      ['before-call-start', 'beforeCallStart'], ['before-message-send', 'beforeMessageSend'],
      ['after-message-receive', 'afterMessageReceive'], ['after-call-end', 'afterCallEnd']
    ];
    const source = 'meta {\n  name: RPC\n  type: grpc\n}\ngrpc {\n  url: localhost:50051\n  method: Service/Method\n}\n'
      + hooks.map(([name]) => 'script:grpc:' + name + ' {\n  console.log("' + name + '");\n}').join('\n');
    const fromBru = await parseRequest(source, { format: 'bru' });
    const fromYml = await parseRequest(stringifyRequest(fromBru, { format: 'yml' }), { format: 'yml' });
    const result = await parseRequest(stringifyRequest(fromYml, { format: 'bru' }), { format: 'bru' });
    for (const [name, key] of hooks) {
      expect(result.request.script[key]).toBe('console.log("' + name + '");');
    }
  });

  for (const kind of ['folder', 'collection']) {
    it('preserves lifecycle-only ' + kind + ' defaults through .bru/YAML conversions', async () => {
      const parse = async (source: string, format: 'bru' | 'yml') => {
        const parsed = kind === 'folder'
          ? await parseFolder(source, { format })
          : await parseCollection(source, { format });
        return kind === 'collection' && format === 'yml' ? parsed.collectionRoot : parsed;
      };
      const stringify = (root: any, format: 'bru' | 'yml') => kind === 'folder'
        ? stringifyFolder(root, { format })
        : stringifyCollection(root, { name: 'Collection' } as any, { format });
      const source = (kind === 'folder' ? 'meta {\n  name: Folder\n}\n' : '')
        + 'script:grpc:before-call-start {\n  console.log("start");\n}\n'
        + 'script:grpc:after-call-end {\n  console.log("end");\n}\n';
      const fromBru = await parse(source, 'bru');
      const fromYml = await parse(stringify(fromBru, 'yml'), 'yml');
      const result = await parse(stringify(fromYml, 'bru'), 'bru');
      expect(result.request.script).toMatchObject({
        beforeCallStart: 'console.log("start");',
        afterCallEnd: 'console.log("end");'
      });
    });
  }

  for (const requestType of ['http', 'graphql']) {
    it.each([0, 105, 1e21, 3.5, -1, Infinity, NaN, 'invalid'])(requestType + ' YAML normalizes redirect setting %s on write/read', async (value) => {
      const parsed = await parseRequest('info:\n  name: Request\n  type: ' + requestType + '\n' + requestType + ':\n  url: https://example.com\n  method: GET\n', { format: 'yml' });
      parsed.settings = { maxRedirects: value };
      const result = await parseRequest(stringifyRequest(parsed, { format: 'yml' }), { format: 'yml' });
      expect(result.settings.maxRedirects).toBe(typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 5);
    });
  }

  for (const format of ['bru', 'yml'] as const) {
    it(format + ' retains multipart content types', async () => {
      const item = await parseRequest('info:\n  name: Multipart\n  type: http\nhttp:\n  url: https://example.com\n  method: POST\n', { format: 'yml' });
      item.request.body = { mode: 'multipartForm', multipartForm: [
        { uid: 'text', name: 'metadata', type: 'text', value: '{}', contentType: 'application/json', enabled: true },
        { uid: 'file', name: 'photo', type: 'file', value: ['photo.png'], contentType: 'image/png', enabled: false }
      ] };
      const result = await parseRequest(stringifyRequest(item, { format }), { format });
      expect(result.request.body.multipartForm).toEqual([
        expect.objectContaining({ name: 'metadata', contentType: 'application/json', enabled: true }),
        expect.objectContaining({ name: 'photo', contentType: 'image/png', enabled: false })
      ]);
    });
  }
});
