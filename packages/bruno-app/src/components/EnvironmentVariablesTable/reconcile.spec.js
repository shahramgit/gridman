import { reconcileSavedChange } from './reconcile';

/**
 * TYPING DURING AN AUTOSAVE MUST NOT LOSE CHARACTERS.
 *
 * Formik's `enableReinitialize` reset the form whenever the saved snapshot changed —
 * including when our own autosave echoed the value back — so anything typed during that
 * async window was discarded and users lost characters mid-word. usebruno/bruno#8732.
 *
 * The decision is pure and lives here so it can be tested without the virtualised table
 * (which pulls in CodeMirror). Arguments are the serialised variable lists.
 */
describe('reconcileSavedChange', () => {
  it('adopts a new snapshot when the form has no unsaved edits', () => {
    // An external change — a script setting an env var, or a file reload.
    expect(reconcileSavedChange({ prevSaved: '[a]', nextSaved: '[b]', current: '[a]' })).toBe('adopt');
  });

  it('KEEPS the user edits when they are typing ahead of the save', () => {
    // The whole bug: the autosave echo arrives while the user has typed further.
    // Adopting here is what deleted their keystrokes.
    expect(reconcileSavedChange({ prevSaved: '[a]', nextSaved: '[ab]', current: '[abc]' })).toBe('skip');
  });

  it('does nothing when the snapshot did not really change', () => {
    expect(reconcileSavedChange({ prevSaved: '[a]', nextSaved: '[a]', current: '[abc]' })).toBe('noop');
  });

  it('does nothing when the form already matches the new snapshot', () => {
    // The common autosave echo: what came back is what is on screen.
    expect(reconcileSavedChange({ prevSaved: '[a]', nextSaved: '[abc]', current: '[abc]' })).toBe('noop');
  });

  it('never adopts over a diverged form, whatever the baselines', () => {
    // Property check: 'adopt' requires current === prevSaved. Anything else that
    // differs from both must be preserved.
    const cases = [
      { prevSaved: '[]', nextSaved: '[a]', current: '[z]' },
      { prevSaved: '[a]', nextSaved: '[]', current: '[a,b]' },
      { prevSaved: '[a,b]', nextSaved: '[a]', current: '[a,b,c]' }
    ];
    for (const c of cases) {
      expect(reconcileSavedChange(c)).not.toBe('adopt');
    }
  });
});
