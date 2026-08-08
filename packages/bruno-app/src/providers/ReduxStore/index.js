import { configureStore } from '@reduxjs/toolkit';
import { setAutoFreeze } from 'immer';
import { initPerfLogging } from 'utils/common/perfLogger';
import tasksMiddleware from './middlewares/tasks/middleware';
import debugMiddleware from './middlewares/debug/middleware';
import perfActionsMiddleware from './middlewares/perfActions/middleware';
import appReducer from './slices/app';
import collectionsReducer from './slices/collections';
import tabsReducer from './slices/tabs';
import notificationsReducer from './slices/notifications';
import globalEnvironmentsReducer from './slices/global-environments';
import logsReducer from './slices/logs';
import performanceReducer from './slices/performance';
import workspacesReducer from './slices/workspaces';
import apiSpecReducer from './slices/apiSpec';
import openapiSyncReducer from './slices/openapi-sync';
import workflowsReducer from './slices/workflows';
import historyReducer from './slices/history';
import aiReducer from './slices/ai';
import historyMiddleware from './middlewares/history/middleware';
import { draftDetectMiddleware } from './middlewares/draft/middleware';
import { autosaveMiddleware } from './middlewares/autosave/middleware';

/**
 * Build mode, read WITHOUT `import.meta`.
 *
 * `import.meta.env.MODE` is a syntax form babel-jest emits verbatim into
 * CommonJS, so Node throws `Cannot use 'import.meta' outside a module` the
 * moment a test imports this module. That made the real store untestable, and
 * the AI reducer-registration test was written against the file's SOURCE TEXT
 * as a result — a test that stayed green when the registration was commented
 * out. Asserting on the configured store instead is only possible if the store
 * can be imported, so the mode lookup has to survive a CommonJS transform.
 *
 * WHY `process.env.NODE_ENV` IS SAFE HERE — this gates the redux debug
 * middleware and initPerfLogging for the WHOLE app, not just AI, so "rsbuild
 * probably defines it" was not good enough. Established by READING this repo's
 * pinned toolchain rather than by running a build, so anyone can re-check it
 * the same way, at these exact locations:
 *
 *  1. `-m production` on the build script becomes `config.mode`
 *     (@rsbuild/core@1.1.2/dist/index.js:6870), and `rsbuild dev` leaves it
 *     unset. `prepareCli` (…:6975-6981) sets `process.env.NODE_ENV` to
 *     'production' for `build`/`preview` and 'development' otherwise.
 *  2. `normalizeConfig` (…:1997-2002) resolves rsbuild's mode: `config.mode`
 *     wins, else NODE_ENV when it is 'production'/'development', else 'none'.
 *  3. That mode is handed to rspack verbatim — `chain.mode(config.mode)`
 *     (…:2769) — and is the SAME value rsbuild's own define plugin used for
 *     `'import.meta.env.MODE': JSON.stringify(config.mode)` (…:3054). So the
 *     old expression and this one are fed by one variable, not two.
 *  4. rspack defaults `optimization.nodeEnv` from that mode — 'production' in
 *     production, 'development' in development, `false` otherwise
 *     (@rspack/core@1.1.8/dist/index.js:9239-9243) — and when it is set applies
 *     `DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify(nodeEnv) })`
 *     (…:18513-18517).
 *  5. Nothing overrides `optimization.nodeEnv`: it appears nowhere in
 *     @rsbuild/core's dist, and this app's rsbuild.config.mjs sets no
 *     `optimization` and no `mode` under `tools.rspack`.
 *
 * So in both real modes this expression is replaced by the same literal
 * `import.meta.env.MODE` used to carry. In the degenerate 'none' mode (a build
 * run with some other NODE_ENV and no `-m`) rspack defines nothing, the read
 * falls through the polyfilled empty `process.env` to the 'production' fallback
 * below — and the old code returned 'none' there, so `isDevEnv()` was false in
 * that case too. No behaviour change in any mode; only the perf log's `mode`
 * label differs, and only in that degenerate case.
 *
 * `pluginNodePolyfill` guarantees `process` exists either way, and jest sets
 * NODE_ENV natively ('test' — which is correctly NOT development). Falls back
 * to 'production' — the mode with less machinery switched on — if it is
 * somehow missing.
 */
// Written as a plain `process.env.NODE_ENV` member access on purpose —
// rspack's define substitutes that exact expression at build time, and an
// optional-chained `process?.env?.NODE_ENV` would not be matched, silently
// falling back to the polyfilled empty `process.env` and reporting production
// during `npm run dev`.
const buildMode = () => {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) {
      return process.env.NODE_ENV;
    }
  } catch (_err) {
    // no `process` at all: fall through
  }
  return 'production';
};

const isDevEnv = () => {
  return buildMode() === 'development';
};

// Skip immer's recursive auto-freeze of every reducer result — in DEV too.
// Profiled on the GSB workspace, isNestedFrozen was the top renderer CPU
// cost while index batches / background hydration streamed into the large
// collections and index maps — the source of 100-150ms frame stalls when
// scrolling during a search. Dev originally kept freezing as a
// mutation-detection safety net, but the team evaluates perf on dev runs
// and the freeze overhead masked every production fix. Trade-off accepted;
// mutation bugs still surface via tests and review.
setAutoFreeze(false);

initPerfLogging({ mode: buildMode() });

// The redux debug middleware console.debugs the ENTIRE store on EVERY
// action — with the startup hydration/index streams that is thousands of
// multi-MB logs, and with DevTools open it made dev builds unusably laggy
// (and made perf testing on dev runs meaningless). Opt in explicitly:
//   localStorage.setItem('gridman.debugRedux', '1')  (+ reload)
const isReduxDebugEnabled = () => {
  try {
    return Boolean(window.localStorage?.getItem('gridman.debugRedux'));
  } catch (_err) {
    return false;
  }
};

let middleware = [perfActionsMiddleware.middleware, tasksMiddleware.middleware, historyMiddleware.middleware, draftDetectMiddleware, autosaveMiddleware];
if (isDevEnv() && isReduxDebugEnabled()) {
  middleware = [...middleware, debugMiddleware.middleware];
}

export const store = configureStore({
  reducer: {
    app: appReducer,
    collections: collectionsReducer,
    tabs: tabsReducer,
    notifications: notificationsReducer,
    globalEnvironments: globalEnvironmentsReducer,
    logs: logsReducer,
    performance: performanceReducer,
    workspaces: workspacesReducer,
    apiSpec: apiSpecReducer,
    openapiSync: openapiSyncReducer,
    workflows: workflowsReducer,
    history: historyReducer,
    // Inert until Preferences > AI is switched on: the slice runs nothing on
    // import (no IPC, no IndexedDB, no network) and every AI component returns
    // null while `app.preferences.ai.enabled` is false. Registered here so
    // `state.ai` always exists — components must never be the thing that
    // decides whether the store has this key.
    ai: aiReducer
  },
  // RTK's dev-only immutableCheck/serializableCheck walk the ENTIRE store
  // on every dispatch. With GSB-scale state (11.7k index nodes + collection
  // trees) one dispatch became a single 26-31s renderer task ([gridman-perf]
  // LONG-TASK + CPU profile: detectMutations/trackProperties/
  // findNonSerializableValue dominated the stall) — the app froze for ~30s
  // after every search in dev. Standard RTK guidance for large states.
  middleware: (getDefaultMiddleware) => getDefaultMiddleware({ immutableCheck: false, serializableCheck: false }).concat(middleware)
});

export default store;
