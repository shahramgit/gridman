export const REQUEST_TYPES = ['http-request', 'graphql-request', 'grpc-request', 'ws-request'];

export const DEFAULT_COLLECTION_FORMAT = 'yml';

/**
 * The request types a collection preset can name.
 *
 * These values are WRITTEN to bruno.json by the collection's Presets form and
 * READ back by the new-request button, from two different files, and they had
 * drifted: the form saved 'ws' while the button switched on 'websocket', so
 * choosing WebSocket as the preset made the button do nothing at all — the
 * switch had no default and fell straight through. Upstream hit the same thing
 * (#8889). One list so the two sides cannot disagree again.
 */
export const PRESET_REQUEST_TYPES = {
  HTTP: 'http',
  GRAPHQL: 'graphql',
  GRPC: 'grpc',
  WS: 'ws'
};

export const DEFAULT_PRESET_REQUEST_TYPE = PRESET_REQUEST_TYPES.HTTP;
