const { parseRequestViaWorker, getRequestParseCost, DEFAULT_COLLECTION_FORMAT } = require('@usebruno/filestore');

/**
 * Parses a large BRU request off the browser process.
 *
 * The body redaction that used to happen here now happens inside the parser itself
 * (packages/bruno-filestore/src/formats/bru), which changes two things for the better:
 *
 *  - It runs in the worker instead of on the browser process. This function used to scan and
 *    rebuild the whole file string here, synchronously, before handing it over.
 *  - It covers leaf payloads at any indent depth - the saved example bodies that are 89-100%
 *    of the biggest files in the real workspace - instead of only top level `body:*` blocks.
 *
 * Because the parser now redacts every .bru request it parses, this and the plain worker
 * parse the watcher uses below the size threshold are the same code path. The wrapper stays
 * so the oversized-file call sites keep their name for it.
 *
 * @param {string} bruContent
 * @param {string} format - Collection format, defaults to 'bru'
 * @returns {Promise<any>} parsed request JSON
 */
async function parseLargeRequestWithRedaction(bruContent, format = DEFAULT_COLLECTION_FORMAT) {
  return await parseRequestViaWorker(bruContent, { format });
}

/**
 * The most a request may cost the grammar before we refuse to parse it on sight.
 *
 * Measured in EFFECTIVE bytes - the size of the redacted copy the grammar actually receives
 * (see getRequestParseCost) - not the size of the file. Those two are not the same question,
 * and a byte-size gate answered the wrong one: over every request above 1 MB in the real
 * workspace,
 *
 *     healthy files:  at most     25 KB effective, 30-82 ms
 *     the one that fails:      1,096 KB effective, 3,525 ms, then out of heap
 *
 * The old 2.5 MB FILE gate got both ends of that backwards. It refused four multi-MB
 * requests that parse in 7-39 ms (including the 3.72 MB one users reported as "Load Request
 * does nothing"), while letting the single genuinely dangerous 1.07 MB file straight through
 * - because that file's payload sits in `body:multipart-form`, which the redactor does not
 * cover, so the grammar sees all of it.
 *
 * 512 KB sits 20x above the largest healthy file and half the size of the failing one. At
 * roughly 1.4 GB of heap per MB the grammar consumes, it is also about 700 MB - survivable,
 * where 1 MB effective is not.
 */
const MAX_EFFECTIVE_PARSE_BYTES = 512 * 1024;

/**
 * Should this request be left unparsed (meta only, with a "Load Request" escape hatch)?
 *
 * Cheap by construction: a file smaller than the budget cannot possibly exceed it after
 * redaction, so the redactor only runs for the handful of genuinely large files - 54 of
 * 12,088 in the reported workspace - and never during the initial scan of the rest.
 */
/**
 * yml keeps the file-size gate it always had.
 *
 * The effective-bytes budget above is calibrated for the ohm grammar, which costs roughly
 * 1.4 GB of heap per MB. js-yaml is a different machine entirely — measured over structured
 * request yml on this corpus, 10.6 ms and 15.3 MB per MB — so a 2 MB yml request parses in
 * ~21 ms and gating it at 512 KB would refuse files that are in no danger. yml also has no
 * redaction, so its effective size IS its size and the estimator can tell us nothing new.
 */
const MAX_YML_PARSE_BYTES = 2.5 * 1024 * 1024;

const isRequestTooExpensiveToParse = (content, sizeInBytes, format = DEFAULT_COLLECTION_FORMAT) => {
  if (!Number.isFinite(sizeInBytes)) {
    return false;
  }
  if (format !== 'bru') {
    return sizeInBytes >= MAX_YML_PARSE_BYTES;
  }
  if (sizeInBytes < MAX_EFFECTIVE_PARSE_BYTES) {
    return false;
  }
  try {
    return getRequestParseCost(content, { format }).effectiveBytes >= MAX_EFFECTIVE_PARSE_BYTES;
  } catch (_err) {
    // Unable to estimate: fall back to the file size, which is what this used to be.
    return sizeInBytes >= MAX_EFFECTIVE_PARSE_BYTES;
  }
};

module.exports = {
  parseLargeRequestWithRedaction,
  isRequestTooExpensiveToParse,
  MAX_EFFECTIVE_PARSE_BYTES,
  MAX_YML_PARSE_BYTES
};
