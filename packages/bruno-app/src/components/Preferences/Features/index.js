import React, { useCallback, useEffect, useRef } from 'react';
import { useFormik } from 'formik';
import { useDispatch, useSelector } from 'react-redux';
import debounce from 'lodash/debounce';
import get from 'lodash/get';
import toast from 'react-hot-toast';
import * as Yup from 'yup';

import { savePreferences } from 'providers/ReduxStore/slices/app';
import StyledWrapper from './StyledWrapper';

const FEATURES = [
  {
    id: 'apiSpec',
    label: 'API Spec',
    description: 'Show API Specs in the sidebar.'
  },
  {
    id: 'gitWorkspace',
    label: 'Git Workspace',
    description: 'Show the workspace-level Git clone action.'
  },
  {
    id: 'fileExplorer',
    label: 'File Explorer',
    description: 'Store the file explorer feature preference.'
  },
  {
    id: 'brunoJson',
    label: 'Show bruno.json',
    description: 'Store whether Gridman collection config files should be visible where supported.'
  }
];

const featuresSchema = Yup.object().shape(
  FEATURES.reduce((acc, feature) => {
    acc[feature.id] = Yup.boolean();
    return acc;
  }, {})
);

const Features = () => {
  const preferences = useSelector((state) => state.app.preferences);
  const dispatch = useDispatch();

  const handleSave = useCallback(
    (newFeaturePreferences) => {
      dispatch(
        savePreferences({
          ...preferences,
          features: {
            ...preferences.features,
            ...newFeaturePreferences
          }
        })
      ).catch(() => toast.error('Failed to update feature preferences'));
    },
    [dispatch, preferences]
  );

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const formik = useFormik({
    enableReinitialize: true,
    initialValues: {
      apiSpec: get(preferences, 'features.apiSpec', true),
      gitWorkspace: get(preferences, 'features.gitWorkspace', get(preferences, 'features.git', true)),
      fileExplorer: get(preferences, 'features.fileExplorer', true),
      brunoJson: get(preferences, 'features.brunoJson', false)
    },
    validationSchema: featuresSchema,
    onSubmit: async (values) => {
      try {
        const newPreferences = await featuresSchema.validate(values, { abortEarly: true });
        handleSave(newPreferences);
      } catch (error) {
        console.error('Feature preferences validation error:', error.message);
      }
    }
  });

  const debouncedSave = useCallback(
    debounce((values) => {
      featuresSchema
        .validate(values, { abortEarly: true })
        .then((validatedValues) => handleSaveRef.current(validatedValues))
        .catch(() => {});
    }, 500),
    []
  );

  useEffect(() => {
    if (formik.dirty && formik.isValid) {
      debouncedSave(formik.values);
    }
    return () => {
      debouncedSave.flush();
    };
  }, [formik.values, formik.dirty, formik.isValid, debouncedSave]);

  return (
    <StyledWrapper className="w-full">
      <form className="bruno-form" onSubmit={formik.handleSubmit}>
        <div className="section-header">Features</div>
        <p className="text-gray-500 dark:text-gray-400 mb-4 text-wrap">
          Turn on/off additional features.
        </p>

        <div className="space-y-4">
          {FEATURES.map((feature) => (
            <div key={feature.id}>
              <div className="flex items-center">
                <input
                  id={`features.${feature.id}`}
                  type="checkbox"
                  name={feature.id}
                  checked={formik.values[feature.id]}
                  onChange={formik.handleChange}
                  className="mousetrap mr-0"
                />
                <label className="block ml-2 select-none" htmlFor={`features.${feature.id}`}>
                  {feature.label}
                </label>
              </div>
              <div className="feature-description ml-6 text-xs text-gray-500 dark:text-gray-400">
                {feature.description}
              </div>
            </div>
          ))}
        </div>
      </form>
    </StyledWrapper>
  );
};

export default Features;
