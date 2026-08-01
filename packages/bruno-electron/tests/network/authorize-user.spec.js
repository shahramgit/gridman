const { matchesCallbackUrl, matchesExpectedState } = require('../../src/ipc/network/authorize-user-in-window');

describe('matchesCallbackUrl', () => {
  const testCases = [
    { url: 'https://random-url/endpoint', expected: false },
    { url: 'https://random-url/endpoint?code=abcd', expected: false },
    { url: 'https://callback.url/endpoint?code=abcd', expected: true },
    { url: 'https://callback.url/endpoint/?code=abcd', expected: true },
    { url: 'https://callback.url/random-endpoint/?code=abcd', expected: false }
  ];

  it.each(testCases)('$url - should be $expected', ({ url, expected }) => {
    let callBackUrl = 'https://callback.url/endpoint';

    let actual = matchesCallbackUrl(new URL(url), new URL(callBackUrl));

    expect(actual).toBe(expected);
  });

  describe('root path callback URL', () => {
    const rootPathCases = [
      { url: 'https://hostname/auth/login', expected: false, desc: 'intermediate login page without code' },
      { url: 'https://hostname/consent', expected: false, desc: 'intermediate consent page without code' },
      { url: 'https://hostname/?code=abcd', expected: true, desc: 'root callback with authorization code' },
      { url: 'https://hostname/?error=access_denied', expected: false, desc: 'root callback with error (handled separately by onWindowRedirect)' },
      { url: 'https://hostname/#access_token=xyz', expected: true, desc: 'root callback with implicit flow hash' },
      { url: 'https://hostname/', expected: false, desc: 'root path without any OAuth2 params' },
      { url: 'https://other-host/?code=abcd', expected: false, desc: 'different host with code param' }
    ];

    it.each(rootPathCases)('$desc ($url) - should be $expected', ({ url, expected }) => {
      let callBackUrl = 'https://hostname/';

      let actual = matchesCallbackUrl(new URL(url), new URL(callBackUrl));

      expect(actual).toBe(expected);
    });
  });

  describe('implicit flow with hash fragments', () => {
    const implicitCases = [
      { url: 'https://callback.url/endpoint#access_token=xyz&token_type=bearer', expected: true, desc: 'callback with hash fragment' },
      { url: 'https://callback.url/endpoint#', expected: false, desc: 'callback with empty hash' },
      { url: 'https://callback.url/endpoint', expected: false, desc: 'callback without hash or code' }
    ];

    it.each(implicitCases)('$desc ($url) - should be $expected', ({ url, expected }) => {
      let callBackUrl = 'https://callback.url/endpoint';

      let actual = matchesCallbackUrl(new URL(url), new URL(callBackUrl));

      expect(actual).toBe(expected);
    });
  });

  it('should return false for null url', () => {
    let callBackUrl = 'https://callback.url/endpoint';
    expect(matchesCallbackUrl(null, new URL(callBackUrl))).toBe(false);
  });
});

// The in-app BrowserWindow used to hand back whatever `code` landed on the callback URL,
// with no correlation to the request that started the flow. Upstream PR #8405 (7e3009ea5)
// added state validation; matchesExpectedState is the check the window close handler runs.
describe('matchesExpectedState', () => {
  describe('authorization code flow (state in query params)', () => {
    it('should accept a callback whose state matches the issued state', () => {
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd&state=issued-state'), 'issued-state')).toBe(true);
    });

    it('should reject a callback carrying a different state', () => {
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd&state=attacker-state'), 'issued-state')).toBe(false);
    });

    it('should reject a callback carrying no state at all', () => {
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd'), 'issued-state')).toBe(false);
    });

    it('should reject a callback whose state is only a prefix of the issued state', () => {
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd&state=user-state'), 'user-state.deadbeef')).toBe(false);
    });

    it('should accept a user-prefixed state that round-trips intact', () => {
      const issuedState = 'user-state.0123456789abcdef';
      expect(matchesExpectedState(new URL(`https://callback.url/?code=abcd&state=${issuedState}`), issuedState)).toBe(true);
    });
  });

  describe('implicit flow (state in hash fragment)', () => {
    it('should accept a hash state that matches the issued state', () => {
      expect(
        matchesExpectedState(new URL('https://callback.url/#access_token=xyz&state=issued-state'), 'issued-state')
      ).toBe(true);
    });

    it('should reject a hash state that does not match', () => {
      expect(
        matchesExpectedState(new URL('https://callback.url/#access_token=xyz&state=attacker-state'), 'issued-state')
      ).toBe(false);
    });

    it('should reject a hash callback with no state', () => {
      expect(matchesExpectedState(new URL('https://callback.url/#access_token=xyz'), 'issued-state')).toBe(false);
    });
  });

  describe('fail closed', () => {
    it('should reject when no state was issued', () => {
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd&state=anything'), null)).toBe(false);
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd'), undefined)).toBe(false);
      expect(matchesExpectedState(new URL('https://callback.url/?code=abcd'), '')).toBe(false);
    });

    it('should reject a null url', () => {
      expect(matchesExpectedState(null, 'issued-state')).toBe(false);
    });
  });
});
