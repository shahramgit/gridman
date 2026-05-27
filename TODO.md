# TODO

## High Priority
- Push current `main` to `origin` and `vasl` when approved.
- Commit the new memory/session files if the user wants them versioned. `AGENTS.md` is currently ignored by `.gitignore`.
- Smoke test sidebar search in a large workspace after a fresh app restart.
- Verify Windows build icon/titlebar behavior after latest branding changes.
- Verify Git pull behavior on Windows with long paths and document prerequisites in user-facing docs.

## Medium Priority
- Create a periodic Bruno upstream review workflow: `sync/bruno-YYYY-MM-DD`, cherry-pick useful commits, test, then merge only with approval.
- Improve sidebar search scalability with a durable workspace search index or backend metadata scan if mount-on-search becomes slow.
- Add tests around workspace-only collection constraints:
  - create/import/open collection copies into `<workspace>/collections`;
  - external paths are rejected/quarantined;
  - delete removes owned collection folder from disk.
- Add Git workflow tests for:
  - init/set origin/change origin;
  - sync committed vs sync full;
  - untracked-overwrite preflight;
  - conflict continue/abort.
- Add user-facing guidance for Git auth:
  - SSH key setup;
  - HTTPS credential helper;
  - Windows Git/PATH/long-path requirements.

## Low Priority
- Clean up remaining user-facing Bruno strings while preserving internal compatibility names.
- Improve README with richer screenshots and workflow examples.
- Add release notes templates for GitHub releases.
- Add app signing/notarization plan for macOS and code signing plan for Windows.

## Technical Debt
- Internal package names still use Bruno. Keep for now, but document before any broad rename.
- Workspace Git logic has accumulated many edge-case handlers; consider splitting into smaller modules with tests.
- Collection loading/search behavior relies on mounted collection trees. Consider separating metadata indexing from full request loading.
- Electron IPC error messages should be normalized into user-actionable UI messages.

## Future Improvements
- Optional visual conflict resolver for `workspace.yml` and request files.
- Safer large-repo Git operations with progress UI and cancellation.
- First-class release CI for macOS/Windows/Linux artifacts.
- More inspection tools for selected text and response bodies.
- Optional documentation/export features for workspace-level API catalogs.
