import { isSameOrigin } from '@usebruno/common/utils';

const ALWAYS_STRIPPED = new Set(['authorization', 'proxy-authorization', 'cookie', 'www-authenticate']);
const CREDENTIAL_HEADER_PATTERN = /(^|[-_])(api[-_]?key|auth|authz|token|secret|password|credential|session)([-_]|$)/i;

// Match the desktop redirect policy: credentials only cross origins with the
// request author's explicit opt-in, including credential-shaped custom headers.
export const stripRedirectCredentials = (
  headers: Record<string, unknown>, fromUrl: string, toUrl: string, forwardAuthorizationHeader?: boolean
): string[] => {
  if (forwardAuthorizationHeader === true || isSameOrigin(fromUrl, toUrl)) return [];
  const removed: string[] = [];
  for (const name of Object.keys(headers || {})) {
    if (ALWAYS_STRIPPED.has(name.toLowerCase()) || CREDENTIAL_HEADER_PATTERN.test(name)) {
      delete headers[name];
      removed.push(name);
    }
  }
  return removed;
};
