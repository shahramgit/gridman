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
import historyMiddleware from './middlewares/history/middleware';
import { draftDetectMiddleware } from './middlewares/draft/middleware';
import { autosaveMiddleware } from './middlewares/autosave/middleware';

const isDevEnv = () => {
  return import.meta.env.MODE === 'development';
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

initPerfLogging({ mode: import.meta.env.MODE });

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
    history: historyReducer
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
