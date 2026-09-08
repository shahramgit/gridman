// CommonJS on purpose: the Electron main process is unbundled ("main":
// "src/index.js") and requires this file. As ESM it only loaded because
// Electron 37's Node 22 re-parses an ambiguous .js file as a module — on
// Node 18 the same require is a SyntaxError, and jest could not load
// src/ipc/collection.js at all without mocking this file away.
const REQUEST_TYPES = ['http-request', 'graphql-request', 'grpc-request', 'ws-request'];

module.exports = { REQUEST_TYPES };
