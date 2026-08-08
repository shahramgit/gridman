/**
 * Minimal line diff.
 *
 * Upstream's DiffView pulls in the `diff` package. That package is only
 * present in this workspace as a hoisted transitive dependency — it is not
 * declared by bruno-app — so relying on it would break the moment the
 * dependency tree is deduped differently. The diff we need is one function
 * over lines, so it lives here instead.
 *
 * Returns the same shape the `diff` package's `diffLines` returns:
 *   [{ value: string, added?: true, removed?: true }, ...]
 * where `value` keeps its trailing newlines, so callers can `split('\n')`.
 */

// Above this, the O(n*m) LCS table costs more than the diff is worth. The
// common prefix/suffix trim below means we only hit this for two genuinely
// unrelated large documents, where a whole-file replace is the honest answer.
const MAX_LCS_LINES = 3000;

const splitLines = (text) => {
  if (!text) return [];
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const join = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

const push = (parts, type, lines) => {
  if (!lines.length) return;
  const last = parts[parts.length - 1];
  const isAdded = type === 'added';
  const isRemoved = type === 'removed';
  if (last && Boolean(last.added) === isAdded && Boolean(last.removed) === isRemoved) {
    last.value += join(lines);
    return;
  }
  const part = { value: join(lines) };
  if (isAdded) part.added = true;
  if (isRemoved) part.removed = true;
  parts.push(part);
};

/**
 * Longest-common-subsequence backtrack over two line arrays. Only called on
 * the middle section left after common prefix/suffix have been trimmed.
 */
const lcsParts = (a, b) => {
  const n = a.length;
  const m = b.length;
  const parts = [];

  if (n === 0 && m === 0) return parts;
  if (n === 0) {
    push(parts, 'added', b);
    return parts;
  }
  if (m === 0) {
    push(parts, 'removed', a);
    return parts;
  }
  if (n > MAX_LCS_LINES || m > MAX_LCS_LINES) {
    push(parts, 'removed', a);
    push(parts, 'added', b);
    return parts;
  }

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table = new Array(n + 1);
  for (let i = 0; i <= n; i++) table[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let pendingRemoved = [];
  let pendingAdded = [];
  let pendingCommon = [];

  const flushChanges = () => {
    // Removals before additions matches the `diff` package's ordering, which
    // the renderer relies on for line numbering.
    push(parts, 'removed', pendingRemoved);
    push(parts, 'added', pendingAdded);
    pendingRemoved = [];
    pendingAdded = [];
  };

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flushChanges();
      pendingCommon.push(a[i]);
      i++;
      j++;
    } else {
      if (pendingCommon.length) {
        push(parts, 'common', pendingCommon);
        pendingCommon = [];
      }
      if (table[i + 1][j] >= table[i][j + 1]) {
        pendingRemoved.push(a[i]);
        i++;
      } else {
        pendingAdded.push(b[j]);
        j++;
      }
    }
  }

  if (pendingCommon.length) {
    push(parts, 'common', pendingCommon);
    pendingCommon = [];
  }
  while (i < n) pendingRemoved.push(a[i++]);
  while (j < m) pendingAdded.push(b[j++]);
  flushChanges();

  return parts;
};

export const diffLines = (oldStr, newStr) => {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const parts = [];
  push(parts, 'common', a.slice(0, start));
  for (const part of lcsParts(a.slice(start, endA), b.slice(start, endB))) {
    push(parts, part.added ? 'added' : part.removed ? 'removed' : 'common', splitLines(part.value));
  }
  push(parts, 'common', a.slice(endA));

  return parts;
};

export default diffLines;
