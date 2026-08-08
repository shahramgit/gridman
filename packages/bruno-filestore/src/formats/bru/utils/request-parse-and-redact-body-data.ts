/**
 * Keeps .bru parse cost independent of saved-example size.
 *
 * WHY
 * ---
 * The ohm grammar in @usebruno/lang consumes an example body one character at a time
 * (`examplecontent = (~tagend any)*`), allocating a PosInfo per input position and a CST
 * node per character, and then re-splits / re-indents / re-joins it and runs a SECOND ohm
 * grammar over the result. Measured on the real workspace that is 1.8 s / 1.3 GB at
 * 584 KB, 9.2 s / 3.3 GB at 2.33 MB, and a fatal heap OOM at 2.59 MB. The payloads
 * responsible are pure text to the grammar - it never looks inside them - so the fix is to
 * not feed them to ohm at all.
 *
 * WHAT THIS DOES
 * --------------
 * Before the parse, every LEAF text payload (at any indent depth) is replaced with a
 * handful of probe lines. After the parse, the probes are located in the parsed object and
 * the original text is put back. The leaves are:
 *
 *   - top level text blocks:            body:json { ... }, docs { ... }, tests { ... }, ...
 *   - example request bodies:               body:json: { ... }   (indent 4)
 *   - example response bodies:              content: ''' ... '''  (indent 6)
 *   - multiline dictionary values:          key: ''' ... '''      (any indent)
 *
 * The previous implementation only lifted TOP LEVEL blocks (`block.startsWith('body:json {')`
 * after splitting on '\n}\n'), so an example payload - which lives at example > response >
 * body, indented - never matched. Measured over the three biggest files in the real
 * workspace it returned them at exactly the same size: 2,590,667 -> 2,590,667, i.e. it
 * removed 0%.
 *
 * HOW THE ORIGINAL BYTES COME BACK EXACTLY
 * ----------------------------------------
 * The parser turns a leaf's raw text into its string value by stripping a fixed prefix from
 * each line (`parseExampleContent`'s minIndent `substring`, then `outdentString(_, 2)`, then
 * `outdentString(_, 4)`, or `String#slice(4)` for dictionary values) and by trimming the two
 * ends of the whole value. Nothing else. That means:
 *
 *   T(line) = T_ws(leading whitespace of line) + rest of line
 *
 * for every line that is not first or last in the value. So instead of REIMPLEMENTING that
 * strip chain - which is where an earlier prototype silently corrupted output - this
 * MEASURES it: the redacted payload carries one probe line per distinct leading-whitespace
 * prefix, and after the parse the transformed prefix is read straight back out of the parsed
 * value. Whatever the parser did to a prefix, the probe with that prefix records it.
 *
 * The payload's real first and last lines are kept verbatim, so the end-trims land on the
 * same bytes they would have landed on in an unredacted parse. Blank lines are kept verbatim
 * too (a blank line takes a different branch in `parseExampleContent`, so it cannot be
 * probed), and because every distinct prefix keeps a representative, the file's minimum
 * indentation - which the parser uses to outdent an entire example block - is preserved by
 * construction rather than by hope.
 *
 * FAIL CLOSED
 * -----------
 * Anything unexpected returns the file unredacted rather than guessing:
 *   - the placeholder token already occurs in the user's data
 *   - a block's closing brace is not where the grammar would find it
 *   - a lone CR (a CR not part of a CRLF) inside a payload, which the parser would turn into
 *     a line break and so would break the one-line-in-one-line-out assumption
 *   - after the parse a probe is missing, duplicated, or sits at the wrong line
 * The caller then parses the original text, exactly as before this change.
 */

/** Top level block names the grammar parses as a raw text block (`textblock tagend`). */
const TEXT_BLOCK_NAMES = new Set([
  'body',
  'body:json',
  'body:text',
  'body:xml',
  'body:sparql',
  'body:graphql',
  'body:graphql:vars',
  'script:pre-request',
  'script:post-response',
  'tests',
  'docs'
]);

/**
 * Every block name the grammar knows (bruToJson.js "knownblockname"). A name outside this
 * set is an `unknownblock`, whose body is captured VERBATIM and written back verbatim on
 * save - redacting inside one would put a placeholder on disk, so we never look inside.
 */
const KNOWN_BLOCK_NAMES = new Set([
  'meta', 'settings',
  'grpc', 'ws',
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace', 'http',
  'headers', 'metadata',
  'query', 'params:path', 'params:query',
  'vars:pre-request', 'vars:post-response', 'assert',
  'auth:awsv4', 'auth:basic', 'auth:bearer', 'auth:digest',
  'auth:ntlm', 'auth:oauth1', 'auth:oauth2', 'auth:wsse',
  'auth:apikey',
  'auth:oauth2:additional_params:auth_req:headers',
  'auth:oauth2:additional_params:auth_req:queryparams',
  'auth:oauth2:additional_params:access_token_req:headers',
  'auth:oauth2:additional_params:access_token_req:queryparams',
  'auth:oauth2:additional_params:access_token_req:body',
  'auth:oauth2:additional_params:refresh_token_req:headers',
  'auth:oauth2:additional_params:refresh_token_req:queryparams',
  'auth:oauth2:additional_params:refresh_token_req:body',
  'body', 'body:json', 'body:text', 'body:xml', 'body:sparql',
  'body:graphql', 'body:graphql:vars', 'body:grpc', 'body:ws',
  'body:form-urlencoded', 'body:multipart-form', 'body:file',
  'example',
  'script:pre-request', 'script:post-response', 'tests', 'docs'
]);

/** Body kinds that appear INSIDE an example's `request: { ... }`, as `body:json: { ... }`. */
const EXAMPLE_BODY_BLOCK = /^([ \t]*)(body:(?:json|text|xml|sparql|graphql|graphql:vars))[ \t]*:[ \t]*\{[ \t]*$/;

const BLOCK_OPEN = /^[ \t]*([A-Za-z][A-Za-z0-9:._-]*)[ \t]*\{[ \t]*$/;
const LIST_OPEN = /^[ \t]*([A-Za-z][A-Za-z0-9:._-]*)[ \t]*\[[ \t]*$/;
/** `key: '''` - opens a multiline value. The key part may not contain a quote. */
const TRIPLE_OPEN = /^([ \t]*)[^'\r\n]*:[ \t]*'''[ \t]*$/;
/** `''' @contentType(x)` - closes one. */
const TRIPLE_CLOSE = /^[ \t]*'''[ \t]*(@contentType\([^)\r\n]*\))?[ \t]*$/;

const LEADING_WS = /^[ \t]*/;
/** Tested against one character at a time, so it has nothing to backtrack over. */
const WHITESPACE_CHAR = /\s/;

const BAIL = Symbol('bail');

type LineClass = {
  /** leading whitespace shared by every line in this class */
  prefix: string;
  /** true when the lines of this class end with a CR (i.e. the file uses CRLF) */
  cr: boolean;
  token: string;
};

/**
 * A payload that is a single (very long) line - a saved example whose response body was
 * never pretty printed. There is no second line to probe with, so the redaction happens
 * INSIDE the line: enough of the head and tail survive that every strip and trim the parser
 * applies lands on real bytes, and only the middle is swapped for the token.
 */
type InlineRegion = {
  kind: 'inline';
  token: string;
  line: number;
  /** offset into the line where the redacted middle starts */
  from: number;
  /** offset into the line where the redacted middle ends */
  to: number;
};

type LineRegion = {
  kind: 'lines';
  /** index into `lines` of the first line of the reconstructed middle */
  middleFrom: number;
  /** how many lines the reconstructed middle has */
  middleCount: number;
  /** how many leading lines of the payload went through verbatim */
  headLen: number;
  /** how many trailing lines of the payload went through verbatim */
  tailLen: number;
  classes: LineClass[];
  /** how many blank lines sit inside the middle */
  blankCount: number;
  /**
   * One entry per middle line:
   *   >= 0 -> index into `classes`
   *   -1   -> blank line, take the next measured blank
   */
  classOf: Int32Array;
  /** length of the leading whitespace of each middle line (unused for blanks) */
  prefixLen: Int32Array;
};

type Region = InlineRegion | LineRegion;

/**
 * How much of a one-line payload stays verbatim at each end.
 *
 * At the head: the parser's strips (`substring(minIndent)`, `^ {2}`, `^ {4}`, `slice(4)`) and
 * any leading trim only ever reach into the line's leading whitespace, which is already kept
 * - this margin is there so that a strip WIDER than that whitespace still lands on kept
 * bytes instead of eating the token. A strip wider than the margin chops the token, which
 * `rebuild` sees and refuses.
 * At the tail: a trailing trim eats whitespace, so the margin is added on top of the line's
 * whole trailing whitespace run.
 */
const INLINE_MARGIN = 16;

const leadingWhitespace = (line: string): string => (line.match(LEADING_WS) as RegExpMatchArray)[0];

/**
 * How many whitespace characters the string ends with.
 *
 * Deliberately NOT `text.length - text.replace(/\s+$/, '').length`. That pattern is unanchored,
 * so the engine retries it at every position, and on a whitespace run that is NOT at the end it
 * matches the whole run and then gives back one character at a time looking for the end of the
 * string - O(n^2) in the length of the run. A single line payload with a long run of spaces in
 * the middle of it (an unformatted response body is exactly that) turns this one call into
 * seconds of backtracking; measured 0.8 s at a 40,000 space run and four times that for every
 * doubling. Walking back from the end touches the trailing run and nothing else, and matches
 * `\s+$` exactly because `\s` and the trim it stands in for cover the same characters.
 */
const trailingWhitespaceLength = (text: string): number => {
  let end = text.length;
  while (end > 0 && WHITESPACE_CHAR.test(text.charAt(end - 1))) {
    end--;
  }
  return text.length - end;
};

/** A line as the grammar sees it: the CR of a CRLF belongs to the line terminator. */
const withoutCr = (line: string): string => (line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line);

const countTripleQuotes = (line: string): number => {
  let count = 0;
  let at = line.indexOf('\'\'\'');
  while (at !== -1) {
    count++;
    at = line.indexOf('\'\'\'', at + 3);
  }
  return count;
};

const makeSentinelBase = (): string =>
  `__bru_rdct_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}__`;

const buildInlineRegion = (
  lines: string[],
  at: number,
  regionIndex: number,
  sentinelBase: string
): { region: Region; replacement: string[] } | null => {
  const raw = lines[at];
  const cr = raw.indexOf('\r');
  if (cr !== -1 && cr !== raw.length - 1) {
    return null;
  }
  const body = withoutCr(raw);
  const prefix = leadingWhitespace(body);
  const rest = body.slice(prefix.length);
  if (!rest.length) {
    return null;
  }

  const trailingWhitespace = trailingWhitespaceLength(rest);
  const keepHead = INLINE_MARGIN;
  const keepTail = trailingWhitespace + INLINE_MARGIN;
  const token = `${sentinelBase}r${regionIndex}_i__`;
  // Has to actually save something, and head and tail must not overlap.
  if (rest.length <= keepHead + keepTail + token.length) {
    return null;
  }

  const from = prefix.length + keepHead;
  const to = body.length - keepTail;
  const replacement = `${body.slice(0, from)}${token}${body.slice(to)}${raw.length === body.length ? '' : '\r'}`;

  return {
    region: { kind: 'inline', token, line: at, from, to },
    replacement: [replacement]
  };
};

/**
 * Builds the probe lines for one payload and records what is needed to rebuild it.
 * Returns null when the payload must be left alone (the caller keeps it verbatim and
 * carries on scanning - this is a per-payload skip, not a whole file bail).
 */
const buildRegion = (
  lines: string[],
  from: number,
  to: number,
  regionIndex: number,
  sentinelBase: string
): { region: Region; replacement: string[] } | null => {
  if (from === to) {
    return buildInlineRegion(lines, from, regionIndex, sentinelBase);
  }
  if (to - from < 2) {
    return null;
  }

  // The lines at the two ends of a payload go through verbatim, so that whatever the parser
  // trims off the two ends of the value lands on the same bytes it would have landed on
  // without redaction. Blank end lines are carried into that verbatim head/tail rather than
  // probed: a blank line takes the other branch of `parseExampleContent` (it is NOT
  // outdented), and a `.trim()` on the value can swallow one whole.
  let head = from;
  while (head <= to && withoutCr(lines[head]).trim() === '') {
    head++;
  }
  if (head > to) {
    return null;
  }
  let tail = to;
  while (tail > head && withoutCr(lines[tail]).trim() === '') {
    tail--;
  }
  if (tail - head < 2) {
    return null;
  }

  const middleFrom = head + 1;
  const middleCount = tail - head - 1;
  const headLen = head - from + 1;
  const tailLen = to - tail + 1;

  const classes: LineClass[] = [];
  const classByKey = new Map<string, number>();
  const classOf = new Int32Array(middleCount);
  const prefixLen = new Int32Array(middleCount);
  const blankLines: string[] = [];

  let originalBytes = 0;
  for (let i = from; i <= to; i++) {
    const raw = lines[i];
    originalBytes += raw.length + 1;
    // A CR anywhere but at the very end is a lone CR. `outdentString` splits on /\r\n|\r|\n/,
    // so the parser would turn it into a line break and one input line would come back as
    // two - the reconstruction below assumes one for one.
    const cr = raw.indexOf('\r');
    if (cr !== -1 && cr !== raw.length - 1) {
      return null;
    }
  }

  for (let k = 0; k < middleCount; k++) {
    const raw = lines[middleFrom + k];
    const body = withoutCr(raw);
    if (body.trim() === '') {
      classOf[k] = -1;
      blankLines.push(raw);
      continue;
    }
    const prefix = leadingWhitespace(body);
    const hasCr = raw.length !== body.length;
    const key = `${hasCr ? '\r' : ''}${prefix}`;
    let idx = classByKey.get(key);
    if (idx === undefined) {
      idx = classes.length;
      classByKey.set(key, idx);
      classes.push({ prefix, cr: hasCr, token: `${sentinelBase}r${regionIndex}_c${idx}__` });
    }
    classOf[k] = idx;
    prefixLen[k] = prefix.length;
  }

  // With no probe there is nothing to find the value by after the parse.
  if (!classes.length) {
    return null;
  }

  const replacement: string[] = [];
  for (let i = from; i <= head; i++) {
    replacement.push(lines[i]);
  }
  for (const cls of classes) {
    replacement.push(`${cls.prefix}${cls.token}${cls.cr ? '\r' : ''}`);
  }
  for (const blank of blankLines) {
    replacement.push(blank);
  }
  for (let i = tail; i <= to; i++) {
    replacement.push(lines[i]);
  }

  let redactedBytes = 0;
  for (const line of replacement) {
    redactedBytes += line.length + 1;
  }
  // Nothing to gain - and every redacted payload is one more thing that can go wrong.
  if (redactedBytes >= originalBytes) {
    return null;
  }

  return {
    region: {
      kind: 'lines',
      middleFrom,
      middleCount,
      headLen,
      tailLen,
      classes,
      blankCount: blankLines.length,
      classOf,
      prefixLen
    },
    replacement
  };
};

type ScanState = {
  lines: string[];
  out: string[];
  regions: Region[];
  sentinelBase: string;
};

/** Copies lines [from, to] through untouched. */
const copyThrough = (state: ScanState, from: number, to: number): void => {
  for (let i = from; i <= to; i++) {
    state.out.push(state.lines[i]);
  }
};

const addRegion = (state: ScanState, from: number, to: number): void => {
  const built = buildRegion(state.lines, from, to, state.regions.length, state.sentinelBase);
  if (!built) {
    copyThrough(state, from, to);
    return;
  }
  state.regions.push(built.region);
  for (const line of built.replacement) {
    state.out.push(line);
  }
};

/**
 * Scans the inside of a block for leaf payloads.
 *
 * `allowBodyBlocks` is only true inside an `example { ... }`, where `body:json: { ... }` is a
 * real nested text block. Inside a dictionary a line that looks like one can only be a
 * VALUE, and treating it as a block would move text out of the dictionary.
 */
const scanInner = (state: ScanState, from: number, to: number, allowBodyBlocks: boolean): void | typeof BAIL => {
  let i = from;
  while (i <= to) {
    const body = withoutCr(state.lines[i]);

    const quotes = countTripleQuotes(body);
    if (quotes === 1) {
      // Opens a multiline value. Anything other than the shape the serializers write is a
      // shape we have not reasoned about, so stop redacting the file.
      if (!TRIPLE_OPEN.test(body)) {
        return BAIL;
      }
      const openIndent = leadingWhitespace(body).length;
      let j = i + 1;
      while (j <= to && !state.lines[j].includes('\'\'\'')) {
        j++;
      }
      if (j > to) {
        return BAIL;
      }
      const closeBody = withoutCr(state.lines[j]);
      if (!TRIPLE_CLOSE.test(closeBody)) {
        return BAIL;
      }
      // A payload line shallower than the key line and starting with `}` would close an
      // ENCLOSING block before the value ever ends - the parser would see a different
      // document than we do.
      for (let k = i + 1; k < j; k++) {
        const payload = withoutCr(state.lines[k]);
        const lead = leadingWhitespace(payload);
        if (lead.length < openIndent && payload.charAt(lead.length) === '}') {
          return BAIL;
        }
      }
      state.out.push(state.lines[i]);
      addRegion(state, i + 1, j - 1);
      state.out.push(state.lines[j]);
      i = j + 1;
      continue;
    }
    if (quotes > 1) {
      // A complete `key: '''value'''` on one line. Anything odd is unbalanced.
      if (quotes % 2 !== 0) {
        return BAIL;
      }
      state.out.push(state.lines[i]);
      i++;
      continue;
    }

    if (allowBodyBlocks) {
      const bodyBlock = body.match(EXAMPLE_BODY_BLOCK);
      if (bodyBlock) {
        const indent = bodyBlock[1];
        // `tagend` for this block is a `}` at the same column the block opened at, once the
        // enclosing outdents have been applied. Anything at or left of that column that
        // starts with `}` is where the parser stops.
        let j = i + 1;
        let closer = -1;
        while (j <= to) {
          const candidate = withoutCr(state.lines[j]);
          const lead = leadingWhitespace(candidate);
          if (lead.length <= indent.length && candidate.charAt(lead.length) === '}') {
            closer = j;
            break;
          }
          j++;
        }
        if (closer === -1 || withoutCr(state.lines[closer]) !== `${indent}}`) {
          return BAIL;
        }
        state.out.push(state.lines[i]);
        addRegion(state, i + 1, closer - 1);
        state.out.push(state.lines[closer]);
        i = closer + 1;
        continue;
      }
    }

    state.out.push(state.lines[i]);
    i++;
  }
  return undefined;
};

/**
 * Finds the `}` that ends a top level block. The grammar's `tagend` is `nl "}"`, i.e. the
 * first `}` at column 0 - for text blocks, for `example`, for dictionaries and for unknown
 * blocks alike.
 */
const findTopLevelEnd = (lines: string[], from: number): number => {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].charCodeAt(0) === 125 /* } */) {
      return withoutCr(lines[i]) === '}' ? i : -1;
    }
  }
  return -1;
};

const findListEnd = (lines: string[], from: number): number => {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].charCodeAt(0) === 93 /* ] */) {
      return withoutCr(lines[i]) === ']' ? i : -1;
    }
  }
  return -1;
};

const scanFile = (lines: string[], sentinelBase: string): ScanState | typeof BAIL => {
  const state: ScanState = { lines, out: [], regions: [], sentinelBase };

  let i = 0;
  while (i < lines.length) {
    const body = withoutCr(lines[i]);
    if (body.trim() === '') {
      state.out.push(lines[i]);
      i++;
      continue;
    }

    const open = body.match(BLOCK_OPEN);
    if (open) {
      const name = open[1];
      const end = findTopLevelEnd(lines, i + 1);
      if (end === -1) {
        return BAIL;
      }
      state.out.push(lines[i]);
      if (!KNOWN_BLOCK_NAMES.has(name)) {
        // unknownblock - captured verbatim by the parser and written back verbatim on save.
        copyThrough(state, i + 1, end);
      } else if (TEXT_BLOCK_NAMES.has(name)) {
        addRegion(state, i + 1, end - 1);
        state.out.push(lines[end]);
      } else {
        const result = scanInner(state, i + 1, end - 1, name === 'example');
        if (result === BAIL) {
          return BAIL;
        }
        state.out.push(lines[end]);
      }
      i = end + 1;
      continue;
    }

    const list = body.match(LIST_OPEN);
    if (list) {
      const end = findListEnd(lines, i + 1);
      if (end === -1) {
        return BAIL;
      }
      copyThrough(state, i, end);
      i = end + 1;
      continue;
    }

    // A non blank top level line that opens nothing. The file is not shaped the way the
    // grammar expects, so do not pretend to understand the rest of it.
    return BAIL;
  }

  return state;
};

/** Walks every string in the parsed object. `visit` may return a replacement string. */
const walkStrings = (node: any, visit: (value: string) => string | undefined, seen: Set<any>): void => {
  if (Array.isArray(node)) {
    if (seen.has(node)) return;
    seen.add(node);
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      if (typeof child === 'string') {
        const replacement = visit(child);
        if (replacement !== undefined) node[i] = replacement;
      } else if (child && typeof child === 'object') {
        walkStrings(child, visit, seen);
      }
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (typeof child === 'string') {
      const replacement = visit(child);
      if (replacement !== undefined) node[key] = replacement;
    } else if (child && typeof child === 'object') {
      walkStrings(child, visit, seen);
    }
  }
};

/**
 * Rebuilds one payload from the probes the parser handed back.
 * Returns null when the value does not have the exact shape we put in.
 */
const rebuild = (region: Region, parsedValue: string, lines: string[]): string | null => {
  if (region.kind === 'inline') {
    const at = parsedValue.indexOf(region.token);
    if (at === -1 || parsedValue.indexOf(region.token, at + region.token.length) !== -1) {
      return null;
    }
    // Everything before the token already carries whatever the parser stripped off the front
    // and everything after it whatever it trimmed off the back, because both are real bytes
    // of the original line.
    return (
      parsedValue.slice(0, at)
      + withoutCr(lines[region.line]).slice(region.from, region.to)
      + parsedValue.slice(at + region.token.length)
    );
  }

  const parts = parsedValue.split('\n');
  const { headLen, tailLen, blankCount, middleCount } = region;
  const probeCount = region.classes.length;
  const expected = headLen + probeCount + blankCount + tailLen;
  if (parts.length < expected) {
    return null;
  }

  const transformedPrefix: string[] = new Array(probeCount);
  const transformedSuffix: string[] = new Array(probeCount);
  for (let j = 0; j < probeCount; j++) {
    const token = region.classes[j].token;
    const line = parts[headLen + j];
    const at = line.indexOf(token);
    // Not on the line we put it on (the value lost or gained lines), or chopped up by a
    // strip wider than the probe's own indent.
    if (at === -1 || line.indexOf(token, at + token.length) !== -1) {
      return null;
    }
    transformedPrefix[j] = line.slice(0, at);
    transformedSuffix[j] = line.slice(at + token.length);
  }

  const rebuilt: string[] = new Array(headLen + middleCount + tailLen + (parts.length - expected));
  let w = 0;
  // The head and tail lines went through unredacted, so whatever the parser did to the two
  // ends of the value it already did to the right bytes.
  for (let i = 0; i < headLen; i++) {
    rebuilt[w++] = parts[i];
  }

  let blankAt = headLen + probeCount;
  for (let k = 0; k < middleCount; k++) {
    const cls = region.classOf[k];
    if (cls === -1) {
      rebuilt[w++] = parts[blankAt++];
      continue;
    }
    const body = withoutCr(lines[region.middleFrom + k]);
    rebuilt[w++] = transformedPrefix[cls] + body.slice(region.prefixLen[k]) + transformedSuffix[cls];
  }

  for (let i = headLen + probeCount + blankCount; i < expected; i++) {
    rebuilt[w++] = parts[i];
  }
  // Anything the parser appended after the payload - the leftover of a closing ''' line, a
  // @contentType annotation - is identical either way, so it comes straight back.
  for (let t = expected; t < parts.length; t++) {
    rebuilt[w++] = parts[t];
  }

  return rebuilt.join('\n');
};

export interface BruRequestRedaction {
  /** The file with every leaf payload replaced by probe lines. Feed this to the parser. */
  bruFileStringWithRedactedBody: string;
  /**
   * Kept for the pre-existing call signature. Leaf payloads now come back through
   * `restoreRedactedBodyData` instead, so this is always empty.
   */
  extractedBodyContent: Record<string, string>;
  /** True when at least one payload was actually replaced. */
  redacted: boolean;
  /**
   * Puts the original payloads back into the object the parser returned.
   *
   * Returns false if anything is not exactly as it was left - a probe missing, duplicated, or
   * sitting on the wrong line. On false the object passed in has been PARTIALLY rewritten and
   * must be thrown away: parse the original text instead.
   */
  restoreRedactedBodyData: (parsed: any) => boolean;
}

const passThrough = (bruFileContent: string): BruRequestRedaction => ({
  bruFileStringWithRedactedBody: bruFileContent,
  extractedBodyContent: {},
  redacted: false,
  restoreRedactedBodyData: () => true
});

/**
 * Parses a .bru file and extracts body content while redacting it from the main content
 * @param {string} bruFileContent - The raw content of the .bru file
 * @returns {Object} the redacted file content plus the hook that puts the bodies back
 */
export const bruRequestParseAndRedactBodyData = (bruFileContent: string): BruRequestRedaction => {
  try {
    const content = bruFileContent || '';
    if (!content.length) {
      return passThrough(content);
    }

    const sentinelBase = makeSentinelBase();
    // A token that already occurs in the user's data would be indistinguishable from a
    // probe. Bail rather than risk writing the wrong bytes back.
    if (content.indexOf(sentinelBase) !== -1) {
      return passThrough(content);
    }

    const lines = content.split('\n');
    const state = scanFile(lines, sentinelBase);
    if (state === BAIL || !state.regions.length) {
      return passThrough(content);
    }

    const regions = state.regions;
    const redactedContent = state.out.join('\n');

    const restoreRedactedBodyData = (parsed: any): boolean => {
      // Locate the single string that carries each region's first probe.
      const holders: { node: any; key: string | number }[] = new Array(regions.length);
      let failed = false;

      const findHolders = (node: any, seen: Set<any>): void => {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);
        const keys = Array.isArray(node) ? node.map((_: any, i: number) => i) : Object.keys(node);
        for (const key of keys as any[]) {
          const child = node[key];
          if (typeof child === 'string') {
            if (child.indexOf(sentinelBase) === -1) continue;
            for (let r = 0; r < regions.length; r++) {
              const region = regions[r];
              const marker = region.kind === 'inline' ? region.token : region.classes[0].token;
              if (child.indexOf(marker) === -1) continue;
              // The same payload cannot legitimately surface twice.
              if (holders[r]) {
                failed = true;
                return;
              }
              holders[r] = { node, key };
            }
          } else if (child && typeof child === 'object') {
            findHolders(child, seen);
            if (failed) return;
          }
        }
      };

      findHolders(parsed, new Set());
      if (failed) return false;

      for (let r = 0; r < regions.length; r++) {
        const holder = holders[r];
        if (!holder) return false;
        const rebuilt = rebuild(regions[r], holder.node[holder.key], lines);
        if (rebuilt === null) return false;
        holder.node[holder.key] = rebuilt;
      }

      // Nothing may leave this function still carrying a placeholder. The original content
      // was checked for the sentinel above, so a survivor can only mean a probe leaked
      // somewhere we did not model - e.g. into a verbatim `unknownBlocks[].raw`.
      let leaked = false;
      walkStrings(
        parsed,
        (value: string) => {
          if (!leaked && value.indexOf(sentinelBase) !== -1) leaked = true;
          return undefined;
        },
        new Set()
      );
      return !leaked;
    };

    return {
      bruFileStringWithRedactedBody: redactedContent,
      extractedBodyContent: {},
      redacted: true,
      restoreRedactedBodyData
    };
  } catch (error) {
    console.error('Error parsing and redacting body data:', error);
    return passThrough(bruFileContent);
  }
};
