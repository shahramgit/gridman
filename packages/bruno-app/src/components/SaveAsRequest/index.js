import React, { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import classnames from 'classnames';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import { useDispatch, useSelector } from 'react-redux';
import { IconFolder, IconFolders } from '@tabler/icons';
import Modal from 'components/Modal';
import Portal from 'components/Portal';
import Button from 'ui/Button';
import { saveRequestAs } from 'providers/ReduxStore/slices/collections/actions';
import { sanitizeName, validateName, validateNameError } from 'utils/common/regex';
import { buildFolderTree, flattenFolderTree } from 'utils/collections/folderTree';
import path from 'utils/common/path';
import StyledWrapper from './StyledWrapper';

// "Save As…" for the request editor: saves the CURRENT (draft) state of the
// request as a NEW request, with a name and a location picker spanning the
// open collections and their folders. The original request is untouched.
const SaveAsRequest = ({ item, collectionUid, onClose }) => {
  const dispatch = useDispatch();
  const inputRef = useRef();
  const collections = useSelector((state) => state.collections.collections) || [];
  const collectionIndexes = useSelector((state) => state.collections.collectionIndexes);

  const [targetCollectionUid, setTargetCollectionUid] = useState(collectionUid);
  const targetCollection = collections.find((c) => c.uid === targetCollectionUid);

  // Default location: the folder the request currently lives in.
  const defaultDirname = useMemo(() => {
    const sourceCollection = collections.find((c) => c.uid === collectionUid);
    if (item?.pathname && sourceCollection) {
      return path.dirname(item.pathname);
    }
    return sourceCollection?.pathname;
  }, [collections, collectionUid, item?.pathname]);
  const [targetDirname, setTargetDirname] = useState(defaultDirname);

  const folderRows = useMemo(() => {
    if (!targetCollection) {
      return [];
    }
    const tree = buildFolderTree({
      index: collectionIndexes?.[targetCollectionUid],
      collection: targetCollection
    });
    return flattenFolderTree(tree);
  }, [collectionIndexes, targetCollection, targetCollectionUid]);

  const selectCollection = (uid) => {
    setTargetCollectionUid(uid);
    const nextCollection = collections.find((c) => c.uid === uid);
    setTargetDirname(nextCollection?.pathname);
  };

  // Names already present in the chosen target folder, so we can flag a collision
  // inline (clear message, submit disabled) instead of letting the write reject.
  const normForCompare = (p) => String(p || '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const existingNames = useMemo(() => {
    const index = collectionIndexes?.[targetCollectionUid];
    const set = new Set();
    if (!index?.nodesByUid || !targetDirname) {
      return set;
    }
    const parentIsRoot = normForCompare(targetDirname) === normForCompare(targetCollection?.pathname);
    const parentNode = parentIsRoot
      ? null
      : Object.values(index.nodesByUid).find((n) => n.type === 'folder' && normForCompare(n.pathname) === normForCompare(targetDirname));
    const childUids = index.childrenByParentUid?.[parentNode?.uid || 'root'] || [];
    for (const uid of childUids) {
      const node = index.nodesByUid[uid];
      if (node && node.type !== 'folder') {
        if (node.filename) set.add(normForCompare(node.filename));
        if (node.name) set.add(normForCompare(node.name));
      }
    }
    return set;
  }, [collectionIndexes, targetCollectionUid, targetDirname, targetCollection?.pathname]);
  const existingNamesRef = useRef(existingNames);
  existingNamesRef.current = existingNames;
  const targetFormatRef = useRef(targetCollection?.format);
  targetFormatRef.current = targetCollection?.format || 'bru';

  const formik = useFormik({
    enableReinitialize: true,
    initialValues: {
      name: item?.name ? `${item.name} copy` : ''
    },
    validationSchema: Yup.object({
      name: Yup.string()
        .min(1, 'must be at least 1 character')
        .max(255, 'must be 255 characters or less')
        .required('name is required')
        .test('is-valid-filename', function (value) {
          const filename = sanitizeName(value || '');
          if (!filename) {
            return this.createError({ message: 'name is required' });
          }
          if (['collection', 'folder'].includes(filename)) {
            return this.createError({ message: 'The file names "collection" and "folder" are reserved in bruno' });
          }
          return validateName(filename) ? true : this.createError({ message: validateNameError(filename) });
        })
        .test('is-unique-in-folder', function (value) {
          const filename = sanitizeName(value || '');
          if (!filename) {
            return true; // other tests report the empty-name error
          }
          const withExt = `${filename}.${targetFormatRef.current}`;
          const taken = existingNamesRef.current;
          if (taken.has(normForCompare(withExt)) || taken.has(normForCompare(value || ''))) {
            return this.createError({ message: 'A request with this name already exists in the target folder' });
          }
          return true;
        })
    }),
    onSubmit: (values) => {
      dispatch(saveRequestAs({
        item,
        sourceCollectionUid: collectionUid,
        targetCollectionUid,
        targetDirname,
        name: values.name,
        filename: sanitizeName(values.name)
      }))
        .then(() => {
          toast.success('Request saved as a new request!');
          onClose();
        })
        .catch((err) => {
          toast.error(err?.message || 'An error occurred while saving the request');
        });
    }
  });

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  // Re-run validation when the target folder/collection changes so the
  // name-collision check reflects the newly chosen location.
  useEffect(() => {
    formik.validateForm();
  }, [targetDirname, targetCollectionUid]);

  if (!item) {
    return null;
  }

  return (
    <Portal>
      <StyledWrapper>
        <Modal size="md" title="Save As" handleCancel={onClose} hideFooter>
          <form className="bruno-form" onSubmit={formik.handleSubmit}>
            <div>
              <label htmlFor="request-name" className="block font-medium">
                Request Name
              </label>
              <input
                id="request-name"
                type="text"
                name="name"
                data-testid="save-as-request-name"
                placeholder="Enter request name"
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
            </div>

            <div className="mt-4">
              <label htmlFor="save-as-collection" className="block location-label font-medium">
                Save to
              </label>
              <select
                id="save-as-collection"
                data-testid="save-as-collection-select"
                className="collection-select mt-2"
                value={targetCollectionUid || ''}
                onChange={(e) => selectCollection(e.target.value)}
              >
                {collections.map((c) => (
                  <option key={c.uid} value={c.uid}>
                    {c.name}
                  </option>
                ))}
              </select>

              <div className="folder-tree" data-testid="save-as-folder-tree">
                {targetCollection ? (
                  <div
                    className={classnames('folder-row', {
                      selected: targetDirname === targetCollection.pathname
                    })}
                    data-testid="save-as-location-root"
                    onClick={() => setTargetDirname(targetCollection.pathname)}
                  >
                    <IconFolders size={16} strokeWidth={1.5} className="folder-row-icon" />
                    <span>{targetCollection.name}</span>
                  </div>
                ) : null}
                {folderRows.map((row) => (
                  <div
                    key={row.pathname || row.uid}
                    className={classnames('folder-row', { selected: targetDirname === row.pathname })}
                    style={{ paddingLeft: 8 + (row.depth + 1) * 16 }}
                    title={row.pathname}
                    onClick={() => setTargetDirname(row.pathname)}
                  >
                    <IconFolder size={16} strokeWidth={1.5} className="folder-row-icon" />
                    <span>{row.name}</span>
                  </div>
                ))}
                {targetCollection && !folderRows.length ? (
                  <div className="folder-tree-empty">No folders in this collection</div>
                ) : null}
              </div>
            </div>

            <div className="flex justify-end items-center mt-6 bruno-modal-footer">
              <Button type="button" color="secondary" variant="ghost" onClick={onClose} className="mr-2">
                Cancel
              </Button>
              <Button type="submit" data-testid="save-as-submit" disabled={!targetCollection || !targetDirname}>
                Save
              </Button>
            </div>
          </form>
        </Modal>
      </StyledWrapper>
    </Portal>
  );
};

export default SaveAsRequest;
