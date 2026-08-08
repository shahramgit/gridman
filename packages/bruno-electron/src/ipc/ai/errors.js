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

module.exports = { describeAiError, logAiError, logAiWarning };
