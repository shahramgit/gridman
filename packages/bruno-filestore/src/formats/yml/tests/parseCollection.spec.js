import parseCollection from '../parseCollection';

const collectionYml = (presets) => `opencollection: 1.0.0
info:
  name: My Collection
extensions:
  bruno:
    ignore:
      - node_modules
      - .git
${presets}
`;

describe('yml parseCollection - presets', () => {
  it('reads request type and url as strings', () => {
    const { brunoConfig } = parseCollection(
      collectionYml(`    presets:
      request:
        type: graphql
        url: https://example.com/graphql`)
    );

    expect(brunoConfig.presets).toEqual({
      requestType: 'graphql',
      requestUrl: 'https://example.com/graphql'
    });
  });

  it('defaults the missing preset fields to empty strings, not empty arrays', () => {
    const { brunoConfig } = parseCollection(
      collectionYml(`    presets:
      request:
        type: http`)
    );

    expect(brunoConfig.presets).toEqual({
      requestType: 'http',
      requestUrl: ''
    });
    expect(Array.isArray(brunoConfig.presets.requestUrl)).toBe(false);
  });

  it('defaults both preset fields to empty strings when the request block is empty', () => {
    const { brunoConfig } = parseCollection(
      collectionYml(`    presets:
      request: {}`)
    );

    expect(brunoConfig.presets).toEqual({
      requestType: '',
      requestUrl: ''
    });
    expect(Array.isArray(brunoConfig.presets.requestType)).toBe(false);
    expect(Array.isArray(brunoConfig.presets.requestUrl)).toBe(false);
  });

  it('does not set presets when there is no presets block', () => {
    const { brunoConfig } = parseCollection(collectionYml(''));

    expect(brunoConfig.presets).toBeUndefined();
    expect(brunoConfig.ignore).toEqual(['node_modules', '.git']);
  });
});
