import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { exportWorkspaceAction, exportWorkspaceConvertedAction } from 'providers/ReduxStore/slices/workspaces/actions';

const FORMATS = [
  {
    id: 'bru',
    title: 'Gridman files (.bru)',
    description: 'The whole workspace as-is — collections stay in Bruno format, re-openable in Gridman.'
  },
  {
    id: 'json',
    title: 'Collection JSON',
    description: 'One Bruno-collection .json per collection, zipped. Importable into Gridman and Bruno.'
  },
  {
    id: 'postman',
    title: 'Postman Collection v2.1',
    description: 'One Postman-format .json per collection, zipped. Importable into Postman.'
  }
];

// Bulk workspace export with a format choice (user ask: the plain zip was
// always .bru; sharing with Postman users needs converted output).
const ExportWorkspaceModal = ({ workspaceUid, onClose }) => {
  const dispatch = useDispatch();
  const [format, setFormat] = useState('bru');
  const [busy, setBusy] = useState(false);

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = format === 'bru'
        ? await dispatch(exportWorkspaceAction(workspaceUid))
        : await dispatch(exportWorkspaceConvertedAction(workspaceUid, format));
      if (!result?.canceled) {
        if (result?.failed?.length) {
          toast.error(`Exported ${result.exported} collections; failed: ${result.failed.slice(0, 3).join(', ')}${result.failed.length > 3 ? '…' : ''}`);
        } else {
          toast.success('Workspace exported successfully');
        }
        onClose();
      }
    } catch (error) {
      toast.error(error?.message || 'Failed to export workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      size="md"
      title="Export Workspace"
      confirmText={busy ? 'Exporting…' : 'Export'}
      handleConfirm={handleExport}
      handleCancel={onClose}
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0 }} className="text-sm text-muted">Choose the output format for the exported zip:</p>
        {FORMATS.map((option) => (
          <label
            key={option.id}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px', borderRadius: 6 }}
            className={format === option.id ? 'export-format-selected' : ''}
            data-testid={`export-format-${option.id}`}
          >
            <input
              type="radio"
              name="export-workspace-format"
              checked={format === option.id}
              onChange={() => setFormat(option.id)}
              style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ display: 'block', fontWeight: 600 }}>{option.title}</span>
              <span className="text-sm text-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
};

export default ExportWorkspaceModal;
