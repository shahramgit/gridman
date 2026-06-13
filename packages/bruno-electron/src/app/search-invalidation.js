// Tiny bus so the collection watcher can invalidate the workspace search
// index (which lives in ipc/collection.js) without a circular require.
let invalidator = () => {};

const setSearchInvalidator = (fn) => {
  invalidator = typeof fn === 'function' ? fn : () => {};
};

const invalidateSearchForPath = (pathname) => {
  try {
    invalidator(pathname);
  } catch (_err) {
    // invalidation is best-effort
  }
};

module.exports = { setSearchInvalidator, invalidateSearchForPath };
