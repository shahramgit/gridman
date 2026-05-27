# Decisions

## Rebrand Bruno-Derived App As Gridman
- Decision: publish as Gridman while preserving Bruno MIT attribution/history.
- Why: the product diverged materially in workspace and Git behavior.
- Rejected: keep Bruno branding; full internal package rename now.
- Consequences: public docs/UI/assets use Gridman; internal package names may still reference Bruno until a separate refactor.

## Workspace-Only Model
- Decision: remove hidden/default workspace behavior and make every workspace a normal visible folder.
- Why: hidden default state caused separate workspace lists, migration ambiguity, and Git edge cases.
- Rejected: migrate old Bruno/default workspace data automatically.
- Consequences: old data remains untouched; new Gridman installs use `~/Documents/gridman/My Workspace`.

## Workspace-Owned Collections Only
- Decision: collections must live inside `<workspace>/collections/`; opening/importing copies into the workspace.
- Why: Git-at-workspace-root needs a single ownership boundary.
- Rejected: persistent external collection links.
- Consequences: simpler Git behavior and deletion semantics; users cannot share one collection folder by reference across workspaces.

## Workspace-Level Git
- Decision: Git is tied to the workspace root, not individual collections.
- Why: workspace is the unit of collaboration and sync.
- Rejected: upstream Bruno collection-level Git UI as the primary model.
- Consequences: all collection folders and workspace metadata share one repo; environments are excluded for safety.

## Exclude Environments From Gridman Git Commits
- Decision: do not commit environment files through Gridman Git automation.
- Why: environments may contain passwords, tokens, and confidential values.
- Rejected: commit all workspace files by default.
- Consequences: users must handle intentional environment sharing separately.

## Git Sync Semantics
- Decision: split actions into refresh/fetch/pull/push/sync committed/sync full.
- Why: users need both explicit Git operations and a safer one-button flow.
- Rejected: one ambiguous "Sync" button.
- Consequences: more UI surface, but behavior is clearer.

## Public Repository Strategy
- Decision: use a new public GitHub repo `shahramgit/gridman`, keep Bruno upstream read-only, and mirror to VASL.
- Why: preserve history and allow selective upstream updates without pushing to Bruno.
- Rejected: fork-only model; squash import.
- Consequences: branch/remotes require care; upstream updates should be cherry-picked or tested on `sync/*` branches.

## Bruno Upstream Update Policy
- Decision: update Gridman from Bruno through reviewed `sync/*` branches and selective cherry-picks.
- Why: Gridman intentionally diverged in workspace/storage/Git UX; direct upstream merges can undo product decisions.
- Rejected: automatic merging from `upstream/main`.
- Consequences: upstream fixes remain available, but each imported change needs review for Gridman assumptions.

## Bruno 3.4 Upstream Sync Guardrails
- Decision: do not adopt Bruno collection-level Git as-is; adapt only if it fits Gridman's workspace-level Git model.
- Decision: reject Bruno hidden/default workspace behavior. Gridman removed it because it created too much product and code complexity.
- Decision: keep collection open/import semantics as copy-into-active-workspace; reject persistent external collection links.
- Decision: keep Gridman identity in metadata, assets, docs, UI, and release behavior while preserving Bruno attribution/history.
- Decision: preserve Gridman's large-collection active-workspace scoping fix unless upstream has an equivalent or better fix after review.
- Decision: compare Bruno sidebar/search changes against Gridman's broadened sidebar search and reapply only compatible improvements.
- Why: Bruno 3.4 contains useful runtime, import, editor, OpenAPI, and test improvements, but also touches areas where Gridman intentionally diverges.
- Rejected: direct merge of Bruno 3.4/upstream `main` into Gridman.
- Consequences: sync work should be cherry-picked or manually ported in small groups, with special review for workspace, collection, Git, identity, and search files.

## Release Strategy
- Decision: manual release artifact staging/upload for now.
- Why: signing and cross-platform automation are not fully configured.
- Rejected: immediate full CI release pipeline.
- Consequences: `packages/bruno-electron/out` must be staged into `releases/<version>/`; GitHub CLI upload is documented.

## Sidebar Search
- Decision: broaden sidebar search by mounting unopened workspace collections when search starts.
- Why: users expect workspace search to find not-yet-opened collections.
- Rejected: a separate backend search IPC after it caused collection-opening regressions.
- Consequences: first search in a large workspace can be heavier; behavior is simpler and matches visible sidebar data.

## Large Collection Loading
- Decision: keep large collection loading scoped to the active workspace and avoid applying stale async results after workspace switches.
- Why: large collections previously caused UI lag and stale/empty workspace displays.
- Rejected: synchronous/blocking full collection load.
- Consequences: better responsiveness; still needs long-term indexing for very large workspaces.
