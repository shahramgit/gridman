import { createSlice } from '@reduxjs/toolkit';
import get from 'lodash/get';
import { openDB } from 'idb';
import { callIpc } from 'utils/common/ipc';
import {
  findEnvironmentInCollection,
  getAllVariables,
  getFormattedCollectionOauth2Credentials,
  isItemAFolder,
  isItemARequest
} from 'utils/collections';
import { closeTabs } from './tabs';

/**
 * AI feature state plus the renderer's entire IPC surface for it.
 *
 * Upstream splits this across `utils/ai/index.js`, `utils/ai/chat-store.js`
 * and `slices/chat.js`. We keep it in one module on purpose: every call that
 * can reach a model provider originates here, so a reviewer auditing "can
 * this feature leak anything" has exactly one file to read. It also keeps the
 * port inside the small file set this change owns.
 *
 * Nothing in this module runs on import — no IPC, no IndexedDB, no network.
 * The feature is inert until a component explicitly calls one of these.
 */

/* ------------------------------------------------------------------ *
 * IPC surface
 *
 * The renderer never holds a raw API key at rest. set/clear are write-only
 * from the UI's perspective and `getAiStatus` only reports WHETHER a provider
 * has a key on disk, never the key itself. Keys are encrypted by the main
 * process through the existing utils/encryption.js before they touch disk.
 * ------------------------------------------------------------------ */

export const getAiStatus = () => callIpc('renderer:get-ai-status');

export const setAiApiKey = ({ providerId, apiKey }) => callIpc('renderer:set-ai-api-key', { providerId, apiKey });

export const clearAiApiKey = ({ providerId }) => callIpc('renderer:clear-ai-api-key', { providerId });

/**
 * Only used to prefill the "replace key" input so the user can edit rather
 * than retype. The value is never logged, never persisted by the renderer and
 * is dropped from component state as soon as the edit is cancelled or saved.
 */
export const getAiApiKey = ({ providerId }) => callIpc('renderer:get-ai-api-key', { providerId });

export const testAiProvider = ({ providerId }) => callIpc('renderer:ai-test-provider', { providerId });

/*
 * NO GENERATION EXITS HERE ANY MORE.
 *
 * `aiGenerateScript` (renderer:ai-generate-script) and `stopAiGeneration`
 * (renderer:ai-stop-stream) used to live at this point in the file. Their only
 * caller was components/AIAssist — the sparkle / script-generation surface,
 * which nothing outside its own directory ever imported, so no user could
 * reach it. Both the component and the matching main-process handlers were cut
 * rather than hardened: preload.js has no channel allowlist, so an unreachable
 * channel that talks to a model provider is pure risk with no user value.
 *
 * `sendAiMessage` (renderer:ai-chat-stream) is now the ONLY way this renderer
 * can reach a provider, and it goes through the outbound gate below.
 */

/* ------------------------------------------------------------------ *
 * Context builders
 * ------------------------------------------------------------------ */

/**
 * Sensitive name patterns kept in sync with the main process (ipc/ai/context.js),
 * plus the short forms that list missed. The renderer applies them BEFORE
 * anything crosses the IPC boundary so the payload itself never carries a
 * secret — belt and suspenders on top of the backend masking.
 */
const SENSITIVE_NAME_PATTERNS = [
  /api[_-]?key/i,
  // Catches refresh_token, id_token, csrfToken, plain TOKEN, etc. on top of
  // the specific access/auth-token forms below.
  /token/i,
  /access[_-]?token/i,
  /auth[_-]?token/i,
  /secret/i,
  /password/i,
  /^authorization$/i,
  /^cookie$/i,
  // Short forms. `{"pw": "hunter2"}` used to reach the model in full: `pw`
  // matches none of the patterns above and `hunter2` is far too ordinary for
  // any value-shape rule to catch. Name matching is the only thing that can
  // see it, so the name list has to know the abbreviations people actually
  // type.
  /^pw$/i,
  /^pwd$/i,
  /^passwd$/i,
  /^pass$/i,
  /passphrase/i,
  /credential/i,
  /^auth$/i,
  /^key$/i,
  /^sig$/i,
  /signature/i,
  /^session([_-]?id)?$/i,
  /bearer/i,
  /^otp$/i,
  /^pin$/i,
  /private[_-]?key/i,
  // WSSE: our network layer emits `X-WSSE` and its value carries a
  // PasswordDigest + Nonce. No other pattern here matches that name.
  /wsse/i
];

export const isSensitiveVariableName = (name) => {
  if (!name) return false;
  return SENSITIVE_NAME_PATTERNS.some((re) => re.test(name));
};

export const REDACTED_PLACEHOLDER = '<redacted>';

const SKIPPED_VAR_KEYS = new Set(['pathParams', 'maskedEnvVariables', 'process']);

/* ------------------------------------------------------------------ *
 * Credential SHAPE detection
 *
 * Name matching alone leaves two holes the customer cares about:
 * `https://api.internal/v1/keys/sk-live-AAAA` (a secret in the URL PATH, where
 * there is no parameter name to match) and `{"q": "sk-live-AAAA"}` (a secret
 * under an innocuous key). Both are matched on the VALUE instead.
 *
 * WHAT THIS DOES NOT DO — stated here rather than implied away: a short,
 * ordinary-looking secret under an ordinary-looking key (`{"a": "hunter2"}`)
 * is invisible to both rules and is sent. No heuristic can separate it from
 * a normal string. The honest boundary is: name match OR shape match, and
 * nothing else.
 * ------------------------------------------------------------------ */

// Vendor key prefixes. A token starting with one of these and long enough to
// carry a payload is a credential, whatever it is named. One alternation
// rather than a list of `startsWith` calls: this runs per candidate token on
// every request in the collection, and the list walk showed up as the cost.
const CREDENTIAL_PREFIX_SOURCE = [
  'sk[-_]', 'pk[-_]', 'rk_', 'ak_',
  'gh[pousr]_', 'github_pat_',
  'xox[bpasr]-',
  'glpat-', 'gldt-',
  'npm_', 'do[opr]_v1_',
  'shp(?:at|ss|ca|pa)_',
  'sq0(?:atp|csp)-',
  'AKIA', 'ASIA', 'ABIA', 'ACCA',
  'AIza', 'ya29\\.',
  'SG\\.', 'xkeysib-', 'hf_', 'lin_api_', 'pat_'
].join('|');

const CREDENTIAL_PREFIX_RE = new RegExp(`^(?:${CREDENTIAL_PREFIX_SOURCE})`);

/**
 * The same prefixes, findable ANYWHERE inside a token rather than only at its
 * start.
 *
 * THE BUG THIS EXISTS FOR — it leaked end to end, to the model, verbatim:
 * the anchored test above is applied to a "candidate run", and a candidate run
 * is a maximal stretch of `[A-Za-z0-9+/=_.~-]`. That character class contains
 * `/`, `.`, `-`, `_` and `=`, which are exactly the characters a credential is
 * glued to in real payloads — so `/keys/sk-live-AAAABBBBCCCCDDDD`,
 * `https://h/cb/sk-live-…`, `key=sk-live-…`, `x-sk-live-…` and `key.sk-live-…`
 * all arrive as ONE run that does not START with a vendor prefix. The anchor
 * never matched, no other rule fired (the surrounding text drags the run below
 * the mixed-case/digit bar of the opaque rule), and the key went out in full.
 *
 * The prefix must not be preceded by an alphanumeric, so `compat_`, `break_`
 * and `MSG.` do not read as `pat_`, `ak_` and `SG.`. `{` is excluded from the
 * separator class so this pass never starts one character into a `{{…}}`
 * opener and hands back a mangled `{<redacted>}}`. It does NOT make template
 * names safe from redaction — `{{sk_secret}}` is redacted by the candidate-run
 * pass below, as it was before this rule existed.
 *
 * The payload is greedy over the credential charset: where a key ends and the
 * rest of a path begins is not knowable from here, so `…/sk-live-AAAA/rotate`
 * redacts to `…/<redacted>`. Fail closed.
 */
const EMBEDDED_CREDENTIAL_SOURCE
  = `(^|[^A-Za-z0-9{])((?:${CREDENTIAL_PREFIX_SOURCE})[A-Za-z0-9+/=_.~-]{6,})`;
// Two instances of one source: the `g` copy carries a mutable `lastIndex`, so
// it must never be used for `.test()`.
const HAS_EMBEDDED_CREDENTIAL_RE = new RegExp(EMBEDDED_CREDENTIAL_SOURCE);
const EMBEDDED_CREDENTIAL_RE = new RegExp(EMBEDDED_CREDENTIAL_SOURCE, 'g');

/**
 * Replace vendor-prefixed credentials found inside a larger token, keeping the
 * character they were glued to. `…/cb/sk-live-AAAA` comes back as
 * `…/cb/<redacted>` rather than a single `<redacted>` that would erase the
 * endpoint the model is being asked to write code against.
 */
const redactEmbeddedCredentials = (token) =>
  token.replace(EMBEDDED_CREDENTIAL_RE, (_match, before) => `${before}${REDACTED_PLACEHOLDER}`);

const JWT_RE = /^ey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;
const LONG_HEX_RE = /^[0-9a-f]{32,}$/i;
// A UUID in a path is usually a resource id and only sometimes a session
// token — the two are indistinguishable from here. FAIL CLOSED: redact it.
// The model still sees `/sessions/<redacted>`, which is enough to write code.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_CHARSET_RE = /^[A-Za-z0-9+/=_.~-]+$/;
const OPAQUE_MIN_LENGTH = 24;

/**
 * True when a bare token looks like a credential on its own.
 *
 * Deliberately conservative about false positives on the things a model needs:
 * `v1`, `users`, `42`, `acme-corp-limited` and `application/json` are all
 * lower-entropy or too short to match. Anything carrying a `{`/`}` is a Bruno
 * template — a name, never a literal secret — and is left alone.
 */
export const looksLikeCredential = (raw) => {
  const token = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (token.length < 8) return false;
  if (token.includes('{') || token.includes('}')) return false;
  const prefix = CREDENTIAL_PREFIX_RE.exec(token);
  if (prefix && token.length >= prefix[0].length + 6) return true;
  // …and the same prefix glued to surrounding text (`/keys/sk-live-…`,
  // `x-sk-live-…`). Kept as a SECOND test rather than as a replacement for the
  // anchored one so nothing the anchored form already caught can weaken: it
  // counts every trailing character, this one only credential-charset ones.
  if (HAS_EMBEDDED_CREDENTIAL_RE.test(token)) return true;
  if (JWT_RE.test(token)) return true;
  if (UUID_RE.test(token)) return true;
  if (LONG_HEX_RE.test(token)) return true;
  // Long, opaque, mixed-case-and-digits: the shape of an opaque bearer token.
  if (token.length < OPAQUE_MIN_LENGTH) return false;
  return (
    OPAQUE_CHARSET_RE.test(token)
    && /[a-z]/.test(token)
    && /[A-Z]/.test(token)
    && /[0-9]/.test(token)
  );
};

// Whole whitespace-delimited tokens, then maximal runs of the characters a
// credential is made of, so one buried inside a URL or a header value is
// found. Both skip anything shorter than the 8-char floor in
// `looksLikeCredential`, which is what keeps this cheap on collection-sized
// input. (`redactEmbeddedCredentials` runs ahead of both — see above.)
const OUTER_TOKEN_RE = /\S{8,}/g;
const CANDIDATE_RUN_RE = /[A-Za-z0-9+/=_.~-]{8,}/g;

/**
 * Replace every credential-shaped token inside a free-form string.
 *
 * This is the primitive the outbound gate is built from — see
 * `scrubAiOutbound` below. It never removes structure, only values, so a
 * header value stays readable as `Bearer <redacted>`.
 */
export const scrubOutboundText = (value) => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length < 8) return text;
  return text.replace(OUTER_TOKEN_RE, (token) => {
    // Embedded vendor keys FIRST, and by substring. `looksLikeCredential` also
    // recognises them, but it answers about the whole token, so running it
    // first would collapse `https://h/cb/sk-live-…` to a bare `<redacted>` and
    // throw the host away with the secret.
    const scrubbed = redactEmbeddedCredentials(token);
    if (looksLikeCredential(scrubbed)) return REDACTED_PLACEHOLDER;
    return scrubbed.replace(CANDIDATE_RUN_RE, (run) =>
      (looksLikeCredential(run) ? REDACTED_PLACEHOLDER : run));
  });
};

/* ------------------------------------------------------------------ *
 * URL redaction
 *
 * A request URL is a first-class leak channel and nothing downstream was
 * treating it as one: the same credential that shows as `<redacted>` in the
 * Query Parameters block was shipped in full one line above, inside
 * `**Request:** GET <url>`.
 *
 * Rules (FAIL CLOSED — see the note on values below):
 *  - `scheme://user:pass@host` AND the protocol-relative `//user:pass@host` —
 *    userinfo is replaced wholesale. It is a credential by definition and
 *    never useful to a model. The scheme is optional on purpose: the old regex
 *    required a literal `scheme://`, so `//svc:p4ssw0rd@api.internal/x` walked
 *    straight past a rule this file already claimed to enforce.
 *  - Every query-string VALUE is replaced, unless it is exactly one Bruno
 *    template (`{{token}}`), which carries no literal secret and is the most
 *    useful thing the model can see. Query KEYS survive, so the model still
 *    knows the request's shape.
 *  - The fragment gets the same treatment as a query value.
 *  - Every PATH SEGMENT that looks like a credential is replaced. There is no
 *    parameter name in a path to match on, so `…/v1/keys/sk-live-AAAA` was
 *    reaching the model verbatim from both sides of the IPC boundary. Segment
 *    matching is by shape (`looksLikeCredential`), so `/v1/users/42` survives
 *    intact.
 *
 * Redacting every literal query value (rather than only `token`-ish keys) is
 * the deliberate fail-closed choice: a secret in `?k=…` or `?q=…` is still a
 * secret, and name-pattern matching cannot see it. Nothing is lost for the
 * chat and generation surfaces — they also send `params`, where the main
 * process shows non-sensitive values in full under its own policy.
 * ------------------------------------------------------------------ */

const TEMPLATE_ONLY_RE = /^\{\{[^{}]*\}\}$/;

const keepsNoSecret = (value) => value === '' || TEMPLATE_ONLY_RE.test(value.trim());

const redactQueryString = (query) =>
  query
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf('=');
      // A bare `?flag` has no value to leak; a `?SECRET` we cannot tell apart
      // from a flag, so redact the whole token rather than guess.
      if (eq === -1) return keepsNoSecret(pair) ? pair : REDACTED_PLACEHOLDER;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      return `${key}=${keepsNoSecret(value) ? value : REDACTED_PLACEHOLDER}`;
    })
    .join('&');

// `scheme://` or a bare `//` (protocol-relative). Everything up to the next
// `/`, `?` or `#` after it is the authority and must not be segment-scanned —
// a hostname is not a credential.
const AUTHORITY_PREFIX_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//;

// `redactEmbeddedCredentials` runs FIRST, for the same reason it does in
// `scrubOutboundText`: `looksLikeCredential` answers about a WHOLE segment and
// bails on anything containing a `{`, so a template glued to a vendor key
// (`/keys/{{env}}-sk-live-…`) walked straight through this function. Callers in
// this module compose `redactUrlForAi` with `scrubOutboundText`, which caught
// it downstream — but `redactUrlForAi` is exported and its contract says every
// credential-shaped path segment is replaced, so it holds on its own.
const redactPathSegments = (path) =>
  path
    .split('/')
    .map((segment) => {
      const scrubbed = redactEmbeddedCredentials(segment);
      return looksLikeCredential(scrubbed) ? REDACTED_PLACEHOLDER : scrubbed;
    })
    .join('/');

const redactAuthorityAndPath = (beforeQuery) => {
  const prefixMatch = beforeQuery.match(AUTHORITY_PREFIX_RE);
  if (!prefixMatch) {
    // Relative or template-headed (`{{baseUrl}}/v1/keys/sk-live-…`): there is
    // no authority to protect, so the whole thing is path.
    return redactPathSegments(beforeQuery);
  }
  const prefix = prefixMatch[0];
  const rest = beforeQuery.slice(prefix.length);
  const pathAt = rest.indexOf('/');
  const authority = pathAt === -1 ? rest : rest.slice(0, pathAt);
  const path = pathAt === -1 ? '' : rest.slice(pathAt);
  return `${prefix}${authority}${redactPathSegments(path)}`;
};

export const redactUrlForAi = (rawUrl) => {
  if (rawUrl == null) return '';
  let url = String(rawUrl);
  if (!url) return '';

  // [scheme:]//userinfo@host  →  [scheme:]//<redacted>@host
  url = url.replace(
    /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)([^/?#@]*@)/,
    `$1${REDACTED_PLACEHOLDER}@`
  );

  const hashAt = url.indexOf('#');
  let fragment = '';
  if (hashAt !== -1) {
    const raw = url.slice(hashAt + 1);
    fragment = `#${keepsNoSecret(raw) ? raw : REDACTED_PLACEHOLDER}`;
    url = url.slice(0, hashAt);
  }

  const queryAt = url.indexOf('?');
  if (queryAt === -1) return `${redactAuthorityAndPath(url)}${fragment}`;

  return `${redactAuthorityAndPath(url.slice(0, queryAt))}?${redactQueryString(url.slice(queryAt + 1))}${fragment}`;
};

/* ------------------------------------------------------------------ *
 * Request body
 *
 * The main process key-redacts JSON bodies, but its `JSON.parse` sits in a
 * try/catch whose catch returns the RAW string — so any body it cannot parse
 * (the common Bruno case: `{"id": {{userId}}}`) was forwarded verbatim,
 * secrets and all. text/xml/sparql bodies had no redaction of any kind.
 *
 * WHAT "FAIL CLOSED" MEANS HERE, precisely — the earlier wording claimed more
 * than the code delivered, so it is spelled out:
 *
 *  - A body we cannot decompose into fields (text / xml / sparql, or JSON too
 *    malformed to parse) is NOT SENT AT ALL. That part is absolute.
 *  - A body we CAN decompose is sent field by field, with a value replaced
 *    when its KEY matches the sensitive-name list (now including `pw`, `pwd`,
 *    `sig`, `key`, … as well as `password`/`token`/`secret`) OR when its VALUE
 *    is credential-shaped (`sk-live-…`, a JWT, a long opaque token; see
 *    `looksLikeCredential`).
 *  - It does NOT catch a short, ordinary-looking secret under an
 *    ordinary-looking key. `{"a": "hunter2"}` is sent. Nothing in the string
 *    distinguishes it from data, and claiming otherwise would be a lie in a
 *    comment a customer might rely on.
 * ------------------------------------------------------------------ */

export const AI_BODY_OMITTED_NOTICE = '<body omitted — Gridman only sends request bodies it can redact>';

const JSON_MAX_DEPTH = 8;

/**
 * Walk a parsed JSON body and blank the values that are (or look like) a
 * credential. Keys, structure and ordinary values survive so the model can
 * still write code against the body.
 *
 * ON THE VALUE-SHAPE BRANCH (the `typeof data === 'string'` line): the gate
 * would catch every one of these anyway — the serialized body leaves as a
 * string under the non-verbatim key `json`, so `scrubOutboundText` runs over
 * it. This branch is not redundant, though, and it is not kept on faith: it
 * replaces the WHOLE field value, where the gate only replaces the
 * credential-shaped run inside it. `{"note":"see /keys/sk-live-… now"}` leaves
 * as `"note": "<redacted>"` because of this line, and as
 * `"note": "see /keys/<redacted> now"` without it. That difference is asserted
 * in ai-slice.spec.js, so deleting the branch fails the suite.
 */
const redactJsonValues = (data, depth = 0) => {
  if (depth > JSON_MAX_DEPTH) return REDACTED_PLACEHOLDER;
  if (Array.isArray(data)) return data.map((item) => redactJsonValues(item, depth + 1));
  if (data && typeof data === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = isSensitiveVariableName(key) ? REDACTED_PLACEHOLDER : redactJsonValues(value, depth + 1);
    }
    return out;
  }
  if (typeof data === 'string') return looksLikeCredential(data) ? REDACTED_PLACEHOLDER : data;
  return data;
};

const jsonBodyOrNotice = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return raw == null ? '' : raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return AI_BODY_OMITTED_NOTICE;
  }
  return JSON.stringify(redactJsonValues(parsed), null, 2);
};

// Free-text body modes: no key structure to redact against, so the content
// never leaves the renderer.
const UNREDACTABLE_TEXT_MODES = ['text', 'xml', 'sparql'];

/**
 * A GraphQL operation document is the request's SHAPE, so it is worth keeping
 * — but inline arguments are a real credential channel
 * (`mutation { login(password: "hunter2") }`) and the main process ships the
 * query verbatim. Every string literal (block strings included) is replaced;
 * field names, variable declarations and types survive, so the model still
 * sees the operation.
 *
 * Block-string alternative comes first so `"""…"""` is consumed whole rather
 * than being chewed up by the single-quote branch.
 */
const GRAPHQL_STRING_LITERAL_RE = /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g;

const redactGraphqlQuery = (query) => {
  if (typeof query !== 'string' || !query) return query || '';
  return query.replace(GRAPHQL_STRING_LITERAL_RE, `"${REDACTED_PLACEHOLDER}"`);
};

const sanitizeAiRequestBodyFields = (body) => {
  if (!body || typeof body !== 'object') return null;
  const mode = body.mode;
  if (!mode || mode === 'none') return { mode: mode || 'none' };

  if (UNREDACTABLE_TEXT_MODES.includes(mode)) {
    return { mode, [mode]: body[mode] ? AI_BODY_OMITTED_NOTICE : '' };
  }

  switch (mode) {
    case 'json':
      return { mode, json: jsonBodyOrNotice(body.json) };
    case 'formUrlEncoded':
      return { mode, formUrlEncoded: Array.isArray(body.formUrlEncoded) ? body.formUrlEncoded : [] };
    case 'multipartForm':
      return { mode, multipartForm: Array.isArray(body.multipartForm) ? body.multipartForm : [] };
    case 'graphql': {
      const variables = body.graphql?.variables;
      return {
        mode,
        graphql: {
          query: redactGraphqlQuery(body.graphql?.query),
          variables: variables == null ? variables : jsonBodyOrNotice(variables)
        }
      };
    }
    // `file` and any mode added later: unknown shape, nothing sent.
    default:
      return { mode };
  }
};

/**
 * Public body formatter. Every branch above returns through the outbound gate
 * — including the ones that hand back caller-supplied arrays untouched
 * (`formUrlEncoded`, `multipartForm`), which is where a `password` field used
 * to cross IPC in the clear on its way to the main process's masker.
 */
export const sanitizeAiRequestBody = (body) => scrubAiOutbound(sanitizeAiRequestBodyFields(body), 'body');

/**
 * Flat list of variables the model may search: `{ name, value, scope, secret }`.
 *
 * Values come from `getAllVariables()` so they match what `bru.*` resolves at
 * runtime — otherwise the model would be shown a lower-precedence value for
 * any name overridden by a higher-precedence scope.
 *
 * Redaction rules (mirrors the main process):
 * - Variables EXPLICITLY marked secret (env `secret` flag, globalEnvSecrets,
 *   OAuth2 credentials) are ALWAYS redacted.
 * - Names that merely LOOK secret by pattern are ALSO always redacted. This
 *   used to be conditional on the "Redact secret variable values" preference,
 *   which meant switching that preference off put every `*_token` /
 *   `password` value on the IPC wire in the clear — where the main process
 *   masked them anyway, because `buildRedactionPolicy` over there already
 *   treats name matching as unconditional. The renderer now matches: a
 *   toggle may widen redaction, never remove it.
 * - `redactVariables` is still accepted so call sites do not have to change,
 *   and is deliberately NOT able to turn protection off.
 */

export const buildAiVariablesPayload = (collection, item, redactVariables = true) => {
  if (!collection) return [];

  const resolved = getAllVariables(collection, item) || {};

  // name -> { scope, secret }. Last claim wins for scope (matching the spread
  // order in getAllVariables); `secret` is sticky-on once any source flags it.
  const meta = new Map();
  const claim = (name, scope, secret) => {
    if (!name) return;
    const existing = meta.get(name);
    meta.set(name, { scope, secret: Boolean(secret) || Boolean(existing?.secret) });
  };

  const globalSecrets = new Set(collection.globalEnvSecrets || []);
  for (const name of Object.keys(collection.globalEnvironmentVariables || {})) {
    claim(name, 'global', globalSecrets.has(name));
  }

  const env = findEnvironmentInCollection(collection, collection.activeEnvironmentUid);
  if (env && Array.isArray(env.variables)) {
    for (const v of env.variables) {
      if (v?.name && v.enabled) claim(v.name, 'env', Boolean(v.secret));
    }
  }

  for (const name of Object.keys(collection.runtimeVariables || {})) {
    claim(name, 'runtime', false);
  }

  // OAuth2 credentials are always treated as secret.
  const oauth = getFormattedCollectionOauth2Credentials({ oauth2Credentials: collection?.oauth2Credentials });
  if (oauth) {
    for (const name of Object.keys(oauth)) claim(name, 'oauth2', true);
  }

  const out = [];
  for (const name of Object.keys(resolved)) {
    if (SKIPPED_VAR_KEYS.has(name)) continue;
    const m = meta.get(name);
    // Names not claimed by an explicit source come from collection/folder/
    // request vars, which carry no secret flag — pattern matching is the only
    // guard there, and only while the preference is on.
    const scope = m?.scope || 'collection';
    const isSecret = Boolean(m?.secret) || isSensitiveVariableName(name);
    const value = resolved[name];
    out.push({
      name,
      value: isSecret ? REDACTED_PLACEHOLDER : value == null ? '' : String(value),
      scope,
      secret: isSecret
    });
  }
  // Through the gate: a variable whose NAME says nothing but whose VALUE is a
  // live `sk-live-…` / JWT / long opaque token is redacted on shape.
  return scrubAiOutbound(out, 'variables');
};

/**
 * `item.pathname` is an ABSOLUTE path on this machine
 * (`/Users/someone/work/clients/acme/Auth/Login.bru`), and it was being shipped
 * to the model as-is — the user's home directory layout, their employer, and
 * every folder name between, on every request in the collection.
 *
 * Collection-relative is also the only form that WORKS: the model is told to
 * pass this value to `bru.ctx.runRequest(pathname)`, and the runtime resolves
 * it with `path.join(collection.pathname, pathname)` (see
 * bruno-electron/src/ipc/network/index.js) — an absolute path joined onto the
 * collection root resolves to nothing.
 *
 * If the item is somehow not under the collection root (or the root is
 * unknown), fall back to the bare file name rather than emitting the absolute
 * path: the model loses some context, the user's directory tree stays home.
 */
const toCollectionRelativePath = (itemPathname, collectionPathname) => {
  const file = String(itemPathname || '').replace(/\\/g, '/');
  if (!file) return '';
  const root = String(collectionPathname || '').replace(/\\/g, '/').replace(/\/+$/, '');
  // Case-insensitive prefix test: Windows and macOS both hand back paths whose
  // case can differ from the collection root's by drive letter or volume name.
  if (root && file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1);
  }
  return file.split('/').pop() || '';
};

/**
 * Names + methods + urls of every request in the collection, so the model can
 * reference siblings. No headers, no bodies, no variable values.
 */
export const buildAiRequestsPayload = (collection) => {
  if (!collection) return [];
  const out = [];
  const bySeq = (items) => [...(items || [])].sort((a, b) => (a.seq || 0) - (b.seq || 0));

  const walk = (items, folderPath) => {
    for (const item of bySeq(items)) {
      if (item.isTransient) continue;
      if (isItemAFolder(item)) {
        walk(item.items || [], folderPath ? `${folderPath}/${item.name || ''}` : item.name || '');
        continue;
      }
      if (!isItemARequest(item)) continue;
      const req = item.draft?.request || item.request || {};
      out.push({
        name: item.name || '',
        pathname: toCollectionRelativePath(item.pathname, collection.pathname),
        folderPath: folderPath || '',
        type: item.type,
        method: req.method || 'GET',
        // Sibling URLs are printed to the model verbatim by the main process's
        // request-list formatter, so they get the same treatment as the active
        // request's URL — a collection-wide dump of query strings would
        // otherwise leak every inline credential in the tree.
        url: redactUrlForAi(req.url)
      });
    }
  };
  walk(collection.items || [], '');
  return scrubAiOutbound(out, 'requests');
};

/* ------------------------------------------------------------------ *
 * THE OUTBOUND GATE
 *
 * The last round fixed the URL in ONE emitter and three others kept leaking.
 * The fix for that is not a fourth patch — it is a gate that does not depend
 * on the next emitter remembering to call anything.
 *
 * `scrubAiOutbound` is that gate. It walks an arbitrary value and applies the
 * rules by position, and `scrubAiOutboundPayload` runs it over EVERY key of
 * an IPC payload except a short, explicit verbatim list. That inversion is the
 * point: a context key added later is scrubbed by default. A new emitter
 * cannot bypass the gate by being new, only by being added to the verbatim
 * list — which is a visible, reviewable edit that the tests assert on.
 *
 * `sendAiMessage` is the only way the renderer can reach a provider, and it
 * goes through it.
 * ------------------------------------------------------------------ */

// Keys whose string value is a URL and needs structure-aware treatment.
const URL_VALUED_KEYS = new Set(['url', 'baseUrl', 'endpoint', 'uri']);

/**
 * Keys sent VERBATIM, each for a stated reason. Anything not listed here is
 * scrubbed.
 *
 * This list is EXACTLY the keys the surviving exit actually sends. It used to
 * carry `prompt`, `currentScript`, `docsContext`, `scriptType`, `streamId` and
 * `tabUid` as well — all six belonged to the deleted generation surface and
 * nothing sends them any more. A dead entry on this list is not inert: it is a
 * standing exemption waiting for some future payload to reuse the name and be
 * shipped unscrubbed without anyone deciding that. Removed for that reason.
 *
 * - `messages`      — the user's own words. Rewriting what someone typed into
 *                     a chat box would be a bug.
 * - `allContent`    — the file content the model is being asked to EDIT: the
 *                     Tests, Pre-Request script, Post-Response script and Docs
 *                     of the active request/folder/collection. The reply is
 *                     diffed against it; scrub it and we would write
 *                     `<redacted>` into the user's .bru file. It is
 *                     user-authored text, not captured traffic — and it is
 *                     disclosed as verbatim in Preferences > AI > Security and
 *                     in the chat panel's empty state, by name, all four.
 * - `docs`          — the same Docs text again, inside `requestContext`.
 * - the rest        — routing/identity scalars with no user content.
 */
export const OUTBOUND_VERBATIM_KEYS = new Set([
  'messages',
  'allContent',
  'docs',
  'contentType',
  'requestId',
  'model'
]);

/**
 * VERBATIM IS A PROPERTY OF A PAYLOAD SLOT, NOT OF A FIELD NAME.
 *
 * THE BUG THIS EXISTS FOR — confirmed leaking, same class as the anchored
 * prefix above: `scrubAiOutbound` applied the whole verbatim list by key name
 * at EVERY depth. `requestContext.responseData` is arbitrary CAPTURED TRAFFIC,
 * so a response body of
 *
 *     {"model": "sk-live-AAAABBBBCCCCDDDD"}
 *
 * matched the `model` exemption and went to the provider in full, while the
 * identical value under `{"ordinary": …}` was redacted. Every one of
 * `model`, `messages`, `docs`, `contentType`, `requestId` and `allContent` is
 * an ordinary field name that real APIs use — a chat API's own response is
 * literally `{"messages": […], "model": …}` — so this was not a corner case.
 *
 * The exemptions above are about WHERE a value sits in the IPC payload:
 * `scrubAiOutboundPayload` grants them at the top level, and exactly one is
 * needed any deeper — `docs`, as a direct field of `requestContext`, which is
 * the user's own Docs prose and the same text `allContent` carries. Nothing
 * below that is user-authored; it is all captured traffic, so it is scrubbed.
 *
 * Depth 1 is the direct fields of the object handed to `scrubAiOutbound`
 * (`buildAiRequestContext` / `sanitizeAiRequestContext` pass the context at
 * depth 0), so `requestContext.docs` is verbatim and
 * `requestContext.responseData.docs` — two levels down, inside a response — is
 * not. Fail closed.
 */
export const NESTED_VERBATIM_KEYS = new Set(['docs']);
const NESTED_VERBATIM_MAX_DEPTH = 1;

/**
 * The recursive rule set. `keyName` is the key this value was found under,
 * which is what makes name-based masking work at any depth.
 */
const OUTBOUND_MAX_DEPTH = 12;

export const scrubAiOutbound = (value, keyName = '', depth = 0) => {
  if (value == null) return value;
  // A response body can be arbitrarily deep and, if a caller ever hands us a
  // live object graph, cyclic. Fail closed at the cap rather than recurse.
  if (depth > OUTBOUND_MAX_DEPTH) return REDACTED_PLACEHOLDER;

  if (Array.isArray(value)) return value.map((entry) => scrubAiOutbound(entry, keyName, depth + 1));

  if (typeof value === 'object') {
    // A request body is not a generic object: its content is a serialized
    // blob whose fields only exist after parsing. Token scrubbing alone would
    // let `{"pw":"hunter2"}` through, so the gate re-derives the body through
    // the body rules first. Idempotent, so it is safe on an already-sanitized
    // body and on one a caller hand-rolled.
    if (keyName === 'body' && typeof value.mode === 'string') {
      return scrubAiOutbound(sanitizeAiRequestBodyFields(value), 'sanitizedBody', depth);
    }
    // `{ name, value }` pairs — headers, query/path params, form fields and
    // the variables payload all use this shape, and the credential's name
    // lives in a sibling field rather than in the key.
    const masksSibling = typeof value.name === 'string' && isSensitiveVariableName(value.name);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (masksSibling && key === 'value') {
        out[key] = REDACTED_PLACEHOLDER;
        continue;
      }
      out[key] = scrubAiOutbound(entry, key, depth + 1);
    }
    return out;
  }

  if (typeof value !== 'string') return value;
  // Positional, not by name at any depth — see NESTED_VERBATIM_KEYS.
  if (depth <= NESTED_VERBATIM_MAX_DEPTH && NESTED_VERBATIM_KEYS.has(keyName)) return value;
  if (URL_VALUED_KEYS.has(keyName)) return scrubOutboundText(redactUrlForAi(value));
  if (isSensitiveVariableName(keyName)) return REDACTED_PLACEHOLDER;
  return scrubOutboundText(value);
};

/**
 * Run the gate over a whole IPC payload. Called by every exit in this module.
 */
export const scrubAiOutboundPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = OUTBOUND_VERBATIM_KEYS.has(key) ? value : scrubAiOutbound(value, key);
  }
  return out;
};

/**
 * Re-apply the URL and body rules to a context assembled elsewhere, then run
 * the gate over the result.
 *
 * Every rule is idempotent (`<redacted>` redacts to `<redacted>`; the omitted
 * body notice is not parseable JSON so it stays the notice), so a surface can
 * run this over a context that already went through `buildAiRequestContext`
 * without double-mangling it.
 */
export const sanitizeAiRequestContext = (ctx) => {
  if (!ctx || typeof ctx !== 'object') return ctx;
  return scrubAiOutbound(
    {
      ...ctx,
      url: redactUrlForAi(ctx.url),
      body: sanitizeAiRequestBody(ctx.body)
    },
    'requestContext'
  );
};

/**
 * Request context for chat + generation. This is the ONLY place the renderer
 * assembles one — every AI surface must go through it, so there is a single
 * function to audit for "what can this feature send".
 *
 * Header/param VALUES are still shipped verbatim and masked by the main
 * process formatter, so that mask logic lives in exactly one place
 * (packages/bruno-electron/src/ipc/ai/context.js). The URL and the body are
 * the exceptions: neither had any redaction downstream, so both are made safe
 * here, before anything crosses the IPC boundary.
 */
export const buildAiRequestContext = (item) => {
  if (!item) return null;
  const req = item.draft ? item.draft.request : item.request;
  if (!req) return null;

  return scrubAiOutbound(
    {
      url: redactUrlForAi(req.url),
      method: req.method || 'GET',
      headers: Array.isArray(req.headers) ? req.headers : [],
      params: Array.isArray(req.params) ? req.params : [],
      body: sanitizeAiRequestBody(req.body),
      // The one field in THIS context object sent verbatim. It is
      // user-authored prose, not captured traffic, and the chat also sends it
      // as an edit target in `allContent` — scrubbing it here would protect
      // nothing while making the model's view of the file inconsistent with
      // the file. Disclosed alongside the other verbatim channels (Tests,
      // Pre-Request, Post-Response) in Preferences > AI > Security and in the
      // chat panel, rather than quietly assumed.
      docs: req.docs || null,
      responseStatus: get(item, 'response.status', null),
      responseData: get(item, 'response.data', null)
    },
    'requestContext'
  );
};

/* ------------------------------------------------------------------ *
 * Conversation persistence (IndexedDB, local only)
 * ------------------------------------------------------------------ */

const DB_NAME = 'gridman-ai-chats';
const STORE = 'conversations';
const DB_VERSION = 1;

let dbPromise = null;

const getDb = () => {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('pathname', 'pathname');
          store.createIndex('updatedAt', 'updatedAt');
        }
      }
    }).catch((err) => {
      console.warn('[AI] Failed to open chat history DB:', err);
      dbPromise = null;
      return null;
    });
  }
  return dbPromise;
};

/** Stable conversation id without pulling in a uuid dependency. */
export const newConversationId = () => `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Trimmed title built from the first user message. Empty if there is none. */
export const deriveTitle = (messages) => {
  const firstUser = (messages || []).find((m) => m.role === 'user' && (m.content || '').trim());
  if (!firstUser) return '';
  const text = firstUser.content.trim().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/**
 * Strip transient streaming state before persisting — partial assistant
 * messages and in-flight tool spinners must never reach disk.
 */
const sanitizeMessage = (msg) => {
  const out = { role: msg.role, content: msg.content || '' };
  if (msg.code) out.code = msg.code;
  if (msg.originalCode != null) out.originalCode = msg.originalCode;
  if (msg.contentType) out.contentType = msg.contentType;
  if (msg.codeStatus) out.codeStatus = msg.codeStatus;
  if (msg.cancelled) out.cancelled = true;
  if (msg.writes) {
    out.writes = msg.writes.map((w) => ({
      type: w.type,
      content: w.content,
      originalContent: w.originalContent,
      wasRead: w.wasRead,
      status: w.status
    }));
  }
  return out;
};

export const saveConversation = async (conversation) => {
  const db = await getDb();
  if (!db) return null;

  const record = {
    id: conversation.id,
    pathname: conversation.pathname || '',
    collectionUid: conversation.collectionUid || '',
    title: deriveTitle(conversation.messages || []),
    contentType: conversation.contentType || 'docs',
    messages: (conversation.messages || []).filter((m) => !m.isStreaming).map(sanitizeMessage),
    createdAt: conversation.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  if (!record.messages.length) return null;

  try {
    await db.put(STORE, record);
    return record;
  } catch (err) {
    console.warn('[AI] Failed to save conversation:', err);
    return null;
  }
};

export const listConversationsForPath = async (pathname) => {
  if (!pathname) return [];
  const db = await getDb();
  if (!db) return [];

  try {
    const all = await db.getAllFromIndex(STORE, 'pathname', pathname);
    return all
      .map((c) => ({
        id: c.id,
        title: c.title || '(untitled)',
        contentType: c.contentType,
        messageCount: c.messages?.length || 0,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.warn('[AI] Failed to list conversations:', err);
    return [];
  }
};

export const loadConversation = async (id) => {
  if (!id) return null;
  const db = await getDb();
  if (!db) return null;
  try {
    return (await db.get(STORE, id)) || null;
  } catch (err) {
    console.warn('[AI] Failed to load conversation:', err);
    return null;
  }
};

export const deleteConversation = async (id) => {
  if (!id) return false;
  const db = await getDb();
  if (!db) return false;
  try {
    await db.delete(STORE, id);
    return true;
  } catch (err) {
    console.warn('[AI] Failed to delete conversation:', err);
    return false;
  }
};

/* ------------------------------------------------------------------ *
 * Slice
 * ------------------------------------------------------------------ */

/**
 * No `isPoppedOut` here on purpose. The popout was cut from this pass: it
 * relied on `window.open` with the frameName `gridman-ai-assistant`, and the
 * main process's `setWindowOpenHandler` (bruno-electron/src/index.js) reads
 * only `{ url }` and returns `{ action: 'deny' }` on every path — so the
 * button could never have produced a window. See the note in
 * AiChatSidebar/index.js for exactly what the main process must add before
 * the popout can come back.
 */
const initialState = {
  isOpen: false,
  chats: {}
};

const ensureChat = (state, tabUid) => {
  if (!state.chats[tabUid]) {
    state.chats[tabUid] = {
      conversationId: null,
      pathname: '',
      collectionUid: '',
      contentType: 'docs',
      messages: [],
      isLoading: false,
      error: null,
      currentRequestId: null,
      // Stamped on the first message and preserved through openConversation so
      // later saves don't rewrite it.
      createdAt: null,
      historyList: []
    };
  }
  return state.chats[tabUid];
};

export const aiSlice = createSlice({
  name: 'ai',
  initialState,
  reducers: {
    toggleAiPanel: (state) => {
      state.isOpen = !state.isOpen;
    },
    openAiPanel: (state) => {
      state.isOpen = true;
    },
    closeAiPanel: (state) => {
      state.isOpen = false;
    },
    setChatBinding: (state, action) => {
      const { tabUid, pathname, collectionUid, contentType } = action.payload;
      const chat = ensureChat(state, tabUid);
      chat.pathname = pathname || '';
      chat.collectionUid = collectionUid || '';
      if (contentType) chat.contentType = contentType;
    },
    startNewConversation: (state, action) => {
      const { tabUid, contentType, createdAt } = action.payload;
      const chat = ensureChat(state, tabUid);
      chat.conversationId = newConversationId();
      chat.messages = [];
      chat.error = null;
      chat.createdAt = typeof createdAt === 'number' ? createdAt : null;
      if (contentType) chat.contentType = contentType;
    },
    addAiMessage: (state, action) => {
      const { tabUid, message, timestamp } = action.payload;
      const chat = ensureChat(state, tabUid);
      if (!chat.conversationId) chat.conversationId = newConversationId();
      if (!chat.createdAt) chat.createdAt = timestamp || null;
      chat.messages.push(message);
    },
    setAiLoading: (state, action) => {
      const { tabUid, isLoading } = action.payload;
      ensureChat(state, tabUid).isLoading = isLoading;
    },
    setCurrentRequestId: (state, action) => {
      const { tabUid, requestId } = action.payload;
      ensureChat(state, tabUid).currentRequestId = requestId;
    },
    setAiError: (state, action) => {
      const { tabUid, error } = action.payload;
      ensureChat(state, tabUid).error = error;
    },
    updateAiStreamingMessage: (state, action) => {
      const { tabUid, content } = action.payload;
      const chat = state.chats[tabUid];
      const last = chat?.messages[chat.messages.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        last.content = content;
      }
    },
    addAiToolActivity: (state, action) => {
      const { tabUid, toolName, label } = action.payload;
      const chat = state.chats[tabUid];
      const last = chat?.messages[chat.messages.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        if (!last.toolActivity) last.toolActivity = [];
        last.toolActivity.push({
          toolName,
          label,
          done: false,
          textOffset: last.content?.length || 0
        });
      }
    },
    markAiToolActivityDone: (state, action) => {
      const { tabUid } = action.payload;
      const chat = state.chats[tabUid];
      const last = chat?.messages[chat.messages.length - 1];
      if (last?.role === 'assistant' && last.toolActivity) {
        for (let i = last.toolActivity.length - 1; i >= 0; i--) {
          if (!last.toolActivity[i].done) {
            last.toolActivity[i].done = true;
            break;
          }
        }
      }
    },
    finalizeAiStreamingMessage: (state, action) => {
      const { tabUid, content, code, originalCode, contentType, writes, requestChanges, workflowChanges, cancelled } = action.payload;
      const chat = state.chats[tabUid];
      const last = chat?.messages[chat.messages.length - 1];
      if (last?.role === 'assistant') {
        last.content = content;
        last.code = code;
        last.originalCode = originalCode;
        last.contentType = contentType || 'docs';
        last.writes = writes || null;
        // Structured request proposals travel beside the text writes: one turn
        // can legitimately create a request AND write its tests.
        last.requestChanges = requestChanges || null;
        last.workflowChanges = workflowChanges || null;
        last.isStreaming = false;
        last.cancelled = Boolean(cancelled);
      }
    },
    markAiMessageCodeStatus: (state, action) => {
      const { tabUid, messageIndex, status, writeIndex, requestChangeIndex, workflowChangeIndex } = action.payload;
      const message = state.chats[tabUid]?.messages[messageIndex];
      if (message?.role !== 'assistant') return;
      // Checked before writeIndex: a message can carry both, and a request
      // proposal accepted at index 0 must not mark the text write at index 0.
      if (requestChangeIndex !== undefined && message.requestChanges?.[requestChangeIndex]) {
        message.requestChanges[requestChangeIndex].status = status;
        return;
      }
      if (workflowChangeIndex !== undefined && message.workflowChanges?.[workflowChangeIndex]) {
        message.workflowChanges[workflowChangeIndex].status = status;
        return;
      }
      if (writeIndex !== undefined && message.writes?.[writeIndex]) {
        message.writes[writeIndex].status = status;
      } else {
        message.codeStatus = status;
      }
    },
    setChatHistoryList: (state, action) => {
      const { tabUid, historyList } = action.payload;
      ensureChat(state, tabUid).historyList = Array.isArray(historyList) ? historyList : [];
    },
    replaceChatMessages: (state, action) => {
      const { tabUid, conversationId, messages, contentType, createdAt } = action.payload;
      const chat = ensureChat(state, tabUid);
      chat.conversationId = conversationId;
      chat.messages = messages || [];
      chat.error = null;
      chat.createdAt = typeof createdAt === 'number' ? createdAt : null;
      if (contentType) chat.contentType = contentType;
    }
  },
  extraReducers: (builder) => {
    builder.addCase(closeTabs, (state, action) => {
      const tabUids = action.payload.tabUids || [];
      tabUids.forEach((uid) => {
        delete state.chats[uid];
      });
    });
  }
});

export const {
  toggleAiPanel,
  openAiPanel,
  closeAiPanel,
  setChatBinding,
  startNewConversation,
  addAiMessage,
  setAiLoading,
  setCurrentRequestId,
  setAiError,
  updateAiStreamingMessage,
  addAiToolActivity,
  markAiToolActivityDone,
  finalizeAiStreamingMessage,
  markAiMessageCodeStatus,
  setChatHistoryList,
  replaceChatMessages
} = aiSlice.actions;

const persistChat = async (chat) => {
  if (!chat?.conversationId || !chat.pathname) return;
  return saveConversation({
    id: chat.conversationId,
    pathname: chat.pathname,
    collectionUid: chat.collectionUid,
    contentType: chat.contentType,
    messages: chat.messages,
    createdAt: chat.createdAt
  });
};

/** Refresh the cached history list for a tab from IndexedDB. */
export const refreshChatHistory = (tabUid) => async (dispatch, getState) => {
  const chat = getState().ai?.chats?.[tabUid];
  if (!chat?.pathname) {
    dispatch(setChatHistoryList({ tabUid, historyList: [] }));
    return;
  }
  const list = await listConversationsForPath(chat.pathname);
  dispatch(setChatHistoryList({ tabUid, historyList: list }));
};

/** Load a saved conversation into a tab. */
export const openConversation = (tabUid, conversationId) => async (dispatch) => {
  const record = await loadConversation(conversationId);
  if (!record) return;
  dispatch(
    replaceChatMessages({
      tabUid,
      conversationId: record.id,
      messages: record.messages || [],
      contentType: record.contentType,
      createdAt: record.createdAt
    })
  );
};

/** Delete a saved conversation. If it's the active one, also start fresh. */
export const removeConversation = (tabUid, conversationId) => async (dispatch, getState) => {
  await deleteConversation(conversationId);
  const chat = getState().ai?.chats?.[tabUid];
  if (chat?.conversationId === conversationId) {
    dispatch(startNewConversation({ tabUid, contentType: chat.contentType }));
  }
  await dispatch(refreshChatHistory(tabUid));
};

/** Save the current conversation immediately. */
export const persistCurrentConversation = (tabUid) => async (_dispatch, getState) => {
  const chat = getState().ai?.chats?.[tabUid];
  if (chat) await persistChat(chat);
};

/**
 * Start a chat turn. Refuses to do anything unless `ai.enabled` is true —
 * this is the last renderer-side gate before the main process is asked to
 * talk to a provider, and it holds even if a caller forgets to check.
 */
export const sendAiMessage
  = (tabUid, userMessage, allContent, requestContext, model, contentType = 'docs', variables = [], requests = [], workflow = null) =>
    async (dispatch, getState) => {
      const state = getState();
      if (!get(state, 'app.preferences.ai.enabled', false)) return;

      const { ipcRenderer } = window;
      if (!ipcRenderer) return;

      // Reject overlapping sends for the same tab. The slice tracks one
      // currentRequestId per tab and the chunk/tool reducers mutate the last
      // assistant message, so a concurrent send would interleave into the same
      // streaming entry and only the latest stop would target a controller.
      const existingChat = state.ai.chats[tabUid];
      if (existingChat?.currentRequestId || existingChat?.isLoading) return;

      const now = Date.now();
      const requestId = `${tabUid}-${now}`;

      const priorMessages = (existingChat?.messages || [])
        .filter((m) => !m.isStreaming)
        .map((m) => ({ role: m.role, content: m.content }));

      dispatch(addAiMessage({ tabUid, message: { role: 'user', content: userMessage }, timestamp: now }));
      dispatch(addAiMessage({ tabUid, message: { role: 'assistant', content: '', isStreaming: true }, timestamp: now }));
      dispatch(setAiLoading({ tabUid, isLoading: true }));
      dispatch(setCurrentRequestId({ tabUid, requestId }));
      dispatch(setAiError({ tabUid, error: null }));

      return new Promise((resolve, reject) => {
        const handleChunk = (data) => {
          if (data.requestId !== requestId) return;
          dispatch(updateAiStreamingMessage({ tabUid, content: data.fullText }));
        };

        const handleToolActivity = (data) => {
          if (data.requestId !== requestId) return;
          dispatch(addAiToolActivity({ tabUid, toolName: data.toolName, label: data.label }));
        };

        const handleToolDone = (data) => {
          if (data.requestId !== requestId) return;
          dispatch(markAiToolActivityDone({ tabUid }));
        };

        const finishLifecycle = async (final) => {
          dispatch(finalizeAiStreamingMessage(final));
          dispatch(setAiLoading({ tabUid, isLoading: false }));
          dispatch(setCurrentRequestId({ tabUid, requestId: null }));
          cleanup();
          // Persist after the reducer has applied so we capture the final state.
          await dispatch(persistCurrentConversation(tabUid));
          await dispatch(refreshChatHistory(tabUid));
        };

        const handleComplete = async (data) => {
          if (data.requestId !== requestId) return;
          let resolvedType;
          let resolvedOriginalCode;
          if (data.writes && data.writes.length > 0) {
            const primary = data.writes[data.writes.length - 1];
            resolvedType = primary.type;
            resolvedOriginalCode = primary.originalContent;
          } else {
            resolvedType = data.contentType || contentType;
            resolvedOriginalCode = typeof allContent === 'object' ? allContent[resolvedType] || '' : allContent;
          }
          await finishLifecycle({
            tabUid,
            content: data.message,
            code: data.code,
            originalCode: resolvedOriginalCode,
            contentType: resolvedType,
            writes: data.writes || null,
            requestChanges: data.requestChanges || null,
            workflowChanges: data.workflowChanges || null
          });
          resolve();
        };

        const handleStopped = async (data) => {
          if (data.requestId !== requestId) return;
          const original = typeof allContent === 'object' ? allContent[contentType] || '' : allContent;
          await finishLifecycle({
            tabUid,
            content: data.message,
            code: null,
            originalCode: original,
            contentType,
            cancelled: true
          });
          resolve();
        };

        const handleError = (data) => {
          if (data.requestId !== requestId) return;
          // Finalize the streaming placeholder so the UI doesn't stay stuck on
          // "Thinking…"; the error itself surfaces through setAiError.
          const original = typeof allContent === 'object' ? allContent[contentType] || '' : allContent;
          dispatch(
            finalizeAiStreamingMessage({
              tabUid,
              content: '',
              code: null,
              originalCode: original,
              contentType,
              cancelled: true
            })
          );
          dispatch(setAiError({ tabUid, error: data.error }));
          dispatch(setAiLoading({ tabUid, isLoading: false }));
          dispatch(setCurrentRequestId({ tabUid, requestId: null }));
          cleanup();
          reject(new Error(data.error));
        };

        const unsubs = [
          ipcRenderer.on('main:ai-chat-chunk', handleChunk),
          ipcRenderer.on('main:ai-chat-tool-activity', handleToolActivity),
          ipcRenderer.on('main:ai-chat-tool-done', handleToolDone),
          ipcRenderer.on('main:ai-chat-complete', handleComplete),
          ipcRenderer.on('main:ai-chat-stopped', handleStopped),
          ipcRenderer.on('main:ai-chat-error', handleError)
        ];
        const cleanup = () => unsubs.forEach((u) => u && u());

        const messages = [...priorMessages, { role: 'user', content: userMessage }];
        const normalizedContent = typeof allContent === 'object' ? allContent : { [contentType]: allContent };

        // THE EXIT. Everything the chat surface can send leaves through this one
        // call, and it leaves through the gate — including a `requestContext`,
        // `variables` or `requests` a caller hand-rolled instead of using the
        // builders above, and including any context key added here later.
        ipcRenderer.send(
          'renderer:ai-chat-stream',
          scrubAiOutboundPayload({
            messages,
            allContent: normalizedContent,
            contentType,
            requestContext,
            variables,
            requests,
            // Not in OUTBOUND_VERBATIM_KEYS on purpose: a workflow carries
            // setvars values and script code the user typed, so it goes through
            // the same masking as everything else here.
            workflow,
            requestId,
            model
          })
        );
      });
    };

export const stopAiStream = (tabUid) => (_dispatch, getState) => {
  const { ipcRenderer } = window;
  const requestId = getState().ai?.chats?.[tabUid]?.currentRequestId;
  if (ipcRenderer && requestId) {
    ipcRenderer.send('renderer:ai-chat-stop', { requestId });
  }
};

/**
 * Update the accept/reject status of a diff and persist it so the status
 * survives a restart.
 */
export const setMessageCodeStatus = (params) => async (dispatch) => {
  dispatch(markAiMessageCodeStatus(params));
  await dispatch(persistCurrentConversation(params.tabUid));
};

export default aiSlice.reducer;
