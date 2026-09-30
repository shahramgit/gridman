import React from 'react';
import Modal from 'components/Modal';
import { isItemAFolder } from 'utils/tabs';
import { useDispatch, useStore } from 'react-redux';
import { deleteItem, closeTabs } from 'providers/ReduxStore/slices/collections/actions';
import { recursivelyGetAllItemUids } from 'utils/collections';
import StyledWrapper from './StyledWrapper';
import toast from 'react-hot-toast';

const normalizeTabPath = (pathname) => String(pathname || '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '');

// Tabs opened from the sidebar are keyed `indexed-request:<collection>:<path>`,
// not by the item's uid, so closing by uid alone left a deleted request's tab
// open, still showing the request — which reads as "delete did nothing". Match
// on the path the tab records too, and for a folder everything beneath it.
const tabUidsUnderPath = (tabs, collectionUid, pathname) => {
  const target = normalizeTabPath(pathname);
  if (!target) {
    return [];
  }
  return (tabs || [])
    .filter((tab) => tab.collectionUid === collectionUid && tab.itemPathname)
    .filter((tab) => {
      const tabPath = normalizeTabPath(tab.itemPathname);
      return tabPath === target || tabPath.startsWith(`${target}/`);
    })
    .map((tab) => tab.uid);
};

const DeleteCollectionItem = ({ onClose, item, collectionUid, onDelete }) => {
  const dispatch = useDispatch();
  const store = useStore();
  const isFolder = isItemAFolder(item);
  const onConfirm = () => {
    const deleteOperation = onDelete ? onDelete() : dispatch(deleteItem(item.uid, collectionUid));

    Promise.resolve(deleteOperation).then(() => {
      const byPath = tabUidsUnderPath(store.getState().tabs?.tabs, collectionUid, item.pathname);
      if (isFolder) {
        // close all tabs that belong to the folder
        // including the folder itself and its children
        const tabUids = [...recursivelyGetAllItemUids(item.items || []), item.uid, ...byPath];

        dispatch(
          closeTabs({
            tabUids: [...new Set(tabUids)]
          })
        );
      } else {
        dispatch(
          closeTabs({
            tabUids: [...new Set([item.uid, ...byPath])]
          })
        );
      }
    }).catch((error) => {
      console.error('Error deleting item', error);
      toast.error(error?.message || 'Error deleting item');
    });
    onClose();
  };

  return (
    <StyledWrapper>
      <Modal
        size="md"
        title={`Delete ${isFolder ? 'Folder' : 'Request'}`}
        confirmText="Delete"
        confirmButtonColor="danger"
        handleConfirm={onConfirm}
        handleCancel={onClose}
      >
        Are you sure you want to delete <span className="font-medium">{item.name}</span> ?
      </Modal>
    </StyledWrapper>
  );
};

export default DeleteCollectionItem;
