const URL = require('url');
// The WHATWG parser, kept under its own name because `URL` above is the legacy module.
const { URL: WhatwgURL } = require('url');
const Socket = require('net').Socket;
const axios = require('axios');
const connectionCache = new Map(); // Cache to store checkConnection() results
const electronApp = require('electron');
const { setupProxyAgents } = require('../../utils/proxy-util');
const { addCookieToJar, getCookieStringForUrl } = require('../../utils/cookies');
const { preferencesUtil } = require('../../store/preferences');
const { safeStringifyJSON } = require('../../utils/common');
const { createFormData } = require('../../utils/form-data');

const LOCAL_IPV6 = '::1';
const LOCAL_IPV4 = '127.0.0.1';
const LOCALHOST = 'localhost';
const version = electronApp?.app?.getVersion() ?? '';
const redirectResponseCodes = [301, 302, 303, 307, 308];

/**
 * Credentials must not follow a redirect to another origin.
 *
 * We do not use axios's own redirect handling (`maxRedirects: 0` below) — we follow them
 * ourselves so the timeline, cookies and method rewriting are ours. That also means axios's
 * own cross-origin header stripping never runs, and the redirect config was built with
 * `headers: { ...error.config.headers }`: every header, verbatim, to whatever host the
 * Location pointed at. Verified against a local server before this change — a request
 * carrying `Authorization: Bearer …` and `x-api-key` handed both to a different host.
 *
 * Two deliberate differences from upstream's fix (usebruno/bruno#8380, #8893):
 *
 *  1. SECURE BY DEFAULT. Upstream gates stripping behind `forwardAuthorizationHeader`,
 *     which defaults to true — you have to know the setting exists to be protected. Here
 *     the absence of the setting means "strip", and only an explicit `true` forwards.
 *     A file written by stock Bruno that sets it true is still honoured.
 *  2. It is not only `authorization`. Upstream strips authorization and
 *     proxy-authorization; the leak test also carried `cookie` and `x-api-key` across.
 *     Anything credential-shaped goes.
 *
 * Same-origin redirects keep every header — that is the normal case (a login flow bouncing
 * within one host) and stripping there would break it.
 */
const ALWAYS_STRIPPED_ON_CROSS_ORIGIN = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'www-authenticate'
]);

// Custom headers that carry a credential by convention. Deliberately narrow: a
// false positive here breaks a legitimate request, so this matches names that
// are about identity, not merely names containing "key".
const CREDENTIAL_HEADER_PATTERN = /(^|[-_])(api[-_]?key|auth|authz|token|secret|password|credential|session)([-_]|$)/i;

const isCredentialHeader = (name) => {
  const lower = String(name || '').toLowerCase();
  return ALWAYS_STRIPPED_ON_CROSS_ORIGIN.has(lower) || CREDENTIAL_HEADER_PATTERN.test(lower);
};

/**
 * Same origin = same protocol, host AND port, matching the web platform's definition.
 * Implemented here rather than imported from bruno-common: v4's `utils/index.ts` replaces
 * the export block our entry points live in (see AGENTS-BRUNO-SYNC.md), and this is four
 * lines.
 *
 * An unparseable URL is treated as a DIFFERENT origin — if we cannot prove the target is
 * the same host, the credential does not travel.
 */
const isSameOrigin = (fromUrl, toUrl) => {
  try {
    // WhatwgURL, NOT the module-level `URL` — this file binds that name to the
    // legacy `url` module (it calls URL.resolve above). `new URL(...)` against the
    // module object throws, which the catch below turned into "different origin",
    // so every redirect looked cross-origin and every same-origin login flow lost
    // its Authorization header. A fail-safe default hid a plain bug.
    const from = new WhatwgURL(fromUrl);
    const to = new WhatwgURL(toUrl);
    return from.protocol === to.protocol && from.hostname === to.hostname && from.port === to.port;
  } catch (_err) {
    // Unparseable: treat as a different origin so the credential does not travel.
    return false;
  }
};

const stripCredentialsForCrossOriginRedirect = ({ headers, fromUrl, toUrl, forwardAuthorizationHeader }) => {
  if (forwardAuthorizationHeader === true) {
    return [];
  }
  if (isSameOrigin(fromUrl, toUrl)) {
    return [];
  }
  const removed = [];
  for (const key of Object.keys(headers || {})) {
    if (isCredentialHeader(key)) {
      delete headers[key];
      removed.push(key);
    }
  }
  return removed;
};

const saveCookies = (url, headers) => {
  if (preferencesUtil.shouldStoreCookies()) {
    let setCookieHeaders = [];
    if (headers['set-cookie']) {
      setCookieHeaders = Array.isArray(headers['set-cookie'])
        ? headers['set-cookie']
        : [headers['set-cookie']];
      for (let setCookieHeader of setCookieHeaders) {
        if (typeof setCookieHeader === 'string' && setCookieHeader.length) {
          addCookieToJar(setCookieHeader, url);
        }
      }
    }
  }
};

const getTld = (hostname) => {
  if (!hostname) {
    return '';
  }

  return hostname.substring(hostname.lastIndexOf('.') + 1);
};

const checkConnection = (host, port) =>
  new Promise((resolve) => {
    const key = `${host}:${port}`;
    const cachedResult = connectionCache.get(key);

    if (cachedResult !== undefined) {
      resolve(cachedResult);
    } else {
      const socket = new Socket();

      socket.once('connect', () => {
        socket.end();
        connectionCache.set(key, true); // Cache successful connection
        resolve(true);
      });

      socket.once('error', () => {
        connectionCache.set(key, false); // Cache failed connection
        resolve(false);
      });

      // Try to connect to the host and port
      socket.connect(port, host);
    }
  });

/**
 * Function that configures axios with timing interceptors
 * Important to note here that the timings are not completely accurate.
 * @see https://github.com/axios/axios/issues/695
 * @returns {axios.AxiosInstance}
 */
function makeAxiosInstance({
  proxyMode = 'off',
  proxyModeReason = '',
  proxyConfig = {},
  requestMaxRedirects = 5,
  httpsAgentRequestFields = {},
  interpolationOptions = {},
  followRedirects = true
} = {}) {
  /** @type {axios.AxiosInstance} */
  const instance = axios.create({
    transformRequest: function (data, headers) {
      const contentType = headers?.['Content-Type'] || headers?.['content-type'] || '';
      const hasJSONContentType = contentType.includes('json');
      if (typeof data === 'string' && hasJSONContentType) {
        return data;
      }

      axios.defaults.transformRequest.forEach(function (tr) {
        data = tr.call(this, data, headers);
      }, this);
      return data;
    },
    proxy: false,
    maxRedirects: 0,
    headers: {}
  });

  // Extend common headers with User-Agent rather than replacing the object.
  // axios.create() preserves defaults.headers.common = { Accept: 'application/json, text/plain, */*' }.
  // Assigning a new object (= { 'User-Agent': ... }) would nuke that default, causing servers that
  // rely on content-negotiation to receive requests with no Accept header.
  instance.defaults.headers.common['User-Agent'] = `bruno-runtime/${version}`;

  instance.interceptors.request.use(async (config) => {
    const url = URL.parse(config.url);
    config.metadata = config.metadata || {};
    config.metadata.startTime = new Date().getTime();
    const timeline = config.metadata.timeline || [];
    // Add initial request details to the timeline
    timeline.push({
      timestamp: new Date(),
      type: 'separator'
    });
    timeline.push({
      timestamp: new Date(),
      type: 'info',
      message: `Preparing request to ${config.url}`
    });
    timeline.push({
      timestamp: new Date(),
      type: 'info',
      message: `Current time is ${new Date().toISOString()}`
    });

    // Add request method line
    timeline.push({
      timestamp: new Date(),
      type: 'request',
      message: `${config.method.toUpperCase()} ${config.url}`
    });

    // Add request data if available
    if (config.data) {
      let requestData = typeof config.data === 'string' ? config.data : JSON.stringify(config.data, null, 2);
      timeline.push({
        timestamp: new Date(),
        type: 'requestData',
        message: requestData
      });
    }

    // Resolve all *.localhost to localhost and check if it should use IPv6 or IPv4
    // RFC: 6761 section 6.3 (https://tools.ietf.org/html/rfc6761#section-6.3)
    // @see https://github.com/usebruno/bruno/issues/124
    if (getTld(url.hostname) === LOCALHOST || url.hostname === LOCAL_IPV4 || url.hostname === LOCAL_IPV6) {
      // use custom DNS lookup for localhost
      config.lookup = (hostname, options, callback) => {
        const portNumber = Number(url.port) || (url.protocol.includes('https') ? 443 : 80);
        checkConnection(LOCAL_IPV6, portNumber).then((useIpv6) => {
          const ip = useIpv6 ? LOCAL_IPV6 : LOCAL_IPV4;
          callback(null, ip, useIpv6 ? 6 : 4);
        });
      };
    } else {
      delete config.lookup;
    }

    config.headers['request-start-time'] = Date.now();

    /**
      Apply header deletions requested via req.deleteHeader() in pre-request scripts.
      Using set(name, null) rather than delete(): the axios http adapter guards its
      own defaults (User-Agent, Accept-Encoding) with set(..., false) which only
      skips writing when the key already exists. delete() removes the key entirely,
      so the guard misses and the adapter re-adds the default. null keeps the key
      present (blocking the guard) while toJSON() omits null values from the wire.
     */
    const headersToDelete = config.__headersToDelete;
    let deleteConnection = false;

    if (headersToDelete && Array.isArray(headersToDelete)) {
      headersToDelete.forEach((headerName) => {
        const lower = headerName.toLowerCase();
        if (lower === 'host') return;
        if (lower === 'connection') {
          // Handled after setupProxyAgents to avoid being overwritten by keepAlive:true.
          deleteConnection = true;
          return;
        }
        config.headers.set(headerName, null);
      });
      delete config.__headersToDelete;
    }

    // Log request headers AFTER deletion so the timeline reflects what is actually sent.
    // Skip null values (headers marked for deletion) and false values (e.g. content-type
    // suppressed for no-body requests — see https://github.com/usebruno/bruno/issues/1693).
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value === null || value === false) return;
      timeline.push({
        timestamp: new Date(),
        type: 'requestHeader',
        message: `${key}: ${value}`
      });
    });

    const agentOptions = {
      ...httpsAgentRequestFields,
      keepAlive: true
    };

    try {
      // Now call setupProxyAgents and pass the timeline (async - may perform PAC resolution)
      await setupProxyAgents({
        requestConfig: config,
        proxyMode,
        proxyModeReason,
        proxyConfig,
        httpsAgentRequestFields: agentOptions,
        interpolationOptions,
        timeline
      });
    } catch (err) {
      timeline.push({
        timestamp: new Date(),
        type: 'error',
        message: `Error setting up proxy agents: ${err?.message}`
      });
    }

    config.metadata.timeline = timeline;
    return config;
  });

  let redirectCount = 0;

  instance.interceptors.response.use(
    (response) => {
      let timeline;
      const end = Date.now();
      const start = response.config.headers['request-start-time'];
      response.headers['request-duration'] = end - start;
      redirectCount = 0;

      const config = response.config;
      timeline = config?.metadata?.timeline || [];
      const duration = end - config?.metadata.startTime;

      const httpVersion = response?.request?.res?.httpVersion || response?.httpVersion;
      if (httpVersion?.startsWith('2')) {
        timeline.push({
          timestamp: new Date(),
          type: 'info',
          message: `Using HTTP/2, server supports multiplexing`
        });
      }
      timeline.push({
        timestamp: new Date(),
        type: 'response',
        message: `HTTP/${httpVersion || '1.1'} ${response.status} ${response.statusText}`
      });

      Object.entries(response.headers).forEach(([key, value]) => {
        timeline.push({
          timestamp: new Date(),
          type: 'responseHeader',
          message: `${key}: ${value}`
        });
      });

      timeline.push({
        timestamp: new Date(),
        type: 'info',
        message: `Request completed in ${duration} ms`
      });
      response.timeline = timeline;
      return response;
    },
    async (error) => {
      const config = error.config;
      const timeline = config?.metadata?.timeline || [];
      timeline?.push({
        timestamp: new Date(),
        type: 'error',
        message: 'there was an error executing the request!'
      });
      if (error.response) {
        const end = Date.now();
        const start = error.config.headers['request-start-time'];
        error.response.headers['request-duration'] = end - start;
        const duration = end - config?.metadata?.startTime;
        if (error.response && redirectResponseCodes.includes(error.response.status)) {
          timeline.push({
            timestamp: new Date(),
            type: 'response',
            message: `HTTP/${error.response.httpVersion || '1.1'} ${error.response.status} ${error.response.statusText}`
          });
          Object.entries(error.response.headers).forEach(([key, value]) => {
            timeline.push({
              timestamp: new Date(),
              type: 'responseHeader',
              message: `${key}: ${value}`
            });
          });
          timeline.push({
            timestamp: new Date(),
            type: 'info',
            message: `Request completed in ${duration} ms`
          });

          // Attach the timeline to the response
          error.response.timeline = timeline;

          if (!followRedirects) {
            if (preferencesUtil.shouldStoreCookies()) {
              saveCookies(error.config.url, error.response.headers);
            }

            return Promise.reject(error);
          }

          if (redirectCount >= requestMaxRedirects) {
            const errorResponseData = error.response.data;
            timeline?.push({
              timestamp: new Date(),
              type: 'error',
              message: safeStringifyJSON(errorResponseData?.toString?.())
            });
            return Promise.reject(error);
          }

          // Increase redirect count
          redirectCount++;

          const locationHeader = error.response.headers.location;

          // Save cookies before deciding whether the redirect is followable: a bare 302 from an
          // enterprise proxy still carries the Set-Cookie that the next attempt needs, and the
          // `followRedirects === false` branch above already saves them before rejecting.
          if (preferencesUtil.shouldStoreCookies()) {
            saveCookies(error.config.url, error.response.headers);
          }

          // A 3xx without a Location header is not followable — enterprise proxies return bare
          // 302s on auth failure. Without this we'd build a redirect config with `url: undefined`
          // and fire a bogus request. Upstream fix: usebruno/bruno#7725 (d4b886006).
          if (!locationHeader) {
            return Promise.reject(error);
          }

          let redirectUrl = locationHeader;

          // Handle relative URLs by resolving them against the original request URL
          if (locationHeader && !locationHeader.match(/^https?:\/\//i)) {
            // It's a relative URL, resolve it against the original URL
            redirectUrl = URL.resolve(error.config.url, locationHeader);

            timeline.push({
              timestamp: new Date(),
              type: 'info',
              message: `Resolving relative redirect URL: ${locationHeader} → ${redirectUrl}`
            });
          }

          // Create a new request config for the redirect
          const requestConfig = {
            ...error.config,
            url: redirectUrl,
            headers: {
              ...error.config.headers
            }
          };

          const strippedHeaders = stripCredentialsForCrossOriginRedirect({
            headers: requestConfig.headers,
            fromUrl: error.config.url,
            toUrl: redirectUrl,
            forwardAuthorizationHeader: error.config?.settings?.forwardAuthorizationHeader
          });
          if (strippedHeaders.length) {
            timeline.push({
              timestamp: new Date(),
              type: 'info',
              message: `Cross-origin redirect to a different host — not forwarding: ${strippedHeaders.join(', ')}`
            });
          }

          // Apply proper HTTP redirect behavior based on status code
          const statusCode = error.response.status;
          const originalMethod = (error.config.method || 'get').toLowerCase();

          // For 301, 302, 303: change method to GET unless it was HEAD
          if ([301, 302, 303].includes(statusCode) && originalMethod !== 'head') {
            requestConfig.method = 'get';
            requestConfig.data = undefined;
            delete requestConfig.headers['content-length'];
            delete requestConfig.headers['Content-Length'];

            delete requestConfig.headers['content-type'];
            delete requestConfig.headers['Content-Type'];

            timeline.push({
              timestamp: new Date(),
              type: 'info',
              message: `Changed method from ${originalMethod.toUpperCase()} to GET for ${statusCode} redirect and removed request body`
            });
          } else {
            // For 307, 308 and other status codes: preserve method and body
            if (requestConfig.data && typeof requestConfig.data === 'object'
              && requestConfig.data.constructor && requestConfig.data.constructor.name === 'FormData') {
              const formData = requestConfig.data;
              if (formData._released || (formData._streams && formData._streams.length === 0)) {
                if (error.config._originalMultipartData && error.config.collectionPath) {
                  timeline.push({
                    timestamp: new Date(),
                    type: 'info',
                    message: `Recreating consumed FormData for ${statusCode} redirect`
                  });

                  const recreatedForm = createFormData(error.config._originalMultipartData, error.config.collectionPath);
                  requestConfig.data = recreatedForm;

                  const formHeaders = recreatedForm.getHeaders();
                  Object.assign(requestConfig.headers, formHeaders);

                  // preserve the original data for potential future redirects
                  requestConfig._originalMultipartData = error.config._originalMultipartData;
                  requestConfig.collectionPath = error.config.collectionPath;
                } else {
                  timeline.push({
                    timestamp: new Date(),
                    type: 'info',
                    message: `FormData consumed but no original data available for ${statusCode} redirect`
                  });
                }
              } else {
                requestConfig._originalMultipartData = error.config._originalMultipartData;
                requestConfig.collectionPath = error.config.collectionPath;
              }
            }
          }

          if (preferencesUtil.shouldSendCookies()) {
            const cookieString = getCookieStringForUrl(redirectUrl);
            if (cookieString && typeof cookieString === 'string' && cookieString.length) {
              requestConfig.headers['cookie'] = cookieString;
            }
          }

          try {
            await setupProxyAgents({
              requestConfig,
              proxyMode,
              proxyModeReason,
              proxyConfig,
              httpsAgentRequestFields,
              interpolationOptions,
              timeline
            });
          } catch (err) {
            if (err.timeline) {
              timeline = err.timeline;
            }
            timeline.push({
              timestamp: new Date(),
              type: 'error',
              message: `Error setting up proxy agents: ${err?.message}`
            });
          }

          requestConfig.metadata.timeline = timeline;
          // Make the redirected request
          return instance(requestConfig);
        } else {
          const errorResponseData = error.response.data;
          timeline.push({
            timestamp: new Date(),
            type: 'response',
            message: `HTTP/${error.response.httpVersion || '1.1'} ${error.response.status} ${error.response.statusText}`
          });
          Object.entries(error?.response?.headers || {}).forEach(([key, value]) => {
            timeline.push({
              timestamp: new Date(),
              type: 'responseHeader',
              message: `${key}: ${value}`
            });
          });
          timeline?.push({
            timestamp: new Date(),
            type: 'error',
            message: safeStringifyJSON(errorResponseData?.toString?.())
          });
          error?.cause && timeline?.push({
            timestamp: new Date(),
            type: 'error',
            message: safeStringifyJSON(error?.cause)
          });
          error?.errors && timeline?.push({
            timestamp: new Date(),
            type: 'error',
            message: safeStringifyJSON(error?.errors)
          });
          error.response.timeline = timeline;
          return Promise.reject(error);
        }
      } else if (error?.code) {
        Object.entries(error?.response?.headers || {}).forEach(([key, value]) => {
          timeline.push({
            timestamp: new Date(),
            type: 'responseHeader',
            message: `${key}: ${value}`
          });
        });
        timeline?.push({
          timestamp: new Date(),
          type: 'error',
          message: safeStringifyJSON(error?.cause)
        });
        timeline?.push({
          timestamp: new Date(),
          type: 'error',
          message: safeStringifyJSON(error?.errors)
        });
        error.timeline = timeline;
        error.statusText = error.code;
        return Promise.reject(error);
      }
      return Promise.reject(error);
    }
  );

  return instance;
}

module.exports = {
  makeAxiosInstance
};
