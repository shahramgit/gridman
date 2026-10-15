import {
  transformCollectionToSaveToExportAsFile,
  transformFolderRootToSave,
  transformRequestToSaveToFilesystem
} from './index';
import { processEnvironmentData } from '../importers/bruno-environment';
import { exportBrunoEnvironment } from '../exporters/bruno-environment';
import { environmentSchema, itemSchema } from '@usebruno/schema';

const hook = { name: 'script:grpc:before-call-start', raw: 'script:grpc:before-call-start {\n  bru.setVar("x", 1);\n}' };
const folder = {
  type: 'folder', uid: 'folder', name: 'Folder', seq: 2, items: [],
  root: { meta: { name: 'Folder', seq: 2, tags: ['api', 'smoke'] }, request: { headers: [] } }
};

it('preserves folder tags when saving the folder and exporting its collection', () => {
  expect(transformFolderRootToSave(folder).meta.tags).toEqual(['api', 'smoke']);
  const exported = transformCollectionToSaveToExportAsFile({
    uid: 'collection', name: 'Collection', root: {}, environments: [], items: [folder]
  });
  expect(exported.items[0].root.meta.tags).toEqual(['api', 'smoke']);
});

it('preserves multipart content types and opaque scripting blocks in JSON export', () => {
  const item = {
    uid: 'request', name: 'Upload', type: 'http-request', seq: 1, unknownBlocks: [hook],
    request: { method: 'POST', url: 'http://localhost', headers: [], params: [], auth: { mode: 'none' },
      body: { mode: 'multipartForm', multipartForm: [{ name: 'payload', type: 'text', value: '{}', contentType: 'application/json', enabled: true }] } }
  };
  const exported = transformCollectionToSaveToExportAsFile({
    uid: 'collection', name: 'Collection', root: {}, environments: [], items: [item]
  });
  expect(exported.items[0].request.body.multipartForm[0].contentType).toBe('application/json');
  expect(exported.items[0].unknownBlocks).toEqual([hook]);
});

it('keeps lifecycle hooks in request drafts and allows saving them through the schema', async () => {
  const item = {
    uid: 'abcdefghijklmnopqrstu', name: 'gRPC', type: 'grpc-request', seq: 1,
    request: { method: '', url: 'localhost:50051', headers: [], auth: { mode: 'none' },
      body: { mode: 'grpc', grpc: [] }, script: { beforeCallStart: 'bru.setVar("x", 1);' }, vars: { req: [], res: [] } }
  };
  const saved = transformRequestToSaveToFilesystem(item);
  expect(saved.request.script.beforeCallStart).toBe('bru.setVar("x", 1);');
  await expect(itemSchema.validate(saved)).resolves.toMatchObject({ request: { script: item.request.script } });
});

it('preserves inheritance through environment JSON import, validation and export', async () => {
  const [environment] = processEnvironmentData({ name: 'Development', extends: ['Base', 'Shared'], variables: [] }, 'env.json');
  environment.uid = 'abcdefghijklmnopqrstu';
  await expect(environmentSchema.validate(environment)).resolves.toMatchObject({ extends: ['Base', 'Shared'] });
  window.ipcRenderer = { invoke: jest.fn().mockResolvedValue(undefined) };
  await exportBrunoEnvironment({ environments: [environment], environmentType: 'collection', filePath: '/tmp/env.json' });
  expect(window.ipcRenderer.invoke.mock.calls[0][1].environments[0].extends).toEqual(['Base', 'Shared']);
});
