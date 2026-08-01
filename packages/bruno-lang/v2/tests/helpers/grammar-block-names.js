/**
 * Derives, from a parser's ohm grammar source, the two lists that have to agree:
 *
 *  - `blockNames`: every top level block literal reachable from `BruFile`, i.e. the blocks
 *    the parser actually understands.
 *  - `knownBlockNames`: the literals hand listed in the `knownblockname` rule, which is what
 *    `unknownblock` uses to keep out of the way of blocks we do understand.
 *
 * Nothing in ohm keeps those in sync. If a block is added to `BruFile` but not to
 * `knownblockname`, `unknownblock` silently swallows it: the block stops being interpreted
 * and comes back only as verbatim text. The spec that uses this helper fails on that.
 *
 * The grammar is read as source text on purpose - the parsers do not export their grammar,
 * and the text is the thing that has to be kept in sync.
 */
const fs = require('fs');

const GRAMMAR_START = 'ohm.grammar(`';

const readGrammarSource = (filePath) => {
  const source = fs.readFileSync(filePath, 'utf8');
  const start = source.indexOf(GRAMMAR_START);
  if (start === -1) {
    throw new Error(`no ohm grammar found in ${filePath}`);
  }
  const bodyStart = start + GRAMMAR_START.length;
  const end = source.indexOf('`)', bodyStart);
  if (end === -1) {
    throw new Error(`unterminated ohm grammar in ${filePath}`);
  }
  return source.slice(bodyStart, end);
};

// rule name => rule body, comments and line breaks removed
const parseRules = (grammarSource) => {
  const rules = {};
  let current = null;

  grammarSource.split('\n').forEach((line) => {
    if (line.trim().startsWith('//')) {
      return;
    }
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)(<[^>]*>)?\s*=\s*(.*)$/);
    if (match) {
      current = match[1];
      rules[current] = match[3].trim();
      return;
    }
    if (current && line.trim().length) {
      rules[current] = `${rules[current]} ${line.trim()}`.trim();
    }
  });

  return rules;
};

const identifiersIn = (body) => body.match(/[A-Za-z][A-Za-z0-9_]*/g) || [];

const isPureAlternation = (body) => /^[A-Za-z][A-Za-z0-9_]*(\s*\|\s*[A-Za-z][A-Za-z0-9_]*)*$/.test(body);

/**
 * Walks BruFile's alternatives and collects the literal each one starts with. A rule that is
 * itself an alternation of other rules is followed; `unknownblock` (the catch all, which
 * starts with a negative lookahead rather than a literal) is skipped.
 */
const collectBlockNames = (rules) => {
  const names = new Set();
  const unresolved = [];
  const seen = new Set();

  const visit = (ruleName) => {
    if (seen.has(ruleName)) {
      return;
    }
    seen.add(ruleName);

    const body = rules[ruleName];
    if (body === undefined) {
      unresolved.push(ruleName);
      return;
    }
    if (ruleName === 'unknownblock') {
      return;
    }

    const literal = body.match(/^"((?:[^"\\]|\\.)*)"/);
    if (literal) {
      names.add(literal[1]);
      return;
    }
    if (isPureAlternation(body)) {
      identifiersIn(body).forEach(visit);
      return;
    }
    // Anything else means this helper no longer understands the grammar's shape. Report it
    // instead of quietly under reporting the block list.
    unresolved.push(ruleName);
  };

  const bruFile = rules.BruFile;
  if (!bruFile) {
    throw new Error('grammar has no BruFile rule');
  }
  identifiersIn(bruFile).forEach(visit);

  return { names, unresolved };
};

const collectKnownBlockNames = (rules) => {
  const body = rules.knownblockname;
  if (!body) {
    throw new Error('grammar has no knownblockname rule');
  }
  return new Set([...body.matchAll(/kb<"([^"]+)">/g)].map((m) => m[1]));
};

const grammarBlockNames = (filePath) => {
  const rules = parseRules(readGrammarSource(filePath));
  const { names, unresolved } = collectBlockNames(rules);

  return {
    blockNames: [...names].sort(),
    knownBlockNames: [...collectKnownBlockNames(rules)].sort(),
    unresolved: unresolved.sort()
  };
};

module.exports = { grammarBlockNames };
