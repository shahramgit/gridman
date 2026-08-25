import parseCollection from './parseCollection';
import stringifyCollection from './stringifyCollection';

/**
 * A COLLECTION CAN NAME THE ENVIRONMENT IT OPENS WITH.
 *
 * The preset is a first choice, not an override, and it lives in the
 * collection file so it travels with the repo — which is the point for a team
 * where everyone clones the same collections and picks the same environment on
 * day one.
 *
 * The write side has a shape trap: presets used to imply a `request` block, so
 * a collection with ONLY a default environment would emit `request: {}` and
 * read back as "presets exist but say nothing".
 */

const config = (presets: Record<string, string>) => ({ name: 'C', type: 'collection', presets });
const roundTrip = (presets: Record<string, string>) =>
  parseCollection(stringifyCollection({}, config(presets)))?.brunoConfig?.presets;

describe('presets.defaultEnvironment', () => {
  it('survives a write and read alongside the request presets', () => {
    expect(roundTrip({ requestType: 'ws', requestUrl: 'https://x.internal', defaultEnvironment: 'staging' }))
      .toEqual({ requestType: 'ws', requestUrl: 'https://x.internal', defaultEnvironment: 'staging' });
  });

  it('survives on its own, with no request presets set', () => {
    expect(roundTrip({ defaultEnvironment: 'staging' })?.defaultEnvironment).toBe('staging');
  });

  it('does not write an empty request block when only the environment is set', () => {
    const yml = stringifyCollection({}, config({ defaultEnvironment: 'staging' }));
    expect(yml).toContain('defaultEnvironment: staging');
    expect(yml).not.toMatch(/request:\s*\{\s*\}/);
    expect(yml).not.toMatch(/request:\s*\n\s*defaultEnvironment/);
  });

  it('writes nothing when no preset is set at all', () => {
    expect(stringifyCollection({}, config({}))).not.toContain('presets');
  });

  it('keeps the request presets working on their own, as before', () => {
    // No `defaultEnvironment` key at all — the shape a collection that has
    // never used the feature has always had.
    expect(roundTrip({ requestType: 'graphql', requestUrl: 'https://x.internal' }))
      .toEqual({ requestType: 'graphql', requestUrl: 'https://x.internal' });
  });

  it('reads a file that predates the field', () => {
    // Written by a build before this existed: presets with a request block and
    // no defaultEnvironment key.
    const legacy = [
      'opencollection: 1.0.0',
      '',
      'info:',
      '  name: C',
      'extensions:',
      '  bruno:',
      '    presets:',
      '      request:',
      '        type: http',
      '        url: https://x.internal',
      ''
    ].join('\n');
    const presets = parseCollection(legacy)?.brunoConfig?.presets;
    expect(presets?.requestType).toBe('http');
    expect(presets).not.toHaveProperty('defaultEnvironment');
  });
});
