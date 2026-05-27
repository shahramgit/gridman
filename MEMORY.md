# Project Memory

## Project Identity
- Gridman is an MIT-licensed, Bruno-derived desktop API client.
- Public repo: `github.com/shahramgit/gridman`.
- Internal mirror: `codebase.vaslapp.com/development/service-management/products/gridman`.
- Bruno upstream is retained for history/attribution and selective updates.
- Current app version line used in this session: `3.3.0-vasl.2`.
- Remote model:
  - `origin`: public GitHub Gridman repo.
  - `vasl`: internal VASL mirror.
  - `upstream`: Bruno source, read-only.

## Architecture
- Monorepo with npm workspaces:
  - `packages/bruno-app`: React/Rsbuild renderer.
  - `packages/bruno-electron`: Electron main process, IPC, filesystem, Git integration, packaging.
  - shared packages include common, requests, filestore, converters, schema, query, lang/js.
- Renderer talks to filesystem/Git/network features through Electron IPC.
- Full functionality requires Electron; browser-only renderer mode cannot exercise workspace/Git/file features.
- Preferences and runtime data use app support under `~/Library/Application Support/Gridman` on macOS.

## Workspace And Collection Model
- Gridman intentionally removed Bruno's hidden special default workspace model.
- First launch should create/open a normal workspace at `~/Documents/gridman/My Workspace`.
- `general.defaultLocation` is only a parent directory for new workspaces, not a hidden workspace.
- Collections are workspace-owned and must live under `<workspace>/collections/`.
- `workspace.yml` should store relative collection paths, preferably collection-folder names normalized by helpers; absolute/outside paths are invalid.
- Import/open collection flows copy the collection into the active workspace rather than linking to the original folder.
- Collection delete removes the folder from disk because the workspace owns it.
- Orphan collection folders inside `<workspace>/collections/` can be added to `workspace.yml` or deleted from disk.

## Git Behavior
- Git is workspace-level. Repository root is the workspace folder.
- Supported UI actions include init, set/change origin, fetch, pull, push, refresh status, commit, sync committed, sync full, conflict continue/abort, and orphan folder actions.
- "Sync committed" syncs existing commits; "Sync full" stages/commits allowed local changes before syncing.
- Environments are intentionally excluded from Gridman Git commits because they may contain secrets.
- Remote URLs are shown copyable/clickable, with SSH URLs converted to an HTTPS browser URL when possible.
- On Windows, Git may fail with `spawn git ENOENT`; users need Git installed and available on PATH.
- On Windows with very long collection paths, enable OS/Git long paths:
  - PowerShell admin: `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force`
  - `git config --system core.longpaths true`

## Security And Authentication
- Electron safe storage/keychain prompts can appear when cookies/secrets are accessed. Accepting allows encrypted storage; denial may fall back to unencrypted cookie behavior.
- Git HTTPS credentials and SSH keys should be handled by system Git/credential helpers where possible.
- Do not persist Git passwords in plain text.
- Do not commit environments, `.env*`, or sensitive local data.
- The app supports inspection tools for selected text, including base64/image preview, JWT decode, and URL encode/decode.

## Build And Release Knowledge
- `packages/bruno-electron/out` is overwritten by platform builds; copy final artifacts to `releases/<version>/` between builds.
- Linux x64 AppImage is named with `x86_64`, not `x64`.
- GitHub release helper: `scripts/github-release.sh <version> --repo shahramgit/gridman --upload`.
- macOS builds are unsigned unless signing/notarization is configured.
- Public release docs live in `docs/github-release.md`; local build docs in `docs/local-installation-and-build.md`.

## Bruno Upstream Update Policy
- Fetch Bruno with `git fetch upstream`.
- Create a short-lived `sync/bruno-YYYY-MM-DD` branch from `main`.
- Review `git log --oneline main..upstream/main`.
- Cherry-pick only useful upstream commits.
- Run `git diff --check` and `npm run build:web`; run deeper Electron tests for IPC/build changes.
- Do not let upstream reintroduce Bruno cloud/pricing/default-workspace/external-collection/collection-Git assumptions.

## Recurring Pitfalls
- Bruno package names and `.bru`/OpenCollection compatibility names remain in internals; do not blindly rename all `bruno` strings.
- Avoid reintroducing collection-level Git UI from upstream Bruno.
- Large collection loading can race with workspace switching; all async collection load results must be scoped to the active workspace.
- Sidebar search historically only searched loaded/opened collections. Current approach mounts unopened workspace collections on first search.
- Merge conflicts in `workspace.yml` can break YAML parsing and leave UI stale until conflict resolution and reload.
- Pulling into a workspace with untracked files that overlap remote files needs preflight/autocommit/backup handling; Git otherwise aborts before a merge conflict is created.

## Infra Assumptions
- No Kubernetes, Docker, MongoDB, Redis, HAProxy, or GitLab runtime infrastructure is used by this desktop app in the current project scope.
- Git remotes may include GitHub and internal VASL Git over SSH.
