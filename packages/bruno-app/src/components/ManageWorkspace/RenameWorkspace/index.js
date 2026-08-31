import React, { useEffect, useRef } from 'react';
import Portal from 'components/Portal/index';
import Modal from 'components/Modal/index';
import toast from 'react-hot-toast';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import { useDispatch, useSelector } from 'react-redux';
import { renameWorkspaceAction } from 'providers/ReduxStore/slices/workspaces/actions';

const RenameWorkspace = ({ onClose, workspace }) => {
  const dispatch = useDispatch();
  const { workspaces } = useSelector((state) => state.workspaces);
  const inputRef = useRef();

  const formik = useFormik({
    enableReinitialize: true,
    initialValues: {
      name: workspace.name
    },
    validationSchema: Yup.object({
      name: Yup.string()
        .min(1, 'must be at least 1 character')
        .max(255, 'must be 255 characters or less')
        .required('name is required')
        .test('unique-name', 'A workspace with this name already exists', function (value) {
          if (!value) return true;
          return !workspaces.some((w) =>
            w.uid !== workspace.uid && w.name && w.name.toLowerCase() === value.toLowerCase()
          );
        })
    }),
    onSubmit: (values) => {
      if (values.name === workspace.name) {
        onClose();
        return;
      }
      dispatch(renameWorkspaceAction(workspace.uid, values.name))
        .then(() => {
          onClose();
        })
        .catch((error) => {
          toast.error(error?.message || 'An error occurred while renaming the workspace');
        });
    }
  });

  useEffect(() => {
    if (inputRef && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [inputRef]);

  const onSubmit = () => {
    formik.handleSubmit();
  };

  return (
    <Portal>
      <Modal
        size="md"
        title="Rename Workspace"
        confirmText="Rename"
        handleConfirm={onSubmit}
        handleCancel={onClose}
      >
        <form className="bruno-form" onSubmit={(e) => e.preventDefault()}>
          <div>
            <label htmlFor="workspace-name" className="block font-semibold">
              Workspace Name
            </label>
            <input
              id="workspace-name"
              type="text"
              name="name"
              ref={inputRef}
              className="block textbox mt-2 w-full"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              onChange={formik.handleChange}
              value={formik.values.name || ''}
            />
            {formik.touched.name && formik.errors.name ? (
              <div className="text-red-500">{formik.errors.name}</div>
            ) : null}

            {/*
              The folder is NOT renamed, and saying so is the difference between
              "the rename did nothing" and "the rename did what it said". The
              name lives in workspace.yml, which is git-tracked, so it is the
              workspace's name for everyone who pulls; the directory stays local
              to this machine.
            */}
            {workspace?.pathname ? (
              <div className="text-xs text-muted mt-3" data-testid="rename-workspace-folder-note">
                <div>The folder on disk is not renamed:</div>
                <div className="mt-1 break-all font-mono">{workspace.pathname}</div>
              </div>
            ) : null}
          </div>
        </form>
      </Modal>
    </Portal>
  );
};

export default RenameWorkspace;
