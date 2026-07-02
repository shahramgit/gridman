import React, { useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Modal from 'components/Modal';
import jsyaml from 'js-yaml';
import toast from 'react-hot-toast';
import { IconFileImport } from '@tabler/icons';
import { toastError } from 'utils/common/error';
import { isPostmanCollection, postmanToBruno } from 'utils/importers/postman-collection';
import { isOpenCollection, processOpenCollection } from 'utils/importers/opencollection';
import { isBrunoCollection, processBrunoCollection } from 'utils/importers/bruno-collection';
import { refreshCollectionIndex } from 'providers/ReduxStore/slices/collections/actions';
import { useTheme } from 'providers/Theme';

// Same parsing the ImportCollection FileTab uses, scoped to the formats an
// exported single file can be (JSON or YAML).
const convertFileToObject = async (file) => {
  const text = await file.text();

  try {
    if (file.type === 'application/json' || file.name.endsWith('.json')) {
      return JSON.parse(text);
    }

    const parsed = jsyaml.load(text);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error('Failed to parse the file – ensure it is valid JSON or YAML');
  }
};

// Imports an exported collection file (OpenCollection YAML / Postman JSON /
// Bruno JSON) into an existing folder (or the collection root) instead of
// creating a new collection.
const ImportIntoFolder = ({ onClose, collectionUid, targetDirectory, targetName }) => {
  const dispatch = useDispatch();
  const collection = useSelector((state) => state.collections.collections?.find((c) => c.uid === collectionUid));
  const isIndexedCollection = useSelector((state) => Boolean(state.collections.collectionIndexes?.[collectionUid]));
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const { theme } = useTheme();

  const parseFileToCollection = async (file) => {
    const data = await convertFileToObject(file);

    if (isPostmanCollection(data)) {
      return postmanToBruno(data);
    }
    if (isOpenCollection(data)) {
      return processOpenCollection(data);
    }
    if (isBrunoCollection(data)) {
      return processBrunoCollection(data);
    }

    throw new Error('Unsupported file format. Supported formats: OpenCollection (YAML), Postman (JSON) and Gridman/Bruno (JSON)');
  };

  const processFile = async (file) => {
    if (isImporting) return;

    setIsImporting(true);
    try {
      const convertedCollection = await parseFileToCollection(file);
      const items = convertedCollection?.items || [];
      if (!items.length) {
        throw new Error('No requests or folders found in the file');
      }

      await window.ipcRenderer.invoke('renderer:import-into-folder', {
        items,
        targetDirectory,
        collectionPathname: collection?.pathname
      });

      // Imports can add many files at once; indexed collections need a full
      // re-index. Classic collections pick the new files up via the watcher.
      if (isIndexedCollection) {
        await dispatch(refreshCollectionIndex({ collectionUid }));
      }

      toast.success(`Imported into ${targetName || 'folder'} successfully`);
      onClose();
    } catch (err) {
      toastError(err, 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }

    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFile(e.target.files[0]);
      e.target.value = '';
    }
  };

  return (
    <Modal size="md" title={`Import into ${targetName || 'Folder'}`} hideFooter handleCancel={onClose}>
      <div className="flex flex-col w-full">
        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          className={`
            border-2 border-dashed rounded-lg p-6 transition-colors duration-200
            ${dragActive
      ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20'
      : 'border-gray-200 dark:border-gray-700'
    }
          `}
        >
          <div className="flex flex-col items-center justify-center">
            <IconFileImport size={28} className="text-gray-400 dark:text-gray-500 mb-3" />
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileInputChange}
              accept=".json,.yaml,.yml,application/json,application/yaml,application/x-yaml"
            />
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
              {isImporting ? (
                'Importing...'
              ) : (
                <>
                  Drop a file to import or{' '}
                  <button
                    className="underline cursor-pointer"
                    onClick={() => fileInputRef.current.click()}
                    style={{ color: theme.textLink }}
                  >
                    choose a file
                  </button>
                </>
              )}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              Requests and folders are added into this location. Supports OpenCollection (YAML), Postman (JSON) and Gridman/Bruno (JSON) exports
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ImportIntoFolder;
