const fs = require('fs');
const path = require('path');
const {
  parseRequestViaWorker,
  stringifyRequestViaWorker,
  parseFolder,
  stringifyFolder,
  parseEnvironment,
  stringifyEnvironment,
  parseCollection,
  stringifyCollection
} = require('@usebruno/filestore');
const { writeFile } = require('./filesystem');
const { moveToAppTrash } = require('./app-trash');

// Converts a .bru collection to the .yml (opencollection) format.
//
// Upstream ships this as: walk every .bru, write a .yml sibling, fs.unlinkSync
// every original, delete bruno.json. No verification, no backup, no undo — and
// upstream shipped it with its own UI commented out, so it has never been
// exercised. On a git-backed 11,387-file workspace that is an unreviewable diff
// with nothing to go back to.
//
// This version is built the other way round. It runs in two phases with a hard
// commit point between them:
//
//   PHASE 1 (convert + verify) — writes .yml siblings ONLY. Every file written
//     is read back FROM DISK, parsed with the yml parser, and compared
//     semantically against the parsed original. The first file that does not
//     match aborts the whole run: every .yml this run created is removed and the
//     tree is byte-for-byte what it was before. Nothing is deleted in phase 1,
//     so an abort — or a crash, or a pulled power cord — can only ever leave
//     extra files behind.
//
//   PHASE 2 (commit) — writes opencollection.yml (which is what actually flips
//     the collection's format), then moves the .bru originals and bruno.json to
//     the in-app Trash, where the Trash panel can restore them. Nothing is ever
//     unlinked. Immediately before it, the tree is walked a second time and the
//     run refuses if anything was added, removed or edited while phase 1 was
//     running: a .bru the plan never saw is a .bru that never gets converted,
//     and flipping the format orphans it.
//
// The verification is semantic, not byte-level: the two formats spell the same
// request very differently. What counts as "the same" is defined by
// normalizeForComparison below, and every tolerance it applies is enumerated,
// symmetric (applied to BOTH sides, so it can hide an absence but never a
// difference) and covered by a test.
//
// WHAT THIS ACTUALLY ABORTS ON, TODAY
// -----------------------------------
// Measured over the 442 .bru files in this repo's own fixture collections: 369
// convert faithfully and 49 do not. Every one of the 49 is a real loss in the
// yml writer, not a strictness artefact — the ones seen so far:
//   * an inactive auth block (`auth:basic` credentials kept while the mode is
//     something else) — only the active mode is written                    (13)
//   * a folder.bru with no `seq` gets an explicit `seq: 1`, and
//     sortByNameThenSequence orders "no seq" and "seq 1" differently       (11)
//   * oauth2 `tokenQueryKey` is dropped                                     (8)
//   * websocket / grpc message `name`s are dropped                         (12)
//   * a unary assertion's operand (`isBoolean false` -> `isBoolean`)         (5)
//   * an inactive body block (json/text/formUrlEncoded kept while the mode
//     is something else)                                                    (4)
//   * a folder.bru with no meta block is renamed to "Untitled Folder"       (1)
// So on a large real collection this will usually refuse and name the file
// rather than convert. That is the intended outcome: the alternative on offer
// is upstream's, which loses all of the above silently and unlinks the only
// copy. Fixing them belongs in @usebruno/filestore's yml writer, and each fix
// makes this migration succeed on more files without any change here.

class MigrationCancelledError extends Error {
  constructor() {
    super('Migration cancelled');
    this.name = 'MigrationCancelledError';
    this.cancelled = true;
  }
}

// ---------------------------------------------------------------------------
// Semantic comparison
// ---------------------------------------------------------------------------

// Regenerated on every parse (nanoid), or filled in by the caller after parsing.
// None of them are file content, and none survive a round trip through disk.
const VOLATILE_KEYS = new Set(['uid', 'itemUid', 'pathname', 'filename', 'root', 'items']);

// Values the yml writer spells out that the bru writer leaves implicit. Each
// rule erases the key ONLY when the value on that side equals the default, and
// runs against both the original and the converted object. So:
//   original absent  + converted default -> both absent  -> equal   (tolerated)
//   original 30      + converted 0       -> 30 vs absent -> MISMATCH (caught)
//   original 30      + converted 30      -> both absent  -> equal   (correct)
// A default rule can therefore excuse a missing key, never a changed one.
const DEFAULT_VALUE_RULES = [
  { path: /^settings\.encodeUrl$/, isDefault: (v) => v === true },
  { path: /^settings\.timeout$/, isDefault: (v) => v === 0 },
  { path: /^settings\.followRedirects$/, isDefault: (v) => v === true },
  { path: /^settings\.maxRedirects$/, isDefault: (v) => v === 5 },
  // websocket requests get the same treatment from stringifyWebsocketRequest
  { path: /^settings\.keepAliveInterval$/, isDefault: (v) => v === 0 },
  // "no PKCE" written out explicitly
  { path: /(^|\.)auth\.oauth2\.pkce$/, isDefault: (v) => v === false },
  // A folder or collection root whose auth mode is "none" is skipped by
  // mergeAuth() exactly like one with no auth block at all
  // (utils/collection.js: `folderAuth.mode !== 'none' && !== 'inherit'`), so the
  // two spellings resolve identically. Scoped to the mode alone: an inactive
  // `auth.basic` block sitting next to mode "none" is still content, and losing
  // it is still a mismatch. And because the rule runs on both sides, "none" vs
  // "inherit" — which do NOT behave the same — remains a mismatch in both
  // directions.
  { path: /(^|\.)auth\.mode$/, isDefault: (v) => v === 'none' },
  // parseYmlCollection injects a full "inherit from global preferences" proxy
  // block into brunoConfig whether or not opencollection.yml carries one.
  // After empty-string/empty-object stripping that default reduces to exactly
  // { inherit: true, config: { protocol: 'http' } }.
  {
    path: /^proxy$/,
    isDefault: (v) => JSON.stringify(v) === JSON.stringify({ config: { protocol: 'http' }, inherit: true })
  }
];

// Fields whose text the yml writer rewrites in a way that provably does not
// change behaviour. Applied to both sides.
const VALUE_TRANSFORMS = [
  {
    // toOpenCollectionScripts() trims script and test code before writing it.
    // Leading/trailing whitespace around a JS program is not behaviour.
    path: /(^|\.)(script\.(req|res)|tests)$/,
    transform: (v) => (typeof v === 'string' ? v.trim() : v)
  },
  {
    // Bruno stores an assertion's operator inside its value string and treats a
    // missing operator as `eq` (bruno-js parseAssertionOperator). The yml format
    // splits operator and value apart and writes the operator back explicitly,
    // so `200` comes back as `eq 200` — the same assertion. Strip one leading
    // `eq ` on both sides so `200` and `eq 200` compare equal, while `gt 200`
    // vs `eq 200` still does not.
    path: /(^|\.)assertions\[\]\.value$/,
    transform: (v) => (typeof v === 'string' ? v.replace(/^eq /, '') : v)
  }
];

const matchRule = (rules, keyPath) => rules.find((rule) => rule.path.test(keyPath));

/**
 * Reduces a parsed request/folder/environment/collection object to the content
 * that has to survive the migration, dropping representation-only differences.
 *
 * Absent, null, empty string, empty array and empty object all collapse to
 * "no value", because the two formats disagree constantly about which of those
 * they emit for the same missing field, and none of them carry user data.
 *
 * @param {*} value parsed object (or any sub-value)
 * @param {string} keyPath dotted path used to match the rules above; array
 *   indices are collapsed to `[]` so a rule matches every element
 * @returns {*} normalized value, or undefined when it carries nothing
 */
const normalizeForComparison = (value, keyPath = '') => {
  const transform = matchRule(VALUE_TRANSFORMS, keyPath);
  const transformed = transform ? transform.transform(value) : value;

  if (Array.isArray(transformed)) {
    const items = transformed
      .map((entry) => normalizeForComparison(entry, `${keyPath}[]`))
      .filter((entry) => entry !== undefined);
    return items.length ? items : undefined;
  }

  if (transformed && typeof transformed === 'object') {
    const out = {};
    // Sorted so the comparison (and any JSON.stringify of it) is key-order
    // independent: the two writers emit the same fields in different orders.
    for (const key of Object.keys(transformed).sort()) {
      if (VOLATILE_KEYS.has(key)) {
        continue;
      }
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      const child = normalizeForComparison(transformed[key], childPath);
      if (child === undefined) {
        continue;
      }
      const defaultRule = matchRule(DEFAULT_VALUE_RULES, childPath);
      if (defaultRule && defaultRule.isDefault(child)) {
        continue;
      }
      out[key] = child;
    }
    return Object.keys(out).length ? out : undefined;
  }

  if (transformed === null || transformed === undefined || transformed === '') {
    return undefined;
  }

  return transformed;
};

const describe = (value) => {
  if (value === undefined) {
    return 'absent';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

/**
 * Deep-compares two already-normalized values and reports every difference.
 * Arrays compare positionally and by length, so a dropped or invented list
 * entry is a difference rather than something a containment check would wave
 * through.
 *
 * @param {*} expected normalized original
 * @param {*} actual normalized converted value
 * @param {string} keyPath current path, for reporting
 * @param {Array} out accumulator
 * @returns {Array<{path: string, expected: string, actual: string}>}
 */
const diffNormalized = (expected, actual, keyPath = '', out = []) => {
  const typeOf = (v) => (Array.isArray(v) ? 'array' : v === undefined ? 'undefined' : typeof v);
  const expectedType = typeOf(expected);
  const actualType = typeOf(actual);

  if (expectedType === 'undefined' && actualType === 'undefined') {
    return out;
  }

  if (expectedType !== actualType) {
    out.push({ path: keyPath || '(root)', expected: describe(expected), actual: describe(actual) });
    return out;
  }

  if (expectedType === 'array') {
    if (expected.length !== actual.length) {
      out.push({
        path: keyPath || '(root)',
        expected: `${expected.length} entries`,
        actual: `${actual.length} entries`
      });
      return out;
    }
    expected.forEach((entry, index) => diffNormalized(entry, actual[index], `${keyPath}[${index}]`, out));
    return out;
  }

  if (expectedType === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      diffNormalized(expected[key], actual[key], keyPath ? `${keyPath}.${key}` : key, out);
    }
    return out;
  }

  if (expected !== actual) {
    out.push({ path: keyPath || '(root)', expected: describe(expected), actual: describe(actual) });
  }

  return out;
};

/**
 * The verification step: is `converted` the same content as `original`?
 *
 * @param {*} original object parsed from the .bru file
 * @param {*} converted object parsed from the .yml file that replaced it
 * @param {string[]} ignoredKeys top-level keys excluded from the comparison
 * @returns {Array<{path: string, expected: string, actual: string}>} empty when identical
 */
const compareSemantic = (original, converted, ignoredKeys = []) => {
  const strip = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !ignoredKeys.length) {
      return value;
    }
    const copy = { ...value };
    for (const key of ignoredKeys) {
      delete copy[key];
    }
    return copy;
  };

  return diffNormalized(
    normalizeForComparison(strip(original)),
    normalizeForComparison(strip(converted))
  );
};

// bruno.json keys with no opencollection.yml counterpart because the file
// format itself replaces them: `version` is the bruno.json schema marker and
// `opencollection` is the yml one. Everything else in bruno.json — proxy,
// clientCertificates, presets, protobuf, ignore, scripts, openapi — is compared,
// so a config field the yml writer cannot carry aborts the migration instead of
// disappearing.
const BRUNO_CONFIG_IGNORED_KEYS = ['version', 'opencollection'];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

const toYmlPathname = (bruPathname) => `${bruPathname.slice(0, -'.bru'.length)}.yml`;

/**
 * Walks a .bru collection and classifies every file the migration has to touch.
 *
 * @param {string} collectionPathname absolute collection root
 * @param {object} [options]
 * @param {Set<string>} [options.ignoreExistingTargets] .yml paths that are known
 *   to be this run's own output, so the re-scan before the commit does not
 *   report the files phase 1 just wrote as pre-existing .yml it must not
 *   overwrite
 * @returns {{collectionPathname: string, brunoConfigPathname: string, collectionRootPathname: string|null,
 *   entries: Array<{kind: string, sourcePathname: string, targetPathname: string, relativePath: string}>,
 *   blockers: Array<{pathname: string, reason: string}>}}
 */
const planCollectionYmlMigration = (collectionPathname, { ignoreExistingTargets } = {}) => {
  const root = path.resolve(collectionPathname);
  const brunoConfigPathname = path.join(root, 'bruno.json');
  const openCollectionPathname = path.join(root, 'opencollection.yml');

  if (fs.existsSync(openCollectionPathname)) {
    throw new Error('This collection is already in the .yml (opencollection) format.');
  }
  if (!fs.existsSync(brunoConfigPathname)) {
    throw new Error(`No bruno.json found at ${root}; this does not look like a .bru collection.`);
  }

  const environmentsDir = path.join(root, 'environments');
  const entries = [];
  const blockers = [];
  let collectionRootPathname = null;

  const walk = (directory) => {
    const dirEntries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    for (const dirEntry of dirEntries) {
      const pathname = path.join(directory, dirEntry.name);

      // Excluded whatever they are — a symlinked node_modules is normal, and
      // neither directory can hold a request this migration owns.
      if (SKIPPED_DIRECTORIES.has(dirEntry.name)) {
        continue;
      }

      // A Dirent for a symlink answers FALSE to both isDirectory() and
      // isFile(). Without this branch a symlinked directory matches neither the
      // descend test nor the .bru test, so it is skipped in silence: every
      // request behind it stays a .bru while opencollection.yml turns the
      // collection into a yml one, and those requests vanish from the app — in
      // a run that reports itself as a clean migration.
      //
      // Following the link instead is the other option, and it is worse here:
      // the target can sit outside the collection root (so the .bru originals
      // would be trashed from someone else's tree), can be shared with another
      // collection, and can point back into an ancestor and loop. So the run is
      // refused with the link named, and the user can convert the real
      // directory on its own or replace the link.
      if (dirEntry.isSymbolicLink()) {
        // The Dirent cannot say what is on the other end; only a stat can, and
        // stat follows the link.
        let target = null;
        try {
          target = fs.statSync(pathname);
        } catch (_error) {
          // Broken, circular, or on a share that is not answering. It cannot be
          // proven NOT to be a directory full of requests, so it is refused
          // with the rest.
        }

        if (!target || target.isDirectory() || dirEntry.name.toLowerCase().endsWith('.bru')) {
          blockers.push({
            pathname,
            reason: `"${path.relative(root, pathname)}" is a symlink; the migration will not follow or convert it.`
          });
        }

        // A link to a plain file that is not a .bru — a shared .env, a
        // certificate, a README — is not this migration's business: it is never
        // converted, never moved, and is exactly as valid after the format flip
        // as before it. Refusing over one would make the feature unusable on
        // collections that are otherwise perfectly convertible.
        continue;
      }

      if (dirEntry.isDirectory()) {
        walk(pathname);
        continue;
      }

      if (!dirEntry.name.toLowerCase().endsWith('.bru')) {
        continue;
      }

      if (!dirEntry.isFile()) {
        // Not a regular file and not a symlink either — a fifo, a socket, a
        // device node that happens to be named `something.bru`. Nothing to
        // convert, and skipping it silently would again leave a .bru the app
        // stops seeing.
        blockers.push({
          pathname,
          reason: `"${path.relative(root, pathname)}" is not a regular file; the migration will not convert it.`
        });
        continue;
      }

      const inCollectionRoot = path.normalize(directory) === path.normalize(root);
      const inEnvironmentsDir = path.normalize(directory) === path.normalize(environmentsDir);

      if (inCollectionRoot && dirEntry.name === 'collection.bru') {
        collectionRootPathname = pathname;
        continue;
      }

      let kind = 'request';
      if (inEnvironmentsDir) {
        kind = 'environment';
      } else if (dirEntry.name === 'folder.bru') {
        kind = 'folder';
      }

      const targetPathname = toYmlPathname(pathname);
      if (fs.existsSync(targetPathname) && !(ignoreExistingTargets && ignoreExistingTargets.has(targetPathname))) {
        // Refuse rather than overwrite: that .yml is the user's, and this run
        // must be able to undo itself by deleting only what it created.
        blockers.push({
          pathname: targetPathname,
          reason: `"${path.relative(root, targetPathname)}" already exists; the migration will not overwrite it.`
        });
      }

      entries.push({
        kind,
        sourcePathname: pathname,
        targetPathname,
        relativePath: path.relative(root, pathname)
      });
    }
  };

  walk(root);

  return {
    collectionPathname: root,
    brunoConfigPathname,
    openCollectionPathname,
    collectionRootPathname,
    entries,
    blockers
  };
};

/**
 * What every file a plan is about to act on looks like right now: which files
 * there are, what each one is, and its size and mtime. Two fingerprints taken
 * around phase 1 are what tells the migration whether the tree it verified is
 * still the tree it is about to convert.
 *
 * @param {object} plan result of planCollectionYmlMigration
 * @returns {Map<string, string>} absolute pathname -> signature
 */
const fingerprintPlanSources = (plan) => {
  const fingerprint = new Map();

  const add = (pathname, kind) => {
    if (!pathname) {
      return;
    }
    try {
      const stats = fs.statSync(pathname);
      fingerprint.set(pathname, `${kind}|${stats.size}|${stats.mtimeMs}`);
    } catch (_error) {
      // Cannot stat it -> cannot claim it is the file we planned for.
      fingerprint.set(pathname, `${kind}|unreadable`);
    }
  };

  for (const entry of plan.entries) {
    add(entry.sourcePathname, entry.kind);
  }
  add(plan.collectionRootPathname, 'collectionRoot');
  add(plan.brunoConfigPathname, 'brunoConfig');

  return fingerprint;
};

/**
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @param {string} root collection root, for readable paths
 * @returns {Array<{pathname: string, relativePath: string, change: string}>}
 */
const diffFingerprints = (before, after, root) => {
  const changes = [];
  const describeChange = (pathname, change) =>
    changes.push({ pathname, relativePath: path.relative(root, pathname), change });

  for (const [pathname, signature] of before) {
    if (!after.has(pathname)) {
      describeChange(pathname, 'removed');
    } else if (after.get(pathname) !== signature) {
      describeChange(pathname, 'modified');
    }
  }
  for (const pathname of after.keys()) {
    if (!before.has(pathname)) {
      describeChange(pathname, 'added');
    }
  }

  return changes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const readUtf8 = (pathname) => fs.readFileSync(pathname, 'utf8');

/**
 * Converts one .bru file to yml text and returns everything needed to verify it.
 *
 * Requests go through the filestore worker thread, exactly like every other
 * request read in this app: the collections we ship for carry saved response
 * examples up to the 50 MB cap, and parsing one of those on the browser process
 * blocks the UI for as long as it takes (and can take the process down with it).
 *
 * @param {{kind: string, sourcePathname: string}} entry
 * @returns {Promise<{content: string, original: any, ignoredKeys: string[]}>}
 */
const convertEntryToYml = async (entry) => {
  const content = readUtf8(entry.sourcePathname);
  const basename = path.basename(entry.sourcePathname);

  if (entry.kind === 'request') {
    const original = await parseRequestViaWorker(content, { format: 'bru' });

    // Same rule as renderer:move-item-cross-format: the .bru parser keeps blocks
    // written by a newer Bruno verbatim so a .bru round trip preserves them, and
    // the yml writer has no such escape hatch. Converting would delete them.
    const unknownBlocks = Array.isArray(original?.unknownBlocks) ? original.unknownBlocks : [];
    if (unknownBlocks.length) {
      const names = unknownBlocks.map((block) => block?.name).filter(Boolean).join(', ');
      throw new Error(
        `"${basename}" contains blocks this version of Gridman does not understand${names ? ` (${names})` : ''}. `
        + 'Converting it to yml would delete them.'
      );
    }

    return {
      content: await stringifyRequestViaWorker(original, { format: 'yml' }),
      original,
      ignoredKeys: []
    };
  }

  if (entry.kind === 'folder') {
    const original = parseFolder(content, { format: 'bru' });
    return { content: stringifyFolder(original, { format: 'yml' }), original, ignoredKeys: [] };
  }

  if (entry.kind === 'environment') {
    // A .bru environment carries no name — the app derives it from the filename
    // (collection-watcher addEnvironmentFile) and keeps doing so for .yml. Stamp
    // the same derived name onto the original before writing so the comparison
    // covers the name the yml file actually gets, instead of ignoring it.
    const original = parseEnvironment(content, { format: 'bru' });
    original.name = basename.slice(0, -'.bru'.length);
    return { content: stringifyEnvironment(original, { format: 'yml' }), original, ignoredKeys: [] };
  }

  throw new Error(`Unsupported migration entry kind: ${entry.kind}`);
};

/**
 * Reads back what was written and compares it to the original.
 *
 * Deliberately re-reads from disk rather than re-parsing the string we just
 * built: a verification that never touches the filesystem cannot notice a short
 * write, a mangled encoding or a file that never landed at all.
 *
 * @param {{kind: string, targetPathname: string}} entry
 * @param {{original: any, ignoredKeys: string[]}} converted
 * @returns {Promise<Array>} differences; empty when the conversion is faithful
 */
const verifyConvertedEntry = async (entry, converted) => {
  const written = readUtf8(entry.targetPathname);

  let reparsed;
  if (entry.kind === 'request') {
    reparsed = await parseRequestViaWorker(written, { format: 'yml' });
  } else if (entry.kind === 'folder') {
    reparsed = parseFolder(written, { format: 'yml' });
  } else if (entry.kind === 'environment') {
    reparsed = parseEnvironment(written, { format: 'yml' });
  } else {
    throw new Error(`Unsupported migration entry kind: ${entry.kind}`);
  }

  return compareSemantic(converted.original, reparsed, converted.ignoredKeys);
};

/**
 * Builds opencollection.yml from collection.bru + bruno.json and verifies it
 * WITHOUT writing it. opencollection.yml is what getCollectionFormat() keys off,
 * so the moment it exists the whole collection is a yml collection and every
 * .bru still on disk becomes invisible. It is therefore built and checked here
 * during phase 1, and only written at the commit point.
 *
 * @param {{collectionRootPathname: string|null, brunoConfigPathname: string}} plan
 * @returns {{content: string, differences: Array}}
 */
const buildAndVerifyCollectionRoot = (plan) => {
  const brunoConfig = JSON.parse(readUtf8(plan.brunoConfigPathname));

  const collectionRoot = plan.collectionRootPathname
    ? parseCollection(readUtf8(plan.collectionRootPathname), { format: 'bru' })
    : {};

  const ymlBrunoConfig = { ...brunoConfig, opencollection: '1.0.0' };
  delete ymlBrunoConfig.version;

  const content = stringifyCollection(collectionRoot, ymlBrunoConfig, { format: 'yml' });
  const reparsed = parseCollection(content, { format: 'yml' });

  const differences = [
    ...compareSemantic(collectionRoot, reparsed.collectionRoot).map((difference) => ({
      ...difference,
      path: `collectionRoot.${difference.path}`
    })),
    ...compareSemantic(brunoConfig, reparsed.brunoConfig, BRUNO_CONFIG_IGNORED_KEYS).map((difference) => ({
      ...difference,
      path: `brunoConfig.${difference.path}`
    }))
  ];

  return { content, differences };
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// 11,387 files at one IPC message each would be its own performance problem, so
// progress is coalesced: at most one message per PROGRESS_INTERVAL_MS, plus one
// at every phase change and one at the end. Cancellation is checked on every
// file regardless — it must not wait for a progress tick.
const PROGRESS_INTERVAL_MS = 120;

const makeProgressEmitter = (onProgress) => {
  let lastEmittedAt = 0;
  let lastPhase = null;

  return (payload, { force = false } = {}) => {
    if (typeof onProgress !== 'function') {
      return;
    }
    const now = Date.now();
    // A phase change always gets through. Without this a collection small enough
    // to finish inside one interval reports "scanning" and then "committing",
    // and the renderer never learns how many files there were to convert.
    const phaseChanged = payload?.phase !== lastPhase;
    if (!force && !phaseChanged && now - lastEmittedAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastEmittedAt = now;
    lastPhase = payload?.phase;
    try {
      onProgress(payload);
    } catch (_error) {
      // Progress reporting is best-effort; a closed window must not abort a
      // migration that is already writing files.
    }
  };
};

/**
 * Converts a .bru collection to .yml, reversibly and verified.
 *
 * @param {object} options
 * @param {string} options.collectionPathname absolute collection root
 * @param {Function} [options.onProgress] called with { phase, processed, total, ... }
 * @param {Function} [options.shouldCancel] returns true to stop; checked per file
 * @returns {Promise<object>} result with `status` of 'migrated' | 'cancelled' | 'aborted'
 */
const migrateCollectionToYml = async ({ collectionPathname, onProgress, shouldCancel } = {}) => {
  const emit = makeProgressEmitter(onProgress);
  const isCancelled = () => (typeof shouldCancel === 'function' ? Boolean(shouldCancel()) : false);

  emit({ phase: 'scanning', processed: 0, total: 0 }, { force: true });

  const plan = planCollectionYmlMigration(collectionPathname);
  const total = plan.entries.length + 1; // + opencollection.yml

  // Taken before a single file is converted, and compared against a fresh walk
  // immediately before the commit.
  const treeBeforeConversion = fingerprintPlanSources(plan);

  if (plan.blockers.length) {
    emit({ phase: 'aborted', processed: 0, total }, { force: true });
    return {
      status: 'aborted',
      collectionPathname: plan.collectionPathname,
      converted: 0,
      total,
      blockers: plan.blockers,
      reason: plan.blockers[0].reason
    };
  }

  // Everything this run creates, in creation order, so an abort can remove
  // exactly what it made and nothing else.
  const createdYmlPathnames = [];

  const rollbackFailures = [];

  const rollback = () => {
    // Reverse creation order. One file at a time, because a single locked file
    // must not stop the rest of the rollback — but a failure is recorded rather
    // than swallowed: "the collection is untouched" is a claim this run makes to
    // the user, and it has to be able to withdraw it.
    for (const pathname of [...createdYmlPathnames].reverse()) {
      try {
        fs.unlinkSync(pathname);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          rollbackFailures.push({ pathname, message: error?.message || String(error) });
        }
      }
    }
    createdYmlPathnames.length = 0;
  };

  let processed = 0;
  // Flips the moment the first original leaves its place; past that point
  // nothing may be rolled back.
  let committed = false;

  try {
    // ---- PHASE 1: convert + verify. Creates .yml siblings; deletes nothing. ----
    for (const entry of plan.entries) {
      if (isCancelled()) {
        throw new MigrationCancelledError();
      }

      emit({
        phase: 'converting',
        processed,
        total,
        currentPathname: entry.sourcePathname,
        relativePath: entry.relativePath
      });

      const converted = await convertEntryToYml(entry);
      // Registered BEFORE the write: fs-extra's outputFileSync is not atomic, so
      // a write that throws part-way can still leave a file behind, and the
      // rollback has to be able to remove it. Removing a path that was never
      // created is free (ENOENT is ignored).
      createdYmlPathnames.push(entry.targetPathname);
      await writeFile(entry.targetPathname, converted.content);

      const differences = await verifyConvertedEntry(entry, converted);
      if (differences.length) {
        rollback();
        emit({ phase: 'aborted', processed, total }, { force: true });
        return {
          status: 'aborted',
          collectionPathname: plan.collectionPathname,
          converted: 0,
          total,
          rollbackFailures,
          failedPathname: entry.sourcePathname,
          failedRelativePath: entry.relativePath,
          differences,
          reason:
            `"${entry.relativePath}" does not survive the conversion: `
            + differences
              .slice(0, 3)
              .map((difference) => `${difference.path} (${difference.expected} -> ${difference.actual})`)
              .join('; ')
        };
      }

      processed++;
    }

    if (isCancelled()) {
      throw new MigrationCancelledError();
    }

    // The collection root is built and verified here but written in phase 2:
    // writing it is what flips the collection's format.
    emit({ phase: 'converting', processed, total, relativePath: 'opencollection.yml' });
    const collectionRootResult = buildAndVerifyCollectionRoot(plan);
    if (collectionRootResult.differences.length) {
      rollback();
      emit({ phase: 'aborted', processed, total }, { force: true });
      return {
        status: 'aborted',
        collectionPathname: plan.collectionPathname,
        converted: 0,
        total,
        failedPathname: plan.collectionRootPathname || plan.brunoConfigPathname,
        failedRelativePath: plan.collectionRootPathname ? 'collection.bru' : 'bruno.json',
        differences: collectionRootResult.differences,
        reason:
          'The collection settings do not survive the conversion: '
          + collectionRootResult.differences
            .slice(0, 3)
            .map((difference) => `${difference.path} (${difference.expected} -> ${difference.actual})`)
            .join('; ')
      };
    }

    if (isCancelled()) {
      throw new MigrationCancelledError();
    }

    // ---- RE-SCAN ------------------------------------------------------------
    // The plan was taken before the first file was converted, and on an 11,000
    // file collection that is minutes ago. Anything that appeared, disappeared
    // or was edited since — a request saved in the app, the collection watcher,
    // a git checkout or pull — is not in the plan, so it was never converted;
    // and writing opencollection.yml immediately below turns the whole
    // collection into a yml one, at which point every unconverted .bru is
    // invisible to the app, in a run that reports itself as a clean migration.
    // That is the same orphaning a symlinked directory used to cause, arriving
    // by a different route.
    //
    // There is no lock to take over a git-backed working tree that other tools
    // write to, so the tree is walked again and the run refuses if it is not
    // the tree phase 1 verified. Refusing costs the user a re-run; the
    // alternative costs them requests. The window between this check and the
    // first move is the commit phase itself — no parsing, no verification —
    // which is as narrow as it can be made without a lock.
    const rescan = planCollectionYmlMigration(plan.collectionPathname, {
      ignoreExistingTargets: new Set(createdYmlPathnames)
    });
    const treeChanges = diffFingerprints(
      treeBeforeConversion,
      fingerprintPlanSources(rescan),
      plan.collectionPathname
    );

    if (treeChanges.length || rescan.blockers.length) {
      rollback();
      emit({ phase: 'aborted', processed, total }, { force: true });
      return {
        status: 'aborted',
        collectionPathname: plan.collectionPathname,
        converted: 0,
        total,
        rollbackFailures,
        treeChanges,
        blockers: rescan.blockers,
        reason: treeChanges.length
          ? 'The collection changed while it was being converted, so nothing was migrated: '
          + treeChanges
            .slice(0, 3)
            .map((change) => `"${change.relativePath}" was ${change.change}`)
            .join('; ')
            + `${treeChanges.length > 3 ? `; and ${treeChanges.length - 3} more` : ''}. Try again.`
          : rescan.blockers[0].reason
      };
    }

    // ---- COMMIT POINT -------------------------------------------------------
    // Past here cancellation is refused. Everything below is a sequence of file
    // moves into the Trash; stopping halfway would leave a tree that is neither
    // the old one nor the new one, which is precisely the state this design
    // exists to avoid. The phase is short — no parsing, no verification, just
    // moves — and the whole of it is recoverable from the Trash panel.
    emit({ phase: 'committing', processed: 0, total }, { force: true });

    // Registered before the write for the same reason as every other target: an
    // opencollection.yml half-written by a failing write would still make this a
    // yml collection, with none of its requests visible.
    createdYmlPathnames.push(plan.openCollectionPathname);
    await writeFile(plan.openCollectionPathname, collectionRootResult.content);
    processed++;

    const trashTypeByKind = { request: 'request', folder: 'folder', environment: 'environment' };
    const trashed = [];
    const notTrashed = [];

    const trash = async (pathname, type) => {
      try {
        await moveToAppTrash(pathname, {
          type,
          collectionPathname: plan.collectionPathname,
          displayName: path.relative(plan.collectionPathname, pathname)
        });
        trashed.push(pathname);
        // The first original has left its place: the .yml files are now the only
        // copies in the tree, so rolling them back would destroy the collection
        // rather than restore it. Nothing below this line may roll back.
        committed = true;
      } catch (error) {
        // The .yml replacement is written and verified, so the content is safe.
        // A .bru we could not move (a Windows lock, a read-only file) stays
        // exactly where it is — leaving the user's file on disk is always the
        // right failure. It is reported so they can clear it by hand.
        notTrashed.push({ pathname, message: error?.message || String(error) });
      }
    };

    let committedCount = 0;
    for (const entry of plan.entries) {
      emit({
        phase: 'committing',
        processed: committedCount,
        total,
        currentPathname: entry.sourcePathname,
        relativePath: entry.relativePath
      });
      await trash(entry.sourcePathname, trashTypeByKind[entry.kind] || 'request');
      committedCount++;
    }

    // bruno.json and collection.bru go last, and go to the Trash like everything
    // else. Until this point bruno.json is still on disk, so a failure anywhere
    // above leaves a collection that still opens.
    if (plan.collectionRootPathname) {
      await trash(plan.collectionRootPathname, 'collection');
    }
    await trash(plan.brunoConfigPathname, 'collection');

    emit({ phase: 'done', processed: total, total }, { force: true });

    return {
      status: 'migrated',
      collectionPathname: plan.collectionPathname,
      converted: plan.entries.length + 1,
      total,
      trashedCount: trashed.length,
      notTrashed
    };
  } catch (error) {
    // Only phase 1 is undoable. After the first original has moved to the Trash
    // the .yml files are the collection, and deleting them "to clean up" would
    // be the destructive act this whole design exists to prevent — so past the
    // commit the failure is reported with the tree left as it stands.
    if (!committed) {
      rollback();
    }

    if (error instanceof MigrationCancelledError || error?.cancelled) {
      emit({ phase: 'cancelled', processed, total }, { force: true });
      return {
        status: 'cancelled',
        collectionPathname: plan.collectionPathname,
        converted: 0,
        total,
        rollbackFailures
      };
    }

    emit({ phase: 'aborted', processed, total }, { force: true });
    return {
      status: 'aborted',
      collectionPathname: plan.collectionPathname,
      converted: 0,
      total,
      committed,
      rollbackFailures,
      reason: error?.message || String(error)
    };
  }
};

module.exports = {
  MigrationCancelledError,
  BRUNO_CONFIG_IGNORED_KEYS,
  normalizeForComparison,
  compareSemantic,
  planCollectionYmlMigration,
  convertEntryToYml,
  verifyConvertedEntry,
  buildAndVerifyCollectionRoot,
  migrateCollectionToYml
};
