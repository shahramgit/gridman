import { openCollectionToBruno } from '../src/opencollection/opencollection-to-bruno';
import { fromOpenCollectionFolder, toOpenCollectionFolder } from '../src/opencollection/folder';

/**
 * POST-RESPONSE VARIABLES SURVIVE AN OPENCOLLECTION IMPORT.
 *
 * In opencollection, a post-response variable is an `action`, not a `variable`. The
 * importer read only `request.variables`, so every post-response var was dropped on
 * import — silently, because the request still looked complete afterwards.
 *
 * Ported from usebruno/bruno#8815. Our native yml read/write path (bruno-filestore) was
 * already correct and is not what this covers; the loss was on the import path, which our
 * opencollection importer uses.
 */

const actionFor = (name, expression) => ({
  type: 'set-variable',
  phase: 'after-response',
  selector: { expression, method: 'jsonq' },
  variable: { name, scope: 'runtime' }
});

describe('importing an opencollection', () => {
  it('keeps a COLLECTION-ROOT post-response variable', () => {
    const collection = openCollectionToBruno({
      name: 'C',
      request: {
        variables: [{ name: 'preVar', value: '1' }],
        actions: [actionFor('postVar', 'res.body.id')]
      },
      items: []
    });

    const rootVars = collection.root.request.vars;
    expect(rootVars.req.map((v) => v.name)).toEqual(['preVar']);
    // This was undefined. The collection-level post-response var simply vanished.
    expect(rootVars.res.map((v) => v.name)).toEqual(['postVar']);
  });

  it('keeps a FOLDER-level post-response variable', () => {
    const folder = fromOpenCollectionFolder({
      name: 'F',
      request: { actions: [actionFor('folderVar', 'res.body.token')] }
    });
    expect(folder.root.request.vars.res.map((v) => v.name)).toEqual(['folderVar']);
  });

  it('writes a folder whose ONLY content is post-response vars', () => {
    // The write side had the mirror bug: `actions` was never produced, so such a
    // folder exported with no request block at all and the vars were lost again
    // on the next import.
    const oc = toOpenCollectionFolder({
      name: 'F',
      root: { request: { vars: { res: [{ uid: 'v', name: 'folderVar', value: 'res.body.token', enabled: true }] } } }
    });
    expect(oc.request).toBeDefined();
    expect(oc.request.actions[0].variable.name).toBe('folderVar');
  });

  it('round-trips a folder post-response var without losing it', () => {
    const original = {
      name: 'F',
      root: { request: { vars: { res: [{ uid: 'v', name: 'roundTrip', value: 'res.body.x', enabled: true }] } } }
    };
    const back = fromOpenCollectionFolder(toOpenCollectionFolder(original));
    expect(back.root.request.vars.res.map((v) => v.name)).toEqual(['roundTrip']);
  });

  it('per-REQUEST post-response vars were already correct, and stay correct', () => {
    // items/http.ts always mapped runtime.actions; only the collection-root and
    // folder defaults were dropped. Pinned so a future refactor cannot quietly
    // regress the level that was never broken.
    const collection = openCollectionToBruno({
      name: 'C',
      items: [{
        info: { name: 'R', type: 'http', seq: 1 },
        http: { method: 'GET', url: 'https://api.test/thing' },
        runtime: { actions: [actionFor('itemVar', 'res.body.id')] }
      }]
    });
    expect(collection.items[0].request.vars.res.map((v) => v.name)).toEqual(['itemVar']);
  });
});
