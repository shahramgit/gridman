const crypto = require('node:crypto');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { getAiFetch, clearAiFetchCache } = require('./proxy');

const OPENAI_COMPATIBLE_PREFIX = 'openai-compatible:';

const isOpenAiCompatibleProviderId = (id) =>
  typeof id === 'string' && id.startsWith(OPENAI_COMPATIBLE_PREFIX);

const endpointIdFromProviderId = (providerId) =>
  isOpenAiCompatibleProviderId(providerId) ? providerId.slice(OPENAI_COMPATIBLE_PREFIX.length) : null;

const providerIdFromEndpointId = (endpointId) => `${OPENAI_COMPATIBLE_PREFIX}${endpointId}`;

/**
 * Custom models live in a namespace that a built-in model id CANNOT enter.
 *
 * The bug this closes: a user proxying an internal model through an
 * OpenAI-compatible gateway names it `gpt-4o` (the obvious thing to do). The
 * old lookup consulted the built-in catalog first, so the model was LISTED
 * under their internal endpoint but RESOLVED to api.openai.com — their request
 * bodies, URLs and headers left the network. Making the ids disjoint means the
 * collision cannot be expressed at all, rather than being merely unlikely:
 *
 *   built-in  : `gpt-4o`
 *   custom    : `openai-compatible:<endpointId>::gpt-4o`
 *
 * No key of MODEL_DEFINITIONS starts with the provider prefix, so the two sets
 * can never intersect.
 */
const CUSTOM_MODEL_SEPARATOR = '::';

const customModelId = (endpointId, rawModelId) =>
  `${providerIdFromEndpointId(endpointId)}${CUSTOM_MODEL_SEPARATOR}${rawModelId}`;

const isCustomModelId = (modelId) =>
  isOpenAiCompatibleProviderId(modelId)
  && modelId.indexOf(CUSTOM_MODEL_SEPARATOR, OPENAI_COMPATIBLE_PREFIX.length) !== -1;

const parseCustomModelId = (modelId) => {
  if (!isCustomModelId(modelId)) return null;
  const rest = modelId.slice(OPENAI_COMPATIBLE_PREFIX.length);
  const at = rest.indexOf(CUSTOM_MODEL_SEPARATOR);
  return {
    endpointId: rest.slice(0, at),
    rawModelId: rest.slice(at + CUSTOM_MODEL_SEPARATOR.length)
  };
};

/**
 * An endpoint id containing the namespace separator would make its model ids
 * ambiguous to parse, which is exactly the ambiguity this scheme removes. Such
 * an endpoint is treated as having no models at all rather than being parsed
 * on a best guess. (savePreferences also rejects the id outright, so this is
 * the second of two locks.)
 */
const isUsableEndpointId = (endpointId) =>
  typeof endpointId === 'string'
  && endpointId.length > 0
  && !endpointId.includes(CUSTOM_MODEL_SEPARATOR);

/**
 * Sent as the bearer token when an OpenAI-compatible endpoint is configured
 * without a key. Two reasons this is a literal and not `undefined`:
 *
 *  1. @ai-sdk/openai's `loadApiKey` THROWS when no apiKey is given, so an
 *     internal endpoint that authenticates by network position could not be
 *     used at all.
 *  2. Worse, `loadApiKey` falls back to `process.env.OPENAI_API_KEY`. Leaving
 *     it unset would silently ship the user's OpenAI key to their internal
 *     host. Pinning a placeholder makes that impossible.
 */
const NO_KEY_PLACEHOLDER = 'no-key-required';

const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    requiresApiKey: true,
    createSdk: ({ apiKey, fetchImpl }) => createOpenAI({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    validateApiKey: ({ apiKey, fetchImpl }) => (fetchImpl || fetch)('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000)
    })
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    requiresApiKey: true,
    createSdk: ({ apiKey, fetchImpl }) => createAnthropic({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    validateApiKey: ({ apiKey, fetchImpl }) => (fetchImpl || fetch)('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10000)
    })
  }
};

/**
 * Static model catalog for built-in providers. User-defined custom models for
 * OpenAI-compatible endpoints are layered on top at lookup time.
 */
// `reasoning: true` marks models whose SDK path rejects temperature/stopSequences
// (OpenAI Responses API reasoning models) or accepts them only when thinking is
// off (Anthropic Claude 4+). Callers doing latency-critical work like
// autocomplete drop those params for reasoning models to silence warnings.
const MODEL_DEFINITIONS = {
  // OpenAI
  'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  'gpt-4o': { provider: 'openai', modelId: 'gpt-4o', label: 'GPT-4o' },
  'gpt-5': { provider: 'openai', modelId: 'gpt-5', label: 'GPT-5', reasoning: true },
  'gpt-5-mini': { provider: 'openai', modelId: 'gpt-5-mini', label: 'GPT-5 Mini', reasoning: true },
  // Anthropic
  'claude-opus-4-7': { provider: 'anthropic', modelId: 'claude-opus-4-7', label: 'Claude Opus 4.7', reasoning: true },
  'claude-sonnet-4-6': { provider: 'anthropic', modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', reasoning: true },
  'claude-haiku-4-5': { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', reasoning: true }
};

const isReasoningModel = (modelId) => Boolean(MODEL_DEFINITIONS[modelId]?.reasoning);

const isOpenAiReasoningModel = (modelId) => {
  const def = MODEL_DEFINITIONS[modelId];
  return Boolean(def?.reasoning && def?.provider === 'openai');
};

// Cache SDK instances, bounded. An unbounded map keyed partly on the API key
// grows once per key edit and never shrinks, and every entry retains the key
// material for the lifetime of the process. A user cycling keys while testing
// an endpoint is the ordinary way to grow it.
const SDK_CACHE_MAX_ENTRIES = 16;
const sdkCache = new Map();

// The key is hashed, not stored: the raw API key would otherwise sit in a Map
// key (a string V8 keeps interned) for as long as the process lives. A digest
// distinguishes keys just as well without retaining any of them.
const hashApiKey = (apiKey) =>
  apiKey ? crypto.createHash('sha256').update(String(apiKey)).digest('hex') : '';

// JSON-stringified tuple so values containing ":" (provider ids, URLs) can't
// collide and reuse an SDK configured for a different endpoint/key. The proxy
// signature is folded in so editing Preferences > Proxy rebuilds the SDK
// instead of reusing one still pointed at the old route.
const sdkCacheKey = ({ providerId, apiKey, baseURL, proxySignature }) =>
  JSON.stringify([providerId, baseURL || '', hashApiKey(apiKey), proxySignature || '']);

const getCompatEndpoint = (aiPreferences, endpointId) => {
  if (!isUsableEndpointId(endpointId)) return null;
  const list = Array.isArray(aiPreferences?.openaiCompatibleEndpoints)
    ? aiPreferences.openaiCompatibleEndpoints
    : [];
  return list.find((e) => e?.id === endpointId) || null;
};

const compatProviderEntry = (endpoint) => ({
  id: providerIdFromEndpointId(endpoint.id),
  label: endpoint.name || 'OpenAI-compatible',
  apiKeyPlaceholder: 'optional for internal endpoints',
  apiKeyHelpUrl: null,
  isCustom: true,
  // Internal gateways commonly authenticate by network position. The UI uses
  // this to render the key field as optional instead of required.
  requiresApiKey: false,
  endpointId: endpoint.id,
  baseURL: endpoint.baseURL || ''
});

const getSdk = ({ providerId, apiKey, baseURL }) => {
  // Throws when a proxy is configured that we cannot route through, BEFORE any
  // SDK exists — so a misroutable request is never constructed, let alone sent.
  const { fetch: fetchImpl, signature: proxySignature } = getAiFetch();

  const key = sdkCacheKey({ providerId, apiKey, baseURL, proxySignature });
  let sdk = sdkCache.get(key);
  if (sdk) {
    // Refresh LRU position.
    sdkCache.delete(key);
    sdkCache.set(key, sdk);
    return sdk;
  }

  if (isOpenAiCompatibleProviderId(providerId)) {
    sdk = createOpenAI({
      apiKey: apiKey || NO_KEY_PLACEHOLDER,
      baseURL,
      ...(fetchImpl ? { fetch: fetchImpl } : {})
    });
  } else {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown AI provider: ${providerId}`);
    sdk = provider.createSdk({ apiKey, fetchImpl });
  }

  sdkCache.set(key, sdk);
  while (sdkCache.size > SDK_CACHE_MAX_ENTRIES) {
    const oldest = sdkCache.keys().next().value;
    sdkCache.delete(oldest);
  }
  return sdk;
};

const clearSdkCache = () => {
  sdkCache.clear();
  clearAiFetchCache();
};

/**
 * The live cache's key strings.
 *
 * Exposed so "the SDK cache does not retain API keys as map keys" is a CHECKED
 * claim rather than a comment. It was neither before: replacing `hashApiKey`
 * with the identity function left the whole suite green while every plaintext
 * key sat interned in a Map key for the life of the process.
 *
 * By construction the returned strings contain only provider ids, base URLs, a
 * proxy signature and a SHA-256 digest — no key material — which is exactly
 * what tests/ai/sdk-cache.spec.js asserts.
 */
const listSdkCacheKeys = () => Array.from(sdkCache.keys());

/**
 * The master switch, enforced here and not only in the IPC layer. Every entry
 * point that could construct a provider or reach the network routes through
 * this, so "default preferences ⇒ no provider, no fetch" is a property of this
 * module rather than of its callers.
 */
const isAiEnabled = (aiPreferences) => aiPreferences?.enabled === true;

/**
 * Is this provider switched on? Built-ins read `providers[id].enabled`.
 * OpenAI-compatible endpoints accept EITHER `providers['openai-compatible:x']
 * .enabled` or `enabled` on the endpoint entry itself, so a user who adds an
 * internal endpoint and ticks its box doesn't also have to know about the
 * parallel `providers` map. Both default to false.
 */
const isProviderEnabled = (providerId, aiPreferences) => {
  if (aiPreferences?.providers?.[providerId]?.enabled === true) return true;
  const endpointId = endpointIdFromProviderId(providerId);
  if (!endpointId) return false;
  return getCompatEndpoint(aiPreferences, endpointId)?.enabled === true;
};

/** Built-in providers need a key; internal endpoints may be keyless. */
const providerRequiresApiKey = (providerId) => !isOpenAiCompatibleProviderId(providerId);

const listProviders = (aiPreferences) => {
  const builtIn = Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    apiKeyPlaceholder: p.apiKeyPlaceholder,
    apiKeyHelpUrl: p.apiKeyHelpUrl,
    requiresApiKey: true,
    isCustom: false
  }));

  const endpoints = Array.isArray(aiPreferences?.openaiCompatibleEndpoints)
    ? aiPreferences.openaiCompatibleEndpoints
    : [];

  return [...builtIn, ...endpoints.filter((e) => e?.id).map(compatProviderEntry)];
};

const listEndpoints = (aiPreferences) =>
  (Array.isArray(aiPreferences?.openaiCompatibleEndpoints) ? aiPreferences.openaiCompatibleEndpoints : [])
    .filter((endpoint) => isUsableEndpointId(endpoint?.id));

const listModels = (aiPreferences) => {
  const builtIn = Object.entries(MODEL_DEFINITIONS).map(([id, def]) => ({
    id,
    rawId: id,
    label: def.label,
    provider: def.provider,
    isCustom: false
  }));

  const custom = [];
  for (const endpoint of listEndpoints(aiPreferences)) {
    if (!Array.isArray(endpoint.models)) continue;
    for (const model of endpoint.models) {
      if (!model?.id || !model?.modelId) continue;
      custom.push({
        // Namespaced. This is the id every other layer sees and stores.
        id: customModelId(endpoint.id, model.id),
        // The id as written in preferences, kept so per-model enable/disable
        // toggles written against it are still honoured.
        rawId: model.id,
        label: model.label || model.modelId,
        provider: providerIdFromEndpointId(endpoint.id),
        isCustom: true
      });
    }
  }

  return [...builtIn, ...custom];
};

const customDefinition = (endpoint, model) => ({
  providerId: providerIdFromEndpointId(endpoint.id),
  sdkModelId: model.modelId,
  label: model.label || model.modelId,
  baseURL: endpoint.baseURL || ''
});

// Returned when a bare model id names custom models on MORE than one endpoint.
// Distinct from "not found" so the caller refuses instead of falling through to
// the built-in catalog and shipping the request to a cloud provider.
const AMBIGUOUS = Symbol('ambiguous-model-id');

const resolveCustomModelDefinition = (modelId, aiPreferences) => {
  const endpoints = listEndpoints(aiPreferences);

  const parsed = parseCustomModelId(modelId);
  if (parsed) {
    const endpoint = endpoints.find((e) => e.id === parsed.endpointId);
    if (!endpoint || !Array.isArray(endpoint.models)) return null;
    const model = endpoint.models.find((m) => m?.id === parsed.rawModelId && m?.modelId);
    return model ? customDefinition(endpoint, model) : null;
  }

  // A bare id, e.g. a `defaultModel` written by hand. Still resolved
  // ENDPOINT-FIRST: if it names a custom model, that is what it means, even
  // when a built-in shares the name.
  const matches = [];
  for (const endpoint of endpoints) {
    if (!Array.isArray(endpoint.models)) continue;
    const model = endpoint.models.find((m) => m?.id === modelId && m?.modelId);
    if (model) matches.push(customDefinition(endpoint, model));
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return AMBIGUOUS;
  return null;
};

/**
 * Resolve a Gridman model id (built-in or custom) into its provider config.
 *
 * ORDER MATTERS AND IS PART OF THE SECURITY PROPERTY: custom endpoints are
 * consulted first, and a namespaced id is never retried against the built-in
 * catalog. There is no input for which a model the user configured on their own
 * endpoint resolves to OpenAI or Anthropic.
 */
const resolveModelDefinition = (modelId, aiPreferences) => {
  if (typeof modelId !== 'string' || !modelId) return null;

  const custom = resolveCustomModelDefinition(modelId, aiPreferences);
  if (custom === AMBIGUOUS) return null;
  if (custom) return custom;

  // A namespaced id that did not resolve is a dangling reference to an
  // endpoint's model, never a built-in. Refuse.
  if (isCustomModelId(modelId)) return null;

  const def = MODEL_DEFINITIONS[modelId];
  if (!def) return null;
  return {
    providerId: def.provider,
    sdkModelId: def.modelId,
    label: def.label,
    baseURL: null
  };
};

const isBuiltInModelId = (modelId) => !isCustomModelId(modelId) && Boolean(MODEL_DEFINITIONS[modelId]);

const providerLabel = (providerId, aiPreferences) => {
  if (PROVIDERS[providerId]) return PROVIDERS[providerId].label;
  const endpointId = endpointIdFromProviderId(providerId);
  if (endpointId) {
    const endpoint = getCompatEndpoint(aiPreferences, endpointId);
    if (endpoint) return endpoint.name || 'OpenAI-compatible';
  }
  return providerId;
};

/**
 * Resolve a Gridman model id to a vercel-ai SDK model instance.
 * Throws if AI is off, the provider isn't enabled, the model is unknown, or a
 * provider that requires a key doesn't have one.
 */
const getModel = (modelId, { aiPreferences, getApiKey }) => {
  if (!isAiEnabled(aiPreferences)) {
    throw new Error('AI features are disabled. Enable them in Preferences > AI.');
  }

  const def = resolveModelDefinition(modelId, aiPreferences);
  if (!def) throw new Error(`Unknown model: ${modelId}`);

  if (!isProviderEnabled(def.providerId, aiPreferences)) {
    throw new Error(`${providerLabel(def.providerId, aiPreferences)} is not enabled. Enable it in Preferences > AI.`);
  }

  const apiKey = getApiKey(def.providerId);
  if (!apiKey && providerRequiresApiKey(def.providerId)) {
    throw new Error(`${providerLabel(def.providerId, aiPreferences)} API key is not configured. Add it in Preferences > AI.`);
  }

  if (isOpenAiCompatibleProviderId(def.providerId) && !def.baseURL) {
    throw new Error(`${providerLabel(def.providerId, aiPreferences)} is missing a Base URL. Set one in Preferences > AI.`);
  }

  const sdk = getSdk({ providerId: def.providerId, apiKey, baseURL: def.baseURL });
  if (isOpenAiCompatibleProviderId(def.providerId)) return sdk.chat(def.sdkModelId);
  return sdk(def.sdkModelId);
};

/**
 * List models that are usable right now (AI on + provider enabled + key
 * present when the provider needs one + model not disabled). An internal
 * endpoint with a baseURL and no key is usable and shows up here.
 */
const getAvailableModels = ({ aiPreferences, hasApiKey }) => {
  if (!isAiEnabled(aiPreferences)) return [];

  const out = [];
  for (const model of listModels(aiPreferences)) {
    if (!isProviderEnabled(model.provider, aiPreferences)) continue;
    if (providerRequiresApiKey(model.provider) && !hasApiKey(model.provider)) continue;

    // A custom model has two ids the per-model toggle can be stored under: the
    // namespaced one this module now publishes, and the bare one written into
    // preferences by the endpoint editor. Either one saying `false` disables
    // the model — the toggle is a restriction, so honour whichever is set.
    const modelConfigs = aiPreferences?.models || {};
    if (modelConfigs[model.id]?.enabled === false) continue;
    if (model.rawId && model.rawId !== model.id && modelConfigs[model.rawId]?.enabled === false) continue;

    if (isOpenAiCompatibleProviderId(model.provider)) {
      const endpointId = endpointIdFromProviderId(model.provider);
      const endpoint = getCompatEndpoint(aiPreferences, endpointId);
      if (!endpoint?.baseURL) continue;
    }

    out.push({ id: model.id, label: model.label, provider: model.provider });
  }
  return out;
};

const isKnownProviderId = (providerId, aiPreferences) => {
  if (PROVIDERS[providerId]) return true;
  const endpointId = endpointIdFromProviderId(providerId);
  if (!endpointId) return false;
  return Boolean(getCompatEndpoint(aiPreferences, endpointId));
};

/**
 * Reachability / credential check. Never called unless the user pressed
 * "Test" in Preferences, and refuses outright while AI is off so the button
 * can't become a way to make a request from a disabled feature.
 */
const validateApiKeyForProvider = async ({ providerId, apiKey, aiPreferences }) => {
  if (!isAiEnabled(aiPreferences)) {
    throw new Error('AI features are disabled. Enable them in Preferences > AI.');
  }

  // Same routing as a real generation: if a proxy is configured and cannot be
  // honoured, this throws instead of testing a path the model will never use.
  const { fetch: fetchImpl } = getAiFetch();

  if (PROVIDERS[providerId]) {
    return PROVIDERS[providerId].validateApiKey({ apiKey, fetchImpl });
  }
  const endpointId = endpointIdFromProviderId(providerId);
  const endpoint = endpointId ? getCompatEndpoint(aiPreferences, endpointId) : null;
  if (!endpoint?.baseURL) {
    throw new Error('Endpoint Base URL is not configured');
  }
  // NOT-OUTBOUND: the address we are about to CALL, not context we send to a
  // model. Redacting it would break the reachability check.
  const url = `${endpoint.baseURL.replace(/\/$/, '')}/models`;
  // MUST match what getSdk will actually send. @ai-sdk/openai always emits an
  // Authorization header, and for a keyless endpoint it emits the placeholder
  // (see NO_KEY_PLACEHOLDER). Testing with no header at all made the Test
  // button answer a question nobody asked: it could pass against a gateway
  // that then rejects every real generation, or fail against one that would
  // have accepted them. Whatever the gateway does, it now does the same thing
  // to both.
  return (fetchImpl || fetch)(url, {
    headers: { Authorization: `Bearer ${apiKey || NO_KEY_PLACEHOLDER}` },
    signal: AbortSignal.timeout(10000)
  });
};

module.exports = {
  PROVIDERS,
  MODEL_DEFINITIONS,
  OPENAI_COMPATIBLE_PREFIX,
  CUSTOM_MODEL_SEPARATOR,
  NO_KEY_PLACEHOLDER,
  customModelId,
  isCustomModelId,
  parseCustomModelId,
  resolveModelDefinition,
  listProviders,
  listModels,
  getModel,
  getAvailableModels,
  clearSdkCache,
  listSdkCacheKeys,
  hashApiKey,
  sdkCacheKey,
  isAiEnabled,
  isProviderEnabled,
  providerRequiresApiKey,
  isOpenAiCompatibleProviderId,
  endpointIdFromProviderId,
  providerIdFromEndpointId,
  getCompatEndpoint,
  isKnownProviderId,
  isBuiltInModelId,
  isReasoningModel,
  isOpenAiReasoningModel,
  validateApiKeyForProvider,
  providerLabel
};
