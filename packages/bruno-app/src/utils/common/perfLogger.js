// Lightweight always-on perf telemetry for diagnosing search/startup lag on
// client machines: everything logs to the DevTools console with a
// '[gridman-perf]' prefix. Cheap (a few log lines per second at worst) and
// deliberately human-readable — users paste the console output back to us.

// Bump when shipping a perf-relevant build so a pasted log proves which
// build produced it.
export const PERF_BUILD_TAG = '2026-07-13-E';

const since = () => `${(performance.now() / 1000).toFixed(1)}s`;

export const perfLog = (event, data) => {
  try {
    const line = `[gridman-perf] ${since()} ${event}${data !== undefined ? ` ${JSON.stringify(data)}` : ''}`;
    console.info(line);
    // Also forward to the main process so the line shows in the terminal
    // running `npm run dev` — where perf reports are read from.
    window.ipcRenderer?.invoke?.('renderer:perf-log', line)?.catch?.(() => {});
  } catch (_err) {
    // logging must never break the app
  }
};

let initialized = false;
export const initPerfLogging = ({ mode }) => {
  if (initialized) {
    return;
  }
  initialized = true;
  perfLog('init', { build: PERF_BUILD_TAG, mode });

  // Long main-thread tasks are what the user FEELS as lag/freeze; log every
  // task over 100ms with its duration.
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 100) {
          perfLog('LONG-TASK', { ms: Math.round(entry.duration) });
        }
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch (_err) {
    // longtask observer unsupported — timings above still log
  }
};

// Aggregated background-stream counters (tree-update flushes, index batches,
// index readies) reported every 2s while anything flows — shows how long the
// startup hydration/index streams actually run.
const stream = { treeFiles: 0, indexBatchNodes: 0, indexesReady: 0, timer: null };
export const perfCount = (key, amount = 1) => {
  stream[key] += amount;
  if (!stream.timer) {
    stream.timer = setTimeout(() => {
      const { treeFiles, indexBatchNodes, indexesReady } = stream;
      stream.treeFiles = 0;
      stream.indexBatchNodes = 0;
      stream.indexesReady = 0;
      stream.timer = null;
      perfLog('background-stream (last 2s)', { treeFiles, indexBatchNodes, indexesReady });
    }, 2000);
  }
};
