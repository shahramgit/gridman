/**
 * The point of the redaction is that the payload never reaches the ohm grammar. Every other
 * test in this directory checks that the ANSWER is unchanged, which is exactly what a
 * regression here would also look like - correct, and as slow and as memory-hungry as before.
 *
 * So this one watches the boundary instead: it records what `parseBruRequest` actually hands
 * to `bruToJsonV2`. Revert the redaction and the grammar gets the whole file again, which is
 * what the size assertions below reject.
 */
jest.mock('@usebruno/lang', () => {
  const actual = jest.requireActual('@usebruno/lang');
  global.__bruToJsonV2Inputs = [];
  return {
    ...actual,
    bruToJsonV2: (input) => {
      global.__bruToJsonV2Inputs.push(input);
      return actual.bruToJsonV2(input);
    }
  };
});

const { parseBruRequest } = require('../index');

const lines = (...rows) => rows.join('\n') + '\n';

/** A marker that only ever appears inside the payload, so we can look for it by name. */
const NEEDLE = 'PAYLOAD-BYTES-THAT-MUST-NOT-REACH-THE-GRAMMAR';

/**
 * A payload whose first and last lines carry no marker: those two go through verbatim by
 * design (they are where the parser's end-trims have to land), so the marker lives only on
 * the lines the redaction is supposed to remove.
 */
const payloadLines = (indent, count = 200) => [
  `${indent}{`,
  ...Array.from({ length: count - 2 }, (_, i) => `${indent}  "field${i}": "${NEEDLE}-${i}",`),
  `${indent}}`
];

const withSavedExample = lines(
  'meta {',
  '  name: sample',
  '  type: http',
  '  seq: 1',
  '}',
  '',
  'post {',
  '  url: https://example.com',
  '  body: json',
  '  auth: none',
  '}',
  '',
  'example {',
  '  name: saved response',
  '  ',
  '  request: {',
  '    url: https://example.com',
  '    method: POST',
  '  }',
  '',
  '  response: {',
  '    status: {',
  '      code: 200',
  '      text: OK',
  '    }',
  '',
  '    body: {',
  '      type: json',
  "      content: '''",
  ...payloadLines('        '),
  "      '''",
  '    }',
  '  }',
  '}',
  ''
);

describe('what the grammar is actually given', () => {
  beforeEach(() => {
    global.__bruToJsonV2Inputs = [];
  });

  it('never sees the bytes of a saved example payload', () => {
    const parsed = parseBruRequest(withSavedExample);

    const seen = global.__bruToJsonV2Inputs;
    // If the spy cannot observe its target this is 0 and the test is worthless, so assert it.
    expect(seen).toHaveLength(1);

    const given = seen[0];
    expect(given).not.toContain(NEEDLE);
    expect(given.length).toBeLessThan(withSavedExample.length / 10);

    // ...and the payload still came back whole.
    expect(parsed.examples[0].response.body.content.split('\n')).toHaveLength(200);
    expect(parsed.examples[0].response.body.content).toContain(`${NEEDLE}-197`);
  });

  it('never sees the bytes of a top level body block', () => {
    const content = lines(
      'meta {',
      '  name: sample',
      '  type: http',
      '  seq: 1',
      '}',
      '',
      'post {',
      '  url: https://example.com',
      '  body: json',
      '  auth: none',
      '}',
      '',
      'body:json {',
      ...payloadLines('  '),
      '}',
      ''
    );

    const parsed = parseBruRequest(content);

    const seen = global.__bruToJsonV2Inputs;
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(NEEDLE);
    expect(seen[0].length).toBeLessThan(content.length / 10);
    expect(parsed.request.body.json.split('\n')).toHaveLength(200);
  });

  it('grows the grammar input with the file structure, not with the saved example', () => {
    const measure = (payloadCount) => {
      global.__bruToJsonV2Inputs = [];
      const content = lines(
        'meta {',
        '  name: sample',
        '  type: http',
        '  seq: 1',
        '}',
        '',
        'post {',
        '  url: https://example.com',
        '  body: json',
        '  auth: none',
        '}',
        '',
        'example {',
        '  name: saved response',
        '  ',
        '  response: {',
        '    body: {',
        '      type: json',
        "      content: '''",
        ...payloadLines('        ', payloadCount),
        "      '''",
        '    }',
        '  }',
        '}',
        ''
      );
      parseBruRequest(content);
      return { fileBytes: content.length, grammarBytes: global.__bruToJsonV2Inputs[0].length };
    };

    const small = measure(50);
    const large = measure(5000);

    // The file grew by ~100x...
    expect(large.fileBytes).toBeGreaterThan(small.fileBytes * 50);
    // ...and what the grammar has to chew through did not grow at all.
    expect(large.grammarBytes).toBe(small.grammarBytes);
  });
});
