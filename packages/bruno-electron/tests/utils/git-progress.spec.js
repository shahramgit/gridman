const { parseGitProgressLine, cancelGitOperation } = require('../../src/utils/git-progress');

describe('parseGitProgressLine', () => {
  it('parses phase and percent from receive progress', () => {
    expect(parseGitProgressLine('Receiving objects:  45% (450/1000), 2.5 MiB | 1.2 MiB/s')).toEqual({
      phase: 'Receiving objects',
      percent: 45
    });
  });

  it('parses completed progress lines', () => {
    expect(parseGitProgressLine('Resolving deltas: 100% (200/200), done.')).toEqual({
      phase: 'Resolving deltas',
      percent: 100
    });
  });

  it('strips the remote: prefix', () => {
    expect(parseGitProgressLine('remote: Compressing objects:  12% (3/25)')).toEqual({
      phase: 'Compressing objects',
      percent: 12
    });
  });

  it('parses zero percent', () => {
    expect(parseGitProgressLine('Writing objects:   0% (0/331)')).toEqual({
      phase: 'Writing objects',
      percent: 0
    });
  });

  it('returns a phase without percent for counting lines', () => {
    expect(parseGitProgressLine('remote: Enumerating objects: 519, done.')).toEqual({
      phase: 'Enumerating objects',
      percent: null
    });
  });

  it('returns the raw text as phase for non-progress lines', () => {
    expect(parseGitProgressLine('From github.com:org/repo')).toEqual({
      phase: 'From github.com:org/repo',
      percent: null
    });
  });

  it('returns null for empty lines', () => {
    expect(parseGitProgressLine('')).toBeNull();
    expect(parseGitProgressLine('   ')).toBeNull();
    expect(parseGitProgressLine()).toBeNull();
  });

  it('clamps percent to 100', () => {
    expect(parseGitProgressLine('Receiving objects: 250% (5/2)').percent).toBe(100);
  });
});

describe('cancelGitOperation', () => {
  it('returns false for unknown operation ids', () => {
    expect(cancelGitOperation('does-not-exist')).toBe(false);
  });
});
