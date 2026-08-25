/**
 * How the form reacts when the SAVED snapshot changes underneath it.
 *
 * This replaces Formik's `enableReinitialize`, which reset the form whenever
 * `environment.variables` changed — including when our own autosave echoed the value
 * back. Anything typed during that async save window was discarded, so users lost
 * characters mid-word. usebruno/bruno#8732.
 *
 * The rule: adopt the new snapshot only when the form has no unsaved edits. If the user
 * is typing ahead of the save, keep their edits — the draft/autosave cycle persists them.
 *
 * All three arguments are the serialised (JSON, uid-stripped, named-rows-only) variable
 * lists, so comparison is by content rather than object identity.
 *
 * @returns {'adopt'|'skip'|'noop'}
 */
export const reconcileSavedChange = ({ prevSaved, nextSaved, current }) => {
  // The saved snapshot did not actually change, or the form already matches it.
  if (prevSaved === nextSaved || current === nextSaved) {
    return 'noop';
  }

  // The form still matches the previous baseline, so the user has no unsaved edits
  // and the newly saved / externally reloaded data is safe to take.
  if (current === prevSaved) {
    return 'adopt';
  }

  // Diverged from both baselines: the user is editing ahead of the save. Their
  // keystrokes win.
  return 'skip';
};
