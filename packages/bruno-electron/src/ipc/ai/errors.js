/**
 * Console-safe description of an AI SDK error.
 *
 * WHY THIS EXISTS: `console.error('...', err)` on an AI SDK failure prints the
 * whole error object, and the AI SDK's APICallError carries `requestBodyValues`
 * / `requestBodyText` — the ENTIRE assembled outbound prompt. That is the
 * request context, the variables, the response shape, the docs, and anything
 * the redaction layer let through, dumped verbatim into the terminal and into
 * whatever collects stdout for the app. For an air-gapped customer, a log file
 * is another copy of the data the redaction layer exists to control.
 *
 * `err.message` is not safe either: providers routinely echo the offending part
 * of the request back in their error body, and the AI SDK folds that body into
 * the message. So we log a fixed description plus a small, closed set of
 * non-content fields, and nothing else.
 *
 * The message still goes to the RENDERER (the user's own window) so the user
 * can see why their request failed — that is the same person who typed it.
 * What we refuse to do is write it to a log.
 */

const SAFE_STATUS_FIELDS = ['statusCode', 'status'];

/**
 * Node's TLS failure codes for "this certificate does not verify". The two the
 * user actually meets are UNABLE_TO_VERIFY_LEAF_SIGNATURE (a chain signed by a
 * private CA — surfaced as "unable to verify the first certificate") and
 * DEPTH_ZERO_SELF_SIGNED_CERT (a bare self-signed certificate).
 */
const TLS_TRUST_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_UNTRUSTED'
]);

const TLS_TRUST_MESSAGE_HINTS = [
  'unable to verify the first certificate',
  'self signed certificate',
  'self-signed certificate'
];

const causeChain = function* (err) {
  let node = err;
  // Bounded: fetch wraps its cause, which wraps the TLS error, and a cycle in a
  // hand-built error must not hang the handler.
  for (let depth = 0; node && depth < 5; depth += 1) {
    yield node;
    node = node.cause;
  }
};

/**
 * True when a failure is "the certificate did not verify" rather than anything
 * about the request. Checked by code first; the message strings are the
 * fallback for a provider SDK that flattened the cause into text.
 */
const isTlsTrustError = (err) => {
  for (const node of causeChain(err)) {
    if (TLS_TRUST_ERROR_CODES.has(node?.code)) return true;
  }
  const message = String(err?.message || '').toLowerCase();
  return TLS_TRUST_MESSAGE_HINTS.some((hint) => message.includes(hint));
};

/**
 * What the user should be told when their endpoint's certificate does not
 * verify. The raw SDK text ("Failed after 3 attempts. Last error: Cannot
 * connect to API: unable to verify the first certificate") is accurate and
 * completely unactionable — it does not say that this is fixable, or where.
 *
 * Returns null for every other failure, so nothing else is reworded.
 */
const tlsTrustGuidance = (err) => {
  if (!isTlsTrustError(err)) return null;
  return 'Gridman could not verify this endpoint\'s TLS certificate. If it is signed by your own CA, '
    + 'select that CA certificate under the endpoint in Preferences > AI. If it is self-signed and you '
    + 'have no CA file, tick "Trust this endpoint\'s certificate without verifying it" on the same '
    + 'endpoint. Neither setting affects any other endpoint or any other request the app makes.';
};

const safeStatusOf = (err) => {
  for (const field of SAFE_STATUS_FIELDS) {
    const value = err?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};

/**
 * @returns {string} e.g. `AI_APICallError (HTTP 401)` — never any request or
 *          response content.
 */
const describeAiError = (err) => {
  if (!err) return 'unknown error';

  const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
  const status = safeStatusOf(err);
  const parts = [name];
  if (status !== null) parts.push(`(HTTP ${status})`);
  if (err.name === 'AbortError' || err?.code === 'ABORT_ERR') parts.push('(aborted)');
  return parts.join(' ');
};

/**
 * Log an AI failure without ever passing the error object (or its message) to
 * the console. Use this instead of `console.error(msg, err)` everywhere in
 * this directory.
 */
const logAiError = (context, err) => {
  console.error(`[AI] ${context}: ${describeAiError(err)}`);
};

const logAiWarning = (context, err) => {
  console.warn(`[AI] ${context}: ${describeAiError(err)}`);
};

module.exports = { describeAiError, logAiError, logAiWarning, isTlsTrustError, tlsTrustGuidance };
