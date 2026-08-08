import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import theme from 'themes/dark/dark';
import { getAiStatus, setAiApiKey, clearAiApiKey, getAiApiKey, testAiProvider } from 'providers/ReduxStore/slices/ai';
import { savePreferences } from 'providers/ReduxStore/slices/app';
import AI from './index';

jest.mock('providers/ReduxStore/slices/ai', () => ({
  getAiStatus: jest.fn(),
  setAiApiKey: jest.fn(),
  clearAiApiKey: jest.fn(),
  getAiApiKey: jest.fn(),
  testAiProvider: jest.fn(),
  newConversationId: () => `chat-fixed-${Math.random().toString(36).slice(2, 8)}`
}));

jest.mock('providers/ReduxStore/slices/app', () => ({
  savePreferences: jest.fn(() => () => Promise.resolve())
}));

// components/ToggleSwitch relies on the automatic JSX runtime, which babel-jest
// does not use in this package (it emits React.createElement and that module
// has no React import). Stand in a plain checkbox so these tests exercise the
// pane rather than the switch's internals.
jest.mock('components/ToggleSwitch', () => ({ isOn, handleToggle, ...props }) => (
  <input type="checkbox" checked={Boolean(isOn)} onChange={() => handleToggle()} {...props} />
));

const OPENAI_COMPATIBLE_PREFIX = 'openai-compatible:';

/** A status payload for a machine with no hosted-provider key at all. */
const statusWithNoKeys = (extraProviders = {}, models = []) => ({
  providers: {
    openai: { id: 'openai', label: 'OpenAI', configured: false, apiKeyPlaceholder: 'sk-…' },
    anthropic: { id: 'anthropic', label: 'Anthropic', configured: false, apiKeyPlaceholder: 'sk-ant-…' },
    ...extraProviders
  },
  models,
  availableModels: []
});

const renderAI = (preferences = {}) => {
  const store = configureStore({
    reducer: {
      app: (state = { preferences }) => state
    }
  });
  const utils = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <AI />
      </ThemeProvider>
    </Provider>
  );
  return { ...utils, store };
};

const lastSavedAi = () => savePreferences.mock.calls[savePreferences.mock.calls.length - 1][0].ai;

describe('Preferences > AI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAiStatus.mockResolvedValue(statusWithNoKeys());
  });

  describe('default off', () => {
    it('shows the master switch off when preferences carry no ai section', async () => {
      renderAI({});
      await waitFor(() => expect(getAiStatus).toHaveBeenCalled());

      expect(screen.queryByTestId('ai-compat-add-endpoint')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ai-provider-openai')).not.toBeInTheDocument();
    });

    it('does not save anything just by opening the pane', async () => {
      renderAI({});
      await waitFor(() => expect(getAiStatus).toHaveBeenCalled());
      expect(savePreferences).not.toHaveBeenCalled();
    });

    it('explains the bring-your-own-model model while off', async () => {
      renderAI({});
      await waitFor(() => expect(getAiStatus).toHaveBeenCalled());
      expect(screen.getByText(/Point Gridman at a model on your own network/i)).toBeInTheDocument();
    });

    it('never says Bruno anywhere in the pane', async () => {
      const { container } = renderAI({ ai: { enabled: true } });
      await waitFor(() => expect(screen.getByTestId('ai-compat-add-endpoint')).toBeInTheDocument());
      expect(container.textContent).not.toMatch(/bruno/i);
    });
  });

  describe('self-hosted endpoint path', () => {
    it('leads with the self-hosted section, ahead of the hosted providers', async () => {
      const { container } = renderAI({ ai: { enabled: true } });
      await waitFor(() => expect(screen.getByTestId('ai-compat-add-endpoint')).toBeInTheDocument());

      const text = container.textContent;
      expect(text.indexOf('Your own endpoint')).toBeGreaterThan(-1);
      expect(text.indexOf('Your own endpoint')).toBeLessThan(text.indexOf('Hosted providers'));
    });

    it('states that no hosted key is required', async () => {
      renderAI({ ai: { enabled: true } });
      await waitFor(() => expect(screen.getByTestId('ai-compat-add-endpoint')).toBeInTheDocument());
      expect(screen.getByText(/No OpenAI or Anthropic key is\s+needed for this/i)).toBeInTheDocument();
    });

    it('persists a new endpoint immediately, with its provider OFF', async () => {
      renderAI({ ai: { enabled: true } });
      await waitFor(() => expect(screen.getByTestId('ai-compat-add-endpoint')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-compat-add-endpoint'));
      });

      const saved = lastSavedAi();
      expect(saved.openaiCompatibleEndpoints).toHaveLength(1);
      const endpointId = saved.openaiCompatibleEndpoints[0].id;
      // "Every provider defaults to false" has to be true of the provider row
      // this button creates too — adding a row is not consent to use it.
      expect(saved.providers[`${OPENAI_COMPATIBLE_PREFIX}${endpointId}`]).toEqual({ enabled: false });
      expect(Object.values(saved.providers).some((p) => p.enabled)).toBe(false);
    });

    it('lets the user set a base URL and add a model with no hosted key present', async () => {
      const endpoint = { id: 'ep-1', name: 'Internal LLM', baseURL: '', models: [] };
      const providerId = `${OPENAI_COMPATIBLE_PREFIX}ep-1`;
      getAiStatus.mockResolvedValue(
        statusWithNoKeys({ [providerId]: { id: providerId, label: 'Internal LLM', configured: true, isCustom: true, requiresApiKey: false } })
      );

      renderAI({
        ai: {
          enabled: true,
          openaiCompatibleEndpoints: [endpoint],
          providers: { [providerId]: { enabled: true } }
        }
      });

      await waitFor(() => expect(screen.getByTestId('ai-endpoint-ep-1')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('ai-endpoint-ep-1-baseurl'), {
        target: { value: 'https://llm.internal.example/v1' }
      });
      fireEvent.change(screen.getByTestId('ai-endpoint-ep-1-new-model-id'), { target: { value: 'llama3.1:8b' } });
      fireEvent.click(screen.getByTestId('ai-endpoint-ep-1-add-model'));

      await waitFor(() => expect(savePreferences).toHaveBeenCalled());

      const saved = lastSavedAi();
      expect(saved.openaiCompatibleEndpoints[0].baseURL).toBe('https://llm.internal.example/v1');
      expect(saved.openaiCompatibleEndpoints[0].models[0]).toMatchObject({ modelId: 'llama3.1:8b', label: 'llama3.1:8b' });
      // No hosted provider was ever configured for this to work.
      expect(saved.providers.openai?.enabled).toBeFalsy();
      expect(saved.providers.anthropic?.enabled).toBeFalsy();
    });

    it('drops the endpoint key when the endpoint is removed', async () => {
      const providerId = `${OPENAI_COMPATIBLE_PREFIX}ep-1`;
      clearAiApiKey.mockResolvedValue({});
      getAiStatus.mockResolvedValue(
        statusWithNoKeys({ [providerId]: { id: providerId, label: 'Internal LLM', configured: true, isCustom: true, requiresApiKey: false } })
      );

      renderAI({
        ai: {
          enabled: true,
          openaiCompatibleEndpoints: [{ id: 'ep-1', name: 'Internal LLM', baseURL: 'https://x/v1', models: [] }],
          providers: { [providerId]: { enabled: true } }
        }
      });

      await waitFor(() => expect(screen.getByTestId('ai-endpoint-ep-1')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-endpoint-ep-1-remove'));
      });

      expect(clearAiApiKey).toHaveBeenCalledWith({ providerId });
    });

    it('never claims a key exists for a keyless endpoint', async () => {
      const providerId = `${OPENAI_COMPATIBLE_PREFIX}ep-1`;
      // The backend marks a compatible endpoint "configured" as soon as it has
      // a base URL, key or no key. The card must not render the masked row off
      // that and imply a stored key.
      getAiStatus.mockResolvedValue(
        statusWithNoKeys({
          [providerId]: {
            id: providerId,
            label: 'Internal LLM',
            configured: true,
            isCustom: true,
            requiresApiKey: false,
            apiKeyPlaceholder: 'optional for internal endpoints'
          }
        })
      );

      renderAI({
        ai: {
          enabled: true,
          openaiCompatibleEndpoints: [{ id: 'ep-1', name: 'Internal LLM', baseURL: 'https://x/v1', models: [] }],
          providers: { [providerId]: { enabled: true } }
        }
      });

      await waitFor(() => expect(screen.getByTestId('ai-endpoint-ep-1')).toBeInTheDocument());

      expect(screen.getByTestId('ai-endpoint-ep-1-key-input')).toHaveAttribute(
        'placeholder',
        'optional for internal endpoints'
      );
      expect(screen.queryByText('••••••••••••••••')).not.toBeInTheDocument();
      // Test and Remove stay reachable alongside the editable field.
      expect(screen.getByTestId('ai-endpoint-ep-1-test')).toBeInTheDocument();
      expect(screen.getByTestId('ai-endpoint-ep-1-clear-key')).toBeInTheDocument();
    });

    it('saves an endpoint key through the write-only IPC call', async () => {
      const providerId = `${OPENAI_COMPATIBLE_PREFIX}ep-1`;
      setAiApiKey.mockResolvedValue(statusWithNoKeys());
      getAiStatus.mockResolvedValue(
        statusWithNoKeys({ [providerId]: { id: providerId, label: 'Internal LLM', configured: false, isCustom: true } })
      );

      renderAI({
        ai: {
          enabled: true,
          openaiCompatibleEndpoints: [{ id: 'ep-1', name: 'Internal LLM', baseURL: 'https://x/v1', models: [] }],
          providers: { [providerId]: { enabled: true } }
        }
      });

      await waitFor(() => expect(screen.getByTestId('ai-endpoint-ep-1-key-input')).toBeInTheDocument());

      const input = screen.getByTestId('ai-endpoint-ep-1-key-input');
      expect(input).toHaveAttribute('type', 'password');
      fireEvent.change(input, { target: { value: 'internal-key' } });

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-endpoint-ep-1-save-key'));
      });

      expect(setAiApiKey).toHaveBeenCalledWith({ providerId, apiKey: 'internal-key' });
    });

    /**
     * THE api-key-leakage guarantee.
     *
     * The version of this that shipped in the port asserted over
     * `savePreferences.mock.calls` at a point where that array was EMPTY — the
     * loop body never ran, so the assertion was trivially true and a typed key
     * routed into a persisted field still passed. Everything here exists to
     * make that impossible:
     *
     *  - a preferences write is FORCED after the key is typed (renaming the
     *    endpoint dirties formik), and
     *  - the number of writes is asserted to be non-zero BEFORE the contents
     *    are checked, so an empty-array pass is a failure.
     */
    it('never lets a typed API key reach persisted preferences', async () => {
      const SECRET = 'sk-internal-DO-NOT-PERSIST-9f3a';
      const providerId = `${OPENAI_COMPATIBLE_PREFIX}ep-1`;
      const status = statusWithNoKeys({
        [providerId]: { id: providerId, label: 'Internal LLM', configured: false, isCustom: true }
      });
      getAiStatus.mockResolvedValue(status);
      setAiApiKey.mockResolvedValue(status);

      renderAI({
        ai: {
          enabled: true,
          openaiCompatibleEndpoints: [{ id: 'ep-1', name: 'Internal LLM', baseURL: 'https://x/v1', models: [] }],
          providers: { [providerId]: { enabled: true } }
        }
      });

      await waitFor(() => expect(screen.getByTestId('ai-endpoint-ep-1-key-input')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('ai-endpoint-ep-1-key-input'), { target: { value: SECRET } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-endpoint-ep-1-save-key'));
      });
      expect(setAiApiKey).toHaveBeenCalledWith({ providerId, apiKey: SECRET });

      // Force at least one real preferences write while the key is in play, so
      // the assertions below have something to look at. This deliberately
      // touches a field UNRELATED to the endpoint's own name/baseURL: a leak
      // that routes the key into one of those must survive into the write
      // rather than being overwritten by the probe.
      fireEvent.change(screen.getByTestId('ai-endpoint-ep-1-new-model-id'), { target: { value: 'probe-model' } });
      fireEvent.click(screen.getByTestId('ai-endpoint-ep-1-add-model'));
      await waitFor(() => expect(savePreferences).toHaveBeenCalled(), { timeout: 3000 });

      // Guard against the vacuous form: an empty call list must FAIL here.
      expect(savePreferences.mock.calls.length).toBeGreaterThan(0);

      const persisted = savePreferences.mock.calls.map(([prefs]) => JSON.stringify(prefs));
      // The write we forced really happened and really carried the AI section.
      expect(persisted.some((blob) => blob.includes('probe-model'))).toBe(true);
      for (const blob of persisted) {
        expect(blob).not.toContain(SECRET);
      }
    });
  });

  describe('default model', () => {
    it('is disabled until a model is actually usable', async () => {
      renderAI({ ai: { enabled: true } });
      await waitFor(() => expect(screen.getByTestId('ai-default-model-select')).toBeInTheDocument());
      expect(screen.getByTestId('ai-default-model-select')).toBeDisabled();
    });

    it('offers a self-hosted model and persists the pick', async () => {
      const providerId = `${OPENAI_COMPATIBLE_PREFIX}ep-1`;
      getAiStatus.mockResolvedValue(
        statusWithNoKeys(
          { [providerId]: { id: providerId, label: 'Internal LLM', configured: true, isCustom: true, requiresApiKey: false } },
          [{ id: 'm-1', label: 'llama3.1:8b', provider: providerId }]
        )
      );

      renderAI({
        ai: {
          enabled: true,
          openaiCompatibleEndpoints: [
            { id: 'ep-1', name: 'Internal LLM', baseURL: 'https://x/v1', models: [{ id: 'm-1', modelId: 'llama3.1:8b', label: 'llama3.1:8b' }] }
          ],
          providers: { [providerId]: { enabled: true } }
        }
      });

      const select = await screen.findByTestId('ai-default-model-select');
      await waitFor(() => expect(select).toBeEnabled());

      fireEvent.change(select, { target: { value: 'm-1' } });

      await waitFor(() => expect(savePreferences).toHaveBeenCalled());
      expect(lastSavedAi().defaultModel).toBe('m-1');
    });
  });

  describe('security tab', () => {
    const openSecurity = async () => {
      await waitFor(() => expect(screen.getByTestId('ai-tab-security')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-tab-security'));
    };

    it('defaults every redaction switch on', async () => {
      renderAI({ ai: { enabled: true } });
      await openSecurity();

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-security-headers-toggle'));
      });

      // The first write carries the pre-toggle state of the other switches.
      const saved = lastSavedAi().security;
      expect(saved.redactBody).toBe(true);
      expect(saved.redactVariables).toBe(true);
      expect(saved.redactResponse).toBe(true);
      expect(saved.redactHeaders).toBe(false);
    });

    it('persists a redaction change without waiting for the debounce', async () => {
      renderAI({ ai: { enabled: true } });
      await openSecurity();

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-security-variables-toggle'));
      });

      expect(savePreferences).toHaveBeenCalled();
      expect(lastSavedAi().security.redactVariables).toBe(false);
    });

    it('adds a custom redacted header', async () => {
      renderAI({ ai: { enabled: true } });
      await openSecurity();

      fireEvent.change(screen.getByTestId('ai-security-custom-header-input'), { target: { value: 'X-Internal-Token' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-security-custom-header-add'));
      });

      expect(lastSavedAi().security.customRedactedHeaders).toEqual(['X-Internal-Token']);
    });

    it('tells the user to turn AI on first when it is off', async () => {
      renderAI({});
      await openSecurity();
      expect(screen.getByText(/Turn on AI in the Configuration tab to configure redaction/i)).toBeInTheDocument();
    });

    /**
     * Two things a customer would otherwise only find out by reading the
     * prompt the model received: the content being edited is sent verbatim, and
     * an ordinary-looking secret under an ordinary-looking key is not
     * detectable. Both are stated on the screen that claims to control this.
     */
    describe('disclosure of what is not redacted', () => {
      /**
       * This paragraph is what someone reads when deciding whether to point
       * Gridman at a cloud provider, so it has to be the WHOLE verbatim list.
       * It used to name only Docs while `allContent` shipped Tests,
       * Pre-Request and Post-Response by the same route — see
       * AiChatSidebar/ai-slice.spec.js, "sends every allContent slot verbatim",
       * which is the ground truth these labels have to match.
       */
      it('names every channel that is sent as written, not just docs', async () => {
        renderAI({ ai: { enabled: true } });
        await openSecurity();

        const disclosure = screen.getByTestId('ai-security-disclosure');
        expect(disclosure).toHaveTextContent(/sent word for word/i);
        for (const channel of ['Docs', 'Tests', 'Pre-Request script', 'Post-Response script']) {
          expect(disclosure).toHaveTextContent(channel);
        }
        expect(disclosure).toHaveTextContent(/Chat messages you type are sent as you wrote them/i);
      });

      it('says an ordinary secret under an ordinary key is not caught', async () => {
        renderAI({ ai: { enabled: true } });
        await openSecurity();

        expect(screen.getByTestId('ai-security-disclosure')).toHaveTextContent(
          /ordinary-looking secret under an ordinary-looking key is not detectable/i
        );
      });

      it('does not claim the variables switch can turn protection off', async () => {
        renderAI({ ai: { enabled: true } });
        await openSecurity();

        expect(screen.getByText(/can widen redaction, never remove it/i)).toBeInTheDocument();
      });
    });
  });

  describe('error logging', () => {
    it('keeps the save error out of the console', async () => {
      // Same class as the send path in AiChatSidebar: the rejected value here
      // echoes the offending AI preferences (endpoint names, provider ids,
      // custom redaction entries) and console output lands in crash captures.
      savePreferences.mockImplementation(() => () => Promise.reject(new Error('endpoint corp-llm rejected: apiKey')));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      renderAI({ ai: { enabled: true } });
      await waitFor(() => expect(screen.getByTestId('ai-tab-config')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-tab-config'));
      await waitFor(() => expect(screen.getByTestId('ai-compat-add-endpoint')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-compat-add-endpoint'));
      });

      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      const logged = consoleError.mock.calls.map((call) => call.map((a) => String(a?.message ?? a)).join(' ')).join('\n');
      expect(logged).not.toContain('corp-llm');
      expect(logged).not.toContain('apiKey');

      consoleError.mockRestore();
    });
  });

  describe('autocomplete preference', () => {
    it('is written as off when the user saves anything else', async () => {
      renderAI({ ai: { enabled: true } });
      // The pane remembers the last sub-tab across mounts, so make the tab
      // explicit rather than depending on test order.
      await waitFor(() => expect(screen.getByTestId('ai-tab-config')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-tab-config'));
      await waitFor(() => expect(screen.getByTestId('ai-compat-add-endpoint')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-compat-add-endpoint'));
      });

      expect(lastSavedAi().autocomplete.enabled).toBe(false);
    });
  });
});
