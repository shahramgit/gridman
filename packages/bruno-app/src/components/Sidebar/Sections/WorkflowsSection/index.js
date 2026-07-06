import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { IconDots, IconFileExport, IconFileImport, IconPlus, IconRoute, IconTrash } from '@tabler/icons';

import {
  createWorkflow,
  deleteWorkflow,
  exportWorkflow,
  importWorkflow,
  loadWorkflows,
  openWorkflow
} from 'providers/ReduxStore/slices/workflows';
import Modal from 'components/Modal';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import SidebarSection from 'components/Sidebar/SidebarSection';
import StyledWrapper from './StyledWrapper';

const WorkflowsSection = () => {
  const dispatch = useDispatch();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowPendingDelete, setWorkflowPendingDelete] = useState(null);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const workflows = useSelector((state) => state.workflows.listsByWorkspace[activeWorkspaceUid]) || [];

  useEffect(() => {
    if (activeWorkspaceUid) {
      dispatch(loadWorkflows()).catch(() => {});
    }
  }, [activeWorkspaceUid, dispatch]);

  const handleCreate = () => {
    const name = workflowName.trim();
    if (!name) {
      return;
    }

    dispatch(createWorkflow(name))
      .then(() => {
        setCreateModalOpen(false);
        setWorkflowName('');
      })
      .catch((error) => toast.error(error?.message || 'Unable to create workflow'));
  };

  const handleDelete = () => {
    if (!workflowPendingDelete) {
      return;
    }
    dispatch(deleteWorkflow(workflowPendingDelete.pathname))
      .then(() => setWorkflowPendingDelete(null))
      .catch((error) => toast.error(error?.message || 'Unable to delete workflow'));
  };

  const handleExport = (workflow) => {
    dispatch(exportWorkflow(workflow.pathname))
      .then((result) => {
        if (!result?.cancelled) {
          toast.success(`Exported "${workflow.name}"`);
        }
      })
      .catch((error) => toast.error(error?.message || 'Unable to export workflow'));
  };

  const handleImport = () => {
    dispatch(importWorkflow())
      .then((result) => {
        if (!result?.cancelled) {
          toast.success(`Imported "${result?.name || 'workflow'}"`);
        }
      })
      .catch((error) => toast.error(error?.message || 'Unable to import workflow'));
  };

  const sectionActions = (
    <>
      <ActionIcon
        label="Import workflow"
        data-testid="workflows-import"
        onClick={handleImport}
      >
        <IconFileImport size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
      <ActionIcon
        label="New workflow"
        data-testid="workflows-add"
        onClick={() => setCreateModalOpen(true)}
      >
        <IconPlus size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
    </>
  );

  return (
    <>
      {createModalOpen && (
        <Modal
          size="sm"
          title="New Workflow"
          confirmText="Create"
          handleConfirm={handleCreate}
          handleCancel={() => setCreateModalOpen(false)}
        >
          <label htmlFor="workflow-name" className="block font-semibold">
            Name
          </label>
          <input
            id="workflow-name"
            type="text"
            className="block textbox mt-2 w-full"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
          />
        </Modal>
      )}
      {workflowPendingDelete && (
        <Modal
          size="sm"
          title="Delete Workflow"
          confirmText="Delete"
          handleConfirm={handleDelete}
          handleCancel={() => setWorkflowPendingDelete(null)}
        >
          Delete workflow <strong>{workflowPendingDelete.name}</strong>? The file will be removed from the workspace.
        </Modal>
      )}
      <SidebarSection
        id="workflows"
        title="Workflows"
        icon={IconRoute}
        actions={sectionActions}
        className="workflows-section"
      >
        <StyledWrapper>
          {workflows.length === 0 ? (
            <div className="empty-message">No workflows yet.</div>
          ) : (
            workflows.map((workflow) => (
              <div
                key={workflow.pathname}
                className="workflow-row"
                title={workflow.pathname}
                onClick={() => {
                  dispatch(openWorkflow(workflow.pathname))
                    .catch((error) => toast.error(error?.message || 'Unable to open workflow'));
                }}
              >
                <IconRoute size={15} strokeWidth={1.6} className="row-icon" />
                <span className="workflow-name">{workflow.name}</span>
                {/* the dropdown popper mounts inside this span (appendTo: parent),
                    so stopping propagation here keeps menu clicks from opening the row */}
                <span className="row-menu" onClick={(event) => event.stopPropagation()}>
                  <MenuDropdown
                    data-testid="workflow-row-menu"
                    placement="bottom-start"
                    items={[
                      {
                        id: 'export-workflow',
                        label: 'Export',
                        leftSection: IconFileExport,
                        onClick: () => handleExport(workflow)
                      }
                    ]}
                  >
                    <ActionIcon label="Workflow actions" className="menu-icon">
                      <IconDots size={14} stroke={1.5} aria-hidden="true" />
                    </ActionIcon>
                  </MenuDropdown>
                </span>
                <ActionIcon
                  label="Delete workflow"
                  className="delete-icon"
                  onClick={(event) => {
                    event.stopPropagation();
                    setWorkflowPendingDelete(workflow);
                  }}
                >
                  <IconTrash size={14} stroke={1.5} aria-hidden="true" />
                </ActionIcon>
              </div>
            ))
          )}
        </StyledWrapper>
      </SidebarSection>
    </>
  );
};

export default WorkflowsSection;
