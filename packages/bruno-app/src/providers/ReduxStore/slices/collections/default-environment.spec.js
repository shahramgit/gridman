/**
 * WHICH ENVIRONMENT A COLLECTION OPENS WITH.
 *
 * Two sources, in this order: what the user last chose, and failing that the
 * collection's own `presets.defaultEnvironment`. The preset is a FIRST choice,
 * not an override — a team clones the same collections and lands on the same
 * environment on day one, and after that their own choice wins forever.
 *
 * This runs on mount, which is the only path a lazy collection takes. The
 * older hydrate route fires from onWatcherSetupComplete, which runs on the
 * eager path only, so for any collection over 100 files nothing was restored
 * at all — not the preset and not the remembered choice.
 */

const COLLECTION_UID = 'col-1';

const buildCollection = ({ defaultEnvironment } = {}) => ({
  uid: COLLECTION_UID,
  pathname: '/w/c',
  brunoConfig: defaultEnvironment === undefined ? {} : { presets: { defaultEnvironment } },
  environments: [
    { uid: 'env-dev', name: 'dev' },
    { uid: 'env-staging', name: 'staging' }
  ]
});

const { applyCollectionEnvironmentOnMount } = require('./actions');

const run = ({ collection, uiState }) => {
  const dispatched = [];
  const state = { collections: { collections: [collection] } };
  const dispatch = (action) => {
    dispatched.push(action);
    return action;
  };
  applyCollectionEnvironmentOnMount({ collectionUid: COLLECTION_UID, uiState })(dispatch, () => state);
  return dispatched.filter((a) => a?.type?.includes('selectEnvironment')).map((a) => a.payload);
};

describe('the environment a collection opens with', () => {
  it('uses the preset when the user has never chosen one', () => {
    expect(run({ collection: buildCollection({ defaultEnvironment: 'staging' }), uiState: null }))
      .toEqual([{ environmentUid: 'env-staging', collectionUid: COLLECTION_UID }]);
  });

  it('prefers what the user chose over the preset', () => {
    // The whole point of "default": it must not fight a later choice.
    expect(run({
      collection: buildCollection({ defaultEnvironment: 'staging' }),
      uiState: { selectedEnvironment: 'dev' }
    })).toEqual([{ environmentUid: 'env-dev', collectionUid: COLLECTION_UID }]);
  });

  it('restores the remembered choice when there is no preset', () => {
    expect(run({ collection: buildCollection(), uiState: { selectedEnvironment: 'dev' } }))
      .toEqual([{ environmentUid: 'env-dev', collectionUid: COLLECTION_UID }]);
  });

  it('selects nothing when neither is set', () => {
    expect(run({ collection: buildCollection(), uiState: null })).toEqual([]);
  });

  it('selects nothing when the named environment no longer exists', () => {
    // Renamed or deleted. Landing on an arbitrary environment would send
    // requests somewhere the user did not choose.
    expect(run({ collection: buildCollection({ defaultEnvironment: 'gone' }), uiState: null })).toEqual([]);
    expect(run({ collection: buildCollection(), uiState: { selectedEnvironment: 'gone' } })).toEqual([]);
  });

  it('does nothing for a collection that is not in the store', () => {
    const dispatched = [];
    applyCollectionEnvironmentOnMount({ collectionUid: 'missing', uiState: { selectedEnvironment: 'dev' } })(
      (a) => dispatched.push(a),
      () => ({ collections: { collections: [] } })
    );
    expect(dispatched).toEqual([]);
  });
});
