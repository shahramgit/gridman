import jsyaml from 'js-yaml';
import { toastError } from 'utils/common/error';
import { detectCollectionFormat } from 'utils/importers/detect';

/**
 * Shared "import collection files" pipeline used by the Import Collection
 * dialog's File tab and by the sidebar's drop target. Parses the dropped or
 * selected file(s), detects the collection format and routes the result into
 * the caller's handleSubmit (the same pipeline the import dialog uses).
 */

// True when a native drag event carries OS files (as opposed to internal
// react-dnd item drags, which never expose the 'Files' type).
export const isFilesDragEvent = (event) => Array.from(event?.dataTransfer?.types || []).includes('Files');

export const convertFileToObject = async (file) => {
  const text = await file.text();

  // Handle WSDL files - return as plain text
  if (file.name.endsWith('.wsdl') || file.type === 'text/xml' || file.type === 'application/xml') {
    return text;
  }

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

/**
 * Returns a processFiles(fileList) function bound to the given callbacks.
 * - handleSubmit: receives the same payloads the Import Collection dialog
 *   produces ({ rawData, type, ... } / { filesData, type: 'multiple' }).
 * - setIsLoading / setErrorMessage are optional UI hooks.
 */
export const createCollectionFileProcessor = ({
  handleSubmit,
  setIsLoading = () => {},
  setErrorMessage = () => {}
}) => {
  const processZipFile = async (zipFile) => {
    setIsLoading(true);
    try {
      const filePath = window.ipcRenderer.getFilePath(zipFile);
      const isBrunoZip = await window.ipcRenderer.invoke('renderer:is-bruno-collection-zip', filePath);

      if (isBrunoZip) {
        const collectionName = zipFile.name.replace(/\.zip$/i, '');
        await handleSubmit({ rawData: { zipFilePath: filePath, collectionName }, type: 'bruno-zip' });
        return;
      }

      toastError(new Error('The ZIP file is not a valid Gridman or Bruno collection'));
    } catch (err) {
      toastError(err, 'Import ZIP file failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleMultipleFiles = async (fileArray) => {
    setIsLoading(true);
    try {
      const filesData = [];

      // Parse all files
      for (const file of fileArray) {
        try {
          const data = await convertFileToObject(file);

          // Determine type for each file
          const type = detectCollectionFormat(data);

          if (type) {
            filesData.push({ file, data, type });
          }
        } catch (err) {
          console.warn(`Failed to process file ${file.name}:`, err);
        }
      }

      if (filesData.length > 0) {
        // Pass raw filesData to be processed in BulkImportCollectionLocation
        handleSubmit({ filesData, type: 'multiple' });
      } else {
        throw new Error('No valid collections found in the selected files');
      }
    } catch (err) {
      toastError(err, 'Import multiple files failed');
    } finally {
      setIsLoading(false);
    }
  };

  const processFile = async (file) => {
    setIsLoading(true);
    try {
      const data = await convertFileToObject(file);

      if (!data) {
        throw new Error('Failed to parse file content');
      }

      const type = detectCollectionFormat(data);
      if (!type) {
        throw new Error('Unsupported collection format');
      }

      if (type === 'openapi') {
        const filePath = window.ipcRenderer.getFilePath(file);
        const rawContent = await file.text();
        await handleSubmit({ rawData: data, type, filePath, rawContent });
      } else {
        await handleSubmit({ rawData: data, type });
      }
    } catch (err) {
      toastError(err, 'Import collection failed');
    } finally {
      setIsLoading(false);
    }
  };

  return async (files) => {
    setErrorMessage('');

    const fileArray = Array.from(files);
    const zipFiles = fileArray.filter((file) => file.name.endsWith('.zip'));

    // If both ZIP and non-ZIP files are selected, show error
    if (zipFiles.length && (fileArray.length - zipFiles.length > 0)) {
      setErrorMessage('Cannot mix ZIP files with other file types. Please select either a single ZIP file OR collection files (JSON/YAML)');
      return;
    }

    if (zipFiles.length > 1) {
      setErrorMessage('Multiple ZIP files selected. Please select only one ZIP file at a time for import.');
      return;
    }

    if (zipFiles.length) {
      await processZipFile(zipFiles[0]);
      return;
    }

    if (fileArray.length > 1) {
      // Process multiple non-ZIP files normally
      await handleMultipleFiles(fileArray);
    } else if (fileArray.length === 1) {
      await processFile(fileArray[0]);
    }
  };
};
