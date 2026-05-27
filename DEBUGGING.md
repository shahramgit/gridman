# Debugging Notes

## Build / Packaging
- Symptom: `npm run build:electron:win` on macOS failed in NSIS `makensis`.
  - Finding: cross-building Windows installers on macOS can fail at NSIS packaging.
  - Workaround: build on Windows or use a configured CI/cross-build environment.
- Symptom: building one platform removed previous platform output.
  - Finding: Electron Builder writes to `packages/bruno-electron/out` and can overwrite/clean outputs.
  - Fix: copy final artifacts into `releases/<version>/` after each build.
- Symptom: expected Linux x64 file `gridman_<version>_x64_linux.AppImage` was missing.
  - Finding: Electron Builder names Linux x64 as `x86_64`.
  - Correct asset: `gridman_<version>_x86_64_linux.AppImage`.

## macOS Runtime
- Symptom: app asks for "Gridman/Bruno Safe Storage" keychain permission on startup.
  - Finding: Electron safeStorage/cookie encryption can request keychain access.
  - Behavior: allowing enables encrypted storage; denying can fall back to unencrypted cookie behavior.
- Symptom: unsigned macOS app blocked after install.
  - Workaround: `sudo xattr -dr com.apple.quarantine "/Applications/Gridman.app"`.

## Windows Runtime / Git
- Symptom: `spawn git ENOENT` when initializing workspace Git.
  - Root cause: Git not installed or not available on PATH for the Electron process.
  - Fix: install Git for Windows and expose it on PATH.
- Symptom: `Filename too long` during pull/merge on Windows.
  - Root cause: Windows/Git long path support disabled.
  - Fix:
    - Admin PowerShell: `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force`
    - `git config --system core.longpaths true`

## Workspace / Collection Model
- Symptom: `Workspace collections must be inside the workspace folder.`
  - Root cause: old/default/external collection references conflicted with Gridman's workspace-owned model.
  - Fix: collections must be copied/moved under `<workspace>/collections/`.
- Symptom: `Workspace collections must use relative paths under collections/.`
  - Root cause: workspace config or IPC attempted to add an absolute/outside collection path.
  - Fix: normalize workspace entries through workspace-config helpers and store relative collection paths.
- Symptom: deleting a collection removed only `workspace.yml` entry and left folder on disk.
  - Decision/fix: Gridman delete should remove the owned collection folder from disk.
- Symptom: collection creation failed with `assertWorkspaceCollectionLocation is not defined`.
  - Root cause: helper introduced without proper scope/import during workspace-only enforcement.
  - Fix: ensure location assertion helper is defined/imported wherever create/import flows use it.

## Git Merge / Pull
- Symptom: `refusing to merge unrelated histories`.
  - Root cause: binding an existing local workspace to a remote with unrelated initial history.
  - Fix/workaround: allow unrelated histories in controlled pull path, with preflight handling.
- Symptom: pull aborted with `untracked working tree files would be overwritten by merge`.
  - Root cause: local untracked collection files overlapped remote tracked files.
  - Fix: preflight/autocommit/backup non-protected files before pull where safe; never auto-commit protected environment files.
- Symptom: conflict markers in `workspace.yml` caused YAML parse errors.
  - Signature: `YAMLException: can not read a block mapping entry` near `<<<<<<< HEAD`.
  - Fix: surface conflict state, resolve markers, stage, and continue merge.
- Symptom: `.git/index.lock` blocked Git operations.
  - Root cause: previous Git process crashed or was interrupted.
  - Fix: ensure no Git process is running, then remove `<workspace>/.git/index.lock`.
- Symptom: push rejected as non-fast-forward.
  - Root cause: remote branch had commits not present locally.
  - Fix: pull/merge first, resolve conflicts, then push.

## Request Editing / Execution
- Symptom: new request from plus button created file but UI did not update or replaced an open request.
  - Root cause: transient/new request state and tab activation paths were inconsistent.
  - Fix: ensure new request creates a distinct tab/document and refreshes active collection state.
- Symptom: running a pasted curl before saving failed with `Cannot set properties of undefined (setting 'req')` in `mergeScripts`.
  - Root cause: transient request lacked full collection/script structure expected by request preparation.
  - Fix: initialize missing script/request containers for unsaved transient requests.
- Symptom: closing app and choosing save for unsaved requests did not persist them.
  - Root cause: close/save path did not route transient documents through normal save.
  - Fix: save unsaved request documents to their collection before close completes.
- Symptom: `--data-urlencode` curl body imported without expected body params.
  - Fix: parse urlencoded curl data into body parameters.

## Search / Large Collections
- Symptom: sidebar search only found requests after opening a collection once.
  - Root cause: search operated on mounted in-memory collection trees only.
  - Current fix: when search text is non-empty, mount/open workspace collections and show `Loading collections for search...`.
- Symptom: search spinner never ended.
  - Root cause: pending open/mount tracking was not cleared correctly for search-triggered collection loads.
  - Fix: track opening/mounting paths in refs and clear them in `finally`.
- Symptom: large collection click caused lag and stale workspace display after switching workspaces.
  - Root cause: async load result from old workspace updated UI after active workspace changed.
  - Fix: scope large collection loading to active workspace.
- Symptom: moment warning with `_i: Infinity` while creating cookie strings.
  - Likely cause: cookie expiration/max-age parsing in `@usebruno/requests`.
  - Status: logged but no visible UI failure observed.

## Useful Commands
- State: `git status --short --branch`
- Recent history: `git log --oneline --decorate -8`
- Upstream review: `git fetch upstream && git log --oneline main..upstream/main`
- Upstream sync branch: `git switch main && git switch -c sync/bruno-YYYY-MM-DD`
- Search fast: `rg -n "<pattern>" <paths>`
- Whitespace check: `git diff --check`
- Focused lint: `npx eslint <files>`
- Renderer build: `npm run build:web`
- Electron syntax check: `node --check <file>`
