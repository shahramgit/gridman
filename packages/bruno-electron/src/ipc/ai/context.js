/**
 * Shared context formatting + redaction primitives used by every AI surface
 * that ships. That is now exactly one: the chat sidebar. (Script generation
 * was cut with the AIAssist component it served; ghost-text autocomplete was
 * cut because its two IPC channels had no caller in packages/bruno-app/src.)
 *
 * Everything that goes to a provider passes through this module so the rules
 * (which header names are sensitive, how response bodies are stripped, how a
 * variable marked `secret: true` appears) stay consistent across surfaces.
 */

const { foldSearchText } = require('@usebruno/common');

// --- Sensitive header / param / variable names ---------------------------

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-access-token$/i,
  /^x-csrf-token$/i,
  /api[_-]?key/i,
  // Catches refresh_token, id_token, csrfToken, plain TOKEN, etc. on top of
  // the specific access/auth-token forms above.
  /token/i,
  /access[_-]?token/i,
  /auth[_-]?token/i,
  /secret/i,
  /password/i,
  // WSSE. Our network layer emits `X-WSSE` for the WSSE auth mode
  // (prepare-request.js) and its value carries a PasswordDigest + Nonce
  // derived from the user's password. None of the patterns above match it —
  // the name contains no "token"/"auth"/"secret"/"key" substring — so without
  // this entry a WSSE-authenticated request would ship its credential to the
  // model. Substring (not anchored) so `X-WSSE-Nonce`-style variants are
  // caught too.
  /wsse/i
];

const REDACTED_VALUE = '<redacted>';

const isSensitiveName = (name) => {
  if (!name) return false;
  return SENSITIVE_HEADER_PATTERNS.some((re) => re.test(name));
};

const maskValue = (name, value) => (isSensitiveName(name) ? REDACTED_VALUE : value);

/**
 * Fold a user-supplied name the way the rest of this fork folds search text
 * (@usebruno/common/search-fold): NFC, lowercase, and Persian/Arabic letter
 * variants unified.
 *
 * Without this, a Persian header or variable name typed with ARABIC YEH
 * (U+064A) does not compare equal to the same name typed with FARSI YEH
 * (U+06CC) — they are indistinguishable on screen. The user adds a name to
 * `customRedactedVariables`, sees it listed, and the redaction silently never
 * fires. Same for ARABIC KAF vs KEHEH, and for a name stored NFD.
 */
const foldName = (name) => foldSearchText(String(name ?? '').trim());

const normalizeList = (list) =>
  Array.isArray(list)
    ? list.map((s) => foldName(s)).filter(Boolean)
    : [];

/**
 * A redaction policy.
 *
 * FAIL-CLOSED DESIGN NOTE — the `redact*` toggles can no longer switch OFF
 * credential-name redaction; they only widen it. Previously each toggle was
 * all-or-nothing for its channel, so `redactResponse: false` printed
 * `"access_token": "sk-live-…"` verbatim and `redactHeaders: false` printed
 * every Authorization header. A user who wanted to show the model one ordinary
 * field had to also expose every secret in the same channel.
 *
 * Now name-based redaction (`authorization`, `*_token`, `*secret*`,
 * `password`, X-WSSE, plus the user's custom lists) is UNCONDITIONAL, and the
 * toggles control only the broader behaviour on top of it:
 *   - `redactResponse: true`  -> every response value becomes a type placeholder
 *     `redactResponse: false` -> real values, credential-named keys still masked
 *   - `redactHeaders` / `redactBody` / `redactVariables` no longer have an
 *     "off" that exposes credentials. They are kept in the schema and the UI,
 *     and are still read here, but they can only be a no-op or a restriction.
 */
const buildRedactionPolicy = (security) => {
  const redactHeaders = security?.redactHeaders !== false;
  const redactBody = security?.redactBody !== false;
  const redactVariables = security?.redactVariables !== false;
  const redactResponse = security?.redactResponse !== false;
  const customHeaderSet = new Set(normalizeList(security?.customRedactedHeaders));
  const customVarSet = new Set(normalizeList(security?.customRedactedVariables));

  return {
    redactHeaders,
    redactBody,
    redactVariables,
    redactResponse,
    isSensitiveHeader: (name) => {
      if (!name) return false;
      if (customHeaderSet.has(foldName(name))) return true;
      return isSensitiveName(name);
    },
    // Body checks reuse the header list — custom entries are matched exactly,
    // so a user who adds `password` here also catches JSON keys named the same.
    isSensitiveKey: (name) => {
      if (!name) return false;
      if (customHeaderSet.has(foldName(name))) return true;
      return isSensitiveName(name);
    },
    isCustomVariable: (name) => Boolean(name) && customVarSet.has(foldName(name)),
    matchesVariablePattern: (name) => Boolean(name) && isSensitiveName(name)
  };
};

const DEFAULT_POLICY = buildRedactionPolicy(null);

// --- Response body shape redaction ---------------------------------------

const REDACTED_TRUNCATED = '<truncated>';
const REDACTED_NULL = '<null>';
const REDACTED_BY_TYPE = {
  string: '<string>',
  number: '<number>',
  boolean: '<boolean>',
  bigint: '<bigint>'
};

const REDACTION_NOTICE = 'Values are placeholders (`<string>`, `<number>`, …). The shape, keys, and types are accurate but no real data is shown. Reference fields by path in generated code — do not hard-code these placeholders as literal values.';

const redactResponseValues = (data, depth = 0, maxDepth = 6) => {
  if (data === null || data === undefined) return REDACTED_NULL;
  if (depth >= maxDepth) return REDACTED_TRUNCATED;

  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    // Cap sample size — long arrays only need a few items to convey shape.
    const sampleSize = Math.min(data.length, 3);
    const out = data.slice(0, sampleSize).map((item) => redactResponseValues(item, depth + 1, maxDepth));
    if (data.length > sampleSize) out.push(`<${data.length - sampleSize} more items>`);
    return out;
  }

  if (typeof data === 'object') {
    const keys = Object.keys(data);
    const out = {};
    for (const key of keys.slice(0, 30)) {
      // The KEY is server-chosen data too — see maskCredentialShapedName. This
      // mode promises "no real data is shown"; an unmasked key broke that.
      out[maskedObjectKey(out, key)] = redactResponseValues(data[key], depth + 1, maxDepth);
    }
    if (keys.length > 30) out['...'] = `<${keys.length - 30} more keys>`;
    return out;
  }

  return REDACTED_BY_TYPE[typeof data] || '<unknown>';
};

const RESPONSE_RAW_BODY_MAX_CHARS = 8000;

/**
 * What we say instead of sending content we could not redact.
 *
 * The rule (fail-closed): Gridman only sends a body it can parse into fields
 * and mask field-by-field. Anything else — an XML body, a SPARQL query, a text
 * body, a JSON body too malformed to parse — is described, not shipped. The
 * model still gets the method, URL, headers, params and docs, which is enough
 * to write a script against.
 */
const withheldNotice = (kind, length) =>
  `not sent — ${length} characters of ${kind}. Gridman only shares a body it can parse and redact `
  + 'field by field; this one could not be parsed, so its contents were withheld.';

const formatResponseShape = (status, data, opts = {}) => {
  if (!status && data == null) return '';
  const policy = buildRedactionPolicy(opts.security);
  const parts = [];
  if (status) parts.push(`**Last Response Status:** ${status}`);

  if (data != null) {
    let parsed = data;
    let parsedOk = false;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data); parsedOk = true;
      } catch { parsedOk = false; }
    } else if (typeof data === 'object') {
      parsedOk = true;
    }

    if (parsedOk) {
      if (policy.redactResponse) {
        const redacted = redactResponseValues(parsed);
        if (redacted != null) {
          parts.push(`**Response Shape (values redacted — ${REDACTION_NOTICE}):**\n\`\`\`json\n${JSON.stringify(redacted, null, 2)}\n\`\`\``);
        }
      } else {
        // The user opted out of value-blanking, NOT out of credential
        // protection. Send real values but still mask credential-named keys —
        // this switch used to print `"access_token": "sk-live-…"` in full.
        const raw = JSON.stringify(redactJsonBodyValues(parsed, policy), null, 2);
        const truncated = raw.length > RESPONSE_RAW_BODY_MAX_CHARS;
        const shown = truncated ? `${raw.slice(0, RESPONSE_RAW_BODY_MAX_CHARS)}…` : raw;
        parts.push(`**Response Body (credential fields redacted):**\n\`\`\`json\n${shown}\n\`\`\`${truncated ? '\n\n(truncated)' : ''}`);
      }
    } else if (typeof data === 'string' && data.trim()) {
      // Not parseable, so it cannot be redacted field-by-field. Withheld
      // whatever the toggle says: turning off value-blanking asks for less
      // masking, not for an unredactable blob to be shipped whole.
      parts.push(`**Response:** ${withheldNotice('non-JSON', data.length)}`);
    }
  }

  return parts.join('\n\n');
};

/**
 * Walk a JSON-shaped value and replace primitive values whose KEY is sensitive
 * (`password`, `*_token`, `secret`, etc.) with `<redacted>`. Keeps the shape
 * intact so the model can still see the body's structure and field names.
 *
 * Differs from `redactResponseValues` (which replaces ALL primitives with
 * type placeholders): we DO want the model to see non-sensitive request body
 * values so it can write code that references them correctly.
 *
 * A leaf that survives the key check is then shape-tested, because a key like
 * `session` or `sid` is not credential-NAMED but routinely holds a credential.
 */
const redactJsonBodyValues = (data, policy, depth = 0, maxDepth = 8) => {
  if (data === null || data === undefined) return data;
  if (depth >= maxDepth) return REDACTED_TRUNCATED;
  if (Array.isArray(data)) return data.map((item) => redactJsonBodyValues(item, policy, depth + 1, maxDepth));
  if (typeof data === 'object') {
    const out = {};
    for (const key of Object.keys(data)) {
      // Policy questions are asked of the ORIGINAL key; only what we PRINT is
      // masked. Masking first would make `<redacted>` the name every rule sees.
      const outKey = maskedObjectKey(out, key);
      if (policy.isSensitiveKey(key)) {
        out[outKey] = REDACTED_VALUE;
      } else {
        out[outKey] = redactJsonBodyValues(data[key], policy, depth + 1, maxDepth);
      }
    }
    return out;
  }
  return isCredentialShapedValue(data) ? REDACTED_VALUE : data;
};

/**
 * Bruno bodies routinely contain `{{templating}}`, which is not valid JSON —
 * `{"user": "{{username}}"}` parses, `{"n": {{count}}}` does not. Before the
 * template era this made "unparseable" an edge case; here it is the COMMON
 * case, and the old code answered it by sending the body verbatim.
 *
 * So: substitute each `{{...}}` for an inert token, parse, redact by key, then
 * put the templates back. Tokens inside a value that got masked simply vanish
 * with it. If the substituted text still will not parse, we withhold the body
 * rather than guess.
 */
const TEMPLATE_TOKEN_PREFIX = '__BRU_AI_TPL_';
const TEMPLATE_TOKEN_SUFFIX = '__';
const TEMPLATE_PATTERN = /\{\{[^{}]*\}\}/g;
const TEMPLATE_TOKEN_PATTERN = new RegExp(`${TEMPLATE_TOKEN_PREFIX}(\\d+)${TEMPLATE_TOKEN_SUFFIX}`, 'g');

const parseTemplatedJson = (raw) => {
  try {
    return { ok: true, value: JSON.parse(raw), restore: (s) => s };
  } catch {
    // fall through to the template-tolerant attempt
  }

  // If the body already contains our token shape we cannot tell ours apart
  // from theirs on the way back. Refuse rather than corrupt/leak.
  if (raw.includes(TEMPLATE_TOKEN_PREFIX)) return { ok: false };

  const templates = [];
  const substituted = raw.replace(TEMPLATE_PATTERN, (match) => {
    const token = `${TEMPLATE_TOKEN_PREFIX}${templates.length}${TEMPLATE_TOKEN_SUFFIX}`;
    templates.push(match);
    return token;
  });
  if (!templates.length) return { ok: false };

  try {
    const value = JSON.parse(substituted);
    return {
      ok: true,
      value,
      restore: (s) => s.replace(TEMPLATE_TOKEN_PATTERN, (whole, index) => templates[Number(index)] ?? whole)
    };
  } catch {
    return { ok: false };
  }
};

const redactJsonBodyString = (raw, policy = DEFAULT_POLICY) => {
  if (typeof raw !== 'string' || !raw.trim()) return raw || '';
  const parsed = parseTemplatedJson(raw);
  if (!parsed.ok) {
    // FAIL CLOSED. Previously this returned `raw` — the whole body, including
    // any credential the key-based pass would have masked had it parsed.
    return `[json ${withheldNotice('json', raw.length)}]`;
  }
  return parsed.restore(JSON.stringify(redactJsonBodyValues(parsed.value, policy), null, 2));
};

// Body modes whose content is free-form text we cannot decompose into fields.
// There is no key to match a credential against, so nothing is sent.
const OPAQUE_BODY_MODES = { text: 'text', xml: 'xml', sparql: 'sparql' };

// --- Credential-SHAPED tokens (no name to match on) ----------------------

/**
 * Some credentials carry no name the rules above can match on:
 *
 *   https://hooks.internal.example/services/T000/B000/sk-live-AAAAAAAAAAAA
 *   https://app/callback#access_token=…            (OAuth2 implicit grant)
 *   X-Trace-Id: sk-live-AAAAAAAAAAAA               (innocuous NAME, secret VALUE)
 *
 * Redacting whole paths or whole header tables instead would gut the feature —
 * the model needs `/v1/users/{id}` and `Accept: application/json` to write code
 * — so this is a deliberately CONSERVATIVE shape detector, applied per token.
 *
 * It runs on BOTH sides of the name/value split, and that symmetry is the
 * point: it used to run on URL path segments, query values and fragment tokens
 * ONLY, so `?sid=sk-live-…` in the URL was masked while the very same
 * credential in the headers table, the query/path parameter tables, a form
 * field, a JSON body leaf or a variable value went out verbatim under an
 * innocuous name. See `isCredentialShapedValue` below for the value side.
 *
 * A token is treated as a credential when EITHER:
 *
 *  (a) it carries a well-known credential prefix (`sk-`, `ghp_`, `xox…`,
 *      `AKIA…`, `eyJ` = the base64 of a JWT header, `AIza`, `glpat-`, …), or
 *  (b) it is long (>= 24 chars), drawn only from the URL-safe token charset,
 *      is not word-like, and is high-entropy: mixed case or letters+digits at
 *      >= 3.0 bits/char, 32+ hex characters, or >= 4.0 bits/char outright.
 *
 * KNOWN LIMITS, stated rather than papered over:
 *  - A short credential with no recognisable prefix (an 8-character PIN, a
 *    numeric account id used as a bearer) is NOT detected. Nothing
 *    distinguishes it from an ordinary id, and flagging every short segment
 *    would redact every URL in the collection.
 *  - A long all-lowercase-alphabetic secret is only caught above 4.0
 *    bits/char, because that is also the shape of a slug.
 *  - Conversely, opaque ids that are NOT secrets (a UUID, a 32-hex object id)
 *    ARE masked. That is the fail-closed direction: the model loses an
 *    identifier it would not have hard-coded anyway, and a session id parked
 *    in a path does not leave the machine.
 *  - `{{templates}}` are never flagged — the value is not in the string.
 */
const CREDENTIAL_TOKEN_PREFIXES = [
  /^sk-/i, // OpenAI, Stripe secret keys, and the sk-live-… family
  /^sk_/i,
  /^rk_live/i,
  /^pk_live/i,
  /^gh[pousr]_/, // GitHub personal / oauth / user / server / refresh
  /^github_pat_/,
  /^glpat-/, // GitLab
  /^xox[abposr]/, // Slack bot/user/app/legacy tokens
  /^xapp-/,
  /^(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{6,}$/, // AWS access key ids
  /^AIza/, // Google API key
  /^ya29\./, // Google OAuth access token
  /^eyJ/, // base64("{\"…") — a JWT / any b64-encoded JSON header
  /^hf_/, // HuggingFace
  /^npm_/,
  /^dckr_pat_/,
  /^shpat_/, // Shopify
  /^sq0(atp|csp)-/ // Square
];

const CREDENTIAL_MIN_LENGTH = 24;
const CREDENTIAL_TOKEN_CHARSET = /^[A-Za-z0-9_\-~.=+/]+$/;
const LONG_HEX = /^[0-9a-fA-F]{32,}$/;

const shannonEntropy = (text) => {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

// Split on separators AND camelCase humps, so `GetUserByIdentifier` reads as
// four words rather than one high-entropy blob.
const splitIntoWords = (token) =>
  token
    .split(/[-_.~=+/]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);

/**
 * `reports-quarterly-summary-2024`, `GetUserProfileByIdentifier` — long, mixed
 * case, but plainly a route name. Word-like means every piece is a word, an
 * acronym or a small number, AND the average word is >= 3 characters (which
 * `AbCdEfGhIj…` fails, so a secret cannot hide behind alternating case).
 */
const isWordLike = (token) => {
  const words = splitIntoWords(token);
  if (!words.length) return false;
  const allWordShaped = words.every(
    (w) => w.length <= 20 && (/^[A-Za-z][a-z]*$/.test(w) || /^[0-9]{1,8}$/.test(w) || /^[A-Z]{1,5}$/.test(w))
  );
  if (!allWordShaped) return false;
  const alphabetic = words.filter((w) => /[A-Za-z]/.test(w));
  if (!alphabetic.length) return true;
  return alphabetic.reduce((sum, w) => sum + w.length, 0) / alphabetic.length >= 3;
};

const isCredentialShapedToken = (token) => {
  if (typeof token !== 'string' || !token) return false;
  // A template is a reference, not a value.
  if (token.includes('{{')) return false;
  if (CREDENTIAL_TOKEN_PREFIXES.some((re) => re.test(token))) return true;
  if (token.length < CREDENTIAL_MIN_LENGTH) return false;
  if (!CREDENTIAL_TOKEN_CHARSET.test(token)) return false;
  if (LONG_HEX.test(token)) return true;
  if (isWordLike(token)) return false;

  const entropy = shannonEntropy(token);
  const hasDigit = /[0-9]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  if ((hasDigit && (hasLower || hasUpper)) || (hasLower && hasUpper)) {
    if (entropy >= 3.0) return true;
  }
  return entropy >= 4.0;
};

/**
 * The VALUE side of the detector: is this field value credential-shaped?
 *
 * A whole-string test is not enough, because the credential is usually one
 * token inside a longer value — `Authorization: Bearer sk-live-…` is the
 * canonical shape, and `Bearer sk-live-…` fails the charset test as a single
 * string (it contains a space). So the value is split on the separators that
 * actually appear in header and form values and each token is tested on its
 * own. One credential-shaped token masks the WHOLE value: the surrounding
 * scheme word carries nothing the model needs, and a partial mask would invite
 * a "which half was the secret" reconstruction.
 *
 * Template tokens are skipped, for the same reason `isCredentialShapedToken`
 * skips `{{…}}`: the value is not in the string. `TEMPLATE_TOKEN_PREFIX` is the
 * inert stand-in `parseTemplatedJson` substitutes before parsing, so a body
 * mid-substitution must not be flagged on the shape of our own placeholder.
 */
const CREDENTIAL_VALUE_SEPARATORS = /[\s,;]+/;

const isCredentialShapedValue = (value) => {
  if (typeof value !== 'string' || !value) return false;
  for (const token of value.trim().split(CREDENTIAL_VALUE_SEPARATORS)) {
    if (!token || token.includes(TEMPLATE_TOKEN_PREFIX)) continue;
    if (isCredentialShapedToken(token)) return true;
  }
  return false;
};

/**
 * Mask a value whose NAME was innocuous but whose SHAPE is a credential.
 * Non-strings pass through untouched — only a string can be shape-tested.
 */
const maskCredentialShapedValue = (value) => {
  const text = value ?? '';
  return isCredentialShapedValue(text) ? REDACTED_VALUE : text;
};

/**
 * THE OTHER AXIS. Mask a NAME — a JSON object key, a header name, a form field
 * name, a variable name — whose own text is credential-shaped.
 *
 * THE BUG THIS EXISTS FOR, reproduced against the shipped chat surface with
 * STRICT (default) preferences:
 *
 *     responseData = { "sk-live-AAAABBBBCCCCDDDD": { seen: 1 } }
 *
 *   **Response Shape (values redacted — … no real data is shown):**
 *   { "sk-live-AAAABBBBCCCCDDDD": { "seen": "<number>" } }
 *
 * Every rule in this module ran on ONE side of the name/value split: the value
 * was masked when its name looked sensitive (`isSensitiveKey`) AND when its own
 * shape looked like a credential (`maskCredentialShapedValue`), while the name
 * itself was copied through verbatim at every emitter — JSON keys in both body
 * walkers, and the header / query / path / form / variable tables. A key is not
 * metadata; in a captured response body it is data the server chose, and an
 * object keyed by token is an ordinary API shape. The URL path/query emitters
 * already tested the name side (`redactParamPiece`), so this is that same rule
 * applied everywhere else rather than a new policy.
 *
 * SAME DETECTOR, DELIBERATELY. `isCredentialShapedValue` is what the value side
 * uses, so there is one definition of "credential-shaped" and one place to fix
 * it. Its ASCII charset test also means a Persian, Arabic or CJK field name can
 * never be flagged, whatever its length or entropy.
 *
 * COST, stated: an ordinary field name that is long, mixed-case and carries a
 * digit — `userAuthenticationToken12345` — is masked too, and the model loses
 * it. That is the fail-closed direction this module already takes for UUIDs and
 * object ids, and the name it costs us is one no script should hard-code.
 */
const maskCredentialShapedName = (name) => {
  const text = String(name ?? '');
  return isCredentialShapedValue(text) ? REDACTED_VALUE : text;
};

/**
 * The object-key form. Masking keys can COLLIDE — two distinct credential keys
 * both become `<redacted>` and the second silently overwrites the first, which
 * turns redaction into data loss and hides from the model that there were two
 * fields at all. Number the repeats instead.
 */
const maskedObjectKey = (out, key) => {
  const masked = maskCredentialShapedName(key);
  if (masked === key || !Object.prototype.hasOwnProperty.call(out, masked)) return masked;
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(out, `${REDACTED_VALUE} ${n}`)) n += 1;
  return `${REDACTED_VALUE} ${n}`;
};

// --- Request URL ---------------------------------------------------------

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
};

/**
 * Is the text after the `@` shaped like a host?
 *
 * Only consulted for the SCHEMELESS form (see redactUserInfo). A single label
 * — `internal`, `localhost` — counts only when a path/query/fragment follows
 * it, because `a:b@c` on its own is far more often ordinary text than a URL.
 * With no delimiter after it, the authority has to be dotted (or a bracketed
 * IPv6 literal, or a `{{template}}`) to qualify.
 */
const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST_PREFIX = `(?:\\{\\{[^{}]*\\}\\}|\\[[0-9A-Fa-f:.]+\\]|${HOST_LABEL}`;
const HOST_SUFFIX = ')(?::\\d{1,5})?$';
// `(?:\.label)*` — a single label is enough when a path follows.
const HOST_BEFORE_PATH = new RegExp(`^${HOST_PREFIX}(?:\\.${HOST_LABEL})*${HOST_SUFFIX}`);
// `(?:\.label)+` — with nothing after it, the authority must be dotted.
const HOST_ALONE = new RegExp(`^${HOST_PREFIX}(?:\\.${HOST_LABEL})+${HOST_SUFFIX}`);

const isHostShaped = (rest) => {
  const authority = rest.split(/[/?#]/)[0];
  if (!authority) return false;
  return authority.length < rest.length
    ? HOST_BEFORE_PATH.test(authority)
    : HOST_ALONE.test(authority);
};

/**
 * Mask the password half of `user:password@host`.
 *
 * The scheme is OPTIONAL. A Bruno URL is frequently written without one
 * (`user:pass@internal/v1`, `{{creds}}@host`), and anchoring on `scheme://`
 * meant those went out verbatim. Requires a literal `:` so `alice@host` — a
 * username, no secret — is left alone.
 *
 * The schemeless branch is the aggressive one, so it additionally requires the
 * right-hand side to be host-shaped. Without that check ANY `x:y@z` run in
 * formatter output matched: `{"a":"b:c@d"}` came out as `{"a":"b:<redacted>@d"}`
 * and `12:30@office` as `12:<redacted>@office`. Cosmetic, but it corrupted
 * ordinary JSON and prose on its way to the model. `https://` on the front is
 * unambiguous enough on its own, so the scheme'd branch is unchanged.
 */
const redactUserInfo = (base) => {
  const match = base.match(/^([a-zA-Z][\w+.-]*:\/\/)?([^/?#@:]+):([^/?#@]*)@/);
  if (!match) return base;
  const [whole, scheme, user] = match;
  const rest = base.slice(whole.length);
  if (!scheme && !isHostShaped(rest)) return base;
  return `${scheme || ''}${user}:${REDACTED_VALUE}@${rest}`;
};

/** Index where the path begins, or -1. Handles schemeless and templated URLs. */
const pathStartIndex = (base) => {
  const schemeAt = base.indexOf('://');
  const from = schemeAt !== -1
    ? schemeAt + 3
    : (base.indexOf('@') !== -1 ? base.indexOf('@') + 1 : 0);
  const slash = base.indexOf('/', from);
  return slash === -1 ? -1 : slash;
};

const redactPathSegments = (base) => {
  const at = pathStartIndex(base);
  if (at === -1) return base;
  const authority = base.slice(0, at);
  const path = base.slice(at);
  return authority + path
    .split('/')
    .map((segment) => (isCredentialShapedToken(segment) ? REDACTED_VALUE : segment))
    .join('/');
};

/**
 * Redact one `name=value` piece of a query string or fragment.
 *
 * Two independent reasons to mask: the NAME is credential-shaped (the same
 * rules as the headers table), or the VALUE is credential-shaped even though
 * the name is innocuous (`?t=eyJhbGci…`, `?state=ghp_…`).
 */
const redactParamPiece = (piece, policy) => {
  if (!piece) return piece;
  const eq = piece.indexOf('=');
  if (eq === -1) {
    // A valueless piece. Nothing to leak UNLESS the piece is itself the
    // credential — `#sk-live-…` is a real shape.
    return isCredentialShapedToken(safeDecode(piece)) ? REDACTED_VALUE : piece;
  }
  const name = piece.slice(0, eq);
  const value = piece.slice(eq + 1);
  if (policy.isSensitiveHeader(safeDecode(name))) return `${name}=${REDACTED_VALUE}`;
  if (isCredentialShapedToken(safeDecode(value))) return `${name}=${REDACTED_VALUE}`;
  return piece;
};

// `&` AND `;` are both parameter separators in practice (the HTML spec has
// recommended accepting `;` since forever, and plenty of servers emit it).
// Splitting on `&` alone left `?a=1;api_key=SECRET` completely unredacted.
// The replace form preserves whichever separator was used.
const redactParamString = (text, policy) =>
  text.replace(/[^&;]+/g, (piece) => redactParamPiece(piece, policy));

/**
 * Redact credentials carried IN THE URL.
 *
 * The bug this closes: the URL was emitted verbatim one line above the query
 * parameter table that masks the very same values by name, so
 * `https://api.example.com/v1/users?api_key=sk-live-SUPERSECRET` reached the
 * model in full while the table below it dutifully printed `<redacted>`.
 *
 * Every part of the URL is covered, because a credential has been observed in
 * every one of them:
 *   userinfo   `https://alice:hunter2@host`      -> password masked
 *   path       `/services/T0/B0/sk-live-…`       -> credential-shaped segments
 *   query      `?api_key=…`  and  `?a=1;key=…`   -> by name, and by value shape
 *   fragment   `#access_token=…`                 -> OAuth2 implicit grant
 *
 * Host, path names and non-secret parameters stay readable — the model needs
 * them to write code.
 *
 * Deliberately string-based rather than `new URL()`: a Bruno URL is usually
 * `{{baseUrl}}/v1/users?api_key={{key}}`, which `new URL()` rejects outright.
 * A parser that throws on the common case is a parser that redacts nothing.
 *
 * Idempotent: re-running it over its own output is a no-op, which is what lets
 * `scrubOutbound` below run unconditionally over already-redacted text.
 */
const redactUrl = (url, policy = DEFAULT_POLICY) => {
  if (typeof url !== 'string' || !url) return url || '';

  // Fragment first: it is last in the URL and may itself contain `?`.
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? null : url.slice(hashAt + 1);

  const queryAt = beforeHash.indexOf('?');
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? null : beforeHash.slice(queryAt + 1);

  let out = redactPathSegments(redactUserInfo(base));
  if (query !== null) out += `?${redactParamString(query, policy)}`;
  // The fragment used to be copied through verbatim. `#access_token=sk-live-…`
  // is the single most common way a real credential rides in a URL.
  if (fragment !== null) out += `#${redactParamString(fragment, policy)}`;
  return out;
};

// --- THE OUTBOUND CHOKEPOINT ---------------------------------------------

/**
 * Every formatter this module (and the prompt modules beside it) exposes to
 * the model is wrapped in `outbound()`. Two things happen there:
 *
 *  1. the produced string gets a final `redactUrl` pass over every URL-shaped
 *     run it contains, and
 *  2. the function is TAGGED, so a test can enumerate the module's exports and
 *     fail when a new formatter was added without going through here.
 *
 * WHY A WRAPPER AND NOT "REMEMBER TO CALL redactUrl": the previous round wired
 * redactUrl into `formatRequestContext` and three other emitters kept printing
 * URLs verbatim — the collection list inlined into EVERY chat message, the
 * list_requests / search_requests tool results, and autocomplete's own private
 * copy of the request formatter. A rule that has to be remembered at each new
 * call site is not a rule. Here the default is redacted and the work to bypass
 * it is deliberate.
 *
 * Scope, stated plainly: this covers the CONTEXT this module formats. It is
 * not applied to the user's own script/doc content that chat.js forwards —
 * rewriting a URL inside code the model is asked to return in full would hand
 * `<redacted>` back into the user's file. See README, "Verbatim channels".
 */
const OUTBOUND_GUARD = Symbol.for('gridman.ai.outboundGuarded');

// A URL-shaped run: a scheme, a `{{template}}` followed by a path/query, or a
// `user:pass@host` userinfo. `<redacted>` is matched explicitly so a second
// pass does not stop at the `<` of a marker the first pass wrote.
const URL_LIKE_RE = new RegExp(
  '(?:'
  + String.raw`[a-zA-Z][A-Za-z0-9+.\-]*:\/\/` // https://…
  + String.raw`|\{\{[^{}\s]*\}\}(?=[/?#])` // {{baseUrl}}/…
  + String.raw`|[A-Za-z0-9._\-]+:[^\s:@/"']+@` // user:pass@host
  + ')'
  + String.raw`(?:<redacted>|[^\s"'` + '`' + String.raw`<>()\[\]])*`,
  'g'
);

const scrubOutbound = (text, policy = DEFAULT_POLICY) => {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(URL_LIKE_RE, (run) => redactUrl(run, policy));
};

/**
 * Wrap a formatter so its output is scrubbed and its identity is checkable.
 *
 * `policyFrom` reads the caller's security preferences out of the SAME
 * arguments the formatter received, so the final pass applies the user's
 * `customRedactedHeaders` too and not merely the built-in patterns. Omit it
 * and the strict defaults are used.
 */
const outbound = (fn, policyFrom = null) => {
  const guarded = (...args) => {
    const security = policyFrom ? policyFrom(args) : null;
    return scrubOutbound(fn(...args), security ? buildRedactionPolicy(security) : DEFAULT_POLICY);
  };
  Object.defineProperty(guarded, 'name', { value: fn.name });
  guarded[OUTBOUND_GUARD] = true;
  return guarded;
};

const isOutboundGuarded = (fn) => typeof fn === 'function' && fn[OUTBOUND_GUARD] === true;

// --- Request context (method/url/headers/params/body/+response) ---------

/**
 * Format the renderer-supplied requestContext as Markdown for the model.
 *
 * @param {object} ctx { url, method, headers, params, body, docs,
 *                       responseStatus?, responseData? }
 * @param {object} opts
 *   includeBody      - include body (default true)
 *   bodyMaxChars     - truncate body to this many chars (default null = full)
 *   includeResponse  - inline the redacted response shape (default false)
 *   includeDocs      - include the request's docs field (default true)
 *   security         - user-configured redaction toggles (see
 *                      buildRedactionPolicy). Omit for strict defaults.
 */
const formatRequestContext = (ctx, opts = {}) => {
  const {
    includeBody = true,
    bodyMaxChars = null,
    includeResponse = false,
    includeDocs = true,
    security = null
  } = opts;
  if (!ctx) return '';
  const policy = buildRedactionPolicy(security);
  // Name-based masking is unconditional; see buildRedactionPolicy. When the
  // name is innocuous the VALUE is shape-tested, so `X-Trace-Id: sk-live-…`
  // and `?page=<32 hex>` in the tables below are caught the same way the same
  // credential is caught inside the URL string above them.
  const maskHeader = (name, value) =>
    (policy.isSensitiveHeader(name) ? REDACTED_VALUE : maskCredentialShapedValue(value));
  const maskFormField = (name, value) =>
    (policy.isSensitiveKey(name) ? REDACTED_VALUE : maskCredentialShapedValue(value));
  // The NAME column of every table below is user data too, and it was printed
  // verbatim while the value column beside it was masked three different ways.
  // See maskCredentialShapedName. The policy checks above still receive the
  // ORIGINAL name — only the printed text is masked.
  const showName = (name) => maskCredentialShapedName(name);
  const parts = [];

  if (ctx.url || ctx.method) {
    parts.push(`**Request:** ${ctx.method || 'GET'} ${redactUrl(ctx.url, policy)}`);
  }

  const headers = (ctx.headers || []).filter((h) => h?.enabled && h?.name);
  if (headers.length) {
    parts.push(`**Headers:**\n${headers.map((h) => `  ${showName(h.name)}: ${maskHeader(h.name, h.value)}`).join('\n')}`);
  }

  const params = (ctx.params || []).filter((p) => p?.enabled && p?.name);
  const query = params.filter((p) => p.type === 'query' || !p.type);
  const pathParams = params.filter((p) => p.type === 'path');
  if (query.length) {
    parts.push(`**Query Parameters:**\n${query.map((p) => `  ${showName(p.name)}: ${maskHeader(p.name, p.value)}`).join('\n')}`);
  }
  if (pathParams.length) {
    parts.push(`**Path Parameters:**\n${pathParams.map((p) => `  ${showName(p.name)}: ${maskHeader(p.name, p.value)}`).join('\n')}`);
  }

  const body = ctx.body;
  if (includeBody && body && body.mode && body.mode !== 'none') {
    let content = '';
    switch (body.mode) {
      // JSON bodies often contain fields like `password`, `client_secret`,
      // `refresh_token`. Redact by key so the model sees the structure but
      // not the secret values.
      case 'json': content = redactJsonBodyString(body.json || '', policy); break;
      // FAIL CLOSED. These three were emitted verbatim, and the redactBody
      // toggle did nothing for them: a bearer token pasted into an XML body or
      // a SPARQL literal went to the model in full. There is no field
      // structure to mask here, so we describe the body instead of sending it.
      case OPAQUE_BODY_MODES.text:
      case OPAQUE_BODY_MODES.xml:
      case OPAQUE_BODY_MODES.sparql: {
        const raw = body[body.mode] || '';
        content = raw.trim() ? `[${withheldNotice(body.mode, raw.length)}]` : '';
        break;
      }
      case 'formUrlEncoded': {
        const items = (body.formUrlEncoded || []).filter((p) => p.enabled);
        content = items.map((p) => `  ${showName(p.name)}: ${maskFormField(p.name, p.value)}`).join('\n');
        break;
      }
      case 'multipartForm': {
        const items = (body.multipartForm || []).filter((p) => p.enabled);
        content = items.map((p) => `  ${showName(p.name)}: ${p.type === 'file' ? '[file]' : maskFormField(p.name, p.value)}`).join('\n');
        break;
      }
      case 'graphql':
        content = body.graphql?.query || '';
        if (body.graphql?.variables) {
          // GraphQL variables are stored as a JSON string in Gridman — same
          // key-based redaction applies.
          content += `\n\nVariables:\n${redactJsonBodyString(body.graphql.variables, policy)}`;
        }
        break;
      default: content = '';
    }
    if (content) {
      const truncate = bodyMaxChars && content.length > bodyMaxChars;
      const shown = truncate ? content.slice(0, bodyMaxChars) + '…' : content;
      parts.push(`**Body (${body.mode}):**\n\`\`\`\n${shown}\n\`\`\``);
    }
  }

  if (includeResponse) {
    const responseStr = formatResponseShape(ctx.responseStatus, ctx.responseData, { security });
    if (responseStr) parts.push(responseStr);
  }

  if (includeDocs && ctx.docs && typeof ctx.docs === 'string' && ctx.docs.trim()) {
    parts.push(`**Documentation:**\n${ctx.docs.trim()}`);
  }

  return parts.join('\n\n');
};

/**
 * `formatRequestContextCompact` used to live here — a header-names-only,
 * 400-char-body summary whose ONLY caller was autocomplete-prompts.js. That
 * whole surface (`renderer:ai-autocomplete`, `renderer:ai-autocomplete-cancel`,
 * autocomplete.js, autocomplete-prompts.js) was removed because no renderer
 * ever called it, so the formatter went with it rather than staying behind as
 * an exported, model-facing emitter with no caller.
 */

// --- Variables (env / global / collection / folder / request / runtime) -

/**
 * Variable record shape (what the renderer sends over IPC):
 *   { name: string, value: string | null, scope: string, secret: boolean }
 *
 * - `scope` is informational ('env', 'global', 'collection', 'folder',
 *   'request', 'runtime', 'process', 'oauth2', ...). Used only for the
 *   short list shown to the model.
 * - `secret: true` means the value is omitted from the renderer's payload
 *   too — never trust the value field on a secret. The backend re-masks.
 */

const isSecretVariable = (v, policy = DEFAULT_POLICY) => {
  if (!v) return false;
  // `secret: true` is a hard promise from the renderer's variable
  // pipeline - always honor it, even when the pattern-match toggle is off.
  if (v.secret) return true;
  // Custom-listed names redact unconditionally, the user opted in explicitly.
  if (policy.isCustomVariable(v.name)) return true;
  // Pattern matches are also unconditional now: `redactVariables: false` used
  // to hand the model every `*_token` / `password` variable value in the
  // collection. A toggle may widen redaction, never remove it.
  return policy.matchesVariablePattern(v.name);
};

const variableValueForModel = (v, policy) => {
  if (!v) return '';
  if (isSecretVariable(v, policy)) return REDACTED_VALUE;
  if (v.value == null) return '';
  // `SESSION_ID`, `sid`, `x` — a variable name the patterns cannot match, with
  // a live credential parked in it. Nothing but the shape is left to go on.
  return maskCredentialShapedValue(String(v.value));
};

const VAR_NAMES_PREVIEW_PER_SCOPE = 25;

/**
 * Inline preview shown in the prompt. Names + a small per-scope sample so
 * the model knows what's available without us dumping 500 env vars.
 */
const formatVariablesList = (variables, opts = {}) => {
  if (!Array.isArray(variables) || !variables.length) return '';
  const policy = buildRedactionPolicy(opts.security);

  const byScope = new Map();
  for (const v of variables) {
    if (!v || !v.name) continue;
    const scope = v.scope || 'unknown';
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(v);
  }

  const lines = [];
  for (const [scope, list] of byScope.entries()) {
    const total = list.length;
    const preview = list.slice(0, VAR_NAMES_PREVIEW_PER_SCOPE);
    const more = total > preview.length ? ` (+${total - preview.length} more — use search_variables to find them)` : '';
    const names = preview
      .map((v) => (isSecretVariable(v, policy)
        ? `${maskCredentialShapedName(v.name)} (secret)`
        : maskCredentialShapedName(v.name)))
      .join(', ');
    lines.push(`- ${scope} (${total}): ${names}${more}`);
  }
  return lines.join('\n');
};

const SEARCH_LIMIT = 50;

/**
 * Returns `{ items, totalMatched, limit }`. `totalMatched` is the number of
 * variables that matched the query BEFORE truncation, so the caller can tell
 * the model when there are more matches than were returned.
 */
const searchVariables = (variables, rawQuery, limit = SEARCH_LIMIT) => {
  if (!Array.isArray(variables) || !variables.length) {
    return { items: [], totalMatched: 0, limit };
  }
  const query = String(rawQuery || '').toLowerCase().trim();
  const filtered = query
    ? variables.filter((v) => v?.name && v.name.toLowerCase().includes(query))
    : variables.slice();
  return { items: filtered.slice(0, limit), totalMatched: filtered.length, limit };
};

const formatSearchVariablesResult = ({ items, totalMatched, limit }, query, opts = {}) => {
  if (!items.length) {
    return query
      ? `No variables match "${query}".`
      : 'No variables defined for this collection/environment.';
  }
  const policy = buildRedactionPolicy(opts.security);
  const lines = items.map((v) => {
    const value = variableValueForModel(v, policy);
    const tags = [v.scope || 'unknown'];
    if (isSecretVariable(v, policy)) tags.push('secret');
    return `  ${maskCredentialShapedName(v.name)} = ${value}    [${tags.join(', ')}]`;
  });
  const heading = query
    ? `Found ${items.length}${totalMatched > items.length ? ` of ${totalMatched}` : ''} variable(s) matching "${query}":`
    : `Variables (${items.length}${totalMatched > items.length ? ` of ${totalMatched}` : ''}):`;
  const trailer = totalMatched > items.length
    ? `\n\n(${totalMatched - items.length} more match — narrow the query to see them.)`
    : '';
  return `${heading}\n${lines.join('\n')}${trailer}`;
};

const REQUESTS_PREVIEW_LIMIT = 25;
const REQUESTS_SEARCH_LIMIT = 50;

const methodOf = (r) => String(r?.method || (r?.type === 'app' ? 'APP' : 'GET')).toUpperCase();

const labelOf = (r) => (r?.folderPath ? `${r.folderPath}/${r.name || ''}` : r?.name || '');

/**
 * The collection preview. This one is inlined into EVERY chat context message
 * (chat.js), so it is the highest-volume URL emitter in the port — and it was
 * printing `r.url` verbatim while `formatRequestContext` two blocks up masked
 * the same shape.
 */
const formatRequestsList = (requests, opts = {}) => {
  if (!Array.isArray(requests) || !requests.length) return '';
  const policy = buildRedactionPolicy(opts.security);
  const total = requests.length;
  const preview = requests.slice(0, REQUESTS_PREVIEW_LIMIT);
  const lines = preview.map((r) => {
    const redactedUrl = r.url ? ` — ${redactUrl(r.url, policy)}` : '';
    return `  ${methodOf(r)} ${labelOf(r)}${redactedUrl}`;
  });
  const trailer = total > preview.length
    ? `\n(+${total - preview.length} more — call search_requests to find them)`
    : '';
  return `${lines.join('\n')}${trailer}`;
};

const searchRequests = (requests, rawQuery, limit = REQUESTS_SEARCH_LIMIT) => {
  if (!Array.isArray(requests) || !requests.length) {
    return { items: [], totalMatched: 0, limit };
  }
  const query = String(rawQuery || '').toLowerCase().trim();
  const filtered = query
    ? requests.filter((r) => {
        // NOT-OUTBOUND: a match haystack, compared and discarded. Nothing
        // built here is ever returned to the model — the matched requests are
        // rendered by formatSearchRequestsResult, which redacts.
        const hay = `${r?.name || ''} ${r?.url || ''} ${r?.pathname || ''} ${r?.folderPath || ''}`.toLowerCase();
        if (hay.includes(query)) return true;
        // Method matches only on exact token to avoid `get` matching every URL.
        return String(r?.method || '').toLowerCase() === query;
      })
    : requests.slice();
  return { items: filtered.slice(0, limit), totalMatched: filtered.length, limit };
};

/** Backs the model-callable `list_requests` / `search_requests` tools. */
const formatSearchRequestsResult = ({ items, totalMatched, limit }, query, opts = {}) => {
  if (!items.length) {
    return query
      ? `No requests match "${query}".`
      : 'No requests in this collection.';
  }
  const policy = buildRedactionPolicy(opts.security);
  const lines = items.map((r) => {
    const redactedUrl = r.url ? redactUrl(r.url, policy) : '(no url)';
    return `  ${methodOf(r)} ${labelOf(r)}\n    url: ${redactedUrl}\n    pathname: ${r.pathname || ''}`;
  });
  const heading = query
    ? `Found ${items.length}${totalMatched > items.length ? ` of ${totalMatched}` : ''} request(s) matching "${query}":`
    : `Requests (${items.length}${totalMatched > items.length ? ` of ${totalMatched}` : ''}):`;
  const trailer = totalMatched > items.length
    ? `\n\n(${totalMatched - items.length} more match — narrow the query to see them.)`
    : '';
  return `${heading}\n${lines.join('\n')}${trailer}`;
};

/**
 * EVERY exported formatter goes through `outbound()`. Nothing here may be
 * exported raw — `tests/ai/outbound-chokepoint.spec.js` enumerates these
 * exports, fails when a `format*` export is not guarded, and fails again when
 * a new one has no known-secret fixture asserting its output.
 *
 * The second argument tells the guard where THIS formatter's caller put its
 * security preferences, so the final pass honours the user's custom lists and
 * not only the built-in patterns.
 */
module.exports = {
  // patterns + helpers
  SENSITIVE_HEADER_PATTERNS,
  REDACTED_VALUE,
  REDACTION_NOTICE,
  isSensitiveName,
  maskValue,
  buildRedactionPolicy,
  foldName,
  withheldNotice,
  // the chokepoint itself
  redactUrl,
  scrubOutbound,
  outbound,
  isOutboundGuarded,
  isCredentialShapedToken,
  OUTBOUND_GUARD,
  // response shape
  redactResponseValues,
  formatResponseShape: outbound(formatResponseShape, (args) => args[2]?.security),
  // request context
  formatRequestContext: outbound(formatRequestContext, (args) => args[1]?.security),
  redactJsonBodyString,
  // variables
  isSecretVariable,
  formatVariablesList: outbound(formatVariablesList, (args) => args[1]?.security),
  searchVariables,
  formatSearchVariablesResult: outbound(formatSearchVariablesResult, (args) => args[2]?.security),
  // requests (collection tree)
  formatRequestsList: outbound(formatRequestsList, (args) => args[1]?.security),
  searchRequests,
  formatSearchRequestsResult: outbound(formatSearchRequestsResult, (args) => args[2]?.security)
};
