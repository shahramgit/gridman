import { createSlice } from '@reduxjs/toolkit';
import filter from 'lodash/filter';
import brunoClipboard from 'utils/bruno-clipboard';
import { addTab, focusTab } from './tabs';
import { clearPersistedScope } from 'hooks/usePersistedState/PersistedScopeProvider';

const initialState = {
  isDragging: false,
  idbConnectionReady: false,
  leftSidebarWidth: 250,
  sidebarCollapsed: false,
  showSidebarSearch: false,
  // True while a workspace content search (>= 2 chars) is filtering the
  // sidebar. Background eager-hydration tree updates are held while this is on
  // (the filtered view renders from the search index, not the hydrated tree),
  // so scrolling results never competes with a 400-700ms hydration re-render.
  workspaceSearchActive: false,
  focusedSidebarPath: null,
  screenWidth: 500,
  showHomePage: false,
  showApiSpecPage: false,
  showManageWorkspacePage: false,
  isEnvironmentSettingsModalOpen: false,
  isGlobalEnvironmentSettingsModalOpen: false,
  activePreferencesTab: 'general',
  preferences: {
    request: {
      sslVerification: true,
      customCaCertificate: {
        enabled: false,
        filePath: null
      },
      keepDefaultCaCertificates: {
        enabled: true
      },
      timeout: 0,
      oauth2: {
        useSystemBrowser: false
      }
    },
    font: {
      codeFont: 'default'
    },
    general: {
      defaultLocation: ''
    },
    onboarding: {
      hasLaunchedBefore: false,
      hasSeenWelcomeModal: true
    },
    autoSave: {
      enabled: false,
      interval: 1000
    },
    cache: {
      sslSession: {
        enabled: false
      }
    },
    features: {
      apiSpec: true,
      gitWorkspace: true,
      fileExplorer: true,
      brunoJson: false
    }
  },
  generateCode: {
    mainLanguage: 'Shell',
    library: 'curl',
    shouldInterpolate: true
  },
  cookies: [],
  taskQueue: [],
  gitOperationProgress: {},
  gitVersion: null,
  clipboard: {
    hasCopiedItems: false, // Whether clipboard has Bruno data (for UI)
    operation: 'copy' // 'copy' duplicates on paste, 'cut' moves
  },
  systemProxyVariables: {},
  envVarSearch: {
    collection: { query: '', expanded: false },
    global: { query: '', expanded: false }
  },
  isCreatingCollection: false,
  // { nonce, collectionUid, pathname } - sidebar components react to nonce
  // changes by expanding ancestors and scrolling the request into view
  sidebarReveal: null
};

export const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    idbConnectionReady: (state) => {
      state.idbConnectionReady = true;
    },
    refreshScreenWidth: (state) => {
      state.screenWidth = window.innerWidth;
    },
    updateLeftSidebarWidth: (state, action) => {
      state.leftSidebarWidth = action.payload.leftSidebarWidth;
    },
    updateIsDragging: (state, action) => {
      state.isDragging = action.payload.isDragging;
    },
    revealRequestInSidebar: (state, action) => {
      const { collectionUid, pathname, ensureVisible } = action.payload;
      // `pending` keeps the reveal alive until a row consumes it, so a
      // just-opened collection that hydrates/indexes after the dispatch still
      // gets scrolled into view (effects re-attempt as data arrives).
      // `ensureVisible` marks a deliberate reveal (workflow "Show in sidebar",
      // search, save-as) that may expand the sidebar's Collections section;
      // passive reveals from tab activation leave the accordion alone. Preserve
      // a still-pending deliberate reveal for the same target so the passive
      // reveal addTab fires right after (e.g. save-as focusing the new request)
      // can't downgrade it and leave a never-opened collection collapsed.
      const prev = state.sidebarReveal;
      const keepEnsure = Boolean(ensureVisible)
        || Boolean(prev?.pending && prev.pathname === pathname && prev.collectionUid === collectionUid && prev.ensureVisible);
      state.sidebarReveal = {
        nonce: Date.now(),
        collectionUid,
        pathname,
        pending: true,
        ensureVisible: keepEnsure
      };
    },
    clearSidebarReveal: (state) => {
      if (state.sidebarReveal) {
        state.sidebarReveal = { ...state.sidebarReveal, pending: false };
      }
    },
    showHomePage: (state) => {
      state.showHomePage = true;
      state.showApiSpecPage = false;
      state.showManageWorkspacePage = false;
    },
    hideHomePage: (state) => {
      state.showHomePage = false;
    },
    showManageWorkspacePage: (state) => {
      state.showManageWorkspacePage = true;
      state.showHomePage = false;
      state.showApiSpecPage = false;
    },
    hideManageWorkspacePage: (state) => {
      state.showManageWorkspacePage = false;
    },
    showApiSpecPage: (state) => {
      state.showHomePage = false;
      state.showApiSpecPage = true;
    },
    hideApiSpecPage: (state) => {
      state.showApiSpecPage = false;
    },
    updatePreferences: (state, action) => {
      state.preferences = action.payload;
    },
    updateActivePreferencesTab: (state, action) => {
      state.activePreferencesTab = action.payload.tab;
    },
    updateCookies: (state, action) => {
      state.cookies = action.payload;
    },
    insertTaskIntoQueue: (state, action) => {
      state.taskQueue.push(action.payload);
    },
    removeTaskFromQueue: (state, action) => {
      state.taskQueue = filter(state.taskQueue, (task) => task.uid !== action.payload.taskUid);
    },
    removeAllTasksFromQueue: (state) => {
      state.taskQueue = [];
    },
    updateSystemProxyVariables: (state, action) => {
      state.systemProxyVariables = action.payload;
    },
    updateGenerateCode: (state, action) => {
      state.generateCode = {
        ...state.generateCode,
        ...action.payload
      };
    },
    toggleSidebarCollapse: (state) => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    toggleSidebarSearch: (state) => {
      state.showSidebarSearch = !state.showSidebarSearch;
    },
    setWorkspaceSearchActive: (state, action) => {
      state.workspaceSearchActive = Boolean(action.payload);
    },
    setFocusedSidebarPath: (state, action) => {
      state.focusedSidebarPath = action.payload;
    },
    updateGitOperationProgress: (state, action) => {
      const { uid, data } = action.payload;
      if (!state.gitOperationProgress[uid]) {
        state.gitOperationProgress[uid] = { progressData: [] };
      }
      state.gitOperationProgress[uid].progressData.push(data);
    },
    removeGitOperationProgress: (state, action) => {
      delete state.gitOperationProgress[action.payload];
    },
    setGitVersion: (state, action) => {
      state.gitVersion = action.payload;
    },
    setClipboard: (state, action) => {
      // Update clipboard UI state
      state.clipboard.hasCopiedItems = action.payload.hasCopiedItems;
      if (action.payload.operation) {
        state.clipboard.operation = action.payload.operation;
      }
    },
    setEnvVarSearchQuery: (state, { payload: { context, query } }) => {
      if (!state.envVarSearch[context]) return;
      state.envVarSearch[context].query = query;
    },
    setEnvVarSearchExpanded: (state, { payload: { context, expanded } }) => {
      if (!state.envVarSearch[context]) return;
      state.envVarSearch[context].expanded = expanded;
    },
    setIsCreatingCollection: (state, action) => {
      state.isCreatingCollection = action.payload;
    }
  },
  extraReducers: (builder) => {
    // Automatically hide special pages when any tab is added or focused
    builder
      .addCase(addTab, (state) => {
        state.showHomePage = false;
        state.showApiSpecPage = false;
        state.showManageWorkspacePage = false;
      })
      .addCase(focusTab, (state) => {
        state.showHomePage = false;
        state.showApiSpecPage = false;
        state.showManageWorkspacePage = false;
      });
  }
});

export const {
  idbConnectionReady,
  refreshScreenWidth,
  updateLeftSidebarWidth,
  updateIsDragging,
  revealRequestInSidebar,
  clearSidebarReveal,
  showHomePage,
  hideHomePage,
  showManageWorkspacePage,
  hideManageWorkspacePage,
  showApiSpecPage,
  hideApiSpecPage,
  updatePreferences,
  updateActivePreferencesTab,
  updateCookies,
  insertTaskIntoQueue,
  removeTaskFromQueue,
  removeAllTasksFromQueue,
  updateSystemProxyVariables,
  updateGenerateCode,
  toggleSidebarCollapse,
  toggleSidebarSearch,
  setWorkspaceSearchActive,
  setFocusedSidebarPath,
  updateGitOperationProgress,
  removeGitOperationProgress,
  setGitVersion,
  setClipboard,
  setEnvVarSearchQuery,
  setEnvVarSearchExpanded,
  setIsCreatingCollection
} = appSlice.actions;

export const savePreferences = (preferences) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    ipcRenderer
      .invoke('renderer:save-preferences', preferences)
      .then(() => dispatch(updatePreferences(preferences)))
      .then(resolve)
      .catch(reject);
  });
};

export const deleteCookiesForDomain = (domain) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    ipcRenderer.invoke('renderer:delete-cookies-for-domain', domain).then(resolve).catch(reject);
  });
};

export const deleteCookie = (domain, path, cookieKey) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    ipcRenderer.invoke('renderer:delete-cookie', domain, path, cookieKey).then(resolve).catch(reject);
  });
};

export const addCookie = (domain, cookie) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    ipcRenderer.invoke('renderer:add-cookie', domain, cookie).then(resolve).catch(reject);
  });
};

export const modifyCookie = (domain, oldCookie, cookie) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    ipcRenderer.invoke('renderer:modify-cookie', domain, oldCookie, cookie).then(resolve).catch(reject);
  });
};

export const getParsedCookie = (cookieStr) => () => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:get-parsed-cookie', cookieStr).then(resolve).catch(reject);
  });
};

export const createCookieString = (cookieObj) => () => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:create-cookie-string', cookieObj).then(resolve).catch(reject);
  });
};

export const completeQuitFlow = () => (dispatch, getState) => {
  const { ipcRenderer } = window;
  // Wipe all `persisted::*` keys from localStorage before quitting
  clearPersistedScope();
  return ipcRenderer.invoke('main:complete-quit-flow');
};

export const copyRequest = (item) => (dispatch, getState) => {
  brunoClipboard.write(item, 'copy');
  dispatch(setClipboard({ hasCopiedItems: true, operation: 'copy' }));
  return Promise.resolve();
};

/**
 * Cut is the same clipboard with a different verb: the item is not touched
 * until it is pasted, so cutting and never pasting changes nothing on disk.
 */
export const cutRequest = (item) => (dispatch, getState) => {
  brunoClipboard.write(item, 'cut');
  dispatch(setClipboard({ hasCopiedItems: true, operation: 'cut' }));
  return Promise.resolve();
};

export const clearClipboard = () => (dispatch, getState) => {
  brunoClipboard.clear();
  dispatch(setClipboard({ hasCopiedItems: false, operation: 'copy' }));
  return Promise.resolve();
};

export const getSystemProxyVariables = () => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:get-system-proxy-variables')
      .then((variables) => {
        dispatch(updateSystemProxyVariables(variables));
        return variables;
      })
      .then(resolve).catch(reject);
  });
};

export const refreshSystemProxy = () => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:refresh-system-proxy')
      .then((variables) => {
        dispatch(updateSystemProxyVariables(variables));
        return variables;
      })
      .then(resolve).catch(reject);
  });
};

export const clearHttpHttpsAgentCache = () => () => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:clear-http-https-agent-cache').then(resolve).catch(reject);
  });
};

export const refreshPacCache = () => () => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:refresh-pac-cache').then(resolve).catch(reject);
  });
};

export default appSlice.reducer;
