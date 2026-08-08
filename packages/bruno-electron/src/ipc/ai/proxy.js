const { preferencesUtil } = require('../../store/preferences');

/**
 * Proxy routing for AI traffic.
 *
 * Every other outbound request in this app goes through the agents built in
 * utils/proxy-util.js. The AI SDKs use global `fetch`, which honours NOTHING
 * from `preferences.proxy` — so without this module an AI request on a
 * restricted corporate network either fails outright or, worse, egresses
 * outside the audited path while every other request in the same app stays
 * inside it.
 *
 * The rule enforced here is FAIL-CLOSED: if the user configured a proxy and we
 * cannot route through it, we refuse to make the request at all. Silently
 * going direct is the outcome this whole feature exists to prevent.
 *
 * What is honoured:
 *   - `source: 'manual'`  -> http/https proxy built from preferences.proxy.config
 *   - `source: 'inherit'` -> HTTPS_PROXY / HTTP_PROXY / ALL_PROXY from the
 *                            environment (what a shell-launched app inherits)
 *
 * What is REFUSED rather than bypassed:
 *   - `source: 'pac'`             — a PAC script has to be evaluated per URL;
 *                                   fetch has no hook for that.
 *   - `protocol: socks4 | socks5` — undici's ProxyAgent speaks HTTP CONNECT only.
 *   - undici not loadable         — no dispatcher can be built at all.
 *
 * KNOWN LIMITATION (documented deliberately): on `source: 'inherit'` we read
 * the environment, not the OS proxy database. store/system-proxy.js resolves
 * the OS setting but only asynchronously, and the model-construction path is
 * synchronous. A machine whose proxy is set in the OS UI but not exported into
 * the app's environment will send AI traffic direct.
 */

// Env vars checked, in priority order, when the proxy source is 'inherit'.
// HTTPS first: every provider endpoint we talk to is https.
const ENV_PROXY_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
];

const SOCKS_PROTOCOLS = new Set(['socks', 'socks4', 'socks5']);

const readEnvProxy = () => {
  for (const name of ENV_PROXY_VARS) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

/**
 * Reduce `preferences.proxy` to what AI traffic needs: a proxy URL, or an
 * explicit reason we must refuse. Never returns "go direct" for a
 * configuration that names a proxy we cannot use.
 */
const resolveAiProxy = () => {
  const proxy = preferencesUtil.getGlobalProxyConfig() || {};
  if (proxy.disabled === true) return { mode: 'direct' };

  const source = proxy.source || 'manual';

  if (source === 'pac') {
    return {
      mode: 'refuse',
      reason: 'A PAC proxy script is configured for this app, and AI requests cannot evaluate a PAC script. '
        + 'Switch Preferences > Proxy to a manual proxy to use AI features.'
    };
  }

  if (source === 'inherit') {
    const url = readEnvProxy();
    return url ? { mode: 'proxy', url } : { mode: 'direct' };
  }

  const config = proxy.config || {};
  const hostname = String(config.hostname || '').trim();
  if (!hostname) return { mode: 'direct' };

  const protocol = String(config.protocol || 'http').trim().toLowerCase();
  if (SOCKS_PROTOCOLS.has(protocol)) {
    return {
      mode: 'refuse',
      reason: `A ${protocol} proxy is configured for this app, and AI requests cannot be routed over SOCKS. `
        + 'Switch Preferences > Proxy to an http/https proxy to use AI features.'
    };
  }

  const port = config.port ? `:${config.port}` : '';
  const auth = config.auth || {};
  const username = auth.disabled === true ? '' : String(auth.username || '');
  const password = auth.disabled === true ? '' : String(auth.password || '');

  return {
    mode: 'proxy',
    url: `${protocol}://${hostname}${port}`,
    // Passed to undici as a header rather than embedded in the URL, so proxy
    // credentials never end up in a URL string that could be logged.
    token: username || password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      : undefined
  };
};

// Identifies the resolved routing so callers can key a cache on it and rebuild
// when the user edits the proxy. The token is hashed out — it is a credential.
const proxySignature = (resolved) => {
  if (resolved.mode !== 'proxy') return resolved.mode;
  // NOT-OUTBOUND: an in-process SDK cache key. Never leaves this machine, and
  // never reaches a prompt.
  return `proxy:${resolved.url}:${resolved.token ? 'auth' : 'noauth'}`;
};

let cached = null; // { signature, fetch }

/**
 * undici is a DECLARED dependency of this package (`undici` in
 * packages/bruno-electron/package.json), so on a correctly installed build the
 * require below always succeeds. It used to arrive only transitively, via
 * `@usebruno/js -> cheerio -> undici`, which meant a cheerio bump could take
 * the AI feature out entirely for the restricted-network user whose proxy is
 * never optional.
 *
 * The load stays lazy and guarded anyway. Lazy because the overwhelming
 * majority of users have no proxy configured and should not pay to load it;
 * guarded because a broken or partial install (a packaged app assembled with a
 * pruned node_modules, a hoisting accident in a monorepo) is still possible,
 * and the failure mode has to be a refusal rather than a crash. When it cannot
 * be loaded we refuse rather than fall back to a direct fetch — going direct is
 * exactly the leak this module exists to prevent.
 */
const buildDispatcher = (resolved) => {
  let ProxyAgent;
  try {
    ({ ProxyAgent } = require('undici'));
  } catch (err) {
    ProxyAgent = null;
  }
  if (typeof ProxyAgent !== 'function') {
    throw new Error(
      'A proxy is configured for this app, but AI requests cannot be routed through it on this build '
      + '(the HTTP proxy agent is unavailable). Refusing to send AI traffic outside the configured proxy.'
    );
  }
  return new ProxyAgent(resolved.token ? { uri: resolved.url, token: resolved.token } : { uri: resolved.url });
};

/**
 * Returns `{ fetch, signature }`.
 *
 * `fetch` is null when no proxy applies (callers then leave the SDK on global
 * fetch). THROWS when a proxy is configured but cannot be honoured — callers
 * must let that propagate so the request never leaves the machine.
 */
const getAiFetch = () => {
  const resolved = resolveAiProxy();

  if (resolved.mode === 'refuse') {
    throw new Error(resolved.reason);
  }

  const signature = proxySignature(resolved);

  if (resolved.mode === 'direct') {
    cached = null;
    return { fetch: null, signature };
  }

  if (cached?.signature === signature) {
    return { fetch: cached.fetch, signature };
  }

  const dispatcher = buildDispatcher(resolved);
  // Resolve globalThis.fetch at call time so a test spy (or an Electron
  // override) is honoured, and so we never capture a stale reference.
  const proxiedFetch = (input, init) => globalThis.fetch(input, { ...(init || {}), dispatcher });

  cached = { signature, fetch: proxiedFetch };
  return { fetch: proxiedFetch, signature };
};

const clearAiFetchCache = () => {
  cached = null;
};

module.exports = {
  resolveAiProxy,
  getAiFetch,
  clearAiFetchCache,
  ENV_PROXY_VARS
};
