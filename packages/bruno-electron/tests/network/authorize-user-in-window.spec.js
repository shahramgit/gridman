// The in-app BrowserWindow is the DEFAULT callback path ("use system browser" is off by
// default), so this is the flow almost every user takes. Before upstream PR #8405
// (7e3009ea5) it handed back whatever `code` landed on the callback URL with no
// correlation to the request that started the flow, which is an authorization code
// injection / CSRF hole. These tests drive the real window lifecycle (redirect -> close)
// against a fake BrowserWindow so that removing the state check in the close handler
// fails the suite.

const mockWindowInstances = [];

jest.mock('electron', () => {
  class FakeWebContents {
    constructor() {
      this.listeners = {};
      this.session = {
        webRequest: {
          onBeforeRequest: jest.fn(),
          onBeforeSendHeaders: jest.fn(),
          onHeadersReceived: jest.fn(),
          onCompleted: jest.fn(),
          onErrorOccurred: jest.fn()
        }
      };
    }

    on(event, callback) {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(callback);
    }

    removeAllListeners() {
      this.listeners = {};
    }

    emit(event, ...args) {
      (this.listeners[event] || []).slice().forEach((callback) => callback(...args));
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.id = 2;
      this.closed = false;
      this.listeners = {};
      this.webContents = new FakeWebContents();
      global.__mockWindowInstances.push(this);
    }

    static getAllWindows() {
      return [];
    }

    on(event, callback) {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(callback);
    }

    show() {}

    close() {
      if (this.closed) return;
      this.closed = true;
      (this.listeners['close'] || []).slice().forEach((callback) => callback());
    }

    loadURL() {
      return Promise.resolve();
    }
  }

  return { BrowserWindow: FakeBrowserWindow };
});

jest.mock('../../src/store/preferences', () => ({
  preferencesUtil: {
    shouldVerifyTls: () => true,
    shouldUseSystemBrowser: () => false
  }
}));

global.__mockWindowInstances = mockWindowInstances;

const { authorizeUserInWindow } = require('../../src/ipc/network/authorize-user-in-window');

const AUTHORIZE_URL = 'https://authorization.url/authorize?client_id=client-id&state=issued-state';
const CALLBACK_URL = 'https://callback.url/callback';

// Starts the flow, lets the window get wired up, then drives the provider redirect that
// lands on the callback URL. The window closes itself on a match, which is what settles
// the promise.
const runFlow = async ({ redirectUrl, expectedState, grantType }) => {
  mockWindowInstances.length = 0;

  const promise = authorizeUserInWindow({
    authorizeUrl: AUTHORIZE_URL,
    callbackUrl: CALLBACK_URL,
    session: 'persist:test',
    ...(grantType ? { grantType } : {}),
    ...(expectedState === undefined ? {} : { expectedState })
  });

  // Let the promise executor run up to `await window.loadURL`.
  await Promise.resolve();

  const window = mockWindowInstances[0];
  expect(window).toBeDefined();

  window.webContents.emit('did-navigate', {}, redirectUrl);

  return promise;
};

describe('authorizeUserInWindow - state validation on the callback', () => {
  describe('authorization code flow', () => {
    it('should resolve with the code when the returned state matches the issued state', async () => {
      const result = await runFlow({
        redirectUrl: `${CALLBACK_URL}?code=auth-code-123&state=issued-state`,
        expectedState: 'issued-state'
      });

      expect(result.authorizationCode).toBe('auth-code-123');
    });

    it('should reject a callback carrying a different state', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}?code=attacker-code&state=attacker-state`,
          expectedState: 'issued-state'
        })
      ).rejects.toThrow(/state mismatch/i);
    });

    it('should reject a callback carrying no state at all', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}?code=attacker-code`,
          expectedState: 'issued-state'
        })
      ).rejects.toThrow(/state mismatch/i);
    });

    it('should reject a state that only shares the user-configured prefix', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}?code=attacker-code&state=my-state`,
          expectedState: 'my-state.0123456789abcdef0123456789abcdef'
        })
      ).rejects.toThrow(/state mismatch/i);
    });

    it('should fail closed when no state was issued for the flow', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}?code=attacker-code&state=attacker-state`,
          expectedState: null
        })
      ).rejects.toThrow(/state mismatch/i);

      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}?code=attacker-code`,
          expectedState: undefined
        })
      ).rejects.toThrow(/state mismatch/i);
    });
  });

  describe('implicit flow (tokens and state in the hash fragment)', () => {
    it('should resolve with the tokens when the returned state matches', async () => {
      const result = await runFlow({
        redirectUrl: `${CALLBACK_URL}#access_token=token-abc&token_type=Bearer&state=issued-state`,
        expectedState: 'issued-state',
        grantType: 'implicit'
      });

      expect(result.implicitTokens).toEqual(
        expect.objectContaining({ access_token: 'token-abc', token_type: 'Bearer' })
      );
    });

    it('should reject a hash callback carrying a different state', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}#access_token=attacker-token&token_type=Bearer&state=attacker-state`,
          expectedState: 'issued-state',
          grantType: 'implicit'
        })
      ).rejects.toThrow(/state mismatch/i);
    });

    it('should reject a hash callback carrying no state', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}#access_token=attacker-token&token_type=Bearer`,
          expectedState: 'issued-state',
          grantType: 'implicit'
        })
      ).rejects.toThrow(/state mismatch/i);
    });
  });

  describe('provider error responses', () => {
    it('should reject with the provider error rather than the state mismatch', async () => {
      await expect(
        runFlow({
          redirectUrl: `${CALLBACK_URL}?error=access_denied&error_description=user%20said%20no`,
          expectedState: 'issued-state'
        })
      ).rejects.toThrow(/Authorization Failed/);
    });
  });

  describe('window closed without a callback', () => {
    it('should reject when the user closes the window', async () => {
      mockWindowInstances.length = 0;

      const promise = authorizeUserInWindow({
        authorizeUrl: AUTHORIZE_URL,
        callbackUrl: CALLBACK_URL,
        session: 'persist:test',
        expectedState: 'issued-state'
      });

      await Promise.resolve();
      mockWindowInstances[0].close();

      await expect(promise).rejects.toThrow('Authorization window closed');
    });
  });
});
