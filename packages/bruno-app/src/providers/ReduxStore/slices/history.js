import { createSlice } from '@reduxjs/toolkit';

// Request send History (Postman-style sidebar section, local-only). Entries
// hold the AUTHORED (uninterpolated) request snapshot — the same text already
// in the collection files, so history adds no new secret exposure — plus
// response meta (status/duration/size, never bodies). Persistence lives in the
// main process (one JSONL per workspace under userData/history); this slice is
// the in-memory view for the active workspace.
const MAX_ENTRIES = 500;

const initialState = {
  workspaceUid: null,
  entries: []
};

export const historySlice = createSlice({
  name: 'history',
  initialState,
  reducers: {
    historyLoaded: (state, action) => {
      state.workspaceUid = action.payload.workspaceUid;
      state.entries = action.payload.entries || [];
    },
    historyEntryAdded: (state, action) => {
      const entry = action.payload;
      if (state.workspaceUid && entry.workspaceUid && entry.workspaceUid !== state.workspaceUid) {
        return;
      }
      state.entries.unshift(entry);
      if (state.entries.length > MAX_ENTRIES) {
        state.entries.length = MAX_ENTRIES;
      }
    },
    historyEntryRemoved: (state, action) => {
      state.entries = state.entries.filter((entry) => entry.id !== action.payload.id);
    },
    historyCleared: (state) => {
      state.entries = [];
    }
  }
});

export const { historyLoaded, historyEntryAdded, historyEntryRemoved, historyCleared } = historySlice.actions;

export default historySlice.reducer;
