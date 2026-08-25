const Yup = require('yup');
const Store = require('electron-store');
const { get, merge } = require('lodash');

/**
 * The preferences are stored in the electron store 'preferences.json'.
 * The electron process uses this module to get the preferences.
 *
 */

const defaultPreferences = {
  request: {
    sslVerification: true,
    customCaCertificate: {
      enabled: false,
      filePath: null
    },
    keepDefaultCaCertificates: {
      enabled: true
    },
    storeCookies: true,
    sendCookies: true,
    timeout: 0,
    oauth2: {
      useSystemBrowser: false
    }
  },
  font: {
    codeFont: 'default',
    codeFontSize: 13
  },
  git: {
    // Environment files carry secret NAMES only — values live in the encrypted
    // store under userData and never reach the repository — so they are shared
    // by default, which is what a git-backed team wants. Turn this on if the
    // internal URLs and ids in those files are themselves sensitive.
    // Dotenv files (.env, .env.*) are excluded unconditionally either way.
    excludeEnvironmentsFromGit: false
  },
  proxy: {
    source: 'inherit',
    pac: { source: '' },
    config: {
      protocol: 'http',
      hostname: '',
      port: null,
      auth: {
        username: '',
        password: ''
      },
      bypassProxy: ''
    }
  },
  layout: {
    responsePaneOrientation: 'horizontal'
  },
  beta: {
    'openapi-sync': false,
    // Ships default-off. The engine is complete but the UI is not, and a mock
    // server binds a port and answers requests — not something to switch on for
    // everyone by way of an upgrade.
    'mock-server': false
  },
  onboarding: {
    hasLaunchedBefore: false,
    hasSeenWelcomeModal: true
  },
  general: {
    defaultLocation: ''
  },
  autoSave: {
    enabled: false,
    interval: 1000
  },
  display: {
    zoomPercentage: 100
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
  },
  // AI is DEFAULT OFF at every level. A fresh install must never contact a
  // model provider: `ai.enabled` gates the whole feature, and each provider
  // (including user-added OpenAI-compatible endpoints) carries its own
  // `enabled` flag that also defaults to false. Nothing here holds an API key
  // — keys live encrypted in store/ai-keys.js and never touch this file.
  ai: {
    enabled: false,
    providers: {
      openai: { enabled: false },
      anthropic: { enabled: false }
    },
    models: {},
    defaultModel: '',
    // Internal / self-hosted models. Each entry:
    //   { id, name, baseURL, enabled, models: [{ id, label, modelId }] }
    // An entry with `enabled: true` + a baseURL is enough to use the feature —
    // no OpenAI or Anthropic key required, and the apiKey is optional because
    // most on-prem gateways authenticate by network position instead.
    openaiCompatibleEndpoints: [],
    autocomplete: {
      // Ghost-text autocomplete fires on every keystroke, which is the most
      // perf-sensitive path in the app on a large workspace. It is gated
      // INDEPENDENTLY of the chat and defaults to false — turning `ai.enabled`
      // on must not silently start firing requests while the user types.
      enabled: false,
      model: '',
      triggerMode: 'debounced'
    },
    security: {
      redactHeaders: true,
      redactBody: true,
      redactVariables: true,
      redactResponse: true,
      customRedactedHeaders: [],
      customRedactedVariables: []
    }
  }
};

// Kept in step with CUSTOM_MODEL_SEPARATOR in ipc/ai/providers.js. An endpoint
// id containing it would make the namespaced model ids built from it ambiguous
// to parse, which is the ambiguity the namespace exists to remove — so the id
// is rejected here rather than handled downstream.
const CUSTOM_MODEL_ID_SEPARATOR = '::';

/**
 * An id-keyed map of `{ enabled: boolean }` and nothing else.
 *
 * Yup has no "additionalProperties" for unknown keys, so the values are
 * validated by hand. The point is not tidiness: it is that a credential has
 * nowhere to sit in `ai.providers` / `ai.models`.
 */
const enabledFlagMapSchema = (label) =>
  Yup.object().test(
    'enabled-flags-only',
    `${label} entries may only contain a boolean 'enabled' field`,
    (value) => {
      if (value === undefined || value === null) return true;
      if (typeof value !== 'object' || Array.isArray(value)) return false;
      return Object.values(value).every((entry) => {
        if (entry === undefined || entry === null) return true;
        if (typeof entry !== 'object' || Array.isArray(entry)) return false;
        return Object.entries(entry).every(([key, val]) => key === 'enabled' && typeof val === 'boolean');
      });
    }
  );

const preferencesSchema = Yup.object().shape({
  request: Yup.object().shape({
    sslVerification: Yup.boolean(),
    customCaCertificate: Yup.object({
      enabled: Yup.boolean(),
      filePath: Yup.string().nullable()
    }),
    keepDefaultCaCertificates: Yup.object({
      enabled: Yup.boolean()
    }),
    storeCookies: Yup.boolean(),
    sendCookies: Yup.boolean(),
    timeout: Yup.number(),
    oauth2: Yup.object({
      useSystemBrowser: Yup.boolean()
    })
  }),
  font: Yup.object().shape({
    codeFont: Yup.string().nullable(),
    codeFontSize: Yup.number().min(1).max(32).nullable()
  }),
  git: Yup.object().shape({
    excludeEnvironmentsFromGit: Yup.boolean()
  }),
  proxy: Yup.object({
    disabled: Yup.boolean().optional(),
    source: Yup.string().oneOf(['manual', 'pac', 'inherit']).required(),
    pac: Yup.object({
      source: Yup.string().optional().max(2048).nullable()
    }).optional(),
    config: Yup.object({
      protocol: Yup.string().oneOf(['http', 'https', 'socks4', 'socks5']),
      hostname: Yup.string().max(1024),
      port: Yup.number().min(1).max(65535).nullable(),
      auth: Yup.object({
        disabled: Yup.boolean().optional(),
        username: Yup.string().max(1024),
        password: Yup.string().max(1024)
      }).optional(),
      bypassProxy: Yup.string().optional().max(1024)
    }).required()
  }),
  layout: Yup.object({
    responsePaneOrientation: Yup.string().oneOf(['horizontal', 'vertical'])
  }),
  beta: Yup.object({
    'openapi-sync': Yup.boolean(),
    'mock-server': Yup.boolean()
  }),
  onboarding: Yup.object({
    hasLaunchedBefore: Yup.boolean(),
    hasSeenWelcomeModal: Yup.boolean()
  }),
  general: Yup.object({
    defaultLocation: Yup.string().max(1024).nullable()
  }),
  autoSave: Yup.object({
    enabled: Yup.boolean(),
    interval: Yup.number().min(100)
  }),
  display: Yup.object({
    zoomPercentage: Yup.number().min(50).max(150)
  }),
  cache: Yup.object({
    sslSession: Yup.object({
      enabled: Yup.boolean()
    })
  }).optional(),
  features: Yup.object({
    apiSpec: Yup.boolean(),
    gitWorkspace: Yup.boolean(),
    fileExplorer: Yup.boolean(),
    brunoJson: Yup.boolean()
  }).optional(),
  ai: Yup.object({
    enabled: Yup.boolean(),
    // `providers` and `models` are id-keyed maps, so their KEYS cannot be
    // enumerated in the schema — but their VALUES can. Pinning each entry to a
    // lone `enabled` boolean is what makes `ai.providers.openai.apiKey`
    // unrepresentable: it is not that we strip it, it is that the object no
    // longer validates. Previously these were bare `Yup.object()`, and Yup
    // preserves unknown keys, so anything at all rode through into the
    // plaintext preferences.json.
    providers: enabledFlagMapSchema('ai.providers').optional(),
    models: enabledFlagMapSchema('ai.models').optional(),
    defaultModel: Yup.string().max(200).nullable(),
    openaiCompatibleEndpoints: Yup.array().of(
      Yup.object({
        id: Yup.string()
          .required()
          .test(
            'no-model-namespace-separator',
            `Endpoint id must not contain "${CUSTOM_MODEL_ID_SEPARATOR}"`,
            (value) => typeof value !== 'string' || !value.includes(CUSTOM_MODEL_ID_SEPARATOR)
          ),
        name: Yup.string().max(120).nullable(),
        baseURL: Yup.string().max(2048).nullable(),
        // Per-endpoint opt-in. Absent / false means the endpoint is configured
        // but dormant, so adding one never starts talking to it on its own.
        enabled: Yup.boolean().optional(),
        // TLS, scoped to this endpoint. A path to a PEM CA bundle, and the
        // escape hatch for a certificate no CA vouches for. Both exist so that
        // reaching one internal gateway never requires turning
        // `request.sslVerification` off, which would stop verifying
        // certificates for every request the app makes, to every host.
        // A path, not the certificate text: preferences.json is plaintext, and
        // the file stays where the user's own tooling manages it.
        caCertFilePath: Yup.string().max(4096).nullable(),
        allowSelfSigned: Yup.boolean().optional(),
        models: Yup.array().of(
          Yup.object({
            id: Yup.string().required(),
            label: Yup.string().max(120).nullable(),
            modelId: Yup.string().max(200).nullable()
          }).noUnknown(true).strict(true)
        )
      }).noUnknown(true).strict(true)
    ).optional(),
    autocomplete: Yup.object({
      enabled: Yup.boolean(),
      model: Yup.string().max(200).nullable(),
      triggerMode: Yup.string().oneOf(['aggressive', 'debounced', 'manual']).nullable()
    }).noUnknown(true).strict(true).optional(),
    security: Yup.object({
      redactHeaders: Yup.boolean(),
      redactBody: Yup.boolean(),
      redactVariables: Yup.boolean(),
      redactResponse: Yup.boolean(),
      customRedactedHeaders: Yup.array().of(Yup.string().max(200)).max(200),
      customRedactedVariables: Yup.array().of(Yup.string().max(200)).max(200)
    }).noUnknown(true).strict(true).optional()
    // `.noUnknown(true).strict(true)`: reject, don't preserve. An `apiKey`,
    // `credentials`, or any other key we did not put here fails the save
    // outright instead of being written to disk in the clear.
  }).noUnknown(true).strict(true).optional(),
  // Written by getPreferences() when a migration runs, and round-tripped back
  // through savePreferences by the renderer, so it has to be declared — an
  // undeclared key is now stripped (see below) and the migration would re-run
  // on every launch.
  _migrations: Yup.object().optional()
})
  /**
   * The level ABOVE `ai`. Yup preserves unknown keys by default, so a
   * top-level `apiKey` / `credentials` / anything else a renderer or a
   * hand-edit put in the payload was written straight into plaintext
   * preferences.json — the `ai` subtree was locked and the roof was open.
   *
   * STRIP (`noUnknown` without `strict`), where `ai` REJECTS. The difference is
   * deliberate: `ai` is a subtree this fork owns entirely, so rejecting a
   * surprise key there costs nothing. At the top level a single legacy or
   * third-party key — from an older Bruno, another fork, a hand-edit — would
   * make EVERY preferences save fail, including the user's ability to turn AI
   * off, which is the worst possible failure for the customer this port is
   * for. Stripping removes the credential from what gets persisted (the value
   * written to disk is yup's output, not the input) without that failure mode.
   */
  .noUnknown(true);

/**
 * preferences.json is plaintext on disk. API keys belong in store/ai-keys.js,
 * which encrypts them through utils/encryption — nothing credential-shaped may
 * reach this file.
 *
 * The schema above is the primary lock (unknown keys are rejected outright).
 * This is the second: it walks the WHOLE `ai` subtree, not just the endpoint
 * array. The previous version only looked at `ai.openaiCompatibleEndpoints[i]`,
 * so `ai.apiKey`, `ai.providers.openai.apiKey` and every nested path sailed
 * past it and landed on disk in the clear.
 *
 * Only scalar values are removed. A credential is a string; an object is
 * config, and `ai.models['token'] = { enabled: false }` is a user's model
 * toggle, not a secret — deleting that would silently re-enable a model they
 * turned off. Object-shaped credential containers are handled by the schema,
 * which refuses to validate them at all.
 */
const AI_CREDENTIAL_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /^key$/i,
  /^secret$/i,
  /^token$/i,
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /^auth$/i,
  /^authorization$/i,
  /^credential(s)?$/i,
  /^bearer$/i,
  // clientSecret, refresh_token, access-key, myApiKey, …
  /(api[_-]?key|secret|password|token)$/i
];

const isAiCredentialKey = (key) =>
  typeof key === 'string' && AI_CREDENTIAL_KEY_PATTERNS.some((re) => re.test(key));

const isPlainContainer = (value) => value !== null && typeof value === 'object';

const stripCredentialsDeep = (node, seen) => {
  if (!isPlainContainer(node) || seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) stripCredentialsDeep(item, seen);
    return;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (isPlainContainer(value)) {
      stripCredentialsDeep(value, seen);
    } else if (isAiCredentialKey(key)) {
      delete node[key];
    }
  }
};

const stripAiEndpointCredentials = (preferences) => {
  const ai = get(preferences, 'ai');
  if (!isPlainContainer(ai)) return preferences;
  // `seen` guards against a cycle in a hand-edited / malformed object.
  stripCredentialsDeep(ai, new WeakSet());
  return preferences;
};

class PreferencesStore {
  constructor() {
    this.store = new Store({
      name: 'preferences',
      clearInvalidConfig: true
    });
  }

  getPreferences() {
    let preferences = this.store.get('preferences', {});

    // Handle existing users without proxy settings
    // They should get disabled proxy by default, not inherit from system
    // New users (empty preferences) will get defaultPreferences.proxy via merge
    if (Object.keys(preferences).length > 0 && !preferences.proxy) {
      preferences.proxy = {
        source: 'manual',
        disabled: true,
        config: {
          protocol: 'http',
          hostname: '',
          port: null,
          auth: {
            username: '',
            password: ''
          },
          bypassProxy: ''
        }
      };
    }

    if (preferences?.proxy) {
      const proxy = preferences.proxy || {};

      // Check if this is an old format that needs migration
      const hasOldFormat = proxy.hasOwnProperty('enabled') || proxy.hasOwnProperty('mode');

      if (hasOldFormat) {
        let newProxy = {
          source: 'inherit',
          pac: { source: '' },
          config: {
            protocol: proxy.protocol || 'http',
            hostname: proxy.hostname || '',
            port: proxy.port || null,
            auth: {
              username: get(proxy, 'auth.username', ''),
              password: get(proxy, 'auth.password', '')
            },
            bypassProxy: proxy.bypassProxy || ''
          }
        };

        // Handle old format 1: enabled (boolean)
        if (proxy.hasOwnProperty('enabled') && typeof proxy.enabled === 'boolean') {
          newProxy.source = 'manual';
          newProxy.disabled = !proxy.enabled;
        } else if (proxy.hasOwnProperty('mode')) {
          // Handle old format 2: mode ('off' | 'on' | 'system')
          if (proxy.mode === 'off') {
            newProxy.source = 'manual';
            newProxy.disabled = true;
          } else if (proxy.mode === 'on') {
            newProxy.source = 'manual';
          } else if (proxy.mode === 'system') {
            newProxy.source = 'inherit';
          }
        }

        // Migrate auth.enabled to auth.disabled
        if (get(proxy, 'auth.enabled') === false) {
          newProxy.config.auth.disabled = true;
        }

        // Omit disabled: false at top level (optional field)
        if (newProxy.disabled === false) {
          delete newProxy.disabled;
        }
        // Omit auth.disabled: false (optional field)
        if (newProxy.config.auth.disabled === false) {
          delete newProxy.config.auth.disabled;
        }

        preferences.proxy = newProxy;
        this.store.set('preferences', preferences);
      }

      // Migrate intermediate format: inherit boolean → source string
      if (!hasOldFormat && proxy.hasOwnProperty('inherit')) {
        if (proxy.inherit === true) {
          preferences.proxy.source = 'inherit';
        } else if (!proxy.source) {
          preferences.proxy.source = 'manual';
        }
        delete preferences.proxy.inherit;
        this.store.set('preferences', preferences);
      }
    }

    // Migrate font size from 14px to 13px for existing users
    // Only migrate once if codeFont is 'default' (or not set) and codeFontSize is 14
    // This ensures the migration only happens once and doesn't override user's explicit choices
    // If user explicitly sets it to 14px after migration, it won't be migrated again
    const fontSizeMigrated = get(preferences, '_migrations.codeFontSize14to13', false);
    if (!fontSizeMigrated) {
      const codeFont = get(preferences, 'font.codeFont', 'default');
      const codeFontSize = get(preferences, 'font.codeFontSize');

      // Only migrate if it's the old default combination (codeFont is default and size is 14)
      if (codeFont === 'default' && codeFontSize === 14) {
        preferences.font.codeFontSize = 13;
        // Mark migration as complete
        if (!preferences._migrations) {
          preferences._migrations = {};
        }
        preferences._migrations.codeFontSize14to13 = true;
        // Save the migrated preferences back to the store
        this.store.set('preferences', preferences);
      }
    }

    // Migrate from defaultCollectionLocation to defaultLocation
    if (preferences.general?.defaultCollectionLocation !== undefined
      && preferences.general?.defaultLocation === undefined) {
      preferences.general.defaultLocation = preferences.general.defaultCollectionLocation;
      delete preferences.general.defaultCollectionLocation;
      this.store.set('preferences', preferences);
    }

    return merge({}, defaultPreferences, preferences);
  }

  savePreferences(newPreferences) {
    return this.store.set('preferences', newPreferences);
  }
}

const preferencesStore = new PreferencesStore();

const getPreferences = () => {
  return preferencesStore.getPreferences();
};

/**
 * Cache for the AI autocomplete gate ONLY.
 *
 * electron-store's `get` is a `fs.readFileSync` + JSON.parse of the whole
 * preferences file on every call (conf's `get store()`), and getPreferences()
 * then runs the migrations and a deep merge with the defaults on top. Ghost
 * text asks this question on the keystroke path, so the old comment claiming
 * "nothing here blocks the main thread on the keystroke path" was wrong: a
 * synchronous file read did, on every character typed.
 *
 * Deliberately NOT applied to `isAiEnabled()`. That is the enforcement gate —
 * providers.getModel re-checks it against a fresh read before any provider is
 * constructed, and it must never answer from a cache. This one only decides
 * whether to attempt a completion at all; the attempt is still gated by the
 * uncached check.
 *
 * Invalidated on every save, so an in-app toggle takes effect immediately. The
 * TTL only bounds how long a hand-edit of preferences.json outside the app can
 * go unnoticed.
 */
const AI_GATE_CACHE_TTL_MS = 500;
let aiAutocompleteGate = null; // { at, value }

const invalidateAiPreferencesCache = () => {
  aiAutocompleteGate = null;
};

const readAiAutocompleteGate = () => {
  const now = Date.now();
  if (aiAutocompleteGate && now - aiAutocompleteGate.at < AI_GATE_CACHE_TTL_MS) {
    return aiAutocompleteGate.value;
  }
  const preferences = getPreferences();
  const value = get(preferences, 'ai.enabled', false) === true
    && get(preferences, 'ai.autocomplete.enabled', false) === true;
  aiAutocompleteGate = { at: now, value };
  return value;
};

const savePreferences = async (newPreferences) => {
  return new Promise((resolve, reject) => {
    preferencesSchema
      .validate(newPreferences, { abortEarly: true })
      .then((validatedPreferences) => {
        preferencesStore.savePreferences(stripAiEndpointCredentials(validatedPreferences));
        invalidateAiPreferencesCache();
        resolve();
      })
      .catch((error) => {
        reject(error);
      });
  });
};

const preferencesUtil = {
  shouldVerifyTls: () => {
    return get(getPreferences(), 'request.sslVerification', true);
  },
  shouldUseCustomCaCertificate: () => {
    return get(getPreferences(), 'request.customCaCertificate.enabled', false);
  },
  shouldKeepDefaultCaCertificates: () => {
    return get(getPreferences(), 'request.keepDefaultCaCertificates.enabled', true);
  },
  getCustomCaCertificateFilePath: () => {
    return get(getPreferences(), 'request.customCaCertificate.filePath', null);
  },
  getRequestTimeout: () => {
    return get(getPreferences(), 'request.timeout', 0);
  },
  getGlobalProxyConfig: () => {
    return get(getPreferences(), 'proxy', defaultPreferences.proxy);
  },
  shouldStoreCookies: () => {
    return get(getPreferences(), 'request.storeCookies', true);
  },
  shouldSendCookies: () => {
    return get(getPreferences(), 'request.sendCookies', true);
  },
  shouldUseSystemBrowser: () => {
    return get(getPreferences(), 'request.oauth2.useSystemBrowser', false);
  },
  getResponsePaneOrientation: () => {
    return get(getPreferences(), 'layout.responsePaneOrientation', 'horizontal');
  },
  isBetaFeatureEnabled: (featureName) => {
    return get(getPreferences(), `beta.${featureName}`, false);
  },
  getZoomPercentage: () => {
    return get(getPreferences(), 'display.zoomPercentage', 100);
  },
  isSslSessionCachingEnabled: () => {
    return get(getPreferences(), 'cache.sslSession.enabled', false);
  },
  hasLaunchedBefore: () => {
    return get(getPreferences(), 'onboarding.hasLaunchedBefore', false);
  },
  getAiPreferences: () => {
    return get(getPreferences(), 'ai', defaultPreferences.ai);
  },
  // The single gate every AI code path must pass. Explicit `=== true` rather
  // than a truthiness check so a half-written preferences file (e.g. enabled:
  // 'false' as a string, or 1) can't accidentally read as "on".
  isAiEnabled: () => {
    return get(getPreferences(), 'ai.enabled', false) === true;
  },
  // Autocomplete needs BOTH switches. It is the typing-path feature, so it
  // stays off until the user opts into it separately from the chat — and it is
  // the one gate that is read per keystroke, hence the short cache.
  isAiAutocompleteEnabled: () => readAiAutocompleteGate(),
  getAiSecurityPreferences: () => {
    return get(getPreferences(), 'ai.security', defaultPreferences.ai.security);
  },
  markAsLaunched: async () => {
    const preferences = getPreferences();
    preferences.onboarding.hasLaunchedBefore = true;

    try {
      await savePreferences(preferences);
    } catch (err) {
      console.error('Failed to save preferences in markAsLaunched:', err);
    }
  }
};

module.exports = {
  getPreferences,
  savePreferences,
  preferencesUtil,
  defaultPreferences,
  stripAiEndpointCredentials,
  invalidateAiPreferencesCache
};
