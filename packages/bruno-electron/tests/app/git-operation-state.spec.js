const path = require('path');
const {
  beginGitOperation,
  endGitOperation,
  isPathUnderActiveGitOperation,
  gitOperationEvents
} = require('../../src/app/git-operation-state');

const ROOT = path.resolve('/tmp/gridman-ws');
const CHILD = path.join(ROOT, 'collections', 'c1', 'api', 'get.bru');
const OUTSIDE = path.resolve('/tmp/other-ws/file.bru');

describe('git-operation-state', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('marks descendants of an active git root as suspended', () => {
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(false);

    beginGitOperation(ROOT);
    expect(isPathUnderActiveGitOperation(ROOT)).toBe(true);
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(true);
    expect(isPathUnderActiveGitOperation(OUTSIDE)).toBe(false);

    endGitOperation(ROOT);
    jest.runOnlyPendingTimers();
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(false);
  });

  it('keeps the root active through a grace window, then emits end once', () => {
    const ended = jest.fn();
    gitOperationEvents.once('git-operation-end', ended);

    beginGitOperation(ROOT);
    endGitOperation(ROOT);

    // Still suspended during the grace window to absorb trailing watcher events.
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(true);
    expect(ended).not.toHaveBeenCalled();

    jest.advanceTimersByTime(800);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ gitRootPath: ROOT.replace(/\\/g, '/') });
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(false);
  });

  it('stays active until the last concurrent operation ends (ref counted)', () => {
    beginGitOperation(ROOT);
    beginGitOperation(ROOT);

    endGitOperation(ROOT);
    jest.runOnlyPendingTimers();
    // One operation is still in flight, so no grace timer should have cleared it.
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(true);

    endGitOperation(ROOT);
    jest.runOnlyPendingTimers();
    expect(isPathUnderActiveGitOperation(CHILD)).toBe(false);
  });
});
