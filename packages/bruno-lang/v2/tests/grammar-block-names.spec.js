/**
 * `unknownblock` must never shadow a block the parser understands, so its `knownblockname`
 * rule repeats every block literal in the grammar by hand. Nothing in ohm keeps the two
 * lists in sync: add a block to BruFile and forget knownblockname and that block silently
 * becomes an unknown block - no longer interpreted, only carried around as verbatim text.
 *
 * These tests derive both lists from the grammar source and fail the moment they diverge.
 */
const path = require('path');
const { grammarBlockNames } = require('./helpers/grammar-block-names');
const parser = require('../src/bruToJson');
const collectionParser = require('../src/collectionBruToJson');

const GRAMMARS = [
  ['bruToJson.js', path.join(__dirname, '../src/bruToJson.js'), parser],
  ['collectionBruToJson.js', path.join(__dirname, '../src/collectionBruToJson.js'), collectionParser]
];

describe.each(GRAMMARS)('%s - knownblockname stays in sync with the grammar', (_name, filePath, parse) => {
  const { blockNames, knownBlockNames, unresolved } = grammarBlockNames(filePath);

  it('resolves every alternative of BruFile down to a block name', () => {
    // Guards the derivation itself: if the grammar grows a shape this cannot read, the
    // lists below would silently compare two incomplete sets.
    expect(unresolved).toEqual([]);
    expect(blockNames.length).toBeGreaterThan(0);
  });

  it('lists every block the grammar knows in knownblockname', () => {
    expect(knownBlockNames).toEqual(blockNames);
  });

  it('does not treat any known block as unknown', () => {
    // The behavioural side of the same check - a name in knownblockname that the grammar
    // cannot actually parse would show up here.
    // `example` is skipped: its body goes through the example parser, which logs on a probe
    // body. forward-compat.spec.js covers it with a real example block instead.
    blockNames
      .filter((name) => name !== 'example')
      .forEach((name) => {
        const source = `${name} {\n  a: 1\n}\n`;
        expect(parse(source)).not.toHaveProperty('unknownBlocks');
      });
  });
});
