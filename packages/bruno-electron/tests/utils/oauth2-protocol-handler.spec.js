const {
  registerOauth2AuthorizationRequest,
  handleOauth2ProtocolUrl,
  cancelOAuth2AuthorizationRequest,
  isOauth2AuthorizationRequestInProgress
} = require('../../src/utils/oauth2-protocol-handler');

// The `bruno://` deeplink is the callback for the system-browser OAuth2 flow. Before
// upstream PR #8405 (7e3009ea5) it resolved on ANY `code`, so anything that could make
// the OS open a bruno:// URL could inject an authorization code into a pending flow.
describe('handleOauth2ProtocolUrl - state validation', () => {
  let resolve;
  let reject;

  beforeEach(() => {
    resolve = jest.fn();
    reject = jest.fn();
  });

  afterEach(() => {
    // Clear any pending request between tests
    if (isOauth2AuthorizationRequestInProgress()) {
      cancelOAuth2AuthorizationRequest();
    }
    jest.clearAllMocks();
  });

  describe('authorization code flow (state in query params)', () => {
    it('should resolve with the code when the returned state matches', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123&state=expected-state');

      expect(resolve).toHaveBeenCalledWith('auth-code-123');
      expect(reject).not.toHaveBeenCalled();
    });

    it('should reject when the returned state does not match', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123&state=attacker-state');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });

    it('should reject when no state is returned but one was expected', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });

    it('should reject when the returned state only shares a prefix with the issued state', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'user-state.deadbeef');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123&state=user-state');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });
  });

  describe('implicit flow (state in hash fragment)', () => {
    it('should resolve with tokens when the returned state matches', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback#access_token=token-abc&token_type=bearer&state=expected-state');

      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'token-abc' }));
      expect(reject).not.toHaveBeenCalled();
    });

    it('should reject when the hash state does not match', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback#access_token=token-abc&token_type=bearer&state=attacker-state');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });

    it('should reject when no hash state is returned but one was expected', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback#access_token=token-abc&token_type=bearer');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });
  });

  describe('when no expected state was registered', () => {
    it('should reject rather than resolve without state (fail closed)', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, null);

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });

    it('should reject even when the callback carries some state of its own', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, null);

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123&state=attacker-state');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('state mismatch') }));
    });
  });

  describe('error responses are handled before state validation', () => {
    it('should reject with the provider error even if state is absent', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?error=access_denied');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Authorization Failed') }));
    });

    it('should reject with the provider error in the hash fragment even if state is absent', () => {
      registerOauth2AuthorizationRequest(resolve, reject, null, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback#error=access_denied');

      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Authorization Failed') }));
    });
  });

  // The callback URL is appended to the in-flight flow's debug timeline, which the
  // legitimate request renders. An unsolicited deeplink must not get to write into it.
  describe('debug timeline', () => {
    it('should record a callback whose state matches', () => {
      const debugInfo = { data: [] };
      registerOauth2AuthorizationRequest(resolve, reject, debugInfo, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123&state=expected-state');

      expect(debugInfo.data).toHaveLength(1);
      expect(debugInfo.data[0].request.url).toContain('auth-code-123');
    });

    it('should not record a forged callback carrying a mismatched state', () => {
      const debugInfo = { data: [] };
      registerOauth2AuthorizationRequest(resolve, reject, debugInfo, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=attacker-code&state=attacker-state');

      expect(debugInfo.data).toHaveLength(0);
    });

    it('should not record a forged callback carrying no state', () => {
      const debugInfo = { data: [] };
      registerOauth2AuthorizationRequest(resolve, reject, debugInfo, 'expected-state');

      handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=attacker-code');

      expect(debugInfo.data).toHaveLength(0);
    });
  });

  describe('when no authorization request is pending', () => {
    it('should not throw for an unsolicited callback', () => {
      expect(() => handleOauth2ProtocolUrl('bruno://app/oauth2/callback?code=auth-code-123&state=whatever')).not.toThrow();
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
    });
  });
});
