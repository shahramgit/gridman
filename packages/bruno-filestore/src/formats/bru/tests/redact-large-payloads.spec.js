const { bruToJsonV2 } = require('@usebruno/lang');
const { parseBruRequest, stringifyBruRequest } = require('../index');
const { bruRequestParseAndRedactBodyData } = require('../utils/request-parse-and-redact-body-data');

/**
 * The invariant every test here checks is the same one: parsing a .bru with the leaf payloads
 * redacted has to produce EXACTLY what parsing it whole produces.
 *
 * `reference()` is the whole-file parse - it hands `parseBruRequest` an already-parsed object,
 * which is the one path that does not go through the redactor - so a test failing here means
 * the redaction changed what the file means, which is the failure mode that kept an earlier
 * attempt at this from shipping.
 */
const reference = (content) => parseBruRequest(bruToJsonV2(content), true);

const lines = (...rows) => rows.join('\n') + '\n';

const request = (...blocks) =>
  lines(
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
    ...blocks
  );

/** 40 lines of ~45 bytes - enough that redacting is a win, small enough to read in a failure. */
const payloadLines = (indent, count = 40) =>
  Array.from({ length: count }, (_, i) => `${indent}"field${i}": "${'v'.repeat(30)}",`);

const exampleWithResponseBody = (payload) =>
  request(
    'example {',
    '  name: saved response',
    '  ',
    '  request: {',
    '    url: https://example.com',
    '    method: POST',
    '  }',
    '',
    '  response: {',
    '    headers: {',
    '      content-type: application/json',
    '    }',
    '',
    '    status: {',
    '      code: 200',
    '      text: OK',
    '    }',
    '',
    '    body: {',
    '      type: json',
    "      content: '''",
    ...payload,
    "      '''",
    '    }',
    '  }',
    '}',
    ''
  );

const expectSameAsWholeFileParse = (content) => {
  const expected = reference(content);
  const actual = parseBruRequest(content);
  expect(actual).toEqual(expected);
  // The object comparison above can be satisfied by two objects that serialise differently
  // (a lost key with an undefined value, say). The bytes are what land back on disk.
  expect(stringifyBruRequest(actual)).toBe(stringifyBruRequest(expected));
  return actual;
};

describe('redacting large leaf payloads before the grammar sees them', () => {
  describe('produces exactly the whole-file parse', () => {
    const cases = {
      'saved example response body': exampleWithResponseBody(payloadLines('        ')),

      'saved example request body': request(
        'example {',
        '  name: saved request',
        '  ',
        '  request: {',
        '    url: https://example.com',
        '    method: POST',
        '    mode: json',
        '',
        '    body:json: {',
        ...payloadLines('      '),
        '    }',
        '  }',
        '}',
        ''
      ),

      'top level body block': request('body:json {', ...payloadLines('  '), '}', ''),

      'docs, tests and scripts': request(
        'docs {',
        ...payloadLines('  ', 20),
        '}',
        '',
        'tests {',
        ...payloadLines('  ', 20),
        '}',
        '',
        'script:pre-request {',
        ...payloadLines('  ', 20),
        '}',
        ''
      ),

      'multiline dictionary value': request(
        'body:multipart-form {',
        "  blob: '''",
        ...payloadLines('    '),
        "  '''",
        '}',
        ''
      ),

      'multiline dictionary value with a @contentType annotation': request(
        'body:multipart-form {',
        "  blob: '''",
        ...payloadLines('    '),
        "  ''' @contentType(application/json)",
        '}',
        ''
      ),

      'multiline example description': request(
        'example {',
        '  name: described',
        "  description: '''",
        ...payloadLines('    '),
        "  '''",
        '',
        '  request: {',
        '    url: https://example.com',
        '    method: GET',
        '  }',
        '}',
        ''
      ),

      // Two examples in one file: each payload has to come back to its own example.
      'two saved examples': request(
        'example {',
        '  name: first',
        '  ',
        '  response: {',
        '    body: {',
        '      type: json',
        "      content: '''",
        ...payloadLines('        ').map((l) => l.replace('field', 'first')),
        "      '''",
        '    }',
        '  }',
        '}',
        '',
        'example {',
        '  name: second',
        '  ',
        '  response: {',
        '    body: {',
        '      type: json',
        "      content: '''",
        ...payloadLines('        ').map((l) => l.replace('field', 'second')),
        "      '''",
        '    }',
        '  }',
        '}',
        ''
      ),

      // One long line, never pretty printed - the shape a raw JSON response arrives in.
      'single line payload': exampleWithResponseBody([`        ${JSON.stringify({ blob: 'x'.repeat(4000) })}`]),

      // Trailing whitespace on a single line payload is what a trailing trim would eat.
      'single line payload with trailing whitespace': exampleWithResponseBody([
        `        ${JSON.stringify({ blob: 'x'.repeat(4000) })}      `
      ]),

      'mixed indentation including tabs': request(
        'body:json {',
        ...payloadLines('\t\t', 20),
        ...payloadLines('  ', 20),
        ...payloadLines('      ', 20),
        '}',
        ''
      ),

      // Blank lines take the other branch of parseExampleContent, and whitespace-only lines a
      // third one, so they are carried through verbatim rather than probed.
      'blank and whitespace-only lines inside the payload': request(
        'body:json {',
        '  {',
        '',
        ...payloadLines('    ', 20),
        '   ',
        '',
        ...payloadLines('    ', 20),
        '  }',
        '',
        '}',
        ''
      ),

      // The serializer writes a trailing whitespace-only line whenever the body ends with a
      // newline. This is the single most common real-world payload shape.
      'payload ending in a whitespace-only line': request(
        'body:json {',
        '  {',
        ...payloadLines('    '),
        '  }',
        '  ',
        '}',
        ''
      ),

      'CRLF line endings throughout': exampleWithResponseBody(payloadLines('        ')).replace(/\n/g, '\r\n'),

      // A payload is raw text to the grammar, so a line inside it that looks like structure
      // must not be treated as structure.
      'payload containing what looks like a block opener': request(
        'body:json {',
        '  {',
        '  docs {',
        ...payloadLines('    ', 30),
        '  }',
        '  }',
        '}',
        ''
      ),

      "payload containing a ''' delimiter": request(
        'body:json {',
        '  {',
        "  quoted: '''",
        ...payloadLines('    ', 30),
        '  }',
        '}',
        ''
      ),

      'unknown block from a newer Bruno alongside a redactable one': request(
        'app {',
        '  docs {',
        '    something: value',
        '  }',
        '}',
        '',
        'docs {',
        ...payloadLines('  '),
        '}',
        ''
      )
    };

    for (const [name, content] of Object.entries(cases)) {
      it(name, () => {
        expectSameAsWholeFileParse(content);
      });
    }
  });

  it('keeps an unknown block byte-for-byte, placeholders and all', () => {
    const content = request(
      'app {',
      '  docs {',
      '    something: value',
      '  }',
      '}',
      '',
      'docs {',
      ...payloadLines('  '),
      '}',
      ''
    );

    const parsed = expectSameAsWholeFileParse(content);
    expect(parsed.unknownBlocks).toHaveLength(1);
    expect(parsed.unknownBlocks[0].raw).toBe('app {\n  docs {\n    something: value\n  }\n}');
  });

  it('brings the payload back with its exact bytes, not a re-indented copy', () => {
    // The lines are long on purpose. Short ones cost less than the probe line that would stand
    // in for them, the size-win guard declines the whole payload, and the test then measures
    // the stock parser instead of the restore - which is what this test used to do.
    const value = 'b'.repeat(400);
    const payload = [
      '        {',
      `          "a": "${value}",   `,
      '',
      `        \t"tabbed": "${value}"`,
      '        }'
    ];
    const content = exampleWithResponseBody(payload);

    const redaction = bruRequestParseAndRedactBodyData(content);
    expect(redaction.redacted).toBe(true);
    // The bytes this test is about really did go around the grammar.
    expect(redaction.bruFileStringWithRedactedBody).not.toContain(value);

    const parsed = parseBruRequest(content);
    // Trailing spaces, the blank line and the tab all survive: this is the original text put
    // back, not the payload re-indented from what the parser handed over.
    expect(parsed.examples[0].response.body.content).toBe(
      `{\n  "a": "${value}",   \n\n\t"tabbed": "${value}"\n}`
    );
  });

  /**
   * A payload is not just big, it can be shaped badly. This is the shape that turned one line
   * of the redactor into seconds of regex backtracking: a single line payload - so the inline
   * path runs - carrying a long run of spaces that is NOT at the end of the line. `\s+$`
   * matched that run starting from every position inside it and gave each match back one
   * character at a time; measured at 0.8 s for a 40,000 character run, and four times that for
   * every doubling. Pretty printed JSON and XML are full of whitespace runs and this is the
   * redactor every multi-MB saved example goes through.
   *
   * The budget is relative to an identical file whose run is not whitespace, so a slow machine
   * moves both numbers together, with an absolute floor so timer noise cannot fail it. The old
   * form is ~100x the control at this size, not 12x, and takes seconds - a regression fails
   * here rather than hanging.
   */
  it('does not backtrack over a long whitespace run inside a one-line payload', () => {
    const RUN = 100000;
    const whitespaceRun = exampleWithResponseBody([`        {"blob":"${' '.repeat(RUN)}"}`]);
    const control = exampleWithResponseBody([`        {"blob":"${'x'.repeat(RUN)}"}`]);
    expect(whitespaceRun.length).toBe(control.length);

    // Both take the inline path and both are really redacted. If either stopped being redacted
    // this test would be timing the stock parser and would pass for free.
    expect(bruRequestParseAndRedactBodyData(control).redacted).toBe(true);
    expect(bruRequestParseAndRedactBodyData(whitespaceRun).redacted).toBe(true);

    const timed = (content) => {
      const started = process.hrtime.bigint();
      const parsed = parseBruRequest(content);
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, parsed };
    };

    // Warm up, so the first measurement is not the one paying for the JIT.
    parseBruRequest(exampleWithResponseBody([`        {"blob":"${' '.repeat(1000)}"}`]));

    const controlMs = timed(control).ms;
    const measured = timed(whitespaceRun);

    expect(measured.parsed.examples[0].response.body.content).toBe(`{"blob":"${' '.repeat(RUN)}"}`);
    expect(measured.ms).toBeLessThan(Math.max(500, controlMs * 12));
  });

  describe('fails closed', () => {
    const bails = {
      // A lone CR is a line break to `outdentString` but not to the line split here, so one
      // input line would come back as two.
      'a lone CR inside a payload': exampleWithResponseBody([
        '        first\rsecond',
        ...payloadLines('        ')
      ]),
      'an unbalanced triple quote': request('headers {', "  a: ''''", '}', ''),
      'a top level line that opens no block': request('this-is-not-a-block', 'body:json {', ...payloadLines('  '), '}', ''),
      'a block that never closes at column zero': request('body:json {', ...payloadLines('  '), '  }', '')
    };

    for (const [name, content] of Object.entries(bails)) {
      it(`leaves the file alone for ${name}`, () => {
        const redaction = bruRequestParseAndRedactBodyData(content);
        expect(redaction.redacted).toBe(false);
        expect(redaction.bruFileStringWithRedactedBody).toBe(content);

        // And the caller still gets the same answer it would have got without any of this.
        let expected;
        let expectedError;
        try {
          expected = reference(content);
        } catch (error) {
          expectedError = error.message;
        }
        if (expectedError) {
          expect(() => parseBruRequest(content)).toThrow();
        } else {
          expect(parseBruRequest(content)).toEqual(expected);
        }
      });
    }

    /**
     * The placeholder is random per call, so a collision is vanishingly unlikely - which is
     * exactly why nothing would notice if the check that fails closed on one were deleted.
     * Pinning `Math.random` makes the placeholder knowable, and then it can be planted.
     */
    it('leaves the file alone when its own placeholder already occurs in the data', () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        // Ask it what it picks with the randomness pinned, rather than hard coding the token.
        const first = bruRequestParseAndRedactBodyData(exampleWithResponseBody(payloadLines('        ')));
        expect(first.redacted).toBe(true);
        const placeholder = first.bruFileStringWithRedactedBody.match(/__bru_rdct_[a-z0-9]*__/);
        expect(placeholder).not.toBeNull();

        const collided = exampleWithResponseBody([
          ...payloadLines('        '),
          `        "carried over from somewhere": "${placeholder[0]}",`
        ]);
        // Sanity: the same base really is what it would use for this file too.
        expect(collided).toContain(placeholder[0]);

        const redaction = bruRequestParseAndRedactBodyData(collided);
        expect(redaction.redacted).toBe(false);
        expect(redaction.bruFileStringWithRedactedBody).toBe(collided);

        // And the file still parses to what it means.
        expectSameAsWholeFileParse(collided);
      } finally {
        random.mockRestore();
      }
    });

    /**
     * Redacting is not free: every payload that goes through it is one more thing that can go
     * wrong, and a probe line costs more than the short line it stands in for. Without the
     * size-win guard the redactor hands the grammar a BIGGER file than it was given.
     */
    it('declines a payload whose probe lines would cost more than the payload', () => {
      // Four short middle lines, each at its own indent, so each needs its own probe.
      const content = request(
        'body:json {',
        '  {',
        '   "a": 1,',
        '    "b": 2,',
        '     "c": 3,',
        '      "d": 4',
        '  }',
        '}',
        ''
      );

      const redaction = bruRequestParseAndRedactBodyData(content);
      expect(redaction.redacted).toBe(false);
      expect(redaction.bruFileStringWithRedactedBody).toBe(content);
      expect(redaction.bruFileStringWithRedactedBody.length).not.toBeGreaterThan(content.length);
      expectSameAsWholeFileParse(content);
    });

    /**
     * The same guard on the inline path, where undershooting it also corrupts: the kept head
     * and the kept tail would overlap, and the payload comes back with the overlap in it twice.
     */
    it('declines a one-line payload too short to pay for its own placeholder', () => {
      const payload = '{"ok":true,"id":42}';
      const content = exampleWithResponseBody([`        ${payload}`]);

      const redaction = bruRequestParseAndRedactBodyData(content);
      expect(redaction.redacted).toBe(false);
      expect(redaction.bruFileStringWithRedactedBody).toBe(content);

      const parsed = expectSameAsWholeFileParse(content);
      expect(parsed.examples[0].response.body.content).toBe(payload);
    });

    it('never hands the grammar more bytes than it was given', () => {
      // Sizes either side of both thresholds - line payloads and one-line payloads.
      const contents = [
        request('body:json {', '  {', '   "a": 1,', '    "b": 2', '  }', '}', ''),
        request('body:json {', ...payloadLines('  ', 3), '}', ''),
        request('body:json {', ...payloadLines('  ', 40), '}', ''),
        exampleWithResponseBody(['        {"ok":true}']),
        exampleWithResponseBody([`        ${JSON.stringify({ blob: 'x'.repeat(60) })}`]),
        exampleWithResponseBody([`        ${JSON.stringify({ blob: 'x'.repeat(4000) })}`])
      ];

      for (const content of contents) {
        const redaction = bruRequestParseAndRedactBodyData(content);
        expect(redaction.bruFileStringWithRedactedBody.length).not.toBeGreaterThan(content.length);
        if (!redaction.redacted) {
          expect(redaction.bruFileStringWithRedactedBody).toBe(content);
        }
      }
    });

    it('refuses to restore when a placeholder is missing from the parsed object', () => {
      const content = exampleWithResponseBody(payloadLines('        '));
      const redaction = bruRequestParseAndRedactBodyData(content);
      expect(redaction.redacted).toBe(true);

      const parsed = bruToJsonV2(redaction.bruFileStringWithRedactedBody);
      // Sanity: the untouched object restores.
      expect(redaction.restoreRedactedBodyData(bruToJsonV2(redaction.bruFileStringWithRedactedBody))).toBe(true);

      parsed.examples[0].response.body.content = 'someone rewrote this';
      expect(redaction.restoreRedactedBodyData(parsed)).toBe(false);
    });

    it('refuses to restore when a placeholder is left somewhere it was not expected', () => {
      const content = exampleWithResponseBody(payloadLines('        '));
      const redaction = bruRequestParseAndRedactBodyData(content);
      expect(redaction.redacted).toBe(true);

      const parsed = bruToJsonV2(redaction.bruFileStringWithRedactedBody);
      const placeholder = parsed.examples[0].response.body.content.match(/__bru_rdct_[A-Za-z0-9]+__r\d+_c0__/);
      expect(placeholder).not.toBeNull();
      parsed.docs = `leaked ${placeholder[0]}`;

      expect(redaction.restoreRedactedBodyData(parsed)).toBe(false);
    });
  });

  it('leaves placeholders in the parse until restore is called', () => {
    // The redacted string is not a substitute for the file on its own. Any caller that parses
    // it and skips `restoreRedactedBodyData` is holding an object with placeholders in it -
    // which is what would end up written back to the user's .bru.
    const content = exampleWithResponseBody(payloadLines('        '));
    const redaction = bruRequestParseAndRedactBodyData(content);
    expect(redaction.redacted).toBe(true);

    const unrestored = bruToJsonV2(redaction.bruFileStringWithRedactedBody);
    expect(unrestored.examples[0].response.body.content).toMatch(/__bru_rdct_/);

    expect(redaction.restoreRedactedBodyData(unrestored)).toBe(true);
    expect(unrestored.examples[0].response.body.content).not.toMatch(/__bru_rdct_/);
  });

  it('does not touch a request that has nothing worth redacting', () => {
    const content = request('headers {', '  accept: application/json', '}', '');
    const redaction = bruRequestParseAndRedactBodyData(content);

    expect(redaction.redacted).toBe(false);
    expect(redaction.bruFileStringWithRedactedBody).toBe(content);
    expectSameAsWholeFileParse(content);
  });
});
