const registerAiIpc = require('./ai');

/**
 * AI IPC entry point.
 *
 * Our tree registers most IPC modules individually from src/index.js. This
 * aggregator exists so the AI feature has ONE wiring point: src/index.js only
 * needs `require('./ipc')(mainWindow)` after the main window is created.
 *
 * It used to register a SECOND module here, `./ai/autocomplete`, which owned
 * `renderer:ai-autocomplete` and `renderer:ai-autocomplete-cancel`. Both were
 * removed — see the channel-list comment in ./ai/index.js. The short version:
 * neither had a caller anywhere in packages/bruno-app/src, and preload.js has
 * no channel allowlist, so they were reachable provider exits that nothing
 * used and nothing watched.
 *
 * Registering here is unconditional by design — see the long comment in
 * ./ai/index.js. Every handler re-checks `ai.enabled` on each call, so
 * registration alone can never cause a network request. With default
 * preferences the switch is false and every handler refuses before a provider
 * is constructed.
 */
const registerAllAiIpc = (mainWindow) => {
  registerAiIpc(mainWindow);
};

module.exports = registerAllAiIpc;
module.exports.registerAiIpc = registerAiIpc;
