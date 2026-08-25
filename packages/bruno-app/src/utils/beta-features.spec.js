/* global __dirname */
const fs = require('fs');
const path = require('path');
const { BETA_FEATURES } = require('./beta-features');

/**
 * A BETA FLAG THE USER CANNOT TURN ON IS A FEATURE THAT DOES NOT SHIP.
 *
 * A flag lives in three places that do not import each other: the electron
 * preferences defaults and schema, this id registry, and the list Preferences >
 * Beta actually renders. `mock-server` shipped in all of the code and NONE of
 * the toggles — the engine ran, the sidebar section existed, and no user could
 * reach either. Same shape as the AI's dead 'app' content type.
 *
 * These read the real sources so the three cannot drift apart again.
 */

const PREFERENCES_BETA_UI = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'Preferences', 'Beta', 'index.js'),
  'utf8'
);
const ELECTRON_PREFERENCES = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'bruno-electron', 'src', 'store', 'preferences.js'),
  'utf8'
);

// Every entry is a user-facing toggle. A `nodevm` id used to sit here reading
// nothing: the sandbox runtime is per-collection `securityConfig.jsSandboxMode`
// and the main process has no beta preference by that name.
const ids = Object.values(BETA_FEATURES);
const TOGGLEABLE = ids;

describe('beta features are reachable', () => {
  it('has features to check, so this cannot pass by matching nothing', () => {
    expect(TOGGLEABLE.length).toBeGreaterThan(1);
    expect(TOGGLEABLE).toContain('mock-server');
  });

  it.each(TOGGLEABLE)('%s is rendered in Preferences > Beta', (id) => {
    const key = Object.keys(BETA_FEATURES).find((k) => BETA_FEATURES[k] === id);
    expect(PREFERENCES_BETA_UI).toContain(`BETA_FEATURE_IDS.${key}`);
  });

  it.each(ids)('%s has a default and a schema entry in the main process', (id) => {
    // Without the default, the flag reads as undefined until the user touches
    // it; without the schema entry, saving preferences strips it back out.
    const occurrences = ELECTRON_PREFERENCES.split(`'${id}'`).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('renders nothing Preferences invented on its own', () => {
    // A row whose id is not in the registry toggles a preference nothing reads.
    const rendered = [...PREFERENCES_BETA_UI.matchAll(/BETA_FEATURE_IDS\.([A-Z_]+)/g)].map((m) => m[1]);
    for (const key of rendered) expect(Object.keys(BETA_FEATURES)).toContain(key);
  });
});
