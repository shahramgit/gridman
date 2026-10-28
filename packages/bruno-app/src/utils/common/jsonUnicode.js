import { createScanner, ScanError, SyntaxKind } from 'jsonc-parser';

// Decode JSON string tokens independently: parsing the whole document would
// round large numbers and reorder integer-like keys. JSON.stringify keeps
// quotes, control characters and lone surrogates escaped, while literal \\u
// text remains literal after one decode.
export const decodeJsonUnicodeEscapes = (text) => {
  if (typeof text !== 'string' || !text.includes('\\u')) return text;
  const scanner = createScanner(text, true);
  const parts = [];
  let previousEnd = 0;
  // The scanner also handles malformed/unfinished pastes in one pass, without
  // a string-token regexp backtracking over every escaped quote.
  while (scanner.scan() !== SyntaxKind.EOF) {
    if (scanner.getToken() !== SyntaxKind.StringLiteral || scanner.getTokenError() !== ScanError.None) continue;
    const start = scanner.getTokenOffset();
    const end = start + scanner.getTokenLength();
    if (!text.slice(start, end).includes('\\u')) continue;
    const decoded = JSON.stringify(scanner.getTokenValue());
    parts.push(text.slice(previousEnd, start), decoded);
    previousEnd = end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(previousEnd));
  return parts.join('');
};
