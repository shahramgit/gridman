const fs = require('node:fs');
const { getCACertificates } = require('@usebruno/requests');
const { preferencesUtil, getPreferences } = require('../../store/preferences');

// Parsed here rather than imported from providers.js on purpose: providers.js
// already requires proxy.js, and proxy.js requires this module. Duplicating one
// string prefix is cheaper than the require cycle, and the prefix is fixed by
// the preferences schema (`CUSTOM_MODEL_ID_SEPARATOR` guards its uniqueness).
const OPENAI_COMPATIBLE_PREFIX = 'openai-compatible:';

const isOpenAiCompatibleProviderId = (id) =>
  typeof id === 'string' && id.startsWith(OPENAI_COMPATIBLE_PREFIX);

const findOpenAiCompatibleEndpoint = (providerId) => {
  const endpointId = String(providerId).slice(OPENAI_COMPATIBLE_PREFIX.length);
  if (!endpointId) return null;
  let endpoints;
  try {
    endpoints = getPreferences()?.ai?.openaiCompatibleEndpoints;
  } catch (_err) {
    return null;
  }
  if (!Array.isArray(endpoints)) return null;
  return endpoints.find((endpoint) => endpoint?.id === endpointId) || null;
};

/**
 * TLS for AI traffic.
 *
 * The AI SDKs call global `fetch` (undici), which honours NOTHING from this
 * app's TLS configuration: not `preferences.request.sslVerification`, not the
 * custom CA certificate in Preferences > General. Every other request Gridman
 * makes builds an https agent from those settings (ipc/network/cert-utils.js) —
 * AI requests did not, so an internal endpoint behind a private CA failed with
 * "unable to verify the first certificate" while the exact same host worked
 * fine in a request tab.
 *
 * Two layers, applied in this order:
 *
 *  1. The app-wide settings, same source as every other request. A user who has
 *     already told Gridman about their corporate CA does not have to tell it
 *     again for AI.
 *
 *  2. A per-endpoint override on an OpenAI-compatible endpoint only:
 *     `caCertFilePath` (trust this CA for this endpoint) and `allowSelfSigned`
 *     (skip verification for this endpoint).
 *
 * Why the override is per-endpoint and not a global switch: the alternative is
 * turning `sslVerification` off in Preferences, which disables certificate
 * verification for EVERY request the app makes, against every host, to reach
 * one internal gateway. That trade is not one a user should have to make, and
 * it is silent once made. Scoped here, `allowSelfSigned` weakens exactly one
 * base URL that the user typed themselves.
 *
 * The override is deliberately unavailable to the hosted providers. `openai`
 * and `anthropic` talk to fixed public endpoints over the public internet; a
 * certificate that does not verify there is a real interception, not a private
 * CA, and there is no legitimate configuration in which suppressing it helps.
 */

const readCaFile = (filePath) => {
  const resolved = String(filePath || '').trim();
  if (!resolved) return null;
  try {
    return fs.readFileSync(resolved);
  } catch (err) {
    // Named, not swallowed: a CA file the user pointed at and we could not read
    // must surface as a configuration error. Falling back to the default trust
    // store would "work" for public hosts and fail confusingly for theirs.
    throw new Error(
      `The CA certificate for this AI endpoint could not be read (${resolved}): ${err.message}. `
      + 'Fix the path in Preferences > AI, or clear it to use the app-wide certificate settings.'
    );
  }
};

/**
 * App-wide CA material, from the same helper the request path uses.
 *
 * Only loaded when verification is on — with `rejectUnauthorized: false` the
 * CA list is never consulted, and reading the system trust store costs real
 * time on macOS.
 */
const readAppCaCertificates = () => {
  try {
    if (!preferencesUtil.shouldVerifyTls()) return null;
    const caCertFilePath
      = preferencesUtil.shouldUseCustomCaCertificate() && preferencesUtil.getCustomCaCertificateFilePath();
    const { caCertificates } = getCACertificates({
      caCertFilePath,
      shouldKeepDefaultCerts: preferencesUtil.shouldKeepDefaultCaCertificates()
    });
    return caCertificates || null;
  } catch (_err) {
    // A failure to aggregate the app-wide certs is not a reason to refuse the
    // request: undici still has Node's built-in trust store, which is what the
    // user had before this module existed. The per-endpoint file above is the
    // one whose failure is explicit, because the user named that file.
    return null;
  }
};

/**
 * Resolve the TLS options for one provider.
 *
 * Returns `{ options, signature }` where `options` is null when nothing in this
 * app's configuration differs from undici's defaults — in that case callers
 * must not build a dispatcher at all, so an install with no proxy and no custom
 * certificates keeps using plain global fetch exactly as before.
 */
const resolveAiTls = (providerId) => {
  // Every read below can throw if the preferences store is unreadable (a
  // corrupt file, a locked userData directory). The safe answer to "should we
  // verify certificates?" when we cannot tell is YES — a store we failed to
  // read must never be the reason verification gets skipped.
  const readPreference = (read, fallback) => {
    try {
      const value = read();
      return value === undefined ? fallback : value;
    } catch (_err) {
      return fallback;
    }
  };

  const verifyTls = readPreference(() => preferencesUtil.shouldVerifyTls(), true);
  const endpoint = isOpenAiCompatibleProviderId(providerId)
    ? findOpenAiCompatibleEndpoint(providerId)
    : null;

  const allowSelfSigned = Boolean(endpoint?.allowSelfSigned);
  const rejectUnauthorized = verifyTls && !allowSelfSigned;

  // Nothing to verify against when verification is off.
  if (!rejectUnauthorized) {
    return {
      options: { rejectUnauthorized: false },
      signature: `tls:insecure:${allowSelfSigned ? endpoint?.id || '' : 'global'}`
    };
  }

  const endpointCaPath = String(endpoint?.caCertFilePath || '').trim();
  const appCaPath = readPreference(() => preferencesUtil.shouldUseCustomCaCertificate(), false)
    ? String(readPreference(() => preferencesUtil.getCustomCaCertificateFilePath(), '') || '').trim()
    : '';

  // Nothing configured anywhere: leave undici entirely alone.
  //
  // This early return matters more than it looks. `getCACertificates` with no
  // custom path still returns the aggregated system + root bundle, and handing
  // undici a `ca` array REPLACES its trust store rather than adding to it — so
  // building options here unconditionally would change certificate validation
  // for every user, including the overwhelming majority who have no
  // certificate problem at all. The only users whose TLS behaviour changes are
  // the ones who asked for it.
  if (!endpointCaPath && !appCaPath) {
    return { options: null, signature: 'tls:default' };
  }

  // Read explicitly rather than through `getCACertificates`, whose own error
  // path for an unreadable file is a console warning. A CA the user selected
  // and we cannot read has to be loud.
  const endpointCa = endpointCaPath ? readCaFile(endpointCaPath) : null;
  const appCa = readAppCaCertificates();

  // The endpoint's own CA is ADDITIVE, not a replacement: a machine that talks
  // to an internal gateway signed by a private CA generally still has to reach
  // public hosts, and `readAppCaCertificates` carries the system roots that
  // make that work.
  const ca = [];
  if (appCa) ca.push(...(Array.isArray(appCa) ? appCa : [appCa]));
  if (endpointCa) ca.push(endpointCa);

  if (!ca.length) {
    return { options: null, signature: 'tls:default' };
  }

  return {
    options: { rejectUnauthorized: true, ca },
    // NOT-OUTBOUND: an in-process cache key. The path identifies the file, and
    // mtime rebuilds the dispatcher after the user replaces a rotated cert
    // without having to restart the app.
    signature: `tls:ca:${endpointCaPath}:${endpointCaPath ? caFileStamp(endpointCaPath) : ''}:${appCa ? 'app' : 'noapp'}`
  };
};

const caFileStamp = (filePath) => {
  try {
    const { mtimeMs, size } = fs.statSync(filePath);
    return `${Math.trunc(mtimeMs)}-${size}`;
  } catch (_err) {
    return 'unstatable';
  }
};

module.exports = { resolveAiTls };
