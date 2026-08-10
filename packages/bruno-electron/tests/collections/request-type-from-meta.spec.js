const { parseRequest } = require('@usebruno/filestore');
const { parseFileMeta } = require('../../src/utils/collection');

/**
 * READING A REQUEST'S TYPE MUST NOT PARSE THE REQUEST.
 *
 * `getRequestTypeFromPath` (ipc/collection.js) is on the rename, move, clone
 * and delete paths, and it used to full-parse the file on the browser process
 * to read one word out of the meta block. Measured on the reported workspace, a
 * 1,096 KB request costs 3,081 ms to parse and 0.1 ms to read the meta of, and
 * the largest files there (2.5 MB) can exhaust the heap outright — which is
 * what "pressing rename does nothing, then it applies minutes later with an
 * error" looked like from the outside.
 *
 * The substitution is only safe while the cheap reader AGREES with the parser,
 * so that is what these check — including for the request kinds whose meta
 * spelling differs from the type the app uses.
 */

const buildBru = (type, extra = '') => `meta {
  name: Example
  type: ${type}
  seq: 1
}

${extra}`;

const HTTP_BODY = `get {
  url: https://api.example.internal/v1/thing
  body: none
  auth: none
}
`;

describe('the meta-only type read agrees with a full parse', () => {
  const cases = [
    ['http', HTTP_BODY],
    ['graphql', `post {\n  url: https://api.example.internal/graphql\n  body: graphql\n  auth: none\n}\n`]
  ];

  it.each(cases)('reports the same type as parseRequest for a %s request', (type, body) => {
    const src = buildBru(type, body);
    const viaParser = parseRequest(src, { format: 'bru' });
    const viaMeta = parseFileMeta(src, 'bru');

    expect(viaMeta.type).toBe(viaParser.type);
    // Not the raw meta spelling: the app works in 'http-request' /
    // 'graphql-request', and returning 'http' here would mislabel every row.
    expect(viaMeta.type).toBe(`${type}-request`);
  });

  it('is unaffected by a huge body, which is the whole point', () => {
    // One real file in the reported workspace holds a single 503,897-character
    // line; the parser is the part that cannot cope with it.
    const huge = buildBru('http', `${HTTP_BODY}\nbody:json {\n  ${'x'.repeat(600000)}\n}\n`);

    const started = process.hrtime.bigint();
    const viaMeta = parseFileMeta(huge, 'bru');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(viaMeta.type).toBe('http-request');
    // Generous by three orders of magnitude against the 3,081 ms this replaced,
    // so it fails on a regression to full parsing and not on a slow machine.
    expect(elapsedMs).toBeLessThan(250);
  });

  it('falls back rather than throwing on a file with no meta block', () => {
    // Same outcome the old catch produced, so callers keep their behaviour.
    expect(parseFileMeta('not a request at all', 'bru')).toBeNull();
  });
});
