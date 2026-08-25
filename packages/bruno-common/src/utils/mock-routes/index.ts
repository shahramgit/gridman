/**
 * Turning a request URL into a mock-server route.
 *
 * Ported from upstream's `utils/url` rather than merged into it: that file has
 * diverged here (getExplicitScheme, the fragment handling in parseQueryParams)
 * and taking it wholesale would undo those. These two functions depend on
 * nothing else in it, so they live on their own.
 */

/**
 * Normalize a Bruno request URL to a mock-server route path.
 * Strips scheme/host, leading `{{var}}`, query strings; turns remaining `{{var}}` into `:var`
 * so it matches Express-style route params. Callers that persist or display the user-typed URL
 * pass `preserveTemplateVars: true` to keep `{{var}}` intact.
 */
const extractMockRoutePath = (rawUrl: unknown, { preserveTemplateVars = false } = {}): string => {
  if (!rawUrl) {
    return '/';
  }

  let cleaned = String(rawUrl).trim();
  cleaned = cleaned.replace(/^\{\{[^}]+\}\}/, '');

  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
    try {
      cleaned = new URL(cleaned).pathname;
    } catch {
      const withoutScheme = cleaned.replace(/^https?:\/\//, '');
      const slashIndex = withoutScheme.indexOf('/');
      cleaned = slashIndex === -1 ? '/' : withoutScheme.slice(slashIndex);
      const qIndex = cleaned.indexOf('?');
      if (qIndex !== -1) {
        cleaned = cleaned.substring(0, qIndex);
      }
    }
  } else {
    const ipHostMatch = cleaned.match(/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(\/[^?#]*)?/);
    if (ipHostMatch) {
      cleaned = ipHostMatch[1] || '/';
    } else {
      const domainHostMatch = cleaned.match(/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+(?::\d+)?(\/[^?#]*)?/);
      if (domainHostMatch) {
        cleaned = domainHostMatch[1] || '/';
      } else {
        const bareHostMatch = cleaned.match(/^[a-zA-Z0-9-]+:\d+(\/[^?#]*)?/);
        if (bareHostMatch) {
          cleaned = bareHostMatch[1] || '/';
        }
      }
    }

    const qIndex = cleaned.indexOf('?');
    if (qIndex !== -1) {
      cleaned = cleaned.substring(0, qIndex);
    }
  }

  if (preserveTemplateVars) {
    cleaned = cleaned.replace(/%7B%7B([^%]+)%7D%7D/gi, '{{$1}}');
  } else {
    cleaned = cleaned.replace(/\{\{([^}]+)\}\}/g, ':$1');
  }

  if (!cleaned.startsWith('/')) {
    cleaned = `/${cleaned}`;
  }
  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  cleaned = cleaned.replace(/\/+/g, '/');

  return cleaned || '/';
};

interface MockResponseRouteKeyInput {
  request?: {
    method?: string;
    url?: string;
  } | null;
  response?: {
    status?: number | string;
  } | null;
}

const getMockResponseRouteKey = (response?: MockResponseRouteKeyInput | null): string => {
  const method = (response?.request?.method || 'GET').toUpperCase();
  const url = extractMockRoutePath(response?.request?.url);
  const status = Number(response?.response?.status) || 200;
  return `${method} ${url}::${status}`;
};

export { extractMockRoutePath, getMockResponseRouteKey };
