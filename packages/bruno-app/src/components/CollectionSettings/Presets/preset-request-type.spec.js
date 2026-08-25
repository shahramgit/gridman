import { PRESET_REQUEST_TYPES } from 'utils/common/constants';

/**
 * THE PRESET FORM AND THE BUTTON THAT READS IT MUST AGREE.
 *
 * The collection's Presets form WRITES `requestType` into bruno.json and the
 * new-request button READS it back, from two different files, each with its own
 * hard-coded list — and the lists disagreed. The form saved 'ws'; the button
 * switched on 'websocket' and had no default, so choosing WebSocket as the
 * collection preset made the button silently do nothing. Upstream hit the same
 * thing and reported it as #8889.
 *
 * These read both files and require every value one side can produce to be a
 * value the other side handles, so a fifth request type cannot be added to one
 * of them alone.
 */

/* global __dirname */
const fs = require('fs');
const path = require('path');

const read = (...segments) => fs.readFileSync(path.join(__dirname, ...segments), 'utf8');

// The form is two files since the restyle: index.js renders it and
// constants.jsx holds the segmented-control items. The invariant is that
// neither carries a private spelling of a request type.
const PRESETS_FORM = read('index.js') + read('constants.jsx');
const TRANSIENT_BUTTON = read('..', '..', 'CreateTransientRequest', 'index.js');

const KEYS = Object.keys(PRESET_REQUEST_TYPES);

describe('collection preset request types', () => {
  it('covers the four request kinds, so this is not asserting over an empty set', () => {
    expect(KEYS.sort()).toEqual(['GRAPHQL', 'GRPC', 'HTTP', 'WS']);
    expect(PRESET_REQUEST_TYPES.WS).toBe('ws');
  });

  it.each(KEYS)('the transient-request button handles %s', (key) => {
    expect(TRANSIENT_BUTTON).toContain(`REQUEST_TYPE.${key}`);
  });

  it('neither side keeps a private list of spellings', () => {
    // A literal 'websocket' anywhere in either file is the old bug coming back.
    expect(TRANSIENT_BUTTON).not.toMatch(/['"]websocket['"]/);
    expect(PRESETS_FORM).not.toMatch(/['"]websocket['"]/);
    // index.js imports DEFAULT_PRESET_REQUEST_TYPE, constants.jsx imports the
    // map itself — either way the values come from the shared module.
    expect(PRESETS_FORM).toMatch(/PRESET_REQUEST_TYPES|DEFAULT_PRESET_REQUEST_TYPE/);
    expect(TRANSIENT_BUTTON).toContain('PRESET_REQUEST_TYPES');
  });
});
