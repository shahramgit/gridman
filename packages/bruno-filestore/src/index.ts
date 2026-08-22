import type { BrunoCollection, BrunoItem, BrunoEnvironment } from '@usebruno/schema-types';

import {
  parseBruRequest,
  parseBruCollection,
  parseBruEnvironment,
  stringifyBruRequest,
  stringifyBruCollection,
  stringifyBruEnvironment,
  getBruRequestParseCost
} from './formats/bru';
import {
  parseYmlItem,
  parseYmlCollection,
  parseYmlFolder,
  parseYmlEnvironment,
  stringifyYmlItem,
  stringifyYmlFolder,
  stringifyYmlCollection,
  stringifyYmlEnvironment
} from './formats/yml';
import { dotenvToJson } from '@usebruno/lang';
import BruParserWorker from './workers';
import {
  ParseOptions,
  StringifyOptions,
  CollectionFormat
} from './types';
import { DEFAULT_COLLECTION_FORMAT } from './constants';

// request
export const parseRequest = (content: string, options: ParseOptions = { format: DEFAULT_COLLECTION_FORMAT }): any => {
  if (options.format === 'bru') {
    return parseBruRequest(content);
  } else if (options.format === 'yml') {
    return parseYmlItem(content);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

/**
 * There is deliberately no `parseRequestAndRedactBody` export here any more.
 *
 * It never returned a parsed request - it returned the REDACTION: a copy of the file with
 * placeholders in it, plus the hook that undoes them. Its one caller (bruno-electron's
 * parseLargeRequestWithRedaction) used to stitch the bodies back by hand from
 * `extractedBodyContent`, and that field is now always empty, so calling it the way its own
 * contract said left the placeholder text sitting in `request.body.json`. Redaction is an
 * implementation detail of `parseRequest` / `parseRequestViaWorker` now - they put the
 * payloads back before returning - and nothing outside this package referenced it.
 */

export const stringifyRequest = (requestObj: BrunoItem, options: StringifyOptions = { format: DEFAULT_COLLECTION_FORMAT }): string => {
  if (options.format === 'bru') {
    return stringifyBruRequest(requestObj);
  } else if (options.format === 'yml') {
    return stringifyYmlItem(requestObj);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

// request via worker
let globalWorkerInstance: BruParserWorker | null = null;
const getWorkerInstance = (): BruParserWorker => {
  if (!globalWorkerInstance) {
    globalWorkerInstance = new BruParserWorker();
  }
  return globalWorkerInstance;
};

export const parseRequestViaWorker = async (content: string, options: { format: CollectionFormat; filename?: string; priorityBoost?: number }): Promise<any> => {
  const fileParserWorker = getWorkerInstance();

  return await fileParserWorker.parseRequest(content, options.format, options.priorityBoost ?? 0);
};

export const stringifyRequestViaWorker = async (requestObj: any, options: { format: CollectionFormat }): Promise<string> => {
  const fileParserWorker = getWorkerInstance();
  return await fileParserWorker.stringifyRequest(requestObj, options.format);
};

// collection
export const parseCollection = (content: string, options: ParseOptions = { format: DEFAULT_COLLECTION_FORMAT }): any => {
  if (options.format === 'bru') {
    return parseBruCollection(content);
  } else if (options.format === 'yml') {
    return parseYmlCollection(content);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

export const stringifyCollection = (collectionObj: BrunoCollection, brunoConfig: any, options: StringifyOptions = { format: DEFAULT_COLLECTION_FORMAT }): string => {
  if (options.format === 'bru') {
    return stringifyBruCollection(collectionObj, false);
  } else if (options.format === 'yml') {
    return stringifyYmlCollection(collectionObj, brunoConfig);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

// folder
export const parseFolder = (content: string, options: ParseOptions = { format: DEFAULT_COLLECTION_FORMAT }): any => {
  if (options.format === 'bru') {
    return parseBruCollection(content);
  } else if (options.format === 'yml') {
    return parseYmlFolder(content);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

export const stringifyFolder = (folderObj: any, options: StringifyOptions = { format: DEFAULT_COLLECTION_FORMAT }): string => {
  if (options.format === 'bru') {
    return stringifyBruCollection(folderObj, true);
  } else if (options.format === 'yml') {
    return stringifyYmlFolder(folderObj);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

// environment
export const parseEnvironment = (content: string, options: ParseOptions = { format: DEFAULT_COLLECTION_FORMAT }): any => {
  if (options.format === 'bru') {
    return parseBruEnvironment(content);
  } else if (options.format === 'yml') {
    return parseYmlEnvironment(content);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

export const stringifyEnvironment = (envObj: BrunoEnvironment, options: StringifyOptions = { format: DEFAULT_COLLECTION_FORMAT }): string => {
  if (options.format === 'bru') {
    return stringifyBruEnvironment(envObj);
  } else if (options.format === 'yml') {
    return stringifyYmlEnvironment(envObj);
  }
  throw new Error(`Unsupported format: ${options.format}`);
};

export const parseDotEnv = (content: string): Record<string, string> => {
  return dotenvToJson(content);
};

/**
 * Predicted cost of parsing a bru request, in the units that actually drive it.
 *
 * Callers use this to decide whether to parse at all. See the bru implementation for why
 * file size is the wrong question. yml has no equivalent redaction, so its cost is its size.
 */
export const getRequestParseCost = (
  content: string,
  options: ParseOptions = { format: DEFAULT_COLLECTION_FORMAT }
): { effectiveBytes: number; redacted: boolean } => {
  if (options.format === 'bru') {
    return getBruRequestParseCost(content);
  }
  return { effectiveBytes: Buffer.byteLength(String(content ?? ''), 'utf8'), redacted: false };
};

export { BruParserWorker };
export * from './types';
export * from './constants';
