import jsyaml from 'js-yaml';
import { isOpenApiSpec } from './openapi-collection';
import { isWSDLCollection } from './wsdl-collection';
import { isPostmanCollection } from './postman-collection';
import { isInsomniaCollection } from './insomnia-collection';
import { isOpenCollection } from './opencollection';
import { isBrunoCollection } from './bruno-collection';

/**
 * Single source of truth for collection format detection. Shared by the
 * file import flow and the paste import flow so both accept exactly the
 * same formats.
 *
 * @param {Object|string} data - Parsed collection object (or raw text for WSDL).
 * @returns {string|null} - The detected format, or null when unrecognized.
 */
export const detectCollectionFormat = (data) => {
  if (isOpenApiSpec(data)) {
    return 'openapi';
  }
  if (isWSDLCollection(data)) {
    return 'wsdl';
  }
  if (isPostmanCollection(data)) {
    return 'postman';
  }
  if (isInsomniaCollection(data)) {
    return 'insomnia';
  }
  if (isOpenCollection(data)) {
    return 'opencollection';
  }
  if (isBrunoCollection(data)) {
    return 'bruno';
  }
  return null;
};

/**
 * Parse raw pasted collection text the same way the file import flow parses
 * file contents: XML (WSDL) stays raw text, otherwise JSON first, then YAML.
 *
 * @param {string} text - Raw pasted content.
 * @returns {Object|string} - Parsed object, or the raw text for XML content.
 */
export const parseRawCollectionText = (text) => {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Content is empty');
  }

  // WSDL files are XML — the detection functions expect the raw text.
  if (trimmed.startsWith('<')) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed);
  } catch (jsonError) {
    // fall through to YAML (OpenAPI specs are commonly YAML)
  }

  let parsed;
  try {
    parsed = jsyaml.load(trimmed);
  } catch (yamlError) {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Failed to parse the content – ensure it is valid JSON or YAML');
  }
  return parsed;
};
