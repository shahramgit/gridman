# AI (main process)

Bring-your-own-key AI assistance. There is no Gridman-hosted service, no
account, and no paid tier — every request goes from this machine straight to
the provider the user configured.

## Default off

Nothing here contacts the network until the user explicitly configures **and**
enables a provider. A fresh install makes zero AI requests.

| Switch                                        | Default |
| --------------------------------------------- | ------- |
| `ai.enabled`                                  | `false` |
| `ai.providers.openai.enabled`                 | `false` |
| `ai.providers.anthropic.enabled`              | `false` |
| `ai.openaiCompatibleEndpoints[].enabled`      | `false` |

`ai.autocomplete.*` still exists in the preferences schema and in the
Preferences > AI pane, but it now controls nothing in this module: the
ghost-text surface it gated was removed (see below). Those two files are owned
by another workstream; the leftover toggle is inert, not a second switch.

The gate is enforced in two independent places:

- `providers.js` — `getModel`, `getAvailableModels` and `validateApiKeyForProvider`
  all refuse unless `ai.enabled === true`. This module is the only one that can
  construct a model client or reach a provider, so the property holds even if a
  caller forgets to check.
- `index.js` — every IPC handler re-checks on each call.

### Why the IPC registers unconditionally

Handlers are registered at startup regardless of `ai.enabled`, and each one
refuses early instead. Preferences are mutable at runtime: conditional
registration would require an app restart to enable AI, and would not help on
the disable path (the handlers are already registered by then, so you would
need explicit teardown anyway). Refusing per call is a gate that cannot go
stale. `renderer:get-ai-status` is the one handler that answers while disabled —
it reads local config only and never constructs a provider. Every other channel,
including writing and clearing an API key, refuses while the feature is off, so
the rule has no exception to remember.

### The channel list is the security boundary

`preload.js` has no channel allowlist, so anything registered here is reachable
from any renderer code that can call `ipcRenderer`. `tests/ai/ipc-gate.spec.js`
pins the surface on **two** axes:

1. the registered set matches the intended list **exactly** — a new channel
   fails until someone adds it to the list on purpose; and
2. **every channel on that list has a caller in `packages/bruno-app/src`**
   (non-spec files only). Editing the intended list is not enough to satisfy
   this; the renderer has to actually send on the channel.

Axis 2 exists because axis 1 alone did not catch anything: the ghost-text pair
was *on* the intended list and still had no caller.

| invoke | send |
| ------ | ---- |
| `renderer:get-ai-status`, `renderer:set-ai-api-key`, `renderer:clear-ai-api-key`, `renderer:get-ai-api-key`, `renderer:ai-test-provider` | `renderer:ai-chat-stream`, `renderer:ai-chat-stop` |

Six channels were **removed** rather than hardened, and are named individually
in that suite so a revert fails with the channel in the message:

- `renderer:ai-generate-text` and `renderer:ai-stream-text` took `system` /
  `prompt` / `messages` straight from the renderer and handed them to
  `generateText` / `streamText` with no redaction at all — and had no caller
  anywhere in `bruno-app`. An unredacted passthrough to a model provider with
  zero callers is pure risk: a future renderer bug reaches it and nothing
  notices, because nothing uses it.
- `renderer:ai-generate-script` and its `script-prompts.js` module served the
  AIAssist sparkle component, which was imported by nothing outside its own
  directory and was cut from the renderer in the same change.
- `renderer:ai-stop-stream` existed only to abort those.
- `renderer:ai-autocomplete` and `renderer:ai-autocomplete-cancel` — the
  ghost-text pair, removed for the same reason and one more. They reached
  `generateText` with `prefix` / `suffix` / `requestContext` / `variableNames`
  / `siblingScripts`, and had no caller in `packages/bruno-app/src`. Worse than
  the passthroughs: because nothing reached them through
  `providers/ReduxStore/slices/ai.js`, nothing sent that way ever met the
  RENDERER's outbound gate, so their redaction was main-process-only. Gone with
  `autocomplete.js`, `autocomplete-prompts.js`, their specs, and
  `context.formatRequestContextCompact` — the formatter they were the only
  caller of.

What ships is the chat panel and the Preferences pane. Chat assembles its own
prompt in the main process from structured context that goes through the
chokepoint below; the renderer never supplies a raw `system` / `prompt`
string.

## Using an internal / self-hosted model

The `openai-compatible:` provider is a first-class citizen, not a fallback. Users
on restricted networks — where `api.openai.com` is blocked or unacceptable — can
point Gridman at a model on their own network.

Add an entry to `ai.openaiCompatibleEndpoints`:

```jsonc
{
  "id": "corp-llm",                              // stable id; may contain dots
  "name": "Corp LLM",                            // shown in the UI
  "baseURL": "https://llm.corp.internal/v1",     // OpenAI-compatible base URL
  "enabled": true,                               // per-endpoint opt-in
  "models": [
    { "id": "corp-qwen", "label": "Qwen 2.5 Coder", "modelId": "qwen2.5-coder-32b" }
  ]
}
```

### Model ids are namespaced by endpoint

The id a custom model is known by everywhere outside `preferences.json` is

```
openai-compatible:<endpointId>::<model.id>     e.g. openai-compatible:corp-llm::corp-qwen
```

This is a security property, not tidiness. Users proxying an internal model
through their gateway name it after the model it imitates — `gpt-4o` is the
obvious choice — and a bare id would then collide with the built-in catalog. The
old lookup consulted the built-ins first, so such a model was *listed* under the
internal endpoint and *resolved* to `api.openai.com`. No built-in id can start
with `openai-compatible:`, so the two sets cannot intersect.

Resolution is endpoint-first as well: even a bare id that names a custom model
resolves to that endpoint. A bare id claimed by two endpoints is refused
outright rather than falling through to a built-in, and an endpoint id
containing `::` is rejected by `savePreferences` and ignored here.

Per-model enable toggles are honoured under either the namespaced id or the bare
one the endpoint editor writes; either saying `false` disables the model.

**Known limitation, deliberate.** A bare id is ambiguous — the Preferences
endpoint card keys its checkbox on the raw model id, so
`ai.models["gpt-4o"].enabled = false` could mean the built-in or the
identically-named model on an internal endpoint. It disables **both**. Fail
closed: a toggle is a restriction, and the cost of guessing the other way is
offering a model the user switched off, potentially the cloud one. Disable or
enable precisely by using the namespaced id
(`openai-compatible:corp-llm::gpt-4o`), which never affects the built-in. Pinned
by `tests/ai/model-namespacing.spec.js`.

That is **enough on its own**. No OpenAI or Anthropic key needs to exist:

- The API key is **optional**. Internal gateways commonly authenticate by
  network position. `listProviders` reports `requiresApiKey: false` for these
  entries so the UI can render the key field as optional, and `getAvailableModels`
  does not filter them out for want of a key.
- A key *can* still be set (`renderer:set-ai-api-key` with
  `providerId: "openai-compatible:corp-llm"`); it is encrypted at rest like any
  other.
- The endpoint may be enabled either by its own `enabled` flag or by
  `ai.providers["openai-compatible:<id>"].enabled`. Both default to false.
- An endpoint with no `baseURL` is refused rather than used, because
  `createOpenAI` would otherwise silently default to `https://api.openai.com/v1`
   — exactly the egress this path exists to avoid.

### The keyless bearer placeholder

When no key is configured we pass `NO_KEY_PLACEHOLDER` as the API key rather
than leaving it unset. `@ai-sdk/openai`'s `loadApiKey` throws when `apiKey` is
undefined **and** falls back to `process.env.OPENAI_API_KEY` — which would ship
the user's OpenAI key to their internal host. Pinning a placeholder makes both
outcomes impossible.

Provider reachability checks (`validateApiKeyForProvider`) send **the same**
`Authorization: Bearer <key-or-placeholder>` the SDK will send. They used to
send no header at all for a keyless endpoint, so the Test button answered a
different question than generation: it could pass against a gateway that then
rejected every real request, or fail against one that would have accepted them.
Whatever the gateway does, it now does the same thing to both.

## Secrets

- Keys live in `store/ai-keys.js`, encrypted through the existing
  `utils/encryption`. They never appear in `preferences.json`, never in a
  collection file, and are never logged — error paths log the message and the
  provider id only.
- `savePreferences` has three locks against a key reaching `preferences.json`:
  the Yup schema **rejects** unknown keys anywhere under `ai` (and pins
  `ai.providers` / `ai.models` entries to a lone `enabled` boolean, so a
  credential has nowhere to sit); `stripAiEndpointCredentials` then walks
  the whole `ai` subtree deleting credential-named scalars (it used to look at
  the top level of each endpoint entry only, so `ai.apiKey` and
  `ai.providers.openai.apiKey` reached disk in the clear); and the **top-level**
  schema is `noUnknown` too, so a key one level above `ai` cannot ride through
  either.
- The top level **strips** where `ai` **rejects**, on purpose. `ai` is a subtree
  this fork owns entirely, so refusing a surprise key there costs nothing. At
  the top level a single legacy or third-party key — an older Bruno, another
  fork, a hand-edit — would make *every* preferences save fail, including the
  user's ability to turn AI off. Stripping keeps the credential off disk without
  that failure mode. `_migrations` is declared so migrations do not re-run.
- Keys are **write-only across IPC**. `renderer:get-ai-api-key` returns an empty
  string always — with AI on, with AI off, and with a key sitting in the store.
  Whether a key exists is reported by `renderer:get-ai-status` as
  `providers[id].configured`, which is what the Preferences cards render; the
  edit field simply starts empty. Writing and clearing a key both refuse while
  `ai.enabled` is false.
- Provider ids may contain `.` and `:`, so the key store reads and writes the
  whole `keys` map instead of using electron-store dot-paths.
- Failures log a description only — never the error object and never its
  message. The AI SDK's `APICallError` carries `requestBodyValues`, i.e. the
  entire assembled prompt, and provider error messages echo the request body.
  See `errors.js`.

## Redaction

### The chokepoint

`context.js` owns outbound formatting, and it is a chokepoint by construction
rather than by convention. Every formatter it exposes — and every formatter in
the prompt modules beside it — is wrapped in `context.outbound()`, which does
two things: it runs a final `redactUrl` pass over the produced string, and it
tags the function so a test can enumerate them.

This shape exists because the previous round did not hold. URL redaction was
wired into `formatRequestContext` and **three other emitters kept printing URLs
verbatim**: the collection preview inlined into every chat message (no tool call
needed — the common path), the `list_requests` / `search_requests` tool results,
and a private second copy of the request formatter inside
`autocomplete-prompts.js` that had independently reproduced two already-closed
findings. A redaction call that each new call site has to remember is not a
rule; here the default is redacted and bypassing it takes deliberate work.

`tests/ai/outbound-chokepoint.spec.js` enforces it three ways:

1. every `format*` export must be `outbound()`-wrapped;
2. every one must have a known-secret fixture — a **new formatter with no
   fixture fails the suite**, so the table cannot fall behind;
3. every fixture's output, from a payload with a credential in every field,
   must contain none of them, under strict preferences *and* with every toggle
   off.

`tests/ai/prompt-assembly.spec.js` then asserts the same over the one string
this app actually sends (chat `buildContextMessage`), which covers private
helpers that no enumeration can see. A source scan in the chokepoint suite requires every `${…url…}`
interpolation under `src/ipc/ai/` to go through `redactUrl` or carry a
`NOT-OUTBOUND` annotation with a reason.

### What it strips

It strips

- sensitive headers and query/path params (`authorization`, `cookie`,
  `x-api-key`, `x-auth-token`, `x-access-token`, `x-csrf-token`, anything
  matching `/token/i`, `/secret/i`, `/password/i`, …),
- **`X-WSSE`** — a fork-specific addition. Our network layer emits it for the
  WSSE auth mode and its value carries a `PasswordDigest` and `Nonce`. None of
  upstream's patterns match that name, so without it a WSSE-authenticated
  request would leak its credential,
- values under sensitive keys inside JSON / form / GraphQL-variable bodies,
- response body values (keys and types survive, values become `<string>`,
  `<number>`, … placeholders),
- any variable with `secret: true`, plus name-pattern matches and the user's
  `customRedactedVariables` list,
- and, on top of every name-based rule above, any **value** that is itself
  credential-shaped — see the next-but-one section.

### The request URL, in every part of it

A credential has been observed in every component of a URL, so every component
is covered. Host, path names and non-secret parameters stay readable — the model
needs them to write code.

| Component | Rule |
| --------- | ---- |
| userinfo  | `https://alice:hunter2@host` → password masked. The scheme is optional, so `alice:hunter2@host/v1` is covered too. A bare `alice@host` carries no secret and is left alone. |
| path      | credential-**shaped** segments masked (see below): `/services/T0/B0/sk-live-…` |
| query     | masked by parameter NAME (the same rules as the headers table) **and** by credential-shaped VALUE, so `?t=eyJhbGci…` is caught under an innocuous name. `&` and `;` are both separators — splitting on `&` alone left `?a=1;api_key=SECRET` untouched. |
| fragment  | parsed the same way as the query. `#access_token=…` is the OAuth2 implicit-grant callback, the single most common way a real credential rides in a URL, and it used to be copied through verbatim. A bare `#sk-live-…` is caught too. |

The redaction is string-based on purpose — a Bruno URL is normally
`{{baseUrl}}/v1/users?api_key={{key}}`, which `new URL()` rejects outright, and a
parser that throws on the common case redacts nothing. It is also idempotent,
which is what lets the chokepoint run it over already-redacted text.

### The credential-shape detector, and what it does not catch

Some credentials carry no name to match on — the Slack-webhook shape puts one in
a path segment, and `X-Trace-Id: sk-live-…` puts one under a header name no
pattern will ever match. Redacting whole paths or whole header tables would gut
the feature, so a deliberately conservative shape test runs per token instead.

**Where it runs.** On VALUES and on NAMES, everywhere, which is the fix for two
successive asymmetries. First it ran on URL components *only*, so the identical
credential was masked inside the URL string and printed verbatim one line below
it in the tables. Then it ran on every value but no name, so a credential
sitting in a key went out untouched — see "Keys are data too" below.

| Channel | Value shape-tested | Name/key shape-tested |
| ------- | ------------------ | --------------------- |
| URL path segments, query values, fragment tokens | yes | yes (query/fragment param names) |
| header table | yes | yes |
| query / path parameter tables | yes | yes |
| `formUrlEncoded` / `multipartForm` fields | yes | yes |
| JSON body leaves, GraphQL variables | yes | yes |
| response body — placeholders, and real values when `redactResponse` is off | yes | yes |
| variables (`list`/`search_variables`) | yes | yes |
| the verbatim channels two sections down — docs, the user's own code, GraphQL query text, request names and file paths | **no** | **no** |

### Keys are data too

Every rule in `context.js` used to run on one side of the name/value split. A
value was masked when its NAME looked sensitive (`isSensitiveKey`) and again
when its own SHAPE looked like a credential (`maskCredentialShapedValue`) — and
then the name itself was copied through verbatim, at every emitter. A JSON
object's field names are chosen by whoever produced the body, so this reached
the model on the strictest setting, in the mode whose own notice promises that
no real data is shown:

```
responseData = { "sk-live-AAAABBBBCCCCDDDD": { seen: 1 } }

**Response Shape (values redacted — … no real data is shown):**
{ "sk-live-AAAABBBBCCCCDDDD": { "seen": "<number>" } }
```

`maskCredentialShapedName` closes it, using the SAME detector as the value side
so there is one definition of "credential-shaped" and one place to fix it.
Three properties worth knowing:

- **Policy still sees the original key.** Only the printed text is masked;
  `isSensitiveKey` / `isSensitiveHeader` are asked about the key as it arrived,
  or `<redacted>` would become the name every rule matches against.
- **Masked keys do not collide.** Two different credential-shaped keys would
  both become `<redacted>` and the second would silently overwrite the first —
  redaction turning into data loss. Repeats are numbered (`<redacted> 2`).
- **Non-ASCII names are never flagged.** The detector's charset test is ASCII
  only, so a Persian, Arabic or CJK field name cannot be masked whatever its
  length or entropy.

The cost, stated: an ordinary field name that is long, mixed-case and carries a
digit — `userAuthenticationToken12345` — is masked too, and the model loses it.
That is the same fail-closed direction this module already takes for UUIDs and
object ids.

The renderer has its own gate (`providers/ReduxStore/slices/ai.js`,
`scrubAiOutbound`) which still copies keys verbatim. It is defence in depth in
front of this one, not instead of it: nothing reaches a provider except through
`context.js`, and that file is owned by a different workstream. Flagged there
rather than patched from here.
| `text` / `xml` / `sparql` bodies and unparseable JSON | n/a — withheld whole, see "Bodies fail closed" |

A value is split on whitespace, `,` and `;` and each token is tested on its own,
because the canonical shape is `Bearer sk-live-…` — which fails the charset test
as a single string. One credential-shaped token masks the **whole** value.

A token is treated as a credential when **either**:

- **(a)** it carries a well-known prefix — `sk-`, `sk_`, `rk_live`, `pk_live`,
  `gh[pousr]_`, `github_pat_`, `glpat-`, `xox[abposr]`, `xapp-`,
  `AKIA` / `ASIA` / `ABIA` / `ACCA`, `AIza`, `ya29.`, `eyJ` (the base64 of a
  JSON header, i.e. a JWT), `hf_`, `npm_`, `dckr_pat_`, `shpat_`,
  `sq0atp-` / `sq0csp-`; **or**
- **(b)** it is >= 24 characters, drawn only from the URL-safe token charset,
  not word-like, and high-entropy: mixed case or letters+digits at >= 3.0
  bits/char, 32+ hex characters, or >= 4.0 bits/char outright.

"Not word-like" splits on separators *and* camelCase humps and requires an
average word length of >= 3, so `GetUserProfileByIdentifier` and
`reports-quarterly-summary-2024` stay readable while `AbCdEfGhIjKlMnOpQrStUvWx`
does not hide behind alternating case.

**Stated limits — a customer on a restricted network should know these:**

- A short credential with no recognisable prefix (an 8-digit PIN, a numeric
  account id used as a bearer) is **not** detected. Nothing distinguishes it
  from an order id, and flagging every short segment would redact every URL in
  the collection.
- A long all-lowercase-alphabetic secret is caught only above 4.0 bits/char,
  because that is also the shape of a slug.
- Conversely, opaque ids that are **not** secrets — a UUID, a 32-hex object id —
  **are** masked, in a header value and a parameter table exactly as in a path.
  That is the fail-closed direction: the model loses an identifier it would not
  have hard-coded anyway, and a session id does not leave the machine.
- `{{templates}}` are never flagged; the value is not in the string. Neither is
  the inert placeholder a templated JSON body is parsed through, or an ordinary
  Bruno body would come back as `<redacted>`.
- The verbatim channels are **not** shape-tested, and that is the one place a
  credential-shaped value still goes out under an innocuous name. The Docs field
  is the one to know about: it is the field most likely to hold an example
  `curl` with a real token, and only the URLs inside it are scrubbed.
- The schemeless `user:pass@host` rule requires a host-shaped right-hand side —
  dotted, a bracketed IPv6 literal, a `{{template}}`, or a single label when a
  path follows it. Without that check any `x:y@z` run matched, so
  `{"a":"b:c@d"}` came out as `{"a":"b:<redacted>@d"}` and `12:30@office` as
  `12:<redacted>@office`: cosmetic, but it corrupted ordinary JSON and prose on
  its way to the model. `mailto:ops@example.com` is still masked — a dotted
  authority is indistinguishable from a real one — which costs nothing the model
  needs. Requiring a scheme instead is what let `alice:hunter2@internal/v1` out
  verbatim, so the rule stays schemeless.

The corpus behind these rules is in `tests/ai/redaction.spec.js` — 12 real
credential shapes that must be caught, 21 route segments that must stay
readable, and a credential-shaped value in every channel the table above marks
`yes`.

### Verbatim channels — what still goes out as typed

Not everything can be redacted without destroying the feature. These channels
are sent as the user wrote them — no name rule and no shape test applies to
them — listed so a customer can decide rather than discover:

| Channel | Where | Why it is not redacted |
| ------- | ----- | ---------------------- |
| **Documentation** (`ctx.docs`) | the request's Docs field, in `formatRequestContext` | free-form prose with no field structure. It is the field most likely to contain an example `curl` with a real token. URLs inside it *are* scrubbed by the chokepoint; anything else is not. |
| **The user's own code** (`allContent`) | chat: the active tab plus every other tab — App, Tests, Pre-Request, Post-Response, Docs | the model is asked to return the COMPLETE updated file. Rewriting a URL inside code we hand back would write `<redacted>` into the user's script. Deliberately outside the chokepoint's scope. |
| **GraphQL query text** | `body.graphql.query` in `formatRequestContext` | the query *is* the request; withholding it makes the model useless for GraphQL. GraphQL **variables** are a JSON string and *are* redacted by key and by name. |
| Request names and file paths | `formatRequestsList` / `formatSearchRequestsResult` — `name`, `folderPath`, `pathname` | these identify a `.bru` file on disk, and the model needs them to navigate the collection and to say which request it is talking about. They are not a name/value pair with a masked value beside them, so the name rule below does not extend here. Stated as a judgement call, not an oversight. |

A user who cannot accept these should keep the Docs field free of live
credentials and use `{{variables}}` in code rather than literals — variables
marked `secret` never leave the machine.

### Bodies fail closed

Gridman only sends a request body it can parse into fields and mask field by
field:

- **json** — parsed and redacted by key. `{{templating}}` is substituted for an
  inert token first, so the ordinary Bruno body (which is not valid JSON)
  still gets field-level redaction, and the templates are put back afterwards.
- **formUrlEncoded / multipartForm / graphql variables** — redacted by field name.
- **text / xml / sparql, and any json too malformed to parse** — **not sent**.
  A one-line note giving the mode and the character count goes in its place.
  These have no field structure to mask, so there is no safe partial answer; a
  regex scrub was considered and rejected as a guess rather than a guarantee.
  The same rule applies to a non-JSON response body.

### Toggles widen protection; they never remove it

`redactHeaders`, `redactBody`, `redactVariables` and `redactResponse` used to be
all-or-nothing per channel, so `redactResponse: false` printed
`"access_token": "sk-live-…"` in full and `redactHeaders: false` printed every
`Authorization` header. A user who wanted the model to see one ordinary field
had to expose every secret alongside it.

Name-based redaction is now **unconditional**. `redactResponse` still chooses
between type-placeholder blanking (on) and real values with credential keys
masked (off). The other three no longer have an "off" that exposes a
credential — they can be a no-op or a restriction, never an exemption.

`secret: true` and `customRedactedVariables` are honored in every configuration.
Custom names are compared after the fork's standard Unicode fold
(`@usebruno/common`'s `foldSearchText`): NFC, lowercase, and Persian/Arabic
letter variants unified. Without it a name typed with ARABIC YEH (U+064A) never
matches the same name stored with FARSI YEH (U+06CC) — indistinguishable on
screen, so the redaction silently misses. See `tests/ai/redaction.spec.js`.

## Proxy

AI traffic honours `preferences.proxy`, or it does not leave the machine.

The SDKs use global `fetch`, which honours nothing from the app's proxy
settings, so AI requests used to egress outside the audited path while every
other request in the same app stayed inside it. `proxy.js` now resolves the
routing and hands the SDK a `fetch` carrying an undici `ProxyAgent` dispatcher.

| `preferences.proxy` | AI behaviour |
| ------------------- | ------------ |
| disabled / no host  | direct |
| `source: manual`, http(s) | routed through the configured proxy (credentials sent as a header, never in the URL) |
| `source: inherit`   | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` from the environment, else direct |
| `source: pac`       | **refused** — a PAC script must be evaluated per URL and `fetch` has no hook for it |
| `protocol: socks*`  | **refused** — undici's ProxyAgent speaks HTTP CONNECT only |
| undici not loadable | **refused** |

"Refused" means `getModel` and the Test button throw before anything is
constructed, so nothing is sent. Known limitation: on `inherit` we read the
environment, not the OS proxy database — `store/system-proxy.js` resolves the OS
setting but only asynchronously, and model construction is synchronous. A
machine whose proxy is set in the OS UI but not exported into the app's
environment sends AI traffic direct.

### undici is a declared dependency

The proxy path needs `undici`'s `ProxyAgent`.
`packages/bruno-electron/package.json` declares `"undici": "^6.21.1"` (resolving
to 6.21.1), so it is this package's own dependency.

It used to arrive only by luck, through
`bruno-electron -> @usebruno/js -> cheerio -> undici`. That was a release
blocker: the last row of the table above says AI **refuses outright** when
undici cannot be loaded — the correct choice, since going direct would be the
leak this module exists to prevent — so a cheerio bump that dropped or hoisted
undici differently would have taken the AI feature out entirely, for exactly the
restricted-network customer whose proxy is never optional. Nothing in a normal
test run would have noticed, because every other AI suite mocks the SDKs.

The require in `proxy.js` is still lazy and still guarded: lazy because most
users have no proxy and should not pay to load it, guarded because a pruned or
partially-hoisted install can still happen and the failure mode must be a
refusal rather than a crash. `tests/ai/proxy.spec.js` keeps a tripwire that
fails the moment `undici` stops resolving.

## Tests

`packages/bruno-electron/tests/ai/`

- `context.spec.js` — upstream's redaction suite, plus X-WSSE and Persian cases
- `providers.spec.js` — default-off (no provider constructed, no fetch), the
  keyless internal-endpoint path, and Test/generation auth parity
- `model-namespacing.spec.js` — a custom model can never resolve to the cloud
- `ai-keys.spec.js` — encryption round-trip, no plaintext at rest, dotted ids
- `preferences-ai.spec.js` — defaults, credential stripping, schema
- `preferences-credentials.spec.js` — no key reaches `preferences.json`, at any depth
- `ipc-gate.spec.js` — the registered channel list, asserted **exactly**, plus
  the six removed channels named individually; **plus the renderer-caller scan**
  that fails when a registered channel has no sender in
  `packages/bruno-app/src`; handlers refuse while disabled
- `ipc-wiring.spec.js` — the feature is actually registered from `src/index.js`,
  and registration itself makes no request and builds no provider
- `redaction.spec.js` — URL redaction (userinfo, path, query, fragment), the
  credential-shape corpus, credential-shaped values under innocuous names in
  every channel that carries one, **and the mirror of that block on the NAME
  axis** — credential-shaped keys, header/param/form/variable names, masked-key
  collisions, policy-sees-the-original-key, and non-ASCII names left alone —
  the host-shape narrowing of the schemeless `user:pass@host` rule, fail-closed
  bodies, toggle degradation, Unicode-folded custom names
- `outbound-chokepoint.spec.js` — **the structural one.** Every exported
  formatter is guarded, has a known-secret fixture, and leaks nothing; a new
  formatter that skips the guard or the fixture fails the suite. Plus the
  source scan for raw `${…url…}` interpolations.
- `prompt-assembly.spec.js` — the prompt this app actually sends carries no
  credential, in a name position or a value position, which covers private
  helpers no enumeration can reach
- `error-logging.spec.js` — a failure never prints the prompt
- `api-key-handler.spec.js` — keys are write-only across IPC
- `proxy.spec.js` — AI honours the app proxy or refuses; plus the undici tripwire
- `sdk-cache.spec.js` — the SDK cache is bounded, and the API key is SHA-256'd
  into the cache key rather than retained (the claim used to be a comment only:
  replacing the hash with the identity function left the whole suite green)
- `autocomplete-gate-cache.spec.js` — kept although the autocomplete IPC is
  gone: it tests `store/preferences.js`, which still ships the cached
  `isAiAutocompleteEnabled` gate and is owned by another workstream. Deleting a
  green test of live code in a file we do not own would remove coverage, not
  dead weight.
