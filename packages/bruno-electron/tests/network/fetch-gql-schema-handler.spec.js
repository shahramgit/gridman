// Requiring src/ipc/network pulls in the whole network stack, quickjs's wasm
// module included. On a slower machine — an ARM64 Windows VM under emulation is
// the case that surfaced this — that load alone can exceed jest's 5s default,
// and the tests time out having done nothing wrong. The work here is module
// loading, not the assertions, so the budget is the thing that was wrong.
jest.setTimeout(30000);

const prepareGqlIntrospectionRequest = require('../../src/ipc/network/prepare-gql-introspection-request');
const { fetchGqlSchemaHandler } = require('../../src/ipc/network');

// Mock only the prepare-gql-introspection-request to avoid network calls
jest.mock('../../src/ipc/network/prepare-gql-introspection-request', () => {
  return jest.fn().mockImplementation((endpoint, vars, request, root) => {
    return {
      url: endpoint,
      method: 'POST',
      headers: request?.headers || {},
      data: {
        query: '{ __schema { types { name } } }'
      }
    };
  });
});

describe('fetchGqlSchemaHandler - variable precedence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should override global environment variables with environment variables', async () => {
    const endpoint = 'https://example.com/';
    const environment = {
      variables: [
        { name: 'SHARED_VAR', value: 'env-value', enabled: true }
      ]
    };
    const request = {
      uid: 'test-request',
      vars: {
        req: [] // No request variables
      }
    };
    const collection = {
      uid: 'test-collection',
      pathname: '/test',
      runtimeVariables: {},
      globalEnvironmentVariables: {
        SHARED_VAR: 'global-value'
      },
      items: [
        {
          uid: 'test-request',
          request: {
            vars: {
              req: [] // No request variables
            }
          }
        }
      ],
      root: {
        request: {
          headers: [],
          vars: {
            req: [] // No collection variables
          }
        }
      }
    };

    await fetchGqlSchemaHandler(null, endpoint, environment, request, collection);

    expect(prepareGqlIntrospectionRequest).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        SHARED_VAR: 'env-value'
      }),
      request,
      collection.root
    );
  });

  it('should override environment variables with folder-level variables', async () => {
    const endpoint = 'https://example.com/';
    const environment = {
      variables: [
        { name: 'SHARED_VAR', value: 'env-value', enabled: true }
      ]
    };
    const request = {
      uid: 'test-request',
      vars: {
        req: [] // No request variables
      }
    };
    const collection = {
      uid: 'test-collection',
      pathname: '/test',
      runtimeVariables: {},
      globalEnvironmentVariables: {},
      items: [
        {
          uid: 'test-folder',
          type: 'folder',
          root: {
            request: {
              vars: {
                req: [
                  { name: 'SHARED_VAR', value: 'folder-value', enabled: true }
                ]
              }
            }
          },
          items: [
            {
              uid: 'test-request',
              request: {
                vars: {
                  req: [] // No request variables
                }
              }
            }
          ]
        }
      ],
      root: {
        request: {
          headers: [],
          vars: {
            req: [] // No collection variables
          }
        }
      }
    };

    await fetchGqlSchemaHandler(null, endpoint, environment, request, collection);

    expect(prepareGqlIntrospectionRequest).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        SHARED_VAR: 'folder-value'
      }),
      request,
      collection.root
    );
  });

  it('should override folder-level variables with request variables', async () => {
    const endpoint = 'https://example.com/';
    const environment = {
      variables: []
    };
    const request = {
      uid: 'test-request',
      vars: {
        req: [
          { name: 'SHARED_VAR', value: 'request-value', enabled: true }
        ]
      }
    };
    const collection = {
      uid: 'test-collection',
      pathname: '/test',
      runtimeVariables: {},
      globalEnvironmentVariables: {},
      items: [
        {
          uid: 'test-folder',
          type: 'folder',
          root: {
            request: {
              vars: {
                req: [
                  { name: 'SHARED_VAR', value: 'folder-value', enabled: true }
                ]
              }
            }
          },
          items: [
            {
              uid: 'test-request',
              request: {
                vars: {
                  req: [
                    { name: 'SHARED_VAR', value: 'request-value', enabled: true }
                  ]
                }
              }
            }
          ]
        }
      ],
      root: {
        request: {
          headers: [],
          vars: {
            req: [] // No collection variables
          }
        }
      }
    };

    await fetchGqlSchemaHandler(null, endpoint, environment, request, collection);

    expect(prepareGqlIntrospectionRequest).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        SHARED_VAR: 'request-value'
      }),
      request,
      collection.root
    );
  });

  it('should override global environment variables with collection variables', async () => {
    const endpoint = 'https://example.com/';
    const environment = {
      variables: []
    };
    const request = {
      uid: 'test-request',
      vars: {
        req: [] // No request variables
      }
    };
    const collection = {
      uid: 'test-collection',
      pathname: '/test',
      runtimeVariables: {},
      globalEnvironmentVariables: {
        SHARED_VAR: 'global-value'
      },
      items: [
        {
          uid: 'test-request',
          request: {
            vars: {
              req: [] // No request variables
            }
          }
        }
      ],
      root: {
        request: {
          headers: [],
          vars: {
            req: [
              { name: 'SHARED_VAR', value: 'collection-value', enabled: true }
            ]
          }
        }
      }
    };

    await fetchGqlSchemaHandler(null, endpoint, environment, request, collection);

    expect(prepareGqlIntrospectionRequest).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        SHARED_VAR: 'collection-value'
      }),
      request,
      collection.root
    );
  });

  it('should override collection variables with environment variables', async () => {
    const endpoint = 'https://example.com/';
    const environment = {
      variables: [
        { name: 'SHARED_VAR', value: 'env-value', enabled: true }
      ]
    };
    const request = {
      uid: 'test-request',
      vars: {
        req: [] // No request variables
      }
    };
    const collection = {
      uid: 'test-collection',
      pathname: '/test',
      runtimeVariables: {},
      globalEnvironmentVariables: {},
      items: [
        {
          uid: 'test-request',
          request: {
            vars: {
              req: [] // No request variables
            }
          }
        }
      ],
      root: {
        request: {
          headers: [],
          vars: {
            req: [
              { name: 'SHARED_VAR', value: 'collection-value', enabled: true }
            ]
          }
        }
      }
    };

    await fetchGqlSchemaHandler(null, endpoint, environment, request, collection);

    expect(prepareGqlIntrospectionRequest).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        SHARED_VAR: 'env-value'
      }),
      request,
      collection.root
    );
  });

  it('should override request variables with runtime variables', async () => {
    const endpoint = 'https://example.com/';
    const environment = {
      variables: []
    };

    const request = {
      uid: 'test-request',
      vars: {
        req: [
          { name: 'SHARED_VAR', value: 'request-value', enabled: true }
        ]
      }
    };

    const collection = {
      uid: 'test-collection',
      pathname: '/test',
      runtimeVariables: {
        SHARED_VAR: 'runtime-value'
      },
      items: [
        {
          uid: 'test-request',
          request: {
            vars: {
              req: [
                { name: 'SHARED_VAR', value: 'request-value', enabled: true }
              ]
            }
          }
        }
      ],
      root: {
        request: {
          headers: [],
          vars: {
            req: [] // No collection variables
          }
        }
      }
    };

    await fetchGqlSchemaHandler(null, endpoint, environment, request, collection);

    expect(prepareGqlIntrospectionRequest).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        SHARED_VAR: 'runtime-value'
      }),
      request,
      collection.root
    );
  });
});
