const fs = require('node:fs');
const path = require('node:path');
const { bruToJsonV2 } = require('@usebruno/lang');
const { parseBruRequest } = require('../index');
const { bruRequestParseAndRedactBodyData } = require('../utils/request-parse-and-redact-body-data');

/**
 * The redactor used to hand back the body blocks as strings (`extractedBodyContent`) and a
 * file string with those blocks cut out, and the caller stitched the two together by hand.
 * It only recognised TOP LEVEL blocks, so a saved example payload - which is where the bytes
 * actually are - went straight to the grammar.
 *
 * It now replaces every leaf payload, at any depth, with probe lines and hands back the hook
 * that puts them back. `extractedBodyContent` stays on the result for the old call signature
 * and is always empty.
 */
describe('parse and redact body data', () => {
  const fixturesPath = `/fixtures/request-parse-and-redact-body-data`;
  const inputBruString = fs.readFileSync(path.join(__dirname, fixturesPath, './input.bru'), 'utf8');

  it('leaves a fixture this small completely alone', () => {
    const res = bruRequestParseAndRedactBodyData(inputBruString);

    // Every body in this fixture is a handful of short lines. A payload is only replaced when
    // the replacement is smaller than what it replaces, and a probe line costs more than the
    // three-line JSON body it would stand in for - so nothing here is worth touching. The
    // file still has to come out of the parser identical, which the next test checks.
    expect(res.redacted).toBe(false);
    expect(res.bruFileStringWithRedactedBody).toBe(inputBruString);
    expect(res.extractedBodyContent).toEqual({});
  });

  it('does replace the same blocks once they are big enough to be worth it', () => {
    // The same file with a body long enough to pay for its own probe lines.
    const big = inputBruString.replace(
      '  {\n    "hello": "world"\n  }',
      ['  {', ...Array.from({ length: 60 }, (_, i) => `    "field${i}": "${'v'.repeat(30)}",`), '  }'].join('\n')
    );

    const res = bruRequestParseAndRedactBodyData(big);

    expect(res.redacted).toBe(true);
    expect(res.bruFileStringWithRedactedBody.length).toBeLessThan(big.length / 2);
    expect(big).toContain('"field59"');
    expect(res.bruFileStringWithRedactedBody).not.toContain('"field59"');
    expect(parseBruRequest(big)).toEqual(parseBruRequest(bruToJsonV2(big), true));
  });

  it('parses this fixture identically without ever redacting it', () => {
    // Nothing here is replaced (see above), so this is the pass-through path: what the parser
    // does with a file the redactor declined. It says nothing about the restore - the test
    // below is the one that exercises that.
    const expected = parseBruRequest(bruToJsonV2(inputBruString), true);
    const actual = parseBruRequest(inputBruString);

    expect(actual).toEqual(expected);
    expect(actual.request.body.json).toBe('{\n  "hello": "world"\n}');
    expect(actual.request.body.text).toBe('This is a text body');
    expect(actual.request.body.xml).toBe('<xml>\n  <name>John</name>\n  <age>30</age>\n</xml>');
    expect(actual.request.body.sparql).toBe('SELECT * WHERE {\n  ?subject ?predicate ?object .\n}\nLIMIT 10');
    expect(actual.request.body.graphql.query).toBe(
      '{\n  launchesPast {\n    launch_site {\n      site_name\n    }\n    launch_success\n  }\n}'
    );
  });

  it('puts every body back exactly, once the bodies are big enough to be redacted', () => {
    // The same blocks as the fixture, with each body long enough that the redaction actually
    // fires. On the fixture's own three-line bodies it does not, so asserting the bodies there
    // measures the stock parser and passes with the whole redaction removed.
    const pad = Array.from({ length: 20 }, (_, i) => `"pad${i}": "${'v'.repeat(40)}",`);
    const at = (indent) => pad.map((row) => `${indent}${row}`);
    const content =
      [
        'meta {',
        '  name: echo request',
        '  type: http',
        '  seq: 1',
        '}',
        '',
        'post {',
        '  url: https://echo.usebruno.com',
        '  body: json',
        '  auth: none',
        '}',
        '',
        'body:json {',
        '  {',
        '    "hello": "world",',
        ...at('    '),
        '  }',
        '}',
        '',
        'body:text {',
        '  This is a text body',
        ...at('  '),
        '}',
        '',
        'body:xml {',
        '  <xml>',
        '    <name>John</name>',
        ...at('    '),
        '  </xml>',
        '}',
        ''
      ].join('\n') + '\n';

    const redaction = bruRequestParseAndRedactBodyData(content);
    expect(redaction.redacted).toBe(true);
    // All three bodies really went around the grammar, not just the first one. A line from the
    // middle of the payload: the first and last line of one are kept verbatim by design.
    expect(content.split('"pad10"')).toHaveLength(4);
    expect(redaction.bruFileStringWithRedactedBody).not.toContain('"pad10"');

    const actual = parseBruRequest(content);
    expect(actual).toEqual(parseBruRequest(bruToJsonV2(content), true));
    expect(actual.request.body.json).toBe(`{\n  "hello": "world",\n${at('  ').join('\n')}\n}`);
    expect(actual.request.body.text).toBe(`This is a text body\n${pad.join('\n')}`);
    expect(actual.request.body.xml).toBe(`<xml>\n  <name>John</name>\n${at('  ').join('\n')}\n</xml>`);
  });

  it('leaves the dictionary bodies alone - they are pairs, not text', () => {
    const res = bruRequestParseAndRedactBodyData(inputBruString);

    expect(res.bruFileStringWithRedactedBody).toContain('apikey: secret');
    expect(res.bruFileStringWithRedactedBody).toContain('~file: @file(path/to/file2.json) @contentType(application/json)');
  });
});
