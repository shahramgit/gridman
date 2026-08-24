/**
 * Move an environment variable one row up or down.
 *
 * Pure, and exported, so the table and its tests exercise the SAME code — the ordering
 * rules are the whole feature, and a copy of them in a spec proves nothing about the
 * component.
 *
 * The rule that is easy to get wrong: the table always keeps a trailing empty row for
 * typing a new variable into, and it has to stay last. Swapping a real row past it would
 * move the input the user is about to type in.
 *
 * Returns the original array (same reference) when the move is not allowed, so callers can
 * skip a pointless state update.
 */
export const moveEnvironmentVariable = (values, index, direction) => {
  if (!Array.isArray(values) || values.length === 0) return values;

  const target = index + direction;
  const lastRow = values[values.length - 1];
  const hasTrailingEmptyRow = Boolean(lastRow) && (!lastRow.name || lastRow.name.trim() === '');
  const movableCount = hasTrailingEmptyRow ? values.length - 1 : values.length;

  if (index < 0 || index >= movableCount) return values;
  if (target < 0 || target >= movableCount) return values;

  const reordered = [...values];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered;
};

/** How many rows can be moved — everything except a trailing empty placeholder. */
export const movableRowCount = (values) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const lastRow = values[values.length - 1];
  const hasTrailingEmptyRow = Boolean(lastRow) && (!lastRow.name || lastRow.name.trim() === '');
  return hasTrailingEmptyRow ? values.length - 1 : values.length;
};
