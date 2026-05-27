# Agent Rules

## Scope
- This repository is Gridman, a Bruno-derived Electron/API-client app.
- Preserve Bruno history and attribution. Keep upstream Bruno as read-only.
- Prefer small, reviewable changes that match existing Bruno/Gridman patterns.

## Coding Conventions
- Use existing React, Redux, Electron IPC, and Node CommonJS patterns in nearby files.
- Keep package/folder names such as `packages/bruno-app` unless doing a planned high-risk rename.
- Use ASCII in source/docs unless the existing file or user data requires Unicode.
- Use `rg`/`rg --files` for search.
- Use `apply_patch` for manual edits.
- Do not add broad abstractions unless they reduce real duplication or match existing architecture.
- Keep Gridman user-facing text branded as Gridman. Bruno can remain in internal package names and format compatibility terms.

## Branch Strategy
- Default new work branches: `codex/<short-topic>`.
- Main product branch: `main`.
- Public remote: `origin = git@github.com-shahramgit:shahramgit/gridman.git`.
- Internal mirror: `vasl = ssh://git@codebase.vaslapp.com:8081/development/service-management/products/gridman.git`.
- Bruno upstream: `upstream = https://github.com/usebruno/bruno.git`, push URL disabled.
- Do not merge feature branches into `main` unless the user approves.
- Never push unless the user explicitly asks.
- Selectively cherry-pick useful Bruno upstream changes on a `sync/*` branch; do not merge upstream directly into `main` without testing.

## Updating From Bruno Upstream
- Use Bruno as a source of selected fixes, not as an automatic merge target.
- Standard workflow:
  ```sh
  git fetch upstream
  git switch main
  git switch -c sync/bruno-YYYY-MM-DD
  git log --oneline main..upstream/main
  git cherry-pick <useful-upstream-commit>
  git diff --check
  npm run build:web
  ```
- Prefer upstream commits for security, compatibility, build, dependency, and clear bug fixes.
- Avoid upstream commits that reintroduce Bruno cloud/pricing, hidden default workspace behavior, external collection links, or collection-level Git as the primary model.
- Merge a `sync/*` branch into `main` only after manual testing and user approval.

## Commit Rules
- Commit only intentional project changes. Do not commit generated release artifacts.
- Let normal hooks run; avoid `--no-verify`.
- Preferred style: concise conventional messages, e.g. `fix(search): broaden sidebar collection search`.
- Before commit, check `git status --short --branch` and avoid staging unrelated user changes.

## Testing Expectations
- For frontend changes:
  - focused lint: `npx eslint <changed-js-files>`
  - build smoke: `npm run build:web`
- For Electron/main process changes:
  - syntax check touched CommonJS files with `node --check <file>`
  - run `npm run dev` for manual smoke when behavior depends on IPC/filesystem.
- For release/build changes:
  - `npm run build:web`
  - platform build as needed: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac`, `npm run build:electron:win`, `npm run build:electron:linux`.
- Always run `git diff --check` before committing.

## Forbidden Operations
- Do not run destructive git commands (`git reset --hard`, `git checkout -- <file>`, force-push) unless explicitly requested.
- Do not revert user changes you did not make.
- Do not push to `upstream`.
- Do not reintroduce hidden/default workspace behavior.
- Do not allow persistent external collection links.
- Do not commit environments/secrets or release output directories.

## Deployment And Release Restrictions
- Releases are manual until CI signing/release automation is intentionally added.
- Release assets are staged under ignored `releases/<version>/`.
- Upload only final installers/runtime files: `.dmg`, `.exe`, `.AppImage`.
- Do not upload unpacked folders, `.blockmap`, `.yml`, `.7z`, or intermediates unless auto-update support is designed.
- macOS builds are currently unsigned; release notes should include:
  `sudo xattr -dr com.apple.quarantine "/Applications/Gridman.app"`.

## Architecture Constraints
- Gridman is workspace-only:
  - every workspace is a normal visible folder;
  - every collection lives under `<workspace>/collections/<collection-folder>`;
  - `workspace.yml` stores relative collection entries;
  - Git runs at the workspace root.
- Opening/importing a collection copies it into the active workspace; it must not link to external folders.
- Deleting a collection deletes its owned folder from disk.
- Environment files must not be committed by Gridman Git operations.
- Git UI is workspace-level only; hide/avoid upstream Bruno collection-level Git assumptions.
- Very large collections must be loaded asynchronously and scoped to the active workspace to avoid stale UI updates.

## Run / Build / Test
- First setup: `npm run setup`
- Dev app: `npm run dev`
- Renderer only: `npm run dev:web`
- Build renderer: `npm run build:web`
- Build all/current Electron targets: `npm run build:electron`
- Platform builds:
  - macOS: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac`
  - Windows: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:win`
  - Linux ARM64: `npm run build:electron:linux`
  - Linux x64: from `packages/bruno-electron`, run `npx electron-builder --linux AppImage --x64 --config electron-builder-config.js`
- Release helper: `scripts/github-release.sh <version> [--upload]`
