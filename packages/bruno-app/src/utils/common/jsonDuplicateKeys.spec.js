import findDuplicateJsonKeys from './jsonDuplicateKeys';

describe('findDuplicateJsonKeys', () => {
  it('returns no duplicates for a valid unique-key object', () => {
    expect(findDuplicateJsonKeys('{"a": 1, "b": 2}')).toEqual([]);
  });

  it('flags a duplicate key at the root object', () => {
    const text = '{\n  "grant_type": "password",\n  "grant_type": "client_credentials"\n}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('grant_type');
    // second occurrence, including the quotes
    expect(result[0].from).toEqual({ line: 2, ch: 2 });
    expect(result[0].to).toEqual({ line: 2, ch: 14 });
  });

  it('flags a duplicate key inside a nested object', () => {
    const text = '{"outer": {"a": 1, "a": 2}, "b": 3}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('a');
    expect(result[0].from).toEqual({ line: 0, ch: 19 });
  });

  it('does not flag the same key in sibling objects', () => {
    const text = '{"first": {"a": 1}, "second": {"a": 2}}';
    expect(findDuplicateJsonKeys(text)).toEqual([]);
  });

  it('treats objects in an array independently', () => {
    const text = '[{"id": 1}, {"id": 2}, {"id": 3}]';
    expect(findDuplicateJsonKeys(text)).toEqual([]);
  });

  it('still flags duplicates within a single object inside an array', () => {
    const text = '[{"id": 1, "id": 2}]';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('id');
  });

  it('does not confuse string values with keys', () => {
    // "b" appears as a value first, then as a key - not a duplicate.
    const text = '{"a": "b", "b": 1}';
    expect(findDuplicateJsonKeys(text)).toEqual([]);
  });

  it('handles keys with escaped quotes', () => {
    const text = '{"a\\"b": 1, "a\\"b": 2}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('a"b');
  });

  it('does not flag keys whose escaped forms differ in text but not value', () => {
    // a is "a" - same actual key value.
    const text = '{"a": 1, "\\u0061": 2}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('a');
  });

  it('tolerates {{template}} placeholders as values without corrupting scopes', () => {
    const text = '{\n  "token": {{accessToken}},\n  "token": "static"\n}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('token');
    expect(result[0].from.line).toBe(2);
  });

  it('ignores braces inside {{placeholders}} so later keys are still scoped to the right object', () => {
    const text = '{"a": {{env.value}}, "b": {"c": 1, "a": 2}}';
    // "a" in the nested object is NOT a duplicate of root "a".
    expect(findDuplicateJsonKeys(text)).toEqual([]);
  });

  it('ignores placeholders inside string values', () => {
    const text = '{"url": "{{baseUrl}}/path", "url": "other"}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('url');
  });

  it('reports each extra occurrence when a key appears three times', () => {
    const text = '{"k": 1, "k": 2, "k": 3}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.key)).toEqual(['k', 'k']);
    expect(result[0].from.ch).toBe(9);
    expect(result[1].from.ch).toBe(17);
  });

  it('flags a duplicate that follows a nested object value', () => {
    const text = '{"a": {"x": 1}, "a": [1, 2]}';
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].from).toEqual({ line: 0, ch: 16 });
  });

  it('skips line and block comments', () => {
    const text = '{\n  // "a": duplicated in a comment "a":\n  "a": 1,\n  /* "a": 2 */\n  "b": 2\n}';
    expect(findDuplicateJsonKeys(text)).toEqual([]);
  });

  it('survives unterminated strings and malformed input without throwing', () => {
    expect(() => findDuplicateJsonKeys('{"a: 1,\n"b": 2')).not.toThrow();
    expect(() => findDuplicateJsonKeys('{{{{')).not.toThrow();
    expect(findDuplicateJsonKeys('')).toEqual([]);
    expect(findDuplicateJsonKeys(null)).toEqual([]);
  });

  it('handles multi-line documents with duplicates on later lines', () => {
    const text = [
      '{',
      '  "client_id": "abc",',
      '  "scope": "openid",',
      '  "nested": {',
      '    "scope": "profile",',
      '    "scope": "email"',
      '  }',
      '}'
    ].join('\n');
    const result = findDuplicateJsonKeys(text);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('scope');
    expect(result[0].from).toEqual({ line: 5, ch: 4 });
    expect(result[0].to).toEqual({ line: 5, ch: 11 });
  });
});
