import { useSelector } from 'react-redux';

/**
 * Beta features configuration object
 * Contains all available beta feature keys
 */
// Nothing reads `preferences.beta.nodevm`. A NODE_VM entry lived here, but the
// sandbox runtime is chosen by `securityConfig.jsSandboxMode` per collection
// (ipc/network/index.js getJsSandboxRuntime) and the main process has no such
// preference, no default and no schema entry for it.
export const BETA_FEATURES = Object.freeze({
  OPENAPI_SYNC: 'openapi-sync',
  MOCK_SERVER: 'mock-server'
});

/**
 * Hook to check if a beta feature is enabled
 * @param {string} featureName - The name of the beta feature
 * @returns {boolean} - Whether the feature is enabled
 */
export const useBetaFeature = (featureName) => {
  const preferences = useSelector((state) => state.app.preferences);
  return preferences?.beta?.[featureName] || false;
};
