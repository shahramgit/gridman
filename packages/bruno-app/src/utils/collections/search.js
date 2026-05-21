import { flattenItems, isItemARequest, isItemAFolder } from './index';
import find from 'lodash/find';

const includesSearchText = (value, searchText = '') => {
  const normalizedSearchText = searchText.toLowerCase().trim();
  if (!normalizedSearchText) {
    return true;
  }

  return String(value || '').toLowerCase().includes(normalizedSearchText);
};

export const doesRequestMatchSearchText = (request, searchText = '') => {
  return includesSearchText(request?.name, searchText) || includesSearchText(request?.request?.url, searchText);
};

export const doesFolderHaveItemsMatchSearchText = (item, searchText = '') => {
  if (includesSearchText(item?.name, searchText)) {
    return true;
  }

  const flattenedItems = flattenItems(item.items);

  return find(flattenedItems, (child) => {
    if (child.isTransient) {
      return false;
    }

    if (isItemARequest(child)) {
      return doesRequestMatchSearchText(child, searchText);
    }

    if (isItemAFolder(child)) {
      return includesSearchText(child.name, searchText);
    }

    return false;
  });
};

export const doesCollectionHaveItemsMatchingSearchText = (collection, searchText = '') => {
  if (includesSearchText(collection?.name, searchText)) {
    return true;
  }

  const flattenedItems = flattenItems(collection.items);

  return find(flattenedItems, (item) => {
    if (item.isTransient) {
      return false;
    }

    if (isItemARequest(item)) {
      return doesRequestMatchSearchText(item, searchText);
    }

    if (isItemAFolder(item)) {
      return includesSearchText(item.name, searchText);
    }

    return false;
  });
};
