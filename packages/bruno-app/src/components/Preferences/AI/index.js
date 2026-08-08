import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import get from 'lodash/get';
import debounce from 'lodash/debounce';
import { useFormik } from 'formik';
import { useDispatch, useSelector } from 'react-redux';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import { IconChevronDown, IconPlus, IconServer, IconSettings, IconShieldLock, IconStars } from '@tabler/icons';
import StatusBadge from 'ui/StatusBadge';
import { savePreferences } from 'providers/ReduxStore/slices/app';
import ToggleSwitch from 'components/ToggleSwitch';
import { clearAiApiKey, getAiStatus, newConversationId } from 'providers/ReduxStore/slices/ai';
import ProviderCard from './ProviderCard';
import CompatEndpointCard from './CompatEndpointCard';
import SecurityPane from './SecurityPane';
import StyledWrapper from './StyledWrapper';

const OPENAI_COMPATIBLE_PREFIX = 'openai-compatible:';
const isCompatProviderId = (id) => typeof id === 'string' && id.startsWith(OPENAI_COMPATIBLE_PREFIX);

// Local ids only need to be unique inside the preferences file.
const newEndpointId = () => newConversationId().replace('chat-', 'endpoint-');

const aiPreferencesSchema = Yup.object().shape({
  enabled: Yup.boolean(),
  providers: Yup.object(),
  models: Yup.object(),
  defaultModel: Yup.string().max(200).nullable(),
  openaiCompatibleEndpoints: Yup.array().of(
    Yup.object().shape({
      id: Yup.string().required(),
      name: Yup.string().max(120).nullable(),
      baseURL: Yup.string().max(2048).nullable(),
      caCertFilePath: Yup.string().max(4096).nullable(),
      allowSelfSigned: Yup.boolean(),
      models: Yup.array().of(
        Yup.object().shape({
          id: Yup.string().required(),
          label: Yup.string().max(120).nullable(),
          modelId: Yup.string().max(200).nullable()
        })
      )
    })
  ),
  autocomplete: Yup.object().shape({
    enabled: Yup.boolean(),
    model: Yup.string().max(200).nullable(),
    triggerMode: Yup.string().oneOf(['aggressive', 'debounced', 'manual']).nullable()
  }),
  security: Yup.object().shape({
    redactHeaders: Yup.boolean(),
    redactBody: Yup.boolean(),
    redactVariables: Yup.boolean(),
    redactResponse: Yup.boolean(),
    customRedactedHeaders: Yup.array().of(Yup.string().max(200)).max(200),
    customRedactedVariables: Yup.array().of(Yup.string().max(200)).max(200)
  })
});

let lastActiveSubTab = 'config';

/**
 * Preferences > AI.
 *
 * Two deliberate departures from upstream:
 *
 * 1. Self-hosted (OpenAI-compatible) endpoints lead the Configuration tab.
 *    On a restricted network the hosted providers are unreachable, so the path
 *    that actually works there must not be buried under two cards the user
 *    can't use. Nothing in this pane requires an OpenAI or Anthropic key.
 *
 * 2. A "Default model" selector is surfaced. Upstream stores `ai.defaultModel`
 *    but never exposes it; a workspace whose only model is a self-hosted one
 *    needs to pin it explicitly.
 *
 * Everything is OFF until the user turns it on: `ai.enabled` defaults to false
 * and every provider defaults to `enabled: false`, so a fresh install issues
 * no AI request of any kind.
 */
const AI = () => {
  const dispatch = useDispatch();
  const preferences = useSelector((state) => state.app.preferences);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [activeTab, setActiveTabState] = useState(lastActiveSubTab);
  const setActiveTab = useCallback((tab) => {
    lastActiveSubTab = tab;
    setActiveTabState(tab);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getAiStatus();
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      setStatusError(err.message || 'Failed to load AI status');
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const providerIds = status ? Object.keys(status.providers || {}) : [];

  const formik = useFormik({
    enableReinitialize: true,
    // Skip per-change validation — every toggle would otherwise re-run the
    // full nested schema (arrays of endpoints x models x ...), which adds tens
    // of ms of blocking work per click. debouncedSave already validates via
    // `aiPreferencesSchema.validate` right before persisting.
    validateOnChange: false,
    validateOnBlur: false,
    initialValues: {
      enabled: get(preferences, 'ai.enabled', false),
      providers: providerIds.reduce((acc, id) => {
        acc[id] = { enabled: get(preferences, `ai.providers.${id}.enabled`, false) };
        return acc;
      }, {}),
      models: get(preferences, 'ai.models', {}),
      defaultModel: get(preferences, 'ai.defaultModel', ''),
      openaiCompatibleEndpoints: get(preferences, 'ai.openaiCompatibleEndpoints', []),
      autocomplete: {
        // Ghost-text autocomplete fires on every keystroke. It stays off until
        // a user opts in, independently of the chat panel.
        enabled: get(preferences, 'ai.autocomplete.enabled', false),
        model: get(preferences, 'ai.autocomplete.model', ''),
        triggerMode: get(preferences, 'ai.autocomplete.triggerMode', 'debounced')
      },
      security: {
        redactHeaders: get(preferences, 'ai.security.redactHeaders', true),
        redactBody: get(preferences, 'ai.security.redactBody', true),
        redactVariables: get(preferences, 'ai.security.redactVariables', true),
        redactResponse: get(preferences, 'ai.security.redactResponse', true),
        customRedactedHeaders: get(preferences, 'ai.security.customRedactedHeaders', []),
        customRedactedVariables: get(preferences, 'ai.security.customRedactedVariables', [])
      }
    },
    validationSchema: aiPreferencesSchema,
    onSubmit: () => {}
  });

  const handleSave = useCallback(
    (values) =>
      dispatch(
        savePreferences({
          ...preferences,
          ai: {
            enabled: values.enabled,
            providers: values.providers,
            models: values.models,
            defaultModel: values.defaultModel || '',
            openaiCompatibleEndpoints: values.openaiCompatibleEndpoints || [],
            autocomplete: {
              enabled: values.autocomplete?.enabled === true,
              model: values.autocomplete?.model || '',
              triggerMode: values.autocomplete?.triggerMode || 'debounced'
            },
            security: {
              redactHeaders: values.security?.redactHeaders !== false,
              redactBody: values.security?.redactBody !== false,
              redactVariables: values.security?.redactVariables !== false,
              redactResponse: values.security?.redactResponse !== false,
              customRedactedHeaders: Array.isArray(values.security?.customRedactedHeaders)
                ? values.security.customRedactedHeaders
                : [],
              customRedactedVariables: Array.isArray(values.security?.customRedactedVariables)
                ? values.security.customRedactedVariables
                : []
            }
          }
        })
      )
        .then(() => refreshStatus())
        .catch((err) => {
          // Message-free, same class as the send path in AiChatSidebar. The
          // rejected value here is a schema/IPC error whose text echoes the
          // offending part of the AI preferences back at us — endpoint names,
          // provider ids, custom redaction entries. Console output lands in
          // devtools and in crash captures; the user still gets a toast.
          console.error('Failed to save AI preferences (error detail withheld from logs)');
          toast.error('Failed to save AI preferences');
          throw err;
        }),
    [dispatch, preferences, refreshStatus]
  );

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const debouncedSave = useCallback(
    debounce((values) => {
      aiPreferencesSchema
        .validate(values, { abortEarly: true })
        .then((validated) => handleSaveRef.current(validated))
        .catch(() => {});
    }, 400),
    []
  );

  useEffect(() => {
    if (formik.dirty && formik.isValid) {
      debouncedSave(formik.values);
    }
  }, [formik.values, formik.dirty, formik.isValid, debouncedSave]);

  useEffect(() => () => debouncedSave.flush(), [debouncedSave]);

  // Redaction changes bypass the debounce: turning a protection off and
  // closing preferences immediately must not lose the write, and neither must
  // turning one back on.
  const saveSecurityImmediate = (patch) => {
    const nextSecurity = { ...formik.values.security, ...patch };
    const nextValues = { ...formik.values, security: nextSecurity };

    formik.setFieldValue('security', nextSecurity);
    debouncedSave.cancel();

    aiPreferencesSchema
      .validate(nextValues, { abortEarly: true })
      .then((validated) => handleSaveRef.current(validated))
      .catch(() => {});
  };

  const modelsByProvider = useMemo(() => {
    const grouped = {};
    (status?.models || []).forEach((model) => {
      if (!grouped[model.provider]) grouped[model.provider] = [];
      grouped[model.provider].push(model);
    });
    return grouped;
  }, [status]);

  const isModelEnabled = (modelId) => get(formik.values, `models.${modelId}.enabled`, true);

  const handleToggleModel = (modelId, next) => {
    formik.setFieldValue(`models.${modelId}.enabled`, next);
  };

  const endpoints = formik.values.openaiCompatibleEndpoints || [];

  const handleAddEndpoint = async () => {
    const newEndpoint = {
      id: newEndpointId(),
      name: `Endpoint ${endpoints.length + 1}`,
      baseURL: '',
      models: []
    };
    const next = [...endpoints, newEndpoint];
    formik.setFieldValue('openaiCompatibleEndpoints', next);
    // `enabled: false`, matching the documented promise that every provider
    // defaults to off. Adding a row is not consent to route prompts through
    // it — the user turns the endpoint on with its own toggle once the base
    // URL is what they meant. (This used to write `true` and was called
    // harmless because baseURL starts empty; "harmless because another field
    // happens to be blank" is not a default we want to rely on.)
    formik.setFieldValue(`providers.${OPENAI_COMPATIBLE_PREFIX}${newEndpoint.id}.enabled`, false);
    // Persist immediately so the backend recognises the new virtual provider
    // id by the time the user enters an API key. The card derives a `pending`
    // flag from `status.providers` so its key/test actions stay disabled until
    // this resolves, which also closes the race with debouncedSave.
    try {
      await handleSaveRef.current({
        ...formik.values,
        openaiCompatibleEndpoints: next,
        providers: {
          ...formik.values.providers,
          [`${OPENAI_COMPATIBLE_PREFIX}${newEndpoint.id}`]: { enabled: false }
        }
      });
    } catch (_) {
      // toast already raised by handleSave
    }
  };

  const updateEndpoint = (endpointId, patch) => {
    const next = endpoints.map((e) => (e.id === endpointId ? { ...e, ...patch } : e));
    formik.setFieldValue('openaiCompatibleEndpoints', next);
  };

  const updateEndpointModels = (endpointId, mapFn) => {
    const next = endpoints.map((e) => (e.id === endpointId ? { ...e, models: mapFn(e.models || []) } : e));
    formik.setFieldValue('openaiCompatibleEndpoints', next);
  };

  const handleRemoveEndpoint = async (endpointId) => {
    const providerId = `${OPENAI_COMPATIBLE_PREFIX}${endpointId}`;
    const removed = endpoints.find((e) => e.id === endpointId);
    const removedModelIds = new Set((removed?.models || []).map((m) => m.id));

    const next = endpoints.filter((e) => e.id !== endpointId);
    formik.setFieldValue('openaiCompatibleEndpoints', next);

    const providersCopy = { ...formik.values.providers };
    delete providersCopy[providerId];
    formik.setFieldValue('providers', providersCopy);

    // Drop per-model toggles and clear any selector still pointing at a removed
    // model so the picker doesn't resolve to an unknown id later.
    if (removedModelIds.size > 0) {
      const modelsCopy = { ...(formik.values.models || {}) };
      for (const id of removedModelIds) delete modelsCopy[id];
      formik.setFieldValue('models', modelsCopy);

      if (removedModelIds.has(formik.values.defaultModel)) {
        formik.setFieldValue('defaultModel', '');
      }
      if (removedModelIds.has(formik.values.autocomplete?.model)) {
        formik.setFieldValue('autocomplete.model', '');
      }
    }

    // Best-effort key cleanup so we don't leave orphan encrypted blobs on disk.
    try {
      await clearAiApiKey({ providerId });
    } catch (_) {
      // ignore, key may not have been set
    }
  };

  const usableModels = useMemo(() => {
    if (!status) return [];
    const endpointsById = new Map((formik.values.openaiCompatibleEndpoints || []).map((e) => [e.id, e]));
    return (status.models || []).filter((m) => {
      if (!formik.values.providers?.[m.provider]?.enabled) return false;
      if (!status.providers?.[m.provider]?.configured) return false;
      if (!isModelEnabled(m.id)) return false;
      if (isCompatProviderId(m.provider)) {
        const endpointId = m.provider.slice(OPENAI_COMPATIBLE_PREFIX.length);
        const endpoint = endpointsById.get(endpointId);
        if (!endpoint?.baseURL) return false;
      }
      return true;
    });
  }, [status, formik.values.providers, formik.values.models, formik.values.openaiCompatibleEndpoints]);

  // Clear a stale pin rather than silently resolving to an unknown id.
  useEffect(() => {
    const pinned = formik.values.defaultModel;
    if (!pinned || !status) return;
    if (usableModels.some((m) => m.id === pinned)) return;
    formik.setFieldValue('defaultModel', '');
  }, [usableModels, status]);

  const hostedProviderIds = providerIds.filter((id) => !isCompatProviderId(id));

  const renderEndpointCard = (endpoint) => {
    const providerId = `${OPENAI_COMPATIBLE_PREFIX}${endpoint.id}`;
    const pending = !status.providers?.[providerId];
    const provider = status.providers?.[providerId] || {
      id: providerId,
      label: endpoint.name,
      configured: false,
      isCustom: true
    };
    const providerEnabled = get(formik.values, `providers.${providerId}.enabled`, false);

    return (
      <CompatEndpointCard
        key={endpoint.id}
        endpoint={endpoint}
        provider={provider}
        providerEnabled={providerEnabled}
        providerToggle={(
          <ToggleSwitch
            size="xs"
            isOn={providerEnabled}
            handleToggle={() => formik.setFieldValue(`providers.${providerId}.enabled`, !providerEnabled)}
          />
        )}
        pending={pending}
        isModelEnabled={isModelEnabled}
        onToggleModel={handleToggleModel}
        onChangeName={(name) => updateEndpoint(endpoint.id, { name })}
        onChangeBaseURL={(baseURL) => updateEndpoint(endpoint.id, { baseURL })}
        onChangeCaCertFilePath={(caCertFilePath) => updateEndpoint(endpoint.id, { caCertFilePath })}
        onToggleAllowSelfSigned={(allowSelfSigned) => updateEndpoint(endpoint.id, { allowSelfSigned })}
        onAddModel={(model) => updateEndpointModels(endpoint.id, (models) => [...models, model])}
        onRemoveModel={(modelId) => updateEndpointModels(endpoint.id, (models) => models.filter((m) => m.id !== modelId))}
        onUpdateModel={(modelId, patch) =>
          updateEndpointModels(endpoint.id, (models) => models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)))}
        onRemoveEndpoint={handleRemoveEndpoint}
        onStatusChange={(next) => setStatus(next)}
      />
    );
  };

  return (
    <StyledWrapper className="w-full flex flex-col text-xs self-stretch min-h-0">
      <div className="flex items-center gap-2">
        <div className="section-header">AI</div>
        <StatusBadge status="info" size="xs">
          Beta
        </StatusBadge>
      </div>

      <div className="ai-tabs flex items-center" role="tablist" aria-label="AI preferences">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'config'}
          className={`ai-tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}
          data-testid="ai-tab-config"
        >
          <IconSettings size={14} strokeWidth={1.5} />
          Configuration
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'security'}
          className={`ai-tab ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => setActiveTab('security')}
          data-testid="ai-tab-security"
        >
          <IconShieldLock size={14} strokeWidth={1.5} />
          Security
        </button>
      </div>

      {statusError && (
        <div className="ai-empty-notice px-3.5 py-3 text-xs" role="alert">
          {statusError}
        </div>
      )}

      {activeTab === 'config' && (
        <div className="ai-tab-panel" role="tabpanel">
          <div className="ai-master flex items-center justify-between gap-4 px-3.5 py-3 mb-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <IconStars size={15} strokeWidth={1.75} className="ai-master-icon" />
                <span className="text-[13px] font-semibold">AI Features</span>
                <span className="ai-master-summary text-[11px]">
                  Off until you turn it on. Gridman talks to the model you configure and nothing else.
                </span>
              </div>
            </div>
            <ToggleSwitch
              size="xs"
              isOn={formik.values.enabled}
              handleToggle={() => formik.setFieldValue('enabled', !formik.values.enabled)}
              data-testid="ai-master-toggle"
            />
          </div>

          {!formik.values.enabled && !statusError && (
            <div className="ai-empty-notice px-3.5 py-3 text-xs">
              Bring your own model. Point Gridman at a model on your own network, or use your own key with a hosted
              provider. Keys are encrypted on this machine and are never written to a collection.
            </div>
          )}

          {formik.values.enabled && status && (
            <>
              {/* Self-hosted first: the only path that works with no egress. */}
              <div className="ai-primary-section">
                <div className="ai-section-header flex items-center justify-between text-[11px] font-medium uppercase tracking-wider mb-1">
                  <span className="ai-primary-title inline-flex items-center gap-1.5">
                    <IconServer size={13} strokeWidth={1.75} />
                    Your own endpoint
                  </span>
                  <button
                    type="button"
                    className="compat-add-btn inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer normal-case tracking-normal"
                    onClick={handleAddEndpoint}
                    data-testid="ai-compat-add-endpoint"
                  >
                    <IconPlus size={13} strokeWidth={1.75} />
                    Add endpoint
                  </button>
                </div>

                <div className="ai-section-note text-[11px] mb-2.5">
                  Any OpenAI-compatible API — a model on your own network, vLLM, Ollama, LM Studio, or a gateway inside
                  your perimeter. Give it a name, a base URL, and the model ids it serves. No OpenAI or Anthropic key is
                  needed for this.
                </div>

                {endpoints.length === 0 ? (
                  <div className="ai-empty-notice px-3.5 py-3 text-xs">
                    No endpoints yet. Add one to run entirely against infrastructure you control.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">{endpoints.map(renderEndpointCard)}</div>
                )}
              </div>

              <div className="default-model-card flex items-center justify-between gap-3 px-3.5 py-3 mb-5">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[12.5px] font-semibold">Default model</span>
                  <span className="default-model-sub text-[11px]">
                    {usableModels.length > 0
                      ? 'Used by the chat panel unless you pick another one there.'
                      : 'No model is usable yet — add an endpoint or a provider key above.'}
                  </span>
                </div>
                <div className="model-select-wrap">
                  <select
                    className="model-select"
                    value={formik.values.defaultModel || ''}
                    disabled={usableModels.length === 0}
                    onChange={(e) => formik.setFieldValue('defaultModel', e.target.value)}
                    aria-label="Default model"
                    data-testid="ai-default-model-select"
                  >
                    <option value="">Auto (first available)</option>
                    {usableModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <IconChevronDown size={12} strokeWidth={1.75} className="model-select-chevron" />
                </div>
              </div>

              <div className="ai-section-header text-[11px] font-medium uppercase tracking-wider mb-1">
                Hosted providers
              </div>
              <div className="ai-section-note text-[11px] mb-2">
                Optional. These reach the vendor's public API directly and will not work where egress is blocked.
              </div>
              <div className="flex flex-col gap-1.5">
                {hostedProviderIds.map((id) => {
                  const provider = status.providers[id];
                  const providerEnabled = get(formik.values, `providers.${id}.enabled`, false);

                  return (
                    <ProviderCard
                      key={id}
                      provider={provider}
                      providerEnabled={providerEnabled}
                      providerToggle={(
                        <ToggleSwitch
                          size="xs"
                          isOn={providerEnabled}
                          handleToggle={() => formik.setFieldValue(`providers.${id}.enabled`, !providerEnabled)}
                        />
                      )}
                      models={modelsByProvider[id] || []}
                      isModelEnabled={isModelEnabled}
                      onToggleModel={handleToggleModel}
                      onStatusChange={(next) => setStatus(next)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'security' && (
        <div className="ai-tab-panel" role="tabpanel">
          <SecurityPane
            aiEnabled={formik.values.enabled}
            redactHeaders={formik.values.security?.redactHeaders !== false}
            redactBody={formik.values.security?.redactBody !== false}
            redactVariables={formik.values.security?.redactVariables !== false}
            redactResponse={formik.values.security?.redactResponse !== false}
            customRedactedHeaders={formik.values.security?.customRedactedHeaders || []}
            customRedactedVariables={formik.values.security?.customRedactedVariables || []}
            onToggleRedactHeaders={(next) => saveSecurityImmediate({ redactHeaders: next })}
            onToggleRedactBody={(next) => saveSecurityImmediate({ redactBody: next })}
            onToggleRedactVariables={(next) => saveSecurityImmediate({ redactVariables: next })}
            onToggleRedactResponse={(next) => saveSecurityImmediate({ redactResponse: next })}
            onChangeCustomRedactedHeaders={(next) => saveSecurityImmediate({ customRedactedHeaders: next })}
            onChangeCustomRedactedVariables={(next) => saveSecurityImmediate({ customRedactedVariables: next })}
          />
        </div>
      )}
    </StyledWrapper>
  );
};

export default AI;
