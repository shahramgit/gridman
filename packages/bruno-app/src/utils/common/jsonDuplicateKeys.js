/**
 * Pure scanner that finds duplicate keys within the same object scope of a
 * JSON(-ish) document. Used by the CodeMirror JSON lint pass to underline
 * duplicate keys (e.g. "grant_type" appearing twice in a request body).
 *
 * It intentionally works on the ORIGINAL editor text (not the preprocessed
 * text fed to jsonlint) so the reported positions line up with what the user
 * sees. To make that possible it tolerates:
 *   - {{template}} placeholders outside of strings (skipped atomically so
 *     their braces don't corrupt object/array depth tracking)
 *   - // line comments and block comments (JSONC bodies are accepted by the
 *     existing lint pipeline via strip-json-comments)
 *   - escaped quotes and other escapes inside strings
 *
 * Keys are only compared within the SAME object scope: the same key in
 * sibling objects (including objects inside arrays) is not a duplicate.
 *
 * Returns an array of { key, from: { line, ch }, to: { line, ch } } where
 * from/to span the duplicate key's quoted string token (0-based line/ch,
 * matching CodeMirror positions).
 */
const findDuplicateJsonKeys = (text = '') => {
  const duplicates = [];
  const input = String(text);
  const length = input.length;

  // Scope stack: object scopes carry the set of keys seen so far.
  const stack = [];

  let i = 0;
  let line = 0;
  let ch = 0;

  const advance = () => {
    if (input[i] === '\n') {
      line += 1;
      ch = 0;
    } else {
      ch += 1;
    }
    i += 1;
  };

  while (i < length) {
    const c = input[i];

    if (c === '"') {
      // Scan a string token, keeping track of its exact span.
      const from = { line, ch };
      advance(); // opening quote
      let raw = '';
      let closed = false;
      while (i < length) {
        const s = input[i];
        if (s === '\\') {
          raw += s;
          advance();
          if (i < length) {
            raw += input[i];
            advance();
          }
          continue;
        }
        if (s === '"') {
          advance();
          closed = true;
          break;
        }
        if (s === '\n') {
          // Unterminated string on this line - treat as not-a-key and move on.
          break;
        }
        raw += s;
        advance();
      }
      if (!closed) {
        continue;
      }
      const to = { line, ch };

      // A string is a key when the next non-whitespace character is ':'.
      let j = i;
      while (j < length && /\s/.test(input[j])) {
        j += 1;
      }
      const isKey = input[j] === ':';
      const scope = stack[stack.length - 1];
      if (isKey && scope && scope.type === 'object') {
        // Normalize escapes so "a\"b" and the identically-escaped key match
        // on their actual value.
        let key = raw;
        try {
          key = JSON.parse(`"${raw}"`);
        } catch (_err) {
          // Malformed escape - compare on the raw text.
        }
        if (scope.keys.has(key)) {
          duplicates.push({ key, from, to });
        } else {
          scope.keys.add(key);
        }
      }
      continue;
    }

    if (c === '{') {
      // Atomically skip {{template}} placeholders so their braces don't open
      // phantom object scopes. Placeholders never contain quotes or braces.
      if (input[i + 1] === '{') {
        const close = input.indexOf('}}', i + 2);
        if (close !== -1) {
          const inner = input.slice(i + 2, close);
          if (!/["{}]/.test(inner)) {
            const end = close + 2;
            while (i < end) {
              advance();
            }
            continue;
          }
        }
      }
      stack.push({ type: 'object', keys: new Set() });
      advance();
      continue;
    }

    if (c === '}') {
      if (stack.length && stack[stack.length - 1].type === 'object') {
        stack.pop();
      }
      advance();
      continue;
    }

    if (c === '[') {
      stack.push({ type: 'array' });
      advance();
      continue;
    }

    if (c === ']') {
      if (stack.length && stack[stack.length - 1].type === 'array') {
        stack.pop();
      }
      advance();
      continue;
    }

    // Line comment
    if (c === '/' && input[i + 1] === '/') {
      while (i < length && input[i] !== '\n') {
        advance();
      }
      continue;
    }

    // Block comment
    if (c === '/' && input[i + 1] === '*') {
      advance();
      advance();
      while (i < length && !(input[i] === '*' && input[i + 1] === '/')) {
        advance();
      }
      if (i < length) {
        advance();
        advance();
      }
      continue;
    }

    advance();
  }

  return duplicates;
};

export default findDuplicateJsonKeys;
