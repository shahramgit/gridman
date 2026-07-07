import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import { IconFileText, IconFileCode } from '@tabler/icons';
import Modal from 'components/Modal';
import { exportWorkspaceCatalogAction } from 'providers/ReduxStore/slices/workspaces/actions';
import { formatIpcError } from 'utils/common/error';
import { multiLineMsg } from 'utils/common/index';

const FORMAT_OPTIONS = [
  {
    value: 'md',
    label: 'Markdown',
    description: 'GitHub-flavored markdown (.md), great for wikis and repos',
    icon: IconFileText
  },
  {
    value: 'html',
    label: 'HTML',
    description: 'Self-contained web page (.html) with collapsible folders',
    icon: IconFileCode
  }
];

const ExportApiCatalog = ({ workspaceUid, onClose }) => {
  const dispatch = useDispatch();
  const [format, setFormat] = useState('md');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleExport = async () => {
    if (isSubmitting) return;

    try {
      setIsSubmitting(true);
      const result = await dispatch(exportWorkspaceCatalogAction(workspaceUid, format));
      if (!result?.canceled) {
        toast.success('API catalog exported');
      }
      onClose();
    } catch (error) {
      toast.error(multiLineMsg('Failed to export API catalog', formatIpcError(error)));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      size="sm"
      title="Export API Catalog"
      confirmText={isSubmitting ? 'Exporting...' : 'Export'}
      handleConfirm={handleExport}
      handleCancel={onClose}
      confirmDisabled={isSubmitting}
    >
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
        Export a shareable, human-readable catalog of every collection, folder and request in this
        workspace. Environment values, auth credentials and request bodies are never included.
      </p>
      <div className="flex flex-col gap-2">
        {FORMAT_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = format === option.value;
          return (
            <label
              key={option.value}
              className={`
                flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors duration-150
                ${isSelected ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'}
              `}
            >
              <input
                type="radio"
                name="catalog-format"
                className="mt-1"
                value={option.value}
                checked={isSelected}
                onChange={() => setFormat(option.value)}
              />
              <Icon size={20} className="text-gray-500 mt-0.5" />
              <span className="flex flex-col">
                <span className="font-semibold">{option.label}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Modal>
  );
};

export default ExportApiCatalog;
