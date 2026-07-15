const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');

// Persistent request-send History: one JSONL file per workspace under
// <userData>/history/, capped at MAX_ENTRIES (compacted when the file grows
// past COMPACT_THRESHOLD lines). Local-only by design — history never enters
// the workspace git repo and never leaves the machine.
const MAX_ENTRIES = 500;
const COMPACT_THRESHOLD = 800;

const getHistoryDir = () => {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'history');
};

const sanitizeWorkspaceUid = (workspaceUid) => String(workspaceUid || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');

const getHistoryFile = (workspaceUid) => path.join(getHistoryDir(), `${sanitizeWorkspaceUid(workspaceUid)}.jsonl`);

const readEntries = (workspaceUid) => {
  const file = getHistoryFile(workspaceUid);
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (_err) {
      // skip corrupt lines rather than losing the whole history
    }
  }
  return entries;
};

const writeEntries = (workspaceUid, entries) => {
  fsExtra.ensureDirSync(getHistoryDir());
  fs.writeFileSync(getHistoryFile(workspaceUid), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
};

const appendHistoryEntry = (entry) => {
  const workspaceUid = entry?.workspaceUid;
  fsExtra.ensureDirSync(getHistoryDir());
  fs.appendFileSync(getHistoryFile(workspaceUid), JSON.stringify(entry) + '\n');
  // Compact occasionally so the file can't grow unbounded.
  const entries = readEntries(workspaceUid);
  if (entries.length > COMPACT_THRESHOLD) {
    writeEntries(workspaceUid, entries.slice(-MAX_ENTRIES));
  }
};

const loadHistory = (workspaceUid) => {
  // newest first, capped
  return readEntries(workspaceUid).slice(-MAX_ENTRIES).reverse();
};

const removeHistoryEntry = (workspaceUid, id) => {
  const entries = readEntries(workspaceUid).filter((entry) => entry.id !== id);
  writeEntries(workspaceUid, entries);
};

const clearHistory = (workspaceUid) => {
  const file = getHistoryFile(workspaceUid);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
};

module.exports = {
  appendHistoryEntry,
  loadHistory,
  removeHistoryEntry,
  clearHistory
};
