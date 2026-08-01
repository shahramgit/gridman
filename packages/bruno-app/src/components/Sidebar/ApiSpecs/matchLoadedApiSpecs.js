import { normalizePath } from 'utils/common/path';

/**
 * Pairs each workspace API spec entry with its loaded counterpart in the redux
 * store, matching by normalized (posixified, NFC) path.
 *
 * The two paths are derived independently: a spec that lives outside the
 * workspace directory is stored posixified in workspace.yml and handed back by
 * `renderer:load-workspace-apispecs` verbatim (`C:/ws/api.yaml`), while the loaded
 * spec's pathname comes from the file watcher in native form (`C:\ws\api.yaml`).
 * A raw `===` compare therefore fails on Windows and the spec stays hidden from
 * the sidebar. Normalizing both sides makes them match on Windows and also folds
 * NFC/NFD differences in Persian paths; it is a no-op on macOS/Linux.
 *
 * upstream bruno #8255 (2bc735ee0)
 *
 * @param {Array} workspaceApiSpecs - spec entries from the active workspace (each has `path`)
 * @param {Array} allApiSpecs - loaded specs in redux (each has `pathname`)
 * @returns {Array} loaded specs that correspond to the workspace entries
 */
export const matchLoadedApiSpecs = (workspaceApiSpecs, allApiSpecs) => {
  if (!Array.isArray(workspaceApiSpecs)) return [];
  const loadedApiSpecs = Array.isArray(allApiSpecs) ? allApiSpecs : [];

  return workspaceApiSpecs
    .map((ws) => {
      const wsPath = normalizePath(ws?.path);
      if (!wsPath) return undefined;
      return loadedApiSpecs.find((apiSpec) => normalizePath(apiSpec?.pathname) === wsPath);
    })
    .filter(Boolean);
};
