import { uuid } from 'utils/common';

// The bulk editor text only encodes these three fields. Everything else a row
// carries (uid, description, type, contentType, annotations, ...) is metadata
// that exists only in the key/value table and must survive the roundtrip.
const BULK_ENCODED_KEYS = ['name', 'value', 'enabled'];

/**
 * The form a name/value takes in the bulk text.
 *
 * The text is line based and unquoted, so it cannot carry a line break or
 * leading/trailing spaces. We normalise on the way *out* rather than letting
 * the parser quietly drop them on the way back in, which buys two things:
 *
 *   - `serialize(parse(text, items)) === text` for text we produced, so the
 *     editor never rewrites the line the user is standing on; and
 *   - a cheap "was this field actually edited?" test - if the parsed field
 *     equals `toBulkText(original field)` the user cannot have changed it, so
 *     attachMetadata() hands back the original string untouched. That is what
 *     makes a no-edit roundtrip an exact no-op even for values the text cannot
 *     represent (see the whitespace/line-break cases in the spec).
 *
 * Editing such a field does collapse it to what the text shows - unavoidable,
 * since the text is the only thing the user can express an edit in - but it
 * takes a deliberate edit to that field, and the result is visible in the table.
 */
const toBulkText = (field) =>
  String(field ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

/**
 * A row template that clears every metadata field the original rows carry.
 * Rows typed into the bulk editor are spread over this so they cannot inherit
 * metadata from whichever original row happened to sit at the same index -
 * several callers (FormUrlEncodedParams, MultipartFormParams) merge the bulk
 * result back into their params by index.
 *
 * Fields are cleared to `undefined`, not '', so the reducers' destructuring
 * defaults (`description = ''`, `type = 'query'`, `annotations = null`) still
 * apply. Derived from the data rather than a hardcoded list, so a column added
 * to a table later is covered without anyone having to remember this file.
 */
const buildBlankMetadata = (originalItems) => {
  const blank = {};
  originalItems.forEach((item) => {
    Object.keys(item || {}).forEach((key) => {
      if (BULK_ENCODED_KEYS.includes(key)) return;
      blank[key] = undefined;
    });
  });
  return blank;
};

/**
 * Keep the original string for every field the text still shows exactly as we
 * serialised it - see toBulkText() for why the equality test is sound.
 */
const restoreUneditedFields = (row, original) => {
  const merged = { ...original, ...row };
  if (row.name === toBulkText(original.name)) {
    merged.name = original.name;
  }
  if (row.value === toBulkText(original.value)) {
    merged.value = original.value;
  }
  if (row.enabled === Boolean(original.enabled)) {
    merged.enabled = original.enabled;
  }
  return merged;
};

/**
 * Re-attach the metadata of the original rows to the rows parsed out of the
 * bulk editor text.
 *
 * Matching rule, applied in this order:
 *
 *   1. by name - a row whose exact (case sensitive) name still exists among the
 *      originals claims the nearest unclaimed original carrying that name. This
 *      is what makes reordering, inserting and deleting follow the rows: after
 *      deleting line 1 every later line shifts up, so its index is a lie but its
 *      name is not. Duplicate names are handled by "nearest, claimed once", so
 *      the Nth duplicate in the text gets the Nth original rather than all of
 *      them sharing one row's metadata.
 *
 *   2. by position - a row left over after pass 1 (its name is not in the
 *      original set at all, so it was renamed or typed from scratch) claims the
 *      nearest unclaimed original, measured from where the rows pass 1 already
 *      pinned down say it should be. Renaming a row in place is the common case
 *      and row N of the textarea was row N of the list, so position is the
 *      identity signal the text gives us; correcting a typo'd header name keeps
 *      that row's uid and description instead of silently dropping them.
 *
 *      Position is measured relative to those anchors rather than as a raw index
 *      because one delete shifts every later index by one. A renamed row also
 *      cannot have jumped over a row that kept its name, so only originals
 *      *between* the neighbouring anchors are eligible - unless the anchors are
 *      themselves out of order (rows reordered and renamed in the same edit), in
 *      which case betweenness says nothing and every leftover is eligible.
 *
 *   3. anything still unmatched is a genuinely new row: fresh uid, metadata
 *      blanked so it cannot inherit fields from the original at its index.
 *
 * Name before position matters. Position alone mis-assigns every row after a
 * delete or an insert; name alone destroys metadata on every rename, which is
 * the data loss this ordering exists to close.
 *
 * Ambiguity no signal can settle - deleting one row and renaming another in the
 * same edit - resolves in favour of the position the surviving names imply.
 *
 * Ported from upstream bruno #8595 (3c0483852); we preserve the whole original
 * row instead of a fixed field list because our tables carry more columns, and
 * we match positionally as well as by name because upstream's name-only rule
 * loses metadata on rename.
 */
const attachMetadata = (rows, originalItems) => {
  const blankMetadata = buildBlankMetadata(originalItems);
  const claimed = new Array(originalItems.length).fill(false);
  const matchedIndexes = new Array(rows.length).fill(-1);

  const candidatesByName = new Map();
  originalItems.forEach((item, index) => {
    const name = toBulkText(item?.name);
    if (!candidatesByName.has(name)) {
      candidatesByName.set(name, []);
    }
    candidatesByName.get(name).push(index);
  });

  rows.forEach((row, index) => {
    const candidates = candidatesByName.get(row.name) || [];

    let match = -1;
    let matchDistance = Infinity;
    candidates.forEach((candidateIndex) => {
      if (claimed[candidateIndex]) return;
      const distance = Math.abs(candidateIndex - index);
      if (distance < matchDistance) {
        matchDistance = distance;
        match = candidateIndex;
      }
    });

    if (match >= 0) {
      claimed[match] = true;
      matchedIndexes[index] = match;
    }
  });

  rows.forEach((_, index) => {
    if (matchedIndexes[index] >= 0) return;

    let leftRow = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (matchedIndexes[i] >= 0) {
        leftRow = i;
        break;
      }
    }
    let rightRow = -1;
    for (let i = index + 1; i < rows.length; i++) {
      if (matchedIndexes[i] >= 0) {
        rightRow = i;
        break;
      }
    }

    // Exclusive bounds on the originals this row could be. With no anchor on a
    // side the bound is the end of the list, so an unanchored row falls back to
    // its own index.
    const lowerBound = leftRow >= 0 ? matchedIndexes[leftRow] : -1;
    const upperBound = rightRow >= 0 ? matchedIndexes[rightRow] : originalItems.length;
    const bounded = lowerBound < upperBound;

    // Where a rename would have left the row: step off the nearest anchor by the
    // number of lines between them.
    let expected = index;
    if (leftRow >= 0) {
      expected = lowerBound + (index - leftRow);
    } else if (rightRow >= 0) {
      expected = upperBound - (rightRow - index);
    }

    let match = -1;
    let matchDistance = Infinity;
    originalItems.forEach((_, candidateIndex) => {
      if (claimed[candidateIndex]) return;
      if (bounded && (candidateIndex <= lowerBound || candidateIndex >= upperBound)) return;
      const distance = Math.abs(candidateIndex - expected);
      if (distance < matchDistance) {
        matchDistance = distance;
        match = candidateIndex;
      }
    });

    if (match >= 0) {
      claimed[match] = true;
      matchedIndexes[index] = match;
    }
  });

  return rows.map((row, index) => {
    const original = matchedIndexes[index] >= 0 ? originalItems[matchedIndexes[index]] : null;
    if (!original) {
      return { ...blankMetadata, ...row, uid: uuid() };
    }
    return restoreUneditedFields(row, original);
  });
};

/**
 * @param {string} value bulk editor text
 * @param {Array} originalItems the rows the bulk editor currently holds, used to
 *   restore what the text does not encode. Pass the *live* rows, not the rows
 *   the editor was mounted with: they already carry the uids handed out on the
 *   previous keystroke, so a row being typed keeps a stable identity, and rows
 *   changed from outside (URL bar, file watcher after an external edit or a
 *   `git pull`) cannot come back from the dead. Omit only when there is no
 *   original set to preserve.
 */
export function parseBulkKeyValue(value, originalItems = []) {
  const rows = value
    .split(/\r?\n/)
    .map((pair) => {
      // Trim before looking for the comment marker, otherwise an indented
      // `  //A:1` is read as an enabled row literally named `//A`.
      const line = pair.trim();
      const isEnabled = !line.startsWith('//');
      const cleanPair = line.replace(/^\/\/\s*/, '');
      const sep = cleanPair.indexOf(':');
      if (sep < 0) return null;
      return {
        name: cleanPair.slice(0, sep).trim(),
        value: cleanPair.slice(sep + 1).trim(),
        enabled: isEnabled
      };
    })
    .filter(Boolean);

  return attachMetadata(rows, originalItems || []);
}

export function serializeBulkKeyValue(items) {
  return items.map((item) => `${item.enabled ? '' : '//'}${toBulkText(item.name)}:${toBulkText(item.value)}`).join('\n');
}
