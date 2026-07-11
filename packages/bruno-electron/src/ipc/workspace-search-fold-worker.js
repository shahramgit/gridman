const { parentPort } = require('node:worker_threads');
const { buildSearchFields } = require('../utils/workspace-search-match');

// Fold worker for the workspace search index. Folding (Unicode-normalizing
// every searchable field, including full bodies and example blocks) is the
// CPU-dominant part of an index build — measured at ~97% of wall time on
// content-heavy collections — and JS folding on the main thread serializes
// it all onto one core. Each message carries a chunk of files; the reply
// carries their built fields in the same order.

parentPort?.on('message', ({ id, jobs }) => {
  try {
    const results = jobs.map((job) => {
      try {
        return buildSearchFields({
          content: job.content,
          format: job.format,
          name: job.name,
          filename: job.filename,
          url: job.url
        });
      } catch (error) {
        return null;
      }
    });
    parentPort?.postMessage({ id, results });
  } catch (error) {
    parentPort?.postMessage({ id, error: error?.message || 'fold worker failed' });
  }
});
