const {
  splitConflictedContent,
  parseWorkspaceYmlConflict,
  buildMergedWorkspaceYmlConfig
} = require('../../src/utils/workspace-conflict');

const conflictedCollectionsFixture = [
  'opencollection: 1.0.0',
  'info:',
  '  name: "Team Workspace"',
  '  type: workspace',
  '',
  'collections:',
  '  - name: "Shared"',
  '    path: "collections/shared"',
  '<<<<<<< HEAD',
  '  - name: "Local Only"',
  '    path: "collections/local-only"',
  '=======',
  '  - name: "Remote Only"',
  '    path: "collections/remote-only"',
  '  - name: "Remote Extra"',
  '    path: "collections/remote-extra"',
  '>>>>>>> origin/main',
  '',
  'specs:',
  '',
  'docs: \'\''
].join('\n');

const scalarConflictFixture = [
  'opencollection: 1.0.0',
  'info:',
  '<<<<<<< HEAD',
  '  name: "Local Name"',
  '=======',
  '  name: "Remote Name"',
  '>>>>>>> origin/main',
  '  type: workspace',
  '',
  'collections:',
  '  - name: "Shared"',
  '    path: "collections/shared"',
  '',
  'specs:',
  '',
  'docs: \'\''
].join('\n');

describe('splitConflictedContent', () => {
  it('reconstructs full ours and theirs versions', () => {
    const { ours, theirs, conflictCount } = splitConflictedContent(conflictedCollectionsFixture);

    expect(conflictCount).toBe(1);
    expect(ours).toContain('collections/local-only');
    expect(ours).not.toContain('collections/remote-only');
    expect(theirs).toContain('collections/remote-only');
    expect(theirs).toContain('collections/remote-extra');
    expect(theirs).not.toContain('collections/local-only');
    // Common content is present on both sides, markers on neither
    for (const side of [ours, theirs]) {
      expect(side).toContain('collections/shared');
      expect(side).not.toMatch(/^<{7}/m);
      expect(side).not.toMatch(/^={7}\s*$/m);
      expect(side).not.toMatch(/^>{7}/m);
    }
  });

  it('discards the base section of diff3-style conflicts', () => {
    const diff3 = [
      'value:',
      '<<<<<<< HEAD',
      '  ours: 1',
      '||||||| merged common ancestor',
      '  base: 1',
      '=======',
      '  theirs: 1',
      '>>>>>>> branch'
    ].join('\n');

    const { ours, theirs } = splitConflictedContent(diff3);
    expect(ours).toContain('ours: 1');
    expect(theirs).toContain('theirs: 1');
    expect(ours).not.toContain('base: 1');
    expect(theirs).not.toContain('base: 1');
  });

  it('throws on malformed markers', () => {
    const missingSeparator = ['<<<<<<< HEAD', 'a', '>>>>>>> branch'].join('\n');
    expect(() => splitConflictedContent(missingSeparator)).toThrow(/malformed/i);

    const unterminated = ['<<<<<<< HEAD', 'a', '=======', 'b'].join('\n');
    expect(() => splitConflictedContent(unterminated)).toThrow(/not terminated/i);

    const nested = ['<<<<<<< HEAD', '<<<<<<< HEAD', '=======', 'b', '>>>>>>> branch'].join('\n');
    expect(() => splitConflictedContent(nested)).toThrow(/nested/i);
  });
});

describe('parseWorkspaceYmlConflict', () => {
  it('classifies collections into ours-only / theirs-only / both', () => {
    const summary = parseWorkspaceYmlConflict(conflictedCollectionsFixture);

    expect(summary.ok).toBe(true);
    expect(summary.collections.both.map((entry) => entry.path)).toEqual(['collections/shared']);
    expect(summary.collections.oursOnly.map((entry) => entry.path)).toEqual(['collections/local-only']);
    expect(summary.collections.theirsOnly.map((entry) => entry.path)).toEqual([
      'collections/remote-only',
      'collections/remote-extra'
    ]);
    expect(summary.scalarConflicts).toEqual([]);
  });

  it('reports conflicting scalar fields', () => {
    const summary = parseWorkspaceYmlConflict(scalarConflictFixture);

    expect(summary.ok).toBe(true);
    expect(summary.collections.both).toHaveLength(1);
    expect(summary.scalarConflicts).toEqual([
      expect.objectContaining({ field: 'name', ours: 'Local Name', theirs: 'Remote Name' })
    ]);
  });

  it('reports per-collection metadata conflicts for entries on both sides', () => {
    const fixture = [
      'info:',
      '  name: W',
      '  type: workspace',
      'collections:',
      '<<<<<<< HEAD',
      '  - name: "Renamed Locally"',
      '    path: "collections/shared"',
      '=======',
      '  - name: "Renamed Remotely"',
      '    path: "collections/shared"',
      '>>>>>>> origin/main'
    ].join('\n');

    const summary = parseWorkspaceYmlConflict(fixture);
    expect(summary.ok).toBe(true);
    expect(summary.collections.both[0].conflicting).toBe(true);
    expect(summary.scalarConflicts).toEqual([
      expect.objectContaining({
        field: 'collection:collections/shared',
        ours: 'Renamed Locally',
        theirs: 'Renamed Remotely'
      })
    ]);
  });

  it('returns a clear error for malformed conflict markers', () => {
    const malformed = ['<<<<<<< HEAD', 'name: a', '>>>>>>> branch'].join('\n');
    const summary = parseWorkspaceYmlConflict(malformed);

    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/malformed/i);
  });

  it('returns a clear error when a side is not valid YAML', () => {
    const invalidSide = [
      'info:',
      '<<<<<<< HEAD',
      '  name: "unterminated',
      '=======',
      '  name: ok',
      '>>>>>>> branch'
    ].join('\n');

    const summary = parseWorkspaceYmlConflict(invalidSide);
    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/not valid YAML/i);
  });

  it('returns an error for content without conflict markers', () => {
    const summary = parseWorkspaceYmlConflict('info:\n  name: Clean\n  type: workspace\ncollections: []\n');

    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/does not contain Git conflict markers/i);
  });
});

describe('buildMergedWorkspaceYmlConfig', () => {
  it('keeps the union of both collection lists by default', () => {
    const summary = parseWorkspaceYmlConflict(conflictedCollectionsFixture);
    const merged = buildMergedWorkspaceYmlConfig(summary);

    expect(merged.info.name).toBe('Team Workspace');
    expect(merged.info.type).toBe('workspace');
    expect(merged.collections.map((entry) => entry.path)).toEqual([
      'collections/shared',
      'collections/local-only',
      'collections/remote-only',
      'collections/remote-extra'
    ]);
  });

  it('drops entries the user unchecked', () => {
    const summary = parseWorkspaceYmlConflict(conflictedCollectionsFixture);
    const merged = buildMergedWorkspaceYmlConfig(summary, {
      excludedPaths: ['collections/local-only', 'collections/remote-extra']
    });

    expect(merged.collections.map((entry) => entry.path)).toEqual([
      'collections/shared',
      'collections/remote-only'
    ]);
  });

  it('applies scalar choices (theirs)', () => {
    const summary = parseWorkspaceYmlConflict(scalarConflictFixture);
    const merged = buildMergedWorkspaceYmlConfig(summary, { scalarChoices: { name: 'theirs' } });

    expect(merged.info.name).toBe('Remote Name');
  });

  it('defaults scalar conflicts to the local value', () => {
    const summary = parseWorkspaceYmlConflict(scalarConflictFixture);
    const merged = buildMergedWorkspaceYmlConfig(summary);

    expect(merged.info.name).toBe('Local Name');
  });

  it('uses the chosen side for per-collection metadata conflicts', () => {
    const fixture = [
      'info:',
      '  name: W',
      '  type: workspace',
      'collections:',
      '<<<<<<< HEAD',
      '  - name: "Renamed Locally"',
      '    path: "collections/shared"',
      '=======',
      '  - name: "Renamed Remotely"',
      '    path: "collections/shared"',
      '>>>>>>> origin/main'
    ].join('\n');

    const summary = parseWorkspaceYmlConflict(fixture);
    const merged = buildMergedWorkspaceYmlConfig(summary, {
      scalarChoices: { 'collection:collections/shared': 'theirs' }
    });

    expect(merged.collections).toEqual([{ name: 'Renamed Remotely', path: 'collections/shared' }]);
  });

  it('throws for an unparsable summary', () => {
    expect(() => buildMergedWorkspaceYmlConfig({ ok: false, error: 'nope' })).toThrow('nope');
  });
});
