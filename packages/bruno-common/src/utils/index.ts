export {
  hasExplicitScheme,
  encodeUrl,
  parseQueryParams,
  buildQueryString,
  stripOrigin
} from './url';

export {
  buildFormUrlEncodedPayload,
  isFormData,
  getMediaType,
  extractBoundaryFromContentType
} from './form-data';

export {
  patternHasher
} from './template-hasher';

export {
  PROMPT_VARIABLE_TEXT_PATTERN,
  PROMPT_VARIABLE_TEMPLATE_PATTERN,
  extractPromptVariables,
  extractPromptVariablesFromString
} from './prompt-variables';

export {
  jsonToDotenv,
  DotenvVariable
} from './jsonToDotenv';

export {
  foldSearchText,
  foldSearchTextWithMap,
  findFoldedMatchRange,
  foldedIncludes
} from './search-fold';

export {
  extractMockRoutePath,
  getMockResponseRouteKey
} from './mock-routes';

export const DEFAULT_MAX_REDIRECTS = 5;

export const assertSupportedEnvironment = (environment?: { extends?: unknown } | null): void => {
  const parents = environment?.extends;
  if ((typeof parents === 'string' && parents.length > 0) || (Array.isArray(parents) && parents.length > 0)) {
    throw new Error('Environment inheritance is not supported by this version of Gridman. Remove extends or use an environment with all required variables.');
  }
};

export const isSameOrigin = (fromUrl: string, toUrl: string): boolean => {
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    return from.origin === to.origin;
  } catch (_) {
    return false;
  }
};

// Redirect ceilings must be finite numbers. Parsers can warn on undefined, or
// use the shared default; preserving large ceilings also keeps exponent-form
// numbers stable when a file is saved and read again.
export const parseMaxRedirects = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
};

export const toMaxRedirects = (value: unknown): number => parseMaxRedirects(value) ?? DEFAULT_MAX_REDIRECTS;
