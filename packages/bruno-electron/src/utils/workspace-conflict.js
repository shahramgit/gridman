const yaml = require('js-yaml');

// Pure helpers to resolve Git merge conflicts inside workspace.yml.
//
// workspace.yml has a known shape (info.name + a collections list of relative
// paths), so instead of asking the user to hand-edit raw conflict markers we
// can parse both sides of the conflict, diff them structurally, and rebuild a
// merged file. Everything in this module is side-effect free so it can be unit
// tested without a Git repository.

const CONFLICT_START = /^<{7}(\s.*)?$/;
const CONFLICT_BASE = /^\|{7}(\s.*)?$/;
const CONFLICT_SEPARATOR = /^={7}\s*$/;
const CONFLICT_END = /^>{7}(\s.*)?$/;

const MALFORMED_PREFIX = 'workspace.yml conflict markers are malformed';

/**
 * Splits a file containing Git conflict markers into the full "ours" and
 * "theirs" versions of the file. Supports both the default merge style and
 * diff3 style (`|||||||` base section, which is discarded).
 *
 * @param {string} content raw conflicted file content
 * @returns {{ ours: string, theirs: string, conflictCount: number }}
 * @throws {Error} when markers are malformed (unterminated / out of order)
 */
const splitConflictedContent = (content) => {
  const lines = String(content ?? '').split(/\r?\n/);
  const oursLines = [];
  const theirsLines = [];
  let state = 'common'; // common | ours | base | theirs
  let conflictCount = 0;

  for (const line of lines) {
    if (CONFLICT_START.test(line)) {
      if (state !== 'common') {
        throw new Error(`${MALFORMED_PREFIX}: found a nested "<<<<<<<" marker.`);
      }
      state = 'ours';
      conflictCount += 1;
      continue;
    }

    if (CONFLICT_BASE.test(line) && (state === 'ours' || state === 'base')) {
      if (state === 'base') {
        throw new Error(`${MALFORMED_PREFIX}: found a duplicate "|||||||" marker.`);
      }
      state = 'base';
      continue;
    }

    if (CONFLICT_SEPARATOR.test(line) && state !== 'common') {
      if (state === 'theirs') {
        throw new Error(`${MALFORMED_PREFIX}: found a duplicate "=======" marker.`);
      }
      state = 'theirs';
      continue;
    }

    if (CONFLICT_END.test(line)) {
      if (state !== 'theirs') {
        throw new Error(`${MALFORMED_PREFIX}: found ">>>>>>>" without a matching "=======".`);
      }
      state = 'common';
      continue;
    }

    if (state === 'common') {
      oursLines.push(line);
      theirsLines.push(line);
    } else if (state === 'ours') {
      oursLines.push(line);
    } else if (state === 'theirs') {
      theirsLines.push(line);
    }
    // state === 'base' -> discarded
  }

  if (state !== 'common') {
    throw new Error(`${MALFORMED_PREFIX}: a conflict block is not terminated with ">>>>>>>".`);
  }

  return {
    ours: oursLines.join('\n'),
    theirs: theirsLines.join('\n'),
    conflictCount
  };
};

const normalizeEntryPath = (entryPath = '') => String(entryPath).replace(/\\/g, '/').trim().replace(/\/+$/, '');

const extractEntries = (rawEntries) => {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const seen = new Set();
  return rawEntries
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim() !== '')
    .map((entry) => {
      const normalized = {
        name: typeof entry.name === 'string' ? entry.name.trim() : '',
        path: normalizeEntryPath(entry.path)
      };
      if (entry.remote && typeof entry.remote === 'string') {
        normalized.remote = entry.remote.trim();
      }
      return normalized;
    })
    .filter((entry) => {
      if (seen.has(entry.path)) {
        return false;
      }
      seen.add(entry.path);
      return true;
    });
};

const parseWorkspaceYmlSide = (content, sideLabel) => {
  let parsed;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    throw new Error(`The ${sideLabel} side of the workspace.yml conflict is not valid YAML: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The ${sideLabel} side of the workspace.yml conflict is not a valid workspace configuration.`);
  }

  return {
    opencollection: parsed.opencollection != null ? String(parsed.opencollection) : '',
    name: typeof parsed.info?.name === 'string' ? parsed.info.name : (typeof parsed.name === 'string' ? parsed.name : ''),
    type: typeof parsed.info?.type === 'string' ? parsed.info.type : (typeof parsed.type === 'string' ? parsed.type : ''),
    docs: typeof parsed.docs === 'string' ? parsed.docs : '',
    collections: extractEntries(parsed.collections),
    specs: extractEntries(parsed.specs)
  };
};

const collectionEntriesDiffer = (ours, theirs) => {
  return ours.name !== theirs.name || (ours.remote || '') !== (theirs.remote || '');
};

const SCALAR_FIELDS = [
  { field: 'name', label: 'Workspace name' },
  { field: 'docs', label: 'Workspace docs' },
  { field: 'opencollection', label: 'OpenCollection version' }
];

/**
 * Parses a conflicted workspace.yml into a structured comparison the UI can
 * render: collections present in ours-only / theirs-only / both, plus any
 * conflicting scalar fields (workspace name, docs, version, or per-collection
 * metadata for entries present on both sides).
 *
 * Never throws — malformed input yields `{ ok: false, error }` so the caller
 * can fall back to instructing manual resolution.
 *
 * @param {string} content raw conflicted workspace.yml content
 */
const parseWorkspaceYmlConflict = (content) => {
  try {
    const { ours: oursContent, theirs: theirsContent, conflictCount } = splitConflictedContent(content);

    if (conflictCount === 0) {
      return {
        ok: false,
        error: 'workspace.yml does not contain Git conflict markers. It may already be resolved.'
      };
    }

    const ours = parseWorkspaceYmlSide(oursContent, 'local');
    const theirs = parseWorkspaceYmlSide(theirsContent, 'remote');

    const theirsByPath = new Map(theirs.collections.map((entry) => [entry.path, entry]));
    const oursPaths = new Set(ours.collections.map((entry) => entry.path));

    const both = [];
    const oursOnly = [];
    const theirsOnly = theirs.collections.filter((entry) => !oursPaths.has(entry.path));

    for (const entry of ours.collections) {
      const theirsEntry = theirsByPath.get(entry.path);
      if (theirsEntry) {
        both.push({
          path: entry.path,
          ours: entry,
          theirs: theirsEntry,
          conflicting: collectionEntriesDiffer(entry, theirsEntry)
        });
      } else {
        oursOnly.push(entry);
      }
    }

    const scalarConflicts = [];
    for (const { field, label } of SCALAR_FIELDS) {
      if (ours[field] !== theirs[field]) {
        scalarConflicts.push({ field, label, ours: ours[field], theirs: theirs[field] });
      }
    }

    for (const entry of both) {
      if (entry.conflicting) {
        scalarConflicts.push({
          field: `collection:${entry.path}`,
          label: `Collection at ${entry.path}`,
          ours: entry.ours.name + (entry.ours.remote ? ` (remote: ${entry.ours.remote})` : ''),
          theirs: entry.theirs.name + (entry.theirs.remote ? ` (remote: ${entry.theirs.remote})` : '')
        });
      }
    }

    return {
      ok: true,
      conflictCount,
      ours,
      theirs,
      collections: { both, oursOnly, theirsOnly },
      scalarConflicts
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'Failed to parse workspace.yml conflict.'
    };
  }
};

const pickScalar = (summary, scalarChoices, field) => {
  const source = scalarChoices?.[field] === 'theirs' ? summary.theirs : summary.ours;
  return source[field];
};

/**
 * Builds the merged workspace configuration from a parsed conflict summary and
 * the user's selections. Defaults keep the union of both collection lists and
 * the local ("ours") value for scalar conflicts.
 *
 * The returned object is shaped for the existing workspace-config writers
 * (`writeWorkspaceConfig` / `generateYamlContent`) so path normalization and
 * relative-path rules still apply on write.
 *
 * @param {object} summary result of parseWorkspaceYmlConflict (ok === true)
 * @param {object} [selections]
 * @param {string[]} [selections.excludedPaths] ours-only/theirs-only entries to drop
 * @param {Object<string,'ours'|'theirs'>} [selections.scalarChoices]
 */
const buildMergedWorkspaceYmlConfig = (summary, selections = {}) => {
  if (!summary?.ok) {
    throw new Error(summary?.error || 'Cannot build a merged workspace.yml from an unparsable conflict.');
  }

  const excludedPaths = new Set((selections.excludedPaths || []).map(normalizeEntryPath));
  const scalarChoices = selections.scalarChoices || {};

  const collections = [];
  const includedPaths = new Set();

  const pushEntry = (entry) => {
    if (!entry || excludedPaths.has(entry.path) || includedPaths.has(entry.path)) {
      return;
    }
    includedPaths.add(entry.path);
    collections.push(entry);
  };

  const bothByPath = new Map(summary.collections.both.map((item) => [item.path, item]));

  // Preserve the local ordering first, then append remote-only entries.
  for (const entry of summary.ours.collections) {
    const bothEntry = bothByPath.get(entry.path);
    if (bothEntry?.conflicting && scalarChoices[`collection:${entry.path}`] === 'theirs') {
      pushEntry(bothEntry.theirs);
    } else {
      pushEntry(entry);
    }
  }
  for (const entry of summary.collections.theirsOnly) {
    pushEntry(entry);
  }

  // Specs are unioned silently (same relative-path identity rule).
  const specs = [];
  const includedSpecPaths = new Set();
  for (const entry of [...summary.ours.specs, ...summary.theirs.specs]) {
    if (includedSpecPaths.has(entry.path)) {
      continue;
    }
    includedSpecPaths.add(entry.path);
    specs.push({ name: entry.name, path: entry.path });
  }

  return {
    opencollection: pickScalar(summary, scalarChoices, 'opencollection') || '1.0.0',
    info: {
      name: pickScalar(summary, scalarChoices, 'name') || 'Untitled Workspace',
      type: summary.ours.type || summary.theirs.type || 'workspace'
    },
    collections,
    specs,
    docs: pickScalar(summary, scalarChoices, 'docs') || ''
  };
};

module.exports = {
  splitConflictedContent,
  parseWorkspaceYmlConflict,
  buildMergedWorkspaceYmlConfig
};
