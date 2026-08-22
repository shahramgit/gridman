const { isRequestTooExpensiveToParse, MAX_EFFECTIVE_PARSE_BYTES, MAX_YML_PARSE_BYTES } = require('../../src/utils/parse');
const { getRequestParseCost } = require('@usebruno/filestore');

/**
 * WHAT MAKES A REQUEST TOO EXPENSIVE TO PARSE.
 *
 * Not its size. The grammar never sees the file — it sees the redacted copy, where each
 * leaf payload has been swapped for a probe line — so cost tracks THAT, and the two differ
 * by orders of magnitude on exactly the requests users complain about.
 *
 * Measured over every request above 1 MB in the reported workspace:
 *
 *     healthy files:  at most     25 KB effective,  30-82 ms
 *     the one failure:         1,096 KB effective,  3,525 ms then out of heap
 *
 * The 2.5 MB FILE gate this replaced got both ends backwards: it refused a 3.72 MB request
 * that parses in 11 ms (reported as "Load Request does nothing") while letting the 1.07 MB
 * one that actually dies straight through.
 */

const meta = `meta {
  name: R
  type: http
  seq: 1
}

post {
  url: https://api.example.internal/v1/thing
  body: json
  auth: none
}
`;

// A payload inside a block the redactor COVERS: huge on disk, tiny to the grammar.
const withRedactablePayload = (bytes) => `${meta}
body:json {
  {"blob":"${'a'.repeat(bytes)}"}
}
`;

// A payload inside a block the redactor does NOT cover. multipart-form is a table, not a
// text block — this is the shape of the one real file that fails.
const withUnredactablePayload = (bytes) => `${meta}
body:multipart-form {
  file: ${'a'.repeat(bytes)}
}
`;

describe('the parse budget is measured after redaction, not on disk', () => {
  it('lets a multi-megabyte request through when its payload is redactable', () => {
    const content = withRedactablePayload(3 * 1024 * 1024);
    const size = Buffer.byteLength(content);

    expect(size).toBeGreaterThan(2.5 * 1024 * 1024);
    // The old byte gate refused exactly this.
    expect(isRequestTooExpensiveToParse(content, size, 'bru')).toBe(false);

    const cost = getRequestParseCost(content, { format: 'bru' });
    expect(cost.redacted).toBe(true);
    expect(cost.effectiveBytes).toBeLessThan(MAX_EFFECTIVE_PARSE_BYTES);
  });

  it('stops a smaller request whose payload the redactor cannot cover', () => {
    const content = withUnredactablePayload(1024 * 1024);
    const size = Buffer.byteLength(content);

    // Under the old 2.5 MB gate this sailed through and took the app down.
    expect(size).toBeLessThan(2.5 * 1024 * 1024);
    expect(isRequestTooExpensiveToParse(content, size, 'bru')).toBe(true);
    expect(getRequestParseCost(content, { format: 'bru' }).redacted).toBe(false);
  });

  // The initial scan touches ~12,000 requests, so the estimator is skipped for
  // anything under the budget. That shortcut is only sound because redaction can
  // never make a file BIGGER — which is the property asserted here, rather than
  // asserting the shortcut itself (it is unobservable by construction).
  it.each([
    ['redactable', withRedactablePayload],
    ['unredactable', withUnredactablePayload]
  ])('never reports more effective bytes than the file has (%s payload)', (_label, build) => {
    for (const bytes of [1024, 64 * 1024, 600 * 1024]) {
      const content = build(bytes);
      const cost = getRequestParseCost(content, { format: 'bru' });
      expect(cost.effectiveBytes).toBeLessThanOrEqual(Buffer.byteLength(content));
    }
  });

  it('treats an unreadable size as cheap rather than guessing', () => {
    expect(isRequestTooExpensiveToParse('x', undefined, 'bru')).toBe(false);
    expect(isRequestTooExpensiveToParse('x', NaN, 'bru')).toBe(false);
  });

  // yml keeps its own, much larger budget: js-yaml costs ~10.6 ms/MB where the ohm
  // grammar costs ~1.4 GB/MB, so the bru number would refuse yml files in no danger.
  it('leaves yml on its own file-size budget', () => {
    const under = `info:\n  name: r\n${'#'.repeat(MAX_EFFECTIVE_PARSE_BYTES)}\n`;
    expect(isRequestTooExpensiveToParse(under, Buffer.byteLength(under), 'yml')).toBe(false);

    const over = `info:\n  name: r\n${'#'.repeat(MAX_YML_PARSE_BYTES)}\n`;
    expect(isRequestTooExpensiveToParse(over, Buffer.byteLength(over), 'yml')).toBe(true);
  });
});
