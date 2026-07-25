import { transformCollectionToSaveToExportAsFile, isItemARequest } from './index';

// EXACT shape returned by renderer:read-folder-for-export for a YAML-format
// collection (note the empty `items: []` the yml parser adds to REQUESTS)
const ymlRequest = {
  uid: 'u1', type: 'http-request', seq: 1, name: 'Get Users', tags: [],
  request: { url: 'https://jsonplaceholder.typicode.com/users', method: 'GET', headers: [], params: [],
    auth: { mode: 'none' }, body: { mode: 'none' }, script: {}, vars: {}, assertions: [], tests: null, docs: null },
  settings: {}, fileContent: null, root: null, items: [], examples: [],
  filename: 'Get Users.yml', pathname: '/c/YFolder/Get Users.yml', isTransient: false
};

describe('yml-format items are classified as requests (not dropped on export)', () => {
  it('isItemARequest must accept a yml request that carries an empty items array', () => {
    expect(isItemARequest(ymlRequest)).toBe(true);
  });

  it('exports the request instead of dropping it', () => {
    const out = transformCollectionToSaveToExportAsFile({
      uid: 'f1', name: 'YFolder', type: 'collection', root: {}, environments: [], items: [ymlRequest]
    });
    expect(JSON.stringify(out)).toContain('jsonplaceholder.typicode.com/users');
  });
});
