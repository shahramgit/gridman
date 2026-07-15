import { perfLog } from 'utils/common/perfLogger';

// Lightweight always-on dispatch telemetry: time each reducer pass and, every
// FLUSH_MS, emit a [gridman-perf] line for action types whose reducers cost
// real main-thread time in that window. Immer's produce() runs inside every
// RTK reducer, so a single action touching a large slice — or a burst of
// per-row mount dispatches — shows up here as the true cause of a search-mount
// stall (vs. guessing from a CPU profile's minified immer frames). Cost is a
// performance.now() pair + a Map increment per dispatch: negligible.
const FLUSH_MS = 2000;
const WINDOW_LOG_THRESHOLD_MS = 60; // only log a window if something was slow

const perfActionsMiddleware = () => (next) => {
  const byType = new Map();
  let flushTimer = null;

  const flush = () => {
    flushTimer = null;
    if (!byType.size) return;
    const rows = [...byType.entries()]
      .map(([type, s]) => ({ type, ...s }))
      .sort((a, b) => b.totalMs - a.totalMs);
    byType.clear();
    const worst = rows[0];
    if (!worst || worst.totalMs < WINDOW_LOG_THRESHOLD_MS) return;
    const top = rows.slice(0, 6).map((r) => `${r.type} x${r.count}=${Math.round(r.totalMs)}ms`);
    perfLog(`dispatch cost (last ${FLUSH_MS / 1000}s) ${JSON.stringify(top)}`);
  };

  return (action) => {
    const type = action?.type || '(thunk/unknown)';
    const t0 = performance.now();
    const result = next(action);
    const dt = performance.now() - t0;
    const s = byType.get(type) || { count: 0, totalMs: 0, maxMs: 0 };
    s.count += 1;
    s.totalMs += dt;
    if (dt > s.maxMs) s.maxMs = dt;
    byType.set(type, s);
    if (dt > 100) {
      perfLog(`dispatch SLOW ${type} ${Math.round(dt)}ms`);
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
    }
    return result;
  };
};

export default { middleware: perfActionsMiddleware };
