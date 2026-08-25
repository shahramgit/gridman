import React from 'react';
import { useDispatch } from 'react-redux';
import StyledWrapper from './StyledWrapper';
import { updateCollectionPresets } from 'providers/ReduxStore/slices/collections';
import { saveCollectionSettings } from 'providers/ReduxStore/slices/collections/actions';
import { get } from 'lodash';
import Button from 'ui/Button';
import { PRESET_REQUEST_TYPES } from 'utils/common/constants';

const PresetsSettings = ({ collection }) => {
  const dispatch = useDispatch();
  const initialPresets = { requestType: PRESET_REQUEST_TYPES.HTTP, requestUrl: '', defaultEnvironment: '' };

  // Get presets from draft.brunoConfig if it exists, otherwise from brunoConfig
  const currentPresets = collection.draft?.brunoConfig
    ? get(collection, 'draft.brunoConfig.presets', initialPresets)
    : get(collection, 'brunoConfig.presets', initialPresets);

  // Helper to update presets config
  const updatePresets = (updates) => {
    const updatedPresets = { ...currentPresets, ...updates };
    dispatch(updateCollectionPresets({
      collectionUid: collection.uid,
      presets: updatedPresets
    }));
  };

  const handleSave = () => dispatch(saveCollectionSettings(collection.uid));

  const handleRequestTypeChange = (e) => {
    updatePresets({ requestType: e.target.value });
  };

  const handleRequestUrlChange = (e) => {
    updatePresets({ requestUrl: e.target.value });
  };

  const handleDefaultEnvironmentChange = (e) => {
    updatePresets({ defaultEnvironment: e.target.value });
  };

  const environments = collection.environments || [];
  // An environment named in the config but since renamed or deleted would
  // otherwise vanish from the select while staying in the file — show it, so
  // the user can see what is set and change it.
  const configuredEnvironment = currentPresets.defaultEnvironment || '';
  const missingEnvironment = configuredEnvironment
    && !environments.some((environment) => environment.name === configuredEnvironment);

  return (
    <StyledWrapper className="h-full w-full">
      <div className="text-xs mb-4 text-muted">
        These presets will be used as the default values for new requests in this collection.
      </div>
      <div className="bruno-form">
        <div className="mb-3 flex items-center">
          <label className="settings-label flex items-center" htmlFor="http">
            Request Type
          </label>
          <div className="flex items-center">
            <input
              id="http"
              className="cursor-pointer"
              type="radio"
              name="requestType"
              onChange={handleRequestTypeChange}
              value="http"
              checked={(currentPresets.requestType || PRESET_REQUEST_TYPES.HTTP) === PRESET_REQUEST_TYPES.HTTP}
            />
            <label htmlFor="http" className="ml-1 cursor-pointer select-none">
              HTTP
            </label>

            <input
              id="graphql"
              className="ml-4 cursor-pointer"
              type="radio"
              name="requestType"
              onChange={handleRequestTypeChange}
              value="graphql"
              checked={(currentPresets.requestType || PRESET_REQUEST_TYPES.HTTP) === PRESET_REQUEST_TYPES.GRAPHQL}
            />
            <label htmlFor="graphql" className="ml-1 cursor-pointer select-none">
              GraphQL
            </label>

            <input
              id="grpc"
              className="ml-4 cursor-pointer"
              type="radio"
              name="requestType"
              onChange={handleRequestTypeChange}
              value="grpc"
              checked={(currentPresets.requestType || PRESET_REQUEST_TYPES.HTTP) === PRESET_REQUEST_TYPES.GRPC}
            />
            <label htmlFor="grpc" className="ml-1 cursor-pointer select-none">
              gRPC
            </label>

            <input
              id="ws"
              className="ml-4 cursor-pointer"
              type="radio"
              name="requestType"
              onChange={handleRequestTypeChange}
              value="ws"
              checked={(currentPresets.requestType || PRESET_REQUEST_TYPES.HTTP) === PRESET_REQUEST_TYPES.WS}
            />
            <label htmlFor="ws" className="ml-1 cursor-pointer select-none">
              WebSocket
            </label>
          </div>
        </div>
        <div className="mb-3 flex items-center">
          <label className="settings-label" htmlFor="request-url">
            Base URL
          </label>
          <div className="flex items-center w-full">
            <div className="flex items-center flex-grow input-container h-full">
              <input
                id="request-url"
                type="text"
                name="requestUrl"
                placeholder="Request URL"
                className="block textbox"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck="false"
                onChange={handleRequestUrlChange}
                value={currentPresets.requestUrl || ''}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </div>

        <div className="mb-3 flex items-center">
          <label className="settings-label" htmlFor="default-environment">
            Default Environment
          </label>
          <div className="flex items-center w-full">
            <div className="flex items-center flex-grow input-container h-full">
              <select
                id="default-environment"
                name="defaultEnvironment"
                className="block textbox"
                onChange={handleDefaultEnvironmentChange}
                value={configuredEnvironment}
                style={{ width: '100%' }}
              >
                <option value="">No environment</option>
                {missingEnvironment && (
                  <option value={configuredEnvironment}>{configuredEnvironment} (not found)</option>
                )}
                {environments.map((environment) => (
                  <option key={environment.uid} value={environment.name}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="text-xs mb-4 text-muted">
          Selected the first time this collection is opened. It does not override an
          environment you pick later.
        </div>

        <div className="mt-6">
          <Button type="button" size="sm" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </StyledWrapper>
  );
};

export default PresetsSettings;
