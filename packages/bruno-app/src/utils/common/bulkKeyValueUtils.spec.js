// New rows get a uid from uuid(); the global jest.setup mock of nanoid drops
// customAlphabet, so re-map it to the actual module (same pattern as
// collectionIndex.spec.js).
jest.mock('nanoid', () => ({
  ...jest.requireActual('nanoid')
}));

import { parseBulkKeyValue, serializeBulkKeyValue } from './bulkKeyValueUtils';

// A realistic set of rows as they exist in redux/on disk: the bulk editor text
// only encodes name/value/enabled, everything else must survive the roundtrip.
const makeParams = () => [
  { uid: 'uid-auth', name: 'Authorization', value: 'Bearer {{token}}', description: 'auth header', enabled: true },
  { uid: 'uid-accept', name: 'Accept', value: 'application/json', description: 'response format', enabled: true },
  { uid: 'uid-trace', name: 'X-Trace', value: 'off', description: 'debugging only', enabled: false }
];

describe('parseBulkKeyValue', () => {
  it('roundtrips with no edits as an exact no-op', () => {
    const params = makeParams();

    const result = parseBulkKeyValue(serializeBulkKeyValue(params), params);

    expect(result).toEqual(params);
  });

  it('roundtrips values the text cannot represent as an exact no-op', () => {
    // The text is line based and unquoted, so none of these survive a naive
    // parse: they come back trimmed / truncated and get written to disk that way.
    const params = [
      { uid: 'uid-1', name: 'X-Padded', value: 'has trailing space  ', description: 'keep me', enabled: true },
      { uid: 'uid-2', name: '  X-Odd-Name  ', value: 'v', description: 'keep me too', enabled: true },
      { uid: 'uid-3', name: 'X-Multi', value: 'line one\nline two', description: 'and me', enabled: true }
    ];

    const result = parseBulkKeyValue(serializeBulkKeyValue(params), params);

    expect(result).toEqual(params);
  });

  it('keeps the row count stable when a value contains a line break', () => {
    const params = [
      { uid: 'uid-1', name: 'X-Multi', value: 'line one\nline two', description: 'multi', enabled: true },
      { uid: 'uid-2', name: 'Accept', value: 'application/json', description: 'accept', enabled: true }
    ];

    const text = serializeBulkKeyValue(params);

    expect(text).toEqual('X-Multi:line one line two\nAccept:application/json');
    expect(parseBulkKeyValue(text, params)).toHaveLength(2);
  });

  it('does not rewrite text it just produced', () => {
    // CodeEditor calls setValue whenever the serialized value diverges from the
    // buffer, which would yank the line out from under the cursor mid-edit.
    const params = [
      { uid: 'uid-1', name: 'X-Padded', value: 'has trailing space  ', enabled: true },
      { uid: 'uid-2', name: 'X-Multi', value: 'line one\nline two', enabled: false }
    ];
    const text = serializeBulkKeyValue(params);

    expect(serializeBulkKeyValue(parseBulkKeyValue(text, params))).toEqual(text);
  });

  it('keeps description and uid when a value is edited', () => {
    const params = makeParams();
    const text = serializeBulkKeyValue(params).replace('application/json', 'application/xml');

    const result = parseBulkKeyValue(text, params);

    expect(result[1]).toEqual({
      uid: 'uid-accept',
      name: 'Accept',
      value: 'application/xml',
      description: 'response format',
      enabled: true
    });
  });

  it('keeps description and uid when a name is edited', () => {
    // Correcting a typo'd header name must not silently drop the row's
    // description - the row is still the same row.
    const params = [
      { uid: 'u1', name: 'Authorization', value: 'Bearer x', description: 'auth header', enabled: true }
    ];

    const result = parseBulkKeyValue('Authorisation:Bearer x', params);

    expect(result).toEqual([
      { uid: 'u1', name: 'Authorisation', value: 'Bearer x', description: 'auth header', enabled: true }
    ]);
  });

  it('keeps description and uid when a name is edited in the middle of the list', () => {
    const params = makeParams();
    const text = serializeBulkKeyValue(params).replace('Accept:', 'Accepts:');

    const result = parseBulkKeyValue(text, params);

    expect(result[1]).toEqual({
      uid: 'uid-accept',
      name: 'Accepts',
      value: 'application/json',
      description: 'response format',
      enabled: true
    });
    // the untouched rows keep theirs, and nothing shifted onto them
    expect(result[0]).toEqual(params[0]);
    expect(result[2]).toEqual(params[2]);
  });

  it('keeps description and uid while a name is being retyped one character at a time', () => {
    // Every keystroke re-parses; a half-typed name must not orphan the row.
    const params = makeParams();
    let current = params;

    ['Acce', 'Accep', 'Accept-Encoding'].forEach((partialName) => {
      const text = serializeBulkKeyValue(current).split('\n');
      text[1] = `${partialName}:application/json`;
      current = parseBulkKeyValue(text.join('\n'), current);

      expect(current[1].uid).toEqual('uid-accept');
      expect(current[1].description).toEqual('response format');
    });

    expect(current[1].name).toEqual('Accept-Encoding');
  });

  it('keeps description and uid when a row is toggled off', () => {
    const params = makeParams();
    const text = serializeBulkKeyValue(params).replace('Accept:', '//Accept:');

    const result = parseBulkKeyValue(text, params);

    expect(result[1]).toEqual({
      uid: 'uid-accept',
      name: 'Accept',
      value: 'application/json',
      description: 'response format',
      enabled: false
    });
  });

  it('reads an indented comment as a disabled row, not a row named //Name', () => {
    const params = [{ uid: 'uid-1', name: 'A', value: '1', description: 'keep me', enabled: true }];

    const result = parseBulkKeyValue('  //A:1', params);

    expect(result).toEqual([{ uid: 'uid-1', name: 'A', value: '1', description: 'keep me', enabled: false }]);
  });

  it('preserves metadata beyond description, so multipart/query rows survive', () => {
    const params = [
      { uid: 'uid-1', name: 'file', value: 'a.txt', description: 'the file', contentType: 'text/plain', type: 'text', enabled: true }
    ];

    const result = parseBulkKeyValue('file:b.txt', params);

    expect(result[0]).toEqual({
      uid: 'uid-1',
      name: 'file',
      value: 'b.txt',
      description: 'the file',
      contentType: 'text/plain',
      type: 'text',
      enabled: true
    });
  });

  it('follows the rows through a pure reorder', () => {
    const params = makeParams();
    const lines = serializeBulkKeyValue(params).split('\n');

    const result = parseBulkKeyValue([lines[2], lines[0], lines[1]].join('\n'), params);

    expect(result).toEqual([params[2], params[0], params[1]]);
  });

  it('deletes a row without shifting metadata onto its neighbours', () => {
    const params = makeParams();
    const text = serializeBulkKeyValue(params)
      .split('\n')
      .filter((line) => !line.startsWith('Accept:'))
      .join('\n');

    const result = parseBulkKeyValue(text, params);

    expect(result).toEqual([params[0], params[2]]);
  });

  it('gives an inserted row a fresh uid and no inherited metadata', () => {
    const params = makeParams();
    const lines = serializeBulkKeyValue(params).split('\n');
    lines.splice(1, 0, 'X-New:1');

    const result = parseBulkKeyValue(lines.join('\n'), params);

    expect(result).toHaveLength(4);
    expect(result[1].name).toEqual('X-New');
    expect(result[1].uid).toEqual(expect.any(String));
    expect(params.map((p) => p.uid)).not.toContain(result[1].uid);
    expect(result[1].description).toBeUndefined();
    expect(result[2]).toEqual(params[1]);
  });

  it('gives an appended row a fresh uid and no inherited metadata', () => {
    const params = makeParams();
    const text = `${serializeBulkKeyValue(params)}\nX-New:1`;

    const result = parseBulkKeyValue(text, params);

    expect(result).toHaveLength(4);
    expect(result[3].name).toEqual('X-New');
    expect(params.map((p) => p.uid)).not.toContain(result[3].uid);
    expect(result[3].description).toBeUndefined();
  });

  it('keeps a uid stable for a row being typed, once it exists', () => {
    // Feeding the previous result back in is what BulkEditor does on every
    // keystroke; without it a new row would be re-identified on each character.
    const first = parseBulkKeyValue('a:1\nX-New:', [{ uid: 'uid-a', name: 'a', value: '1', enabled: true }]);
    const newUid = first[1].uid;

    const second = parseBulkKeyValue('a:1\nX-New:v', first);
    const third = parseBulkKeyValue('a:1\nX-Newer:v', second);

    expect(newUid).toEqual(expect.any(String));
    expect(second[1].uid).toEqual(newUid);
    expect(third[1].uid).toEqual(newUid);
  });

  it('gives every added row its own uid', () => {
    const result = parseBulkKeyValue('a:1\nb:2', []);

    expect(result[0].uid).toEqual(expect.any(String));
    expect(result[1].uid).toEqual(expect.any(String));
    expect(result[0].uid).not.toEqual(result[1].uid);
  });

  it('does not cross-contaminate metadata between duplicate names', () => {
    const params = [
      { uid: 'uid-1', name: 'tag', value: 'one', description: 'first tag', enabled: true },
      { uid: 'uid-2', name: 'tag', value: 'two', description: 'second tag', enabled: true }
    ];

    const result = parseBulkKeyValue('tag:one\ntag:two\ntag:three', params);

    expect(result[0]).toEqual(params[0]);
    expect(result[1]).toEqual(params[1]);
    // the third duplicate has no original left to claim
    expect(result[2].name).toEqual('tag');
    expect(result[2].value).toEqual('three');
    expect(result[2].description).toBeUndefined();
    expect(result[2].uid).toEqual(expect.any(String));
    expect(['uid-1', 'uid-2']).not.toContain(result[2].uid);
  });

  it('matches duplicate names by position when they are reordered', () => {
    const params = [
      { uid: 'uid-1', name: 'tag', value: 'one', description: 'first tag', enabled: true },
      { uid: 'uid-other', name: 'other', value: 'x', description: 'other', enabled: true },
      { uid: 'uid-2', name: 'tag', value: 'two', description: 'second tag', enabled: true }
    ];

    // 'other' is deleted, both 'tag' rows keep their own metadata
    const result = parseBulkKeyValue('tag:one\ntag:two', params);

    expect(result[0]).toEqual(params[0]);
    expect(result[1]).toEqual(params[2]);
  });

  it('prefers the surviving name over the index when a row is renamed after a delete', () => {
    const params = makeParams();

    // 'Authorization' deleted, 'Accept' renamed - Accept must not inherit
    // Authorization's metadata just because it now sits at index 0
    const result = parseBulkKeyValue('Accepts:application/json\n//X-Trace:off', params);

    expect(result[0].uid).toEqual('uid-accept');
    expect(result[0].description).toEqual('response format');
    expect(result[1]).toEqual(params[2]);
  });

  it('ignores lines without a separator', () => {
    const result = parseBulkKeyValue('\nnot-a-pair\na:1\n', []);

    expect(result).toHaveLength(1);
    expect(result[0].name).toEqual('a');
  });

  it('still parses without an original set', () => {
    const result = parseBulkKeyValue('a:1\n//b:2');

    expect(result[0]).toMatchObject({ name: 'a', value: '1', enabled: true });
    expect(result[1]).toMatchObject({ name: 'b', value: '2', enabled: false });
  });
});

describe('serializeBulkKeyValue', () => {
  it('comments out disabled rows only', () => {
    const text = serializeBulkKeyValue([
      { name: 'a', value: '1', enabled: true },
      { name: 'b', value: '2', enabled: false }
    ]);

    expect(text).toEqual('a:1\n//b:2');
  });

  it('emits nothing for a missing name or value rather than the string "undefined"', () => {
    expect(serializeBulkKeyValue([{ enabled: true }])).toEqual(':');
  });

  it('leaves a row that never carried an enabled flag exactly as it was', () => {
    // `enabled` falsy means commented out, same as upstream. Every producer of
    // these rows sets the flag (toBrunoHttpHeaders, the postman importer, the
    // reducers' `enabled = true` default, and ResponseExampleResponseHeaders
    // which adds it before opening bulk edit), so this only matters as a
    // guarantee that the serializer cannot change data it does not understand.
    const params = [{ uid: 'uid-1', name: 'Accept', value: 'application/json' }];

    expect(parseBulkKeyValue(serializeBulkKeyValue(params), params)).toEqual(params);
  });
});
