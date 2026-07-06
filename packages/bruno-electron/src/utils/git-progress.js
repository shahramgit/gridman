const { spawn } = require('child_process');

// Progress reporting + cancellation for long-running Git operations
// (clone / fetch / pull / push).
//
// Git emits progress on stderr when run with --progress, e.g.:
//   remote: Compressing objects:  45% (450/1000)
//   Receiving objects:  73% (7300/10000), 2.5 MiB | 1.2 MiB/s
// parseGitProgressLine turns one stderr line into { phase, percent } (percent
// is null for lines without a percentage). runCancellableGitCommand spawns the
// git binary directly, streams parsed progress to the renderer keyed by an
// operation id, and registers the child process so cancelGitOperation can kill
// it (SIGTERM, then SIGKILL after 3s if it does not exit).

const SIGKILL_DELAY_MS = 3000;

// operation id -> { child, cancelled, killTimer }
const activeGitProcesses = new Map();

/**
 * Parses a single git stderr line into structured progress.
 * @param {string} line one line of git --progress stderr output
 * @returns {{ phase: string, percent: number|null }|null} null for empty lines
 */
const parseGitProgressLine = (line = '') => {
  const value = String(line).replace(/^remote:\s*/i, '').trim();
  if (!value) {
    return null;
  }

  const percentMatch = value.match(/^([A-Za-z][A-Za-z ./-]*?):\s+(\d{1,3})%/);
  if (percentMatch) {
    return {
      phase: percentMatch[1].trim(),
      percent: Math.min(100, parseInt(percentMatch[2], 10))
    };
  }

  const phaseMatch = value.match(/^([A-Za-z][A-Za-z ./-]*?):\s/);
  if (phaseMatch) {
    return { phase: phaseMatch[1].trim(), percent: null };
  }

  return { phase: value, percent: null };
};

const sendToRenderer = (win, channel, payload) => {
  try {
    if (win && !win.isDestroyed?.() && win.webContents) {
      win.webContents.send(channel, payload);
    }
  } catch (_) {
    // The window may be closing; progress updates are best-effort.
  }
};

/**
 * Runs a git command as a spawned child process with progress streaming and
 * cancellation support.
 *
 * Progress events (when `win` and `processUid` are provided):
 *  - 'main:update-git-operation-progress' { uid, data } — raw stderr chunks,
 *    kept for backwards compatibility with existing listeners.
 *  - 'main:git-operation-progress' { uid, phase, percent, raw } — parsed.
 *
 * @param {object} options
 * @param {string} options.binary absolute git binary or 'git'
 * @param {string[]} options.args git arguments (include --progress for progress)
 * @param {string} options.cwd working directory
 * @param {string} [options.processUid] operation id used for progress + cancel
 * @param {object} [options.win] BrowserWindow receiving progress events
 * @param {object} [options.env] extra environment variables
 * @returns {Promise<{ stdout: string, stderr: string }>} rejects with
 *   error.cancelled === true when the operation was cancelled
 */
const runCancellableGitCommand = ({ binary, args, cwd, processUid, win, env }) => {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        // Own process group on POSIX so cancel can signal git together with
        // its helper children (git-remote-https, ssh, ...).
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      return reject(error);
    }

    const entry = { child, cancelled: false, killTimer: null };
    if (processUid) {
      activeGitProcesses.set(processUid, entry);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      if (processUid && activeGitProcesses.get(processUid) === entry) {
        activeGitProcesses.delete(processUid);
      }
    };

    const forwardProgress = (text) => {
      if (!processUid) {
        return;
      }
      sendToRenderer(win, 'main:update-git-operation-progress', { uid: processUid, data: text });
      for (const line of text.split(/[\r\n]+/)) {
        const progress = parseGitProgressLine(line);
        if (progress) {
          sendToRenderer(win, 'main:git-operation-progress', {
            uid: processUid,
            phase: progress.phase,
            percent: progress.percent,
            raw: line.trim()
          });
        }
      }
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      forwardProgress(text);
    });

    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (entry.cancelled) {
        const error = new Error('Operation cancelled');
        error.cancelled = true;
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }

      if (code === 0) {
        return resolve({ stdout, stderr });
      }

      const error = new Error((stderr || stdout || `git exited with code ${code ?? signal}`).trim());
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    // Normal completions settle on 'close' so all stdio output has been
    // flushed. After a cancel (or a crash that orphans a helper child holding
    // the stdio pipes, e.g. git-remote-https), 'close' can be delayed
    // indefinitely, so 'exit' settles cancelled operations immediately and
    // acts as a short fallback otherwise.
    child.on('close', (code, signal) => settle(code, signal));
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (entry.cancelled) {
        return settle(code, signal);
      }
      const fallbackTimer = setTimeout(() => settle(code, signal), 2000);
      fallbackTimer.unref?.();
    });
  });
};

/**
 * Cancels a running git operation by operation id: SIGTERM immediately, then
 * SIGKILL after 3 seconds if the process has not exited. The repository is
 * left in whatever state git leaves it (fetch/clone are safe to interrupt;
 * an interrupted pull merge is recovered through the existing conflict
 * continue/abort flow).
 *
 * @param {string} processUid operation id passed to runCancellableGitCommand
 * @returns {boolean} true when a running process was found and signalled
 */
const signalGitProcess = (child, signal) => {
  // Signal the whole process group on POSIX so git's helper children die too;
  // fall back to signalling the git process directly.
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (_) {
    }
  }
  try {
    child.kill(signal);
  } catch (_) {
  }
};

const cancelGitOperation = (processUid) => {
  const entry = activeGitProcesses.get(processUid);
  if (!entry || entry.cancelled) {
    return Boolean(entry);
  }

  entry.cancelled = true;
  signalGitProcess(entry.child, 'SIGTERM');

  entry.killTimer = setTimeout(() => {
    signalGitProcess(entry.child, 'SIGKILL');
  }, SIGKILL_DELAY_MS);
  entry.killTimer.unref?.();

  return true;
};

const hasActiveGitOperation = (processUid) => activeGitProcesses.has(processUid);

module.exports = {
  parseGitProgressLine,
  runCancellableGitCommand,
  cancelGitOperation,
  hasActiveGitOperation
};
