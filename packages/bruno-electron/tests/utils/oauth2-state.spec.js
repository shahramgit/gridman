// electron-store is instantiated at module load by the oauth2/preferences stores.
jest.mock('electron-store', () => {
  return class StoreStub {
    constructor() {
      this.data = {};
    }

    get(key, defaultValue) {
      // The real electron-store seeds from defaults; callers assume an object back.
      return this.data[key] ?? defaultValue ?? {};
    }

    set(key, value) {
      this.data[key] = value;
    }
  };
});

jest.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: class {},
  shell: { openExternal: jest.fn() }
}));

jest.mock('../../src/ipc/network/authorize-user-in-window', () => ({
  authorizeUserInWindow: jest.fn()
}));

jest.mock('../../src/ipc/network/authorize-user-in-system-browser', () => ({
  authorizeUserInSystemBrowser: jest.fn()
}));

// The in-app window is the default; the system browser is opt-in via preferences.
let mockUseSystemBrowser = false;
jest.mock('../../src/store/preferences', () => ({
  preferencesUtil: {
    shouldUseSystemBrowser: () => mockUseSystemBrowser,
    shouldVerifyTls: () => true
  }
}));

jest.mock('../../src/ipc/network/axios-instance', () => ({
  makeAxiosInstance: () => jest.fn().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { url: 'https://authorization.url/token', headers: {}, data: '' },
    data: Buffer.from(JSON.stringify({ access_token: 'token-abc', token_type: 'Bearer' }))
  })
}));

const { authorizeUserInWindow } = require('../../src/ipc/network/authorize-user-in-window');
const { authorizeUserInSystemBrowser } = require('../../src/ipc/network/authorize-user-in-system-browser');
const {
  generateState,
  getOAuth2TokenUsingImplicitGrant,
  getOAuth2TokenUsingAuthorizationCode
} = require('../../src/utils/oauth2');

// Upstream PR #8405 (7e3009ea5): every browser-based OAuth2 flow must send an
// unguessable state and hand the same value to the callback handler for comparison,
// otherwise an injected authorization code is indistinguishable from a real one.
describe('oauth2: generateState', () => {
  it('should generate a random state when the user configured none', () => {
    const state = generateState({ userState: '' });
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should generate a random state when userState is undefined', () => {
    expect(generateState({})).toMatch(/^[0-9a-f]{32}$/);
    expect(generateState()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should be different on every call (per-flow, not per-request-definition)', () => {
    const states = new Set(Array.from({ length: 50 }, () => generateState({ userState: '' })));
    expect(states.size).toBe(50);
  });

  it('should keep the user-configured state as a prefix and still add randomness', () => {
    const state = generateState({ userState: 'my-state' });
    expect(state).toMatch(/^my-state\.[0-9a-f]{32}$/);
    expect(generateState({ userState: 'my-state' })).not.toBe(state);
  });

  it('should ignore a whitespace-only user state', () => {
    expect(generateState({ userState: '   ' })).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should trim the user-configured state', () => {
    expect(generateState({ userState: '  my-state  ' })).toMatch(/^my-state\.[0-9a-f]{32}$/);
  });
});

// The authorization code grant is the flow that exchanges the callback for a token, so a
// code injected by an unvalidated callback is directly swapped for the user's access
// token. It has to send a per-flow state and hand the same value to the callback handler.
describe('oauth2: authorization code grant sends and expects the same state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSystemBrowser = false;
  });

  const runAuthorizationCodeGrant = async ({ state, useSystemBrowser = false } = {}) => {
    mockUseSystemBrowser = useSystemBrowser;
    const authorizeFunction = useSystemBrowser ? authorizeUserInSystemBrowser : authorizeUserInWindow;
    authorizeFunction.mockResolvedValue({
      authorizationCode: 'auth-code-123',
      debugInfo: { data: [] }
    });

    await getOAuth2TokenUsingAuthorizationCode({
      request: {
        oauth2: {
          grantType: 'authorization_code',
          authorizationUrl: 'https://authorization.url/authorize',
          accessTokenUrl: 'https://authorization.url/token',
          callbackUrl: 'https://callback.url/callback',
          clientId: 'client-id',
          ...(state === undefined ? {} : { state })
        }
      },
      collectionUid: 'collection-uid',
      forceFetch: true,
      certsAndProxyConfigForTokenUrl: {}
    });

    expect(authorizeFunction).toHaveBeenCalledTimes(1);
    const args = authorizeFunction.mock.calls[0][0];
    return {
      expectedState: args.expectedState,
      sentState: new URL(args.authorizeUrl).searchParams.get('state')
    };
  };

  it('should send a state even when the user configured none', async () => {
    const { expectedState, sentState } = await runAuthorizationCodeGrant();

    expect(sentState).toMatch(/^[0-9a-f]{32}$/);
    expect(expectedState).toBe(sentState);
  });

  it('should send the user state plus a nonce and expect exactly that value back', async () => {
    const { expectedState, sentState } = await runAuthorizationCodeGrant({ state: 'my-state' });

    expect(sentState).toMatch(/^my-state\.[0-9a-f]{32}$/);
    expect(expectedState).toBe(sentState);
  });

  it('should issue a fresh state on every flow', async () => {
    const first = await runAuthorizationCodeGrant({ state: 'my-state' });
    jest.clearAllMocks();
    const second = await runAuthorizationCodeGrant({ state: 'my-state' });

    expect(first.sentState).not.toBe(second.sentState);
  });

  it('should hand the issued state to the system browser flow as well', async () => {
    const { expectedState, sentState } = await runAuthorizationCodeGrant({ useSystemBrowser: true });

    expect(sentState).toMatch(/^[0-9a-f]{32}$/);
    expect(expectedState).toBe(sentState);
  });
});

describe('oauth2: implicit grant sends and expects the same state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSystemBrowser = false;
  });

  const runImplicitGrant = async ({ state } = {}) => {
    authorizeUserInWindow.mockResolvedValue({
      implicitTokens: { access_token: 'token-abc', token_type: 'Bearer' },
      debugInfo: { data: [] }
    });

    await getOAuth2TokenUsingImplicitGrant({
      request: {
        oauth2: {
          grantType: 'implicit',
          authorizationUrl: 'https://authorization.url/authorize',
          callbackUrl: 'https://callback.url/callback',
          clientId: 'client-id',
          ...(state === undefined ? {} : { state })
        }
      },
      collectionUid: 'collection-uid',
      forceFetch: true
    });

    expect(authorizeUserInWindow).toHaveBeenCalledTimes(1);
    const args = authorizeUserInWindow.mock.calls[0][0];
    return {
      expectedState: args.expectedState,
      sentState: new URL(args.authorizeUrl).searchParams.get('state')
    };
  };

  it('should send a state even when the user configured none', async () => {
    const { expectedState, sentState } = await runImplicitGrant();

    expect(sentState).toMatch(/^[0-9a-f]{32}$/);
    expect(expectedState).toBe(sentState);
  });

  it('should send the user state plus a nonce and expect exactly that value back', async () => {
    const { expectedState, sentState } = await runImplicitGrant({ state: 'my-state' });

    expect(sentState).toMatch(/^my-state\.[0-9a-f]{32}$/);
    expect(expectedState).toBe(sentState);
  });

  it('should issue a fresh state on every flow', async () => {
    const first = await runImplicitGrant({ state: 'my-state' });
    jest.clearAllMocks();
    const second = await runImplicitGrant({ state: 'my-state' });

    expect(first.sentState).not.toBe(second.sentState);
  });
});

// The nonce generateState appends is a wire detail. It is validated on the callback and
// then dropped, so what ends up in the stored credentials (and in the UI) stays the value
// the user configured, exactly as it was before the state fix.
describe('oauth2: implicit grant does not leak the nonce into stored credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSystemBrowser = false;
  });

  const runImplicitGrantForCredentials = async ({ state } = {}) => {
    // The callback handler only lets through a state equal to the one it issued, so echo
    // back whatever the flow put on the wire.
    authorizeUserInWindow.mockImplementation(async ({ authorizeUrl }) => ({
      implicitTokens: {
        access_token: 'token-abc',
        token_type: 'Bearer',
        state: new URL(authorizeUrl).searchParams.get('state')
      },
      debugInfo: { data: [] }
    }));

    const result = await getOAuth2TokenUsingImplicitGrant({
      request: {
        oauth2: {
          grantType: 'implicit',
          authorizationUrl: 'https://authorization.url/authorize',
          callbackUrl: 'https://callback.url/callback',
          clientId: 'client-id',
          ...(state === undefined ? {} : { state })
        }
      },
      collectionUid: 'collection-uid',
      forceFetch: true
    });

    return result.credentials;
  };

  it('should persist the user-configured state, not the value put on the wire', async () => {
    const credentials = await runImplicitGrantForCredentials({ state: 'my-state' });

    expect(credentials.state).toBe('my-state');
  });

  it('should persist an empty state when the user configured none', async () => {
    const credentials = await runImplicitGrantForCredentials();

    expect(credentials.state).toBe('');
  });
});
