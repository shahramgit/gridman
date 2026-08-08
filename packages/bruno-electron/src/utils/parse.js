const { parseRequestViaWorker, DEFAULT_COLLECTION_FORMAT } = require('@usebruno/filestore');

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
 *    The old redaction matched `block.startsWith('body:json {')` after splitting on '\n}\n',
 *    and an example payload lives at example > response > body, indented, so it matched
 *    nothing: measured over the three biggest real files it returned them at exactly the size
 *    it received them.
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

module.exports = { parseLargeRequestWithRedaction };
