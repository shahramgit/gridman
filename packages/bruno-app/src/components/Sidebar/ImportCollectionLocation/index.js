import React, { useRef, useState, forwardRef } from 'react';
import { useSelector } from 'react-redux';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import path from 'utils/common/path';
import { IconCaretDown } from '@tabler/icons';
import { postmanToBruno } from 'utils/importers/postman-collection';
import { convertInsomniaToBruno } from 'utils/importers/insomnia-collection';
import { convertOpenapiToBruno } from 'utils/importers/openapi-collection';
import { processBrunoCollection } from 'utils/importers/bruno-collection';
import { processOpenCollection } from 'utils/importers/opencollection';
import { wsdlToBruno } from '@usebruno/converters';
import { toastError } from 'utils/common/error';
import { useBetaFeature, BETA_FEATURES } from 'utils/beta-features';
import Modal from 'components/Modal';
import Help from 'components/Help';
import Dropdown from 'components/Dropdown';
import StyledWrapper from './StyledWrapper';
import { DEFAULT_COLLECTION_FORMAT } from 'utils/common/constants';

// Extract collection name from raw data
const getCollectionName = (format, rawData) => {
  if (!rawData) return 'Collection';

  switch (format) {
    case 'openapi':
      return rawData.info?.title || 'OpenAPI Collection';
    case 'postman':
      return rawData.info?.name || rawData.collection?.info?.name || 'Postman Collection';
    case 'insomnia':
      // For Insomnia v4 format, name is in the workspace resource
      if (rawData.resources && Array.isArray(rawData.resources)) {
        const workspace = rawData.resources.find((r) => r._type === 'workspace');
        if (workspace?.name) {
          return workspace.name;
        }
      }
      // Fallback to root name property
      return rawData.name || 'Insomnia Collection';
    case 'bruno':
      return rawData.name || 'Gridman Collection';
    case 'opencollection':
      return rawData.info?.name || 'OpenCollection';
    case 'wsdl':
      return 'WSDL Collection';
    case 'bruno-zip':
      return rawData.collectionName || 'Gridman Collection';
    default:
      return 'Collection';
  }
};

// Convert raw data to Bruno collection format
const convertCollection = async (format, rawData, groupingType, collectionFormat) => {
  try {
    let collection;

    switch (format) {
      case 'openapi':
        collection = convertOpenapiToBruno(rawData, { groupBy: groupingType, collectionFormat });
        break;
      case 'wsdl':
        collection = await wsdlToBruno(rawData);
        break;
      case 'postman':
        collection = await postmanToBruno(rawData);
        break;
      case 'insomnia':
        collection = convertInsomniaToBruno(rawData);
        break;
      case 'bruno':
        collection = await processBrunoCollection(rawData);
        break;
      case 'opencollection':
        collection = await processOpenCollection(rawData);
        break;
      case 'bruno-zip':
        // ZIP doesn't need conversion
        collection = rawData;
        break;
      default:
        throw new Error('Unknown collection format');
    }

    return collection;
  } catch (err) {
    console.error('Conversion error:', err);
    toastError(err, 'Failed to convert collection');
    throw err;
  }
};

const groupingOptions = [
  { value: 'tags', label: 'Tags', description: 'Group requests by OpenAPI/Swagger tags', testId: 'grouping-option-tags' },
  { value: 'path', label: 'Paths', description: 'Group requests by URL path structure', testId: 'grouping-option-path' }
];

const ImportCollectionLocation = ({ onClose, handleSubmit, rawData, format, sourceUrl, filePath, rawContent }) => {
  const [groupingType, setGroupingType] = useState('tags');
  const [collectionFormat, setCollectionFormat] = useState(DEFAULT_COLLECTION_FORMAT);
  const isOpenAPISyncEnabled = useBetaFeature(BETA_FEATURES.OPENAPI_SYNC);
  const [enableCheckForSpecUpdates, setEnableCheckForSpecUpdates] = useState(isOpenAPISyncEnabled);
  const dropdownTippyRef = useRef();
  const isOpenApi = format === 'openapi';
  const isZipImport = format === 'bruno-zip';
  const isOpenApiFromUrl = isOpenApi && !!sourceUrl && !filePath;
  const isOpenApiFromFile = isOpenApi && !!filePath && !sourceUrl;
  const isSwagger2 = isOpenApi && rawData?.swagger && String(rawData.swagger).startsWith('2');
  const showCheckForSpecUpdatesOption = isOpenAPISyncEnabled && (isOpenApiFromUrl || isOpenApiFromFile);

  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);
  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);

  const defaultLocation = activeWorkspace?.pathname ? path.join(activeWorkspace.pathname, 'collections') : '';

  const collectionName = getCollectionName(format, rawData);

  const formik = useFormik({
    enableReinitialize: true,
    initialValues: {
      collectionLocation: defaultLocation
    },
    validationSchema: Yup.object({
      collectionLocation: Yup.string()
        .min(1, 'must be at least 1 character')
        .max(500, 'must be 500 characters or less')
        .required('Location is required')
    }),
    onSubmit: async (values) => {
      const convertedCollection = await convertCollection(format, rawData, groupingType, collectionFormat);
      const options = { format: collectionFormat };

      if (showCheckForSpecUpdatesOption && enableCheckForSpecUpdates) {
        const syncSourceUrl = sourceUrl || filePath; // URL or absolute path (backend converts to relative)
        const baseBrunoConfig = {
          version: convertedCollection.version || '1',
          name: convertedCollection.name || 'Untitled Collection',
          type: 'collection',
          ignore: ['node_modules', '.git']
        };

        convertedCollection.brunoConfig = {
          ...baseBrunoConfig,
          ...convertedCollection.brunoConfig,
          openapi: [
            {
              sourceUrl: syncSourceUrl,
              groupBy: groupingType,
              autoCheck: true,
              autoCheckInterval: 5
            }
          ]
        };

        options.rawOpenAPISpec = rawContent || rawData;
      }

      handleSubmit(convertedCollection, defaultLocation, options);
    }
  });

  const onDropdownCreate = (ref) => {
    dropdownTippyRef.current = ref;
  };

  const GroupingDropdownIcon = forwardRef((props, ref) => {
    const selectedOption = groupingOptions.find((option) => option.value === groupingType);
    return (
      <div ref={ref} className="flex items-center justify-between w-full current-group" data-testid="grouping-dropdown">
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{selectedOption.label}</div>
        </div>
        <IconCaretDown size={16} className="text-gray-400 ml-[0.25rem]" fill="currentColor" />
      </div>
    );
  });
  const onSubmit = async () => {
    if (isZipImport) {
      const errors = await formik.validateForm();
      if (Object.keys(errors).length > 0) {
        formik.setTouched({ collectionLocation: true });
        return;
      }
      handleSubmit(rawData, defaultLocation, { format: collectionFormat, isZipImport: true });
    } else {
      formik.handleSubmit();
    }
  };

  return (
    <StyledWrapper>
      <Modal
        size="md"
        title="Import Collection"
        confirmText="Import"
        handleConfirm={onSubmit}
        handleCancel={onClose}
        dataTestId="import-collection-location-modal"
      >
        <form className="bruno-form" onSubmit={(e) => e.preventDefault()}>
          <div>
            <label htmlFor="collectionName" className="block font-medium">
              Name
            </label>
            <div className="mt-2">{collectionName}</div>

            <>
              <label htmlFor="collectionLocation" className="font-medium mt-4 flex items-center">
                Location
                <Help>
                  <p>Gridman stores imported collections inside the active workspace.</p>
                  <p className="mt-2">The destination is fixed to this workspace's collections folder.</p>
                </Help>
              </label>
              <div id="collection-location" className="block textbox mt-2 w-full bg-gray-50 dark:bg-gray-800 text-muted">
                {defaultLocation || 'No active workspace'}
              </div>
            </>
            {formik.touched.collectionLocation && formik.errors.collectionLocation ? (
              <div className="text-red-500">{formik.errors.collectionLocation}</div>
            ) : null}

            {!isZipImport && (
              <div className="mt-4">
                <label htmlFor="format" className="flex items-center font-medium">
                  File Format
                  <Help width="300">
                    <p>Choose the file format for storing requests in this collection.</p>
                    <p className="mt-2">
                      <strong>OpenCollection (YAML):</strong> Industry-standard YAML format (.yml files)
                    </p>
                    <p className="mt-1">
                      <strong>BRU:</strong> Gridman's native file format (.bru files)
                    </p>
                  </Help>
                </label>
                <select
                  id="format"
                  name="format"
                  className="block textbox mt-2 w-full"
                  value={collectionFormat}
                  onChange={(e) => setCollectionFormat(e.target.value)}
                >
                  <option value="yml">OpenCollection (YAML)</option>
                  <option value="bru">BRU Format (.bru)</option>
                </select>
              </div>
            )}
          </div>

          {isOpenApi && (
            <div className="mt-4 flex gap-4 items-center justify-between">
              <div>
                <label htmlFor="groupingType" className="block font-medium">
                  Folder arrangement
                </label>
                <p className="text-muted text-xs mt-1 mb-2">
                  Select whether to create folders according to the spec's paths or tags.
                </p>
              </div>
              <div className="relative">
                <Dropdown onCreate={onDropdownCreate} icon={<GroupingDropdownIcon />} placement="bottom-start">
                  {groupingOptions.map((option) => (
                    <div
                      key={option.value}
                      className="dropdown-item"
                      data-testid={option.testId}
                      onClick={() => {
                        dropdownTippyRef?.current?.hide();
                        setGroupingType(option.value);
                      }}
                    >
                      {option.label}
                    </div>
                  ))}
                </Dropdown>
              </div>
            </div>
          )}

          {showCheckForSpecUpdatesOption && (
            <div className={`mt-4 ${isSwagger2 ? 'opacity-50 pointer-events-none' : ''}`}>
              <label className={`flex items-center gap-2 ${isSwagger2 ? '' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={isSwagger2 ? false : enableCheckForSpecUpdates}
                  onChange={(e) => setEnableCheckForSpecUpdates(e.target.checked)}
                  disabled={isSwagger2}
                  className={`checkbox ${isSwagger2 ? '' : 'cursor-pointer'}`}
                />
                <span className="font-medium">Check for Spec Updates</span>
              </label>
              <p className="text-muted text-xs mt-1">
                {isSwagger2
                  ? 'OpenAPI Sync is not supported for Swagger 2.0 specs.'
                  : 'Stay notified of spec changes and sync your collection with the spec.'}
              </p>
            </div>
          )}
        </form>
      </Modal>
    </StyledWrapper>
  );
};

export default ImportCollectionLocation;
