import React, { useState } from 'react';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { IconFileExport } from '@tabler/icons';
import toast from 'react-hot-toast';
import exportPostmanCollection from 'utils/exporters/postman-collection';
import exportOpenCollection from 'utils/exporters/opencollection';
import { transformCollectionToSaveToExportAsFile } from 'utils/collections/index';
import StyledWrapper from './StyledWrapper';

const EXPORT_FORMATS = {
  YAML: 'yaml',
  POSTMAN: 'postman'
};

// Exports a folder subtree as a single file. The folder is read from disk in
// the main process (renderer state only lazily hydrates request bodies) and
// returned as a collection-shaped object the existing exporters accept.
const ExportFolder = ({ onClose, folderName, folderPathname, collectionPathname }) => {
  const [selectedFormat, setSelectedFormat] = useState(EXPORT_FORMATS.YAML);
  const [isExporting, setIsExporting] = useState(false);

  const readFolderFromDisk = async () => {
    const { ipcRenderer } = window;
    const folderCollection = await ipcRenderer.invoke('renderer:read-folder-for-export', {
      folderPathname,
      collectionPathname
    });
    if (!folderCollection) {
      throw new Error('Failed to read folder from disk');
    }
    return folderCollection;
  };

  const handleProceed = async () => {
    if (isExporting) return;

    setIsExporting(true);
    try {
      const folderCollection = await readFolderFromDisk();
      if (selectedFormat === EXPORT_FORMATS.POSTMAN) {
        exportPostmanCollection(folderCollection);
      } else {
        exportOpenCollection(transformCollectionToSaveToExportAsFile(folderCollection));
      }
      toast.success('Folder exported successfully');
      onClose();
    } catch (error) {
      console.error('Folder export error:', error);
      toast.error(error?.message || 'Failed to export folder');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Modal size="md" title="Export Folder" handleCancel={onClose} hideFooter>
      <StyledWrapper className="flex flex-col">
        <p className="text-sm mb-4">
          Export <span className="font-medium">{folderName}</span> and everything inside it as a single file.
        </p>

        <div className="format-grid">
          <div
            className={`format-card ${selectedFormat === EXPORT_FORMATS.YAML ? 'selected' : ''} ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
            onClick={() => !isExporting && setSelectedFormat(EXPORT_FORMATS.YAML)}
          >
            <div className="card-header">
              <IconFileExport size={18} strokeWidth={1.5} />
              <span className="card-title">Gridman (YAML)</span>
            </div>
            <p className="card-description">OpenCollection format bundled into one .yml file</p>
          </div>

          <div
            className={`format-card ${selectedFormat === EXPORT_FORMATS.POSTMAN ? 'selected' : ''} ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
            onClick={() => !isExporting && setSelectedFormat(EXPORT_FORMATS.POSTMAN)}
          >
            <div className="card-header">
              <IconFileExport size={18} strokeWidth={1.5} />
              <span className="card-title">Postman (JSON)</span>
            </div>
            <p className="card-description">Postman collection format as one .json file</p>
          </div>
        </div>

        <div className="modal-footer">
          <Button onClick={handleProceed} disabled={isExporting} loading={isExporting}>
            {isExporting ? 'Exporting...' : 'Export'}
          </Button>
        </div>
      </StyledWrapper>
    </Modal>
  );
};

export default ExportFolder;
