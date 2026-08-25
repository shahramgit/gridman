# Syncing Gridman with upstream Bruno

Companion to AGENTS.md. Read this BEFORE looking at an upstream release. It records
what we decided and why, so a sync does not re-litigate settled questions or
quietly undo a divergence we chose on purpose.

Last sync review: **upstream v4.1.0** (2026-08-20), reviewed 2026-08-25.
Previous: v4.0.0, v3.5.2 (reviewed, nothing adopted), v3.5.1, v3.4.2.

---

## The test for skipping something

**Never "no customer asked for it."** Gridman is Bruno PLUS our features, so every
public Bruno feature is in scope by default. The v4.0.0 review used the customer
test and got several calls wrong — Bruno Apps was filed as never-adopt with no
technical reason at all, and the AI stack was skipped on the same grounds (we
then built our own).

A skip needs one of these, and it has to be demonstrable:

1. **It conflicts with our architecture** — and say which part, with a number.
2. **It loses user data** — theirs, or ours if we adopted it.
3. **It is code we do not have** — a fix to a subsystem we deleted. Note that the
   FEATURE may still be worth building on our own architecture; "their patch is
   unusable" is not the same as "we do not want the behaviour."
4. **It is not a product feature** — dev tooling, branding, their telemetry.

Anything else: ask, or adopt.

## The standing position

**We do not merge upstream. We cherry-pick behaviour.**

Gridman is a hard fork with a rewritten sidebar, its own collection index, its own
search, and features upstream does not have (Workflows, in-app Trash, History,
the workspace Git panel, multi-format export). A merge drags in the parts of
upstream that solve problems we already solved differently, and it silently
reverts our divergences. Every sync so far has confirmed this: the value is
concentrated in a small number of bug fixes to code we still share, and the cost
is concentrated in whole subsystems we do not want.

So the unit of a sync is a FIX, not a commit range. Read the upstream commit,
understand the intent, implement it the way our code is written, and test it here.

## How to run a sync

1. `git fetch upstream --tags`
2. Find the real divergence point — **the release tags are not ancestors of our
   HEAD**. For v4.0.0 the merge-base was `462a39308`, not the `v3.5.2` tag. Use
   `git merge-base HEAD <tag>` and diff files against THAT when asking "did we
   change this file?" (`git diff $(git merge-base HEAD <tag>)..HEAD -- <file>`).
   Diffing against the tag reports our own committed work as upstream changes.
3. Expect a chunk of the range to be already in our tree under different SHAs
   (22 of 225 for v4.0.0) — check before "porting" something we already have.
4. Classify every change: adopt / adapt / conflict / ignore. Anything touching
   the systems in "Never adopt" below is a conflict by default.
5. **Do not trust upstream's changelog.** v4.0.0's release notes claimed secrets
   had moved out of `secrets.json` with automatic migration, and that the CLI
   gained AWS/Azure/Vault integrations. None of it was in the tag —
   `store/env-secrets.js` still created `new Store({ name: 'secrets' })`, and
   grepping for vault matched only the changelog markdown. Read the code.

## Where the value is

In descending order, from three syncs' experience:

- **Fixes to shared code we never touched** — network layer, filestore, bruno-js,
  converters, CLI. These are the cheap wins and they are usually real bugs.
- **Security fixes.** Always take these, always first.
- **Anything that silently loses user data**, especially on the yml side, which is
  our default format and half the customer's estate.
- **Windows path bugs.** Upstream is macOS-first; our users are Windows-only.
  Anything that splits on a literal `/` or compares raw pathnames is broken for
  them and upstream may not have noticed.

Where the value is NOT: upstream's new product surfaces, their performance work
(they are solving our problem again, differently and later), and anything in the
sidebar.

## Never adopt

Recorded so a future sync does not re-open them.

- **mount v2** — `services/mount/*`, `services/pool/*`, `services/storage/*`
  (node:sqlite file cache, workerpool). Upstream's answer to slow cold mounts.
  We solved it with the collection indexer: metadata-only, no full parse, no
  persistent cache to invalidate. Theirs is Beta and default-off even upstream.
  It also re-introduces `addDepth` over the hydrated tree, which AGENTS.md's
  Performance Rules forbid on O(N²) grounds.
- **The sidebar.** Phase 3a deleted the recursive render path; Phase 3b made
  search a filter over one indexed renderer. Upstream's sidebar work lands on
  files we no longer have. v4's #8577 was the feared collision and turned out to
  be inert — both files it edits are gone, and its one real fix (calling
  `canItemBeDropped` from the drop handler) we already have, with a multi-select
  rule upstream lacks. Mine these commits for INTENT only.
- **Snapshot / tab persistence** (`restoreTabs`, `syncTabUid`, SnapshotManager).
  We removed the subsystem; every upstream fix to it is a fix to code we deleted.
- **Scripted variables persisting to disk by default** (#8315, #8406). Upstream
  flipped `bru.setEnvVar` from opt-in `{persist:true}` to persist-by-default.
  This fights our architecture directly: every write fires our collection watcher
  and invalidates the search index. Keep the opt-in form.
- **Notifications / changelog / update surfaces.** Upstream v4 inverted
  notifications from pull-on-demand to a push from `appinfo.usebruno.com` on
  every window load. We read `GRIDMAN_INFO_ENDPOINT || BRUNO_INFO_ENDPOINT` with
  NO fallback, on purpose. Do not take `ipc/notifications.js`, the ChangelogTab,
  or `useChangelogOnUpdate`.
- **Branding, packaging identity, signing config.** Out of bounds per AGENTS.md.
  (`tool: 'notarytool'` in notarize.js is the one technically-neutral bit.)
- **The `.bru → .yml` collection migration.** Destructive and unbacked: it walks
  every `.bru`, writes a `.yml` sibling, `unlinkSync`s every original and deletes
  `bruno.json`. Upstream shipped v4.0.0 with its UI commented out. If we ever
  want this it must be Trash-backed and reversible, on our terms.
- **file mode** — raw text of every request on the tree payload, doubling it for
  11,700 files. Architecture conflict; still a no.
- ~~**"Bruno Apps"**~~ — RE-OPENED 2026-08-25. This was filed with no technical
  reason, which the corrected test above does not accept. See the v4.1.0 record.
- ~~**WebSocket multi-message**~~ — CLOSED 2026-08-25 in `86cedcdc8`, and both
  earlier notes were wrong. The first said we reverted it deliberately in
  `7c2b64731`; that is UPSTREAM's own revert (#7921 reverting #7719), which we
  inherited. The second said there was nothing to take; upstream re-landed the
  feature as `b9d8bdf2e` (#8115, 2026-06-08) and we do not have that commit.
  But the port was not needed: every layer here except the pane already handled
  a LIST — the `.bru` writer emits one `body:ws` block per message and parses
  them back (verified by round-trip), the yml writer emits a variant list, and
  `renderer:ws:start-connection` queues every entry in `body.ws`. Only
  `canClientSendMultipleMessages` was pinned to `false`, so a three-message
  request DISPLAYED one and SENT three. Fixed by making the flag true, not by
  taking #8115.
- **`plugins/remote-images`** — an rsbuild loader that downloads assets from a
  CloudFront CDN at build time. Our build must stay offline-capable.

## Deliberate divergences a sync must not undo

- `isItemARequest` in **bruno-converters** — we widened the type list and changed
  `!item.items` to "only a NON-EMPTY items array means not a request" (65ade78d2).
  Upstream still carries the bug. Re-taking their version silently breaks Postman
  export for every yml collection.
- **bruno-common `search-fold.ts`** — we split `foldSearchText` from
  `foldSearchTextWithMap`. v4's `src/index.ts` and `src/utils/index.ts` REPLACE
  the export block our entry points live in. Never take those two files wholesale.
- **bruno-converters `postman-to-bruno.js`** — diverged +327/-444. Port hunks,
  never the file.
- The response pane's large-response handling, the 50MB example cap, and lazy
  example matching.

## Watch list

- **Grammar forward-compatibility.** Our `.bru` ohm grammar is a whitelist:
  `BruFile = (meta | http | ...)*`, so an unknown top-level block is a hard parse
  failure of the WHOLE file, not an ignored block. v4 added `app { }`,
  `auth:akamai-edgegrid { }` and typed-variable annotations — all three verified
  failing against our parser. Because the customer's workspaces are shared git
  repos, one teammate running stock Bruno can make a file unreadable for
  everyone. Every future upstream release can add another block, so re-test this
  on each sync even if we adopt nothing else.
- **Upstream carries phantom workspaces** in v4.0.0's lockfile
  (`packages/bruno-pool`, `packages/bruno-storage`) that do not exist in the tag.
  Do not copy their lockfile.

## v4.0.0 record

225 commits, 613 files, +51k/−5k, 2026-07-13 → 2026-07-23. Classified 127
findings: 49 adopt, 32 adapt, 15 conflict, 31 ignore.

**What made it a major:** typed variable annotations and `@description` on rows
in the on-disk format; the (disabled) yml migration; mount v2; scripted-variable
persistence; the AI stack; Apps; EdgeGrid auth; WebSocket multi-message.
**Not** a toolchain major — Electron 37.6.1, React 19, rsbuild, rollup, RTK and
immer are byte-identical at both tags, and upstream never bumped package.json
(bruno-electron reads `2.0.0` at both). Everything risky ships default-off behind
`preferences.beta.*`.

**On the AI stack** (evaluated because our users are on a restricted network):
BYO-key, no account, no Bruno-hosted service, no paid tier, `ai.enabled: false`
by default, keys encrypted through the existing store, egress only to the
provider the user configures. Adoptable if ever wanted. Not adopted — no customer
need, and it is the bulk of v4 by line count.

**Taken in this sync** (see the commits that follow this file's creation):
forward-compat grammar tolerance; OAuth2 `state` validation (#8405 — the callback
accepted any code); bulk-editor description/uid preservation (a data-loss bug
that was OURS, not upstream's); yml `stringifyEnvironment` dropping non-string
values; yml gRPC keeping only the first message; the yml collection-root wipe;
env secrets hydrating onto the wrong variable (#8679); malformed files vanishing
from the tree (#8545); the runner `findLast` crash; the reducer crash on partial
items (#8558); Windows path bugs in RequestsNotLoaded and ApiSpecs; redirect
without `Location`; empty/disabled path params substituted into URLs; `encodeUrl`
running before the scheme; `bru.deleteEnvVar('__name__')`.


## v4.1.0 record

247 commits, 877 files, +58,948/−5,689, 2026-07-23 → 2026-08-20. Divergence point
unchanged (`462a39308`).

**Grammar forward-compat: CLEAR.** The `bruToJson.js` diff is pure `let`→`const`;
no new top-level blocks this cycle. Re-test next release regardless.

**Taken:**
- `#8380`/`#8893` cross-origin credential leak on redirect — a LIVE leak here,
  proven against real servers before the fix. Adapted, not copied: secure by
  default (upstream defaults to forwarding), and covers cookie plus
  credential-shaped custom headers, not just `authorization`.
- `#8815` collection-root and folder-level post-response vars dropped on
  opencollection import. Per-request was already correct; so is our native yml path.
- `#8461` `res.getHeader` made case-insensitive.
- `#8588` PAC `myIpAddress` no longer opens a socket to a public host.
- `#8977` a path outside the collection no longer yields phantom sidebar folders.

**Measured, then rejected: `bruno-sqlite`.** Re-measured 2026-08-25 against the
real GSB workspace (124 collections, 12,088 `.bru`, 210 MB) rather than a
synthetic tree, and the earlier "large win" framing was measuring a workload we
do not run.

Upstream needs a parse cache because it eagerly loads and parses whole
collections. We do not: `shouldUseIndexedCollectionLoad` (>100 files, >20 MB, or
any file >5 MB) puts every large collection on the lazy path, and collections
mount on demand. On GSB, 33 of 124 collections are lazy and they hold 9,733 of
the 12,088 files.

| on GSB's largest collection (1,192 files, 10.3 MB) | ms |
| --- | --- |
| index build — what actually runs when you open it | **29** (26 read + 3 regex) |
| full eager parse — what a cache would save | 2,339 (2,196 of it parse) |
| warm read of a JSON cache of that parse | 28 |

The 2,339 ms is real but unreachable for that collection: it is on the lazy
path. Whole-workspace figures are the same shape — index 421-827 ms, full parse
38.3 s. We pay the first and not the second, so a parse cache would buy roughly
nothing and cost ~220 MB on disk plus a staleness class of bug we do not have.

If one is ever built it is not SQLite. On the same real payload (Node 25.8.1):
JSON 43 ms write / 29 ms read / 10.7 MB; SQLite 69 / 24 / 11.4 MB. SQLite reads
marginally faster, writes 60% slower, is bigger on disk, and `node:sqlite` would
put a Node >=22.5 floor on the project. Its one genuine advantage is single-row
updates — a JSON cache rewrites the whole file on every save.

**Two things the measurement did surface, both ours, neither about caching:**

- `WorkerQueue.processQueue` (bruno-filestore) holds a single `isProcessing`
  boolean and one Worker per script path, so each size lane runs strictly one
  parse at a time. 1,067 of that collection's 1,192 files land in the same
  0.005 MB lane, and their parse cost (1,628 ms of the 2,213 ms total — the cost
  is per-file, not per-byte: the two files over 1 MB cost 25 ms between them)
  serializes through one thread with 1,067 postMessage round-trips.
  NOT changed, for the same reason the cache was not: nothing bursts through it.
  `parseRequestViaWorker` has three callers — the watcher's `add` (a burst only
  on the eager path, which is capped at 100 files), `renderer:load-request` (one
  request), and the yml migration (already a long batch job with progress). Make
  it concurrent only if a fourth caller appears, and note it needs a worker POOL
  or request-id correlation: the responses carry no id, so raising concurrency
  on the shared Worker would mismatch results to callers.
- `collection-indexer.js` read the FULL text of every file to extract five
  fields that are all inside the first 8 KB. DONE in `074ad47e9`, tiered: whole
  file to 64 KB, 8 KB head above. 34 MB of I/O per full scan instead of 210 MB.
  **Do not quote the 6x as a speedup.** Measured end to end through the real
  indexer over all 122 GSB collections: 1,755 ms -> 1,601 ms, 9%, because the
  page cache makes the read the small part and readdir + regex + uid + IPC are
  the rest. The 6x is bytes, and the case for it is Windows, where Defender
  charges per file and per byte — unverified from here. Cost: 47 of 5,410
  example-bearing files lose the sidebar chevron until the request is opened.

**Deferred, not rejected:** mock server (69 files ADDED, zero collisions with our
divergences — genuinely additive, but 8 of its own fixes shipped in the same
release, so take it one release later and port it once).

**Still open:** sidebar-state persistence (build ours), yml migration entry point
(their UI, our reversible engine), presets restyle, `#8722` folder sequencing
(needs adapting to our diverged sidebar), `#8733` secrets env table (cosmetic —
an empty placeholder row inherits `secret`). Bruno Apps was on this list; it is
resolved, see below.

**Closed by re-verification, not by work:** the old backlog carried "yml writer
gaps — request.auth, meta.seq, ws/grpc message names, assertions". Re-tested
2026-08-25 by round-tripping a `.bru` request with bearer auth, `seq: 7`, two
assertions and a pre-request var through `stringifyRequest`/`parseRequest`, and
a two-message gRPC request through the same: every field survives. The
migration work fixed these; the note was stale.

**Prompt-vs-runtime drift is its own bug class.** Fixed in `4f95fcc47`: the AI
prompt taught `bru.ctx.runRequest` (no `bru.ctx` on either sandbox — it is
`bru.runRequest`), `bru.getSecretVar` and `bru.visualize` (neither exists on the
Bru class, here or upstream). Every script the model wrote for those tasks threw
on the first line. `tests/ai/prompt-api-exists.spec.js` now resolves every
`bru.<path>(` the model is shown against a real Bru instance, covering both
chat-prompts.js and chat.js's tool descriptions. Related and NOT fixed: the
quickjs shim exposes `visualize` and `getSecretVar` handles that call those same
missing methods, so hand-written scripts hit it too — upstream's bug, needs a
decision.

**Known defect this review surfaced — FIXED in `5738bb47a`.** Our AI's
`CONTENT_TYPES` included `'app'` and carried a full Apps system prompt, but
Gridman has no Apps feature — no `appEnabled`, no app tab. An accepted "Apply" on
an app diff hit `default: return` and silently did nothing: a change the user
approved, dropped. Stripped rather than adopted, because stripping is reversible
in an afternoon and adopting Apps is not.

To restore it if Bruno Apps is ever adopted, put back, in
`packages/bruno-electron/src/ipc/ai/chat-prompts.js`: `'app'` in `CONTENT_TYPES`,
the `app` entry in `SYSTEM_PROMPTS` (upstream's `chat-prompts.js` still has the
text), and the two `TOOL_LABELS` rows. In `chat.js`: the `'App Code'` label. Then
add the `case 'app':` arm to the three `switch (targetType)` blocks in
`AiChatSidebar/index.js` and the label in its `constants.js` — the new
`content-type-contract.spec.js` fails until all three switches have it, which is
the point of it.
