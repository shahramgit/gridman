import { collectionSchema, environmentSchema, itemSchema } from '@usebruno/schema';
import { parseQueryParams, extractPromptVariables } from '@usebruno/common/utils';
import { REQUEST_TYPES, DEFAULT_COLLECTION_FORMAT } from 'utils/common/constants';
import cloneDeep from 'lodash/cloneDeep';
import filter from 'lodash/filter';
import find from 'lodash/find';
import get from 'lodash/get';
import set from 'lodash/set';
import trim from 'lodash/trim';
import path, { normalizePath } from 'utils/common/path';
import { insertTaskIntoQueue, removeTaskFromQueue, toggleSidebarCollapse } from 'providers/ReduxStore/slices/app';
import toast from 'react-hot-toast';
import IpcErrorModal from 'components/Errors/IpcErrorModal/index';
import {
  findCollectionByUid,
  findEnvironmentInCollection,
  findItemInCollection,
  findItemInCollectionByPathname,
  findParentItemInCollection,
  isItemAFolder,
  refreshUidsInItem,
  isItemARequest,
  getAllVariables,
  transformRequestToSaveToFilesystem,
  transformCollectionRootToSave,
  flattenItems
} from 'utils/collections';
import { uuid, waitForNextTick } from 'utils/common';
import { cancelNetworkRequest, connectWS, sendGrpcRequest, sendNetworkRequest, sendWsRequest } from 'utils/network/index';
import { callIpc } from 'utils/common/ipc';
import brunoClipboard from 'utils/bruno-clipboard';

import {
  collectionAddEnvFileEvent as _collectionAddEnvFileEvent,
  createCollection as _createCollection,
  removeCollection as _removeCollection,
  selectEnvironment as _selectEnvironment,
  sortCollections as _sortCollections,
  updateCollectionMountStatus,
  moveCollection,
  workspaceEnvUpdateEvent,
  requestCancelled,
  resetRunResults,
  responseReceived,
  updateLastAction,
  setCollectionSecurityConfig,
  collectionAddOauth2CredentialsByUrl,
  collectionClearOauth2CredentialsByUrlAndCredentialsId,
  initRunRequestEvent,
  updateRunnerConfiguration as _updateRunnerConfiguration,
  updateActiveConnections,
  collectionAddFileEvent,
  collectionUnlinkDirectoryEvent,
  saveRequest as _saveRequest,
  saveEnvironment as _saveEnvironment,
  updateEnvironmentColor as _updateEnvironmentColor,
  saveCollectionDraft,
  saveFolderDraft,
  addVar,
  updateVar,
  addFolderVar,
  updateFolderVar,
  addCollectionVar,
  updateCollectionVar,
  addTransientDirectory,
  addSaveTransientRequestModal,
  updatePathParam,
  collectionIndexNodeCloned,
  collectionIndexNodeMoved,
  collectionIndexNodeRenamed,
  collectionIndexNodeAdded,
  collectionIndexNodeRemoved
} from './index';

import { each } from 'lodash';
import { closeAllCollectionTabs, closeTabs as _closeTabs, focusTab, reopenLastClosedTab } from 'providers/ReduxStore/slices/tabs';
import { clearOpenApiSyncTabState } from 'providers/ReduxStore/slices/openapi-sync';
import { removeCollectionFromWorkspace } from 'providers/ReduxStore/slices/workspaces';
import { resolveRequestFilename } from 'utils/common/platform';
import { interpolateUrl, parsePathParams, splitOnFirst } from 'utils/url/index';
import { sendCollectionOauth2Request as _sendCollectionOauth2Request } from 'utils/network/index';
import {
  getGlobalEnvironmentVariables,
  findCollectionByPathname,
  findEnvironmentInCollectionByName,
  getReorderedItemsInTargetDirectory,
  resetSequencesInFolder,
  getReorderedItemsInSourceDirectory,
  calculateDraggedItemNewPathname,
  transformFolderRootToSave,
  getTreePathFromCollectionToItem,
  mergeHeaders
} from 'utils/collections/index';
import { sanitizeName } from 'utils/common/regex';
import { buildPersistedEnvVariables } from 'utils/environments';
import { safeParseJSON, safeStringifyJSON } from 'utils/common/index';
import { resolveInheritedAuth } from 'utils/auth';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { updateSettingsSelectedTab } from './index';
import { saveGlobalEnvironment } from 'providers/ReduxStore/slices/global-environments';
import { getTabToFocusForCurrentWorkspace } from 'providers/ReduxStore/slices/workspaces/getTabToFocusForCurrentWorkspace';
import { clearPersistedScope } from 'hooks/usePersistedState/PersistedScopeProvider';

// generate a unique names
const generateUniqueName = (originalName, existingItems, isFolder) => {
  // Extract base name by removing any existing " (number)" suffix
  const baseName = originalName.replace(/\s*\(\d+\)$/, '');
  const baseFilename = sanitizeName(baseName);

  // Get normalized filenames for items of the same type
  const existingFilenames = existingItems
    .filter((item) => isFolder ? item.type === 'folder' : item.type !== 'folder')
    .map((item) => {
      let filename = trim(item.filename);
      // For requests, remove file extension (.bru, .yml, .yaml)
      return isFolder ? filename : filename.replace(/\.(bru|yml|yaml)$/, '');
    });

  // Check if base name conflicts with existing items
  if (!existingFilenames.includes(baseFilename)) {
    return { newName: baseName, newFilename: baseFilename };
  }

  // Find highest counter among conflicting names
  const counters = existingFilenames
    .filter((filename) => filename === baseFilename || filename.startsWith(`${baseFilename} (`))
    .map((filename) => {
      if (filename === baseFilename) return 0;
      const match = filename.match(/\((\d+)\)$/);
      return match ? parseInt(match[1], 10) : 0;
    });

  const nextCounter = Math.max(0, ...counters) + 1;
  return {
    newName: `${baseName} (${nextCounter})`,
    newFilename: `${baseFilename} (${nextCounter})`
  };
};

const getTransientRequestNameCandidate = (requestName, offset) => {
  if (offset === 0) {
    return requestName;
  }

  const match = requestName.match(/^(.*?)(?:\s+(\d+))?$/);
  const baseName = trim(match?.[1] || requestName);
  const currentNumber = match?.[2] ? parseInt(match[2], 10) : 1;
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + offset : offset + 1;

  return `${baseName} ${nextNumber}`;
};

const createTransientRequestFile = async ({
  collection,
  collectionUid,
  dispatch,
  item,
  requestName,
  tempDirectory,
  transientRequests
}) => {
  if (!tempDirectory) {
    throw new Error('Transient request directory is not ready');
  }

  const { ipcRenderer } = window;

  for (let offset = 0; offset < 100; offset += 1) {
    const candidateName = getTransientRequestNameCandidate(requestName, offset);
    const candidateBaseFilename = sanitizeName(candidateName);
    const candidatePathFilename = resolveRequestFilename(candidateBaseFilename, collection.format);
    const fullName = path.join(tempDirectory, candidatePathFilename);
    const reqWithSameNameExists = find(
      transientRequests,
      (i) => trim(i.filename) === trim(candidateBaseFilename) || trim(i.pathname) === trim(fullName)
    );
    const fileExists = await ipcRenderer.invoke('renderer:exists-sync', fullName);

    if (reqWithSameNameExists || fileExists) {
      continue;
    }

    const itemToSave = {
      ...item,
      name: candidateName,
      filename: candidateBaseFilename
    };
    const taskUid = uuid();

    try {
      dispatch(
        insertTaskIntoQueue({
          uid: taskUid,
          type: 'OPEN_REQUEST',
          collectionUid,
          itemPathname: fullName,
          preview: false
        })
      );
      await ipcRenderer.invoke('renderer:new-request', fullName, itemToSave);
      dispatch(
        collectionAddFileEvent({
          file: {
            meta: {
              collectionUid,
              pathname: fullName,
              name: path.basename(fullName)
            },
            data: itemToSave,
            partial: false,
            loading: false
          }
        })
      );
      return;
    } catch (error) {
      dispatch(removeTaskFromQueue({ taskUid }));

      if (String(error?.message || error).includes('already exists')) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('Unable to create a unique transient request');
};

export const renameCollection = (newName, collectionUid) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:rename-collection', newName, collection.pathname).then(resolve).catch(reject);
  });
};

export const saveRequest = (itemUid, collectionUid, silent = false) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);
  const tempDirectory = state.collections.tempDirectories?.[collectionUid];
  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);
    const item = findItemInCollection(collectionCopy, itemUid);
    if (!item) {
      return reject(new Error('Not able to locate item'));
    }

    const isTransient = tempDirectory && item.pathname.startsWith(tempDirectory);
    if (isTransient) {
      dispatch(addSaveTransientRequestModal({ item, collection }));
      return reject();
    }

    const itemToSave = transformRequestToSaveToFilesystem(item);
    const { ipcRenderer } = window;

    itemSchema
      .validate(itemToSave)
      .then(() => ipcRenderer.invoke('renderer:save-request', item.pathname, itemToSave, collection.format))
      .then(() => {
        if (!silent) {
          toast.success('Request saved successfully');
        }
        dispatch(
          _saveRequest({
            itemUid,
            collectionUid
          })
        );
      })
      .then(resolve)
      .catch((err) => {
        toast.error(err.message || 'Failed to save request!');
        reject(err);
      });
  });
};

export const saveMultipleRequests = (items) => (dispatch, getState) => {
  const state = getState();
  const { collections } = state.collections;

  return new Promise((resolve, reject) => {
    const itemsToSave = [];
    each(items, (item) => {
      const collection = findCollectionByUid(collections, item.collectionUid);
      if (collection) {
        const itemToSave = transformRequestToSaveToFilesystem(item);
        const itemIsValid = itemSchema.validateSync(itemToSave);
        if (itemIsValid) {
          itemsToSave.push({
            item: itemToSave,
            pathname: item.pathname,
            format: collection.format
          });
        }
      }
    });

    const { ipcRenderer } = window;

    ipcRenderer
      .invoke('renderer:save-multiple-requests', itemsToSave)
      .then(resolve)
      .catch((err) => {
        toast.error('Failed to save requests!');
        reject(err);
      });
  });
};

export const saveCollectionRoot = (collectionUid) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);

    // Transform collection root (uses draft if exists)
    const collectionRootToSave = transformCollectionRootToSave(collectionCopy);
    const { ipcRenderer } = window;

    ipcRenderer
      .invoke('renderer:save-collection-root', collectionCopy.pathname, collectionRootToSave, collectionCopy.brunoConfig)
      .then(() => {
        toast.success('Collection Settings saved successfully');
        dispatch(saveCollectionDraft({ collectionUid }));
      })
      .then(resolve)
      .catch((err) => {
        toast.error('Failed to save collection settings!');
        reject(err);
      });
  });
};

export const saveFolderRoot = (collectionUid, folderUid, silent = false) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);
  const folder = findItemInCollection(collection, folderUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    if (!folder) {
      return reject(new Error('Folder not found'));
    }

    const { ipcRenderer } = window;

    // Use draft if it exists, otherwise use root
    const folderRootToSave = transformFolderRootToSave(folder);

    const folderData = {
      name: folder.name,
      folderPathname: folder.pathname,
      collectionPathname: collection.pathname,
      root: folderRootToSave
    };

    ipcRenderer
      .invoke('renderer:save-folder-root', folderData)
      .then(() => {
        if (!silent) {
          toast.success('Folder Settings saved successfully');
        }
        // If there was a draft, save it to root and clear the draft
        if (folder.draft) {
          dispatch(saveFolderDraft({ collectionUid, folderUid }));
        }
      })
      .then(resolve)
      .catch((err) => {
        toast.error('Failed to save folder settings!');
        reject(err);
      });
  });
};

export const saveMultipleCollections = (collectionDrafts) => (dispatch, getState) => {
  const state = getState();
  const { collections } = state.collections;

  return new Promise((resolve, reject) => {
    const savePromises = [];

    each(collectionDrafts, (collectionDraft) => {
      const collection = findCollectionByUid(collections, collectionDraft.collectionUid);
      if (collection) {
        const collectionCopy = cloneDeep(collection);
        const collectionRootToSave = transformCollectionRootToSave(collectionCopy);
        const { ipcRenderer } = window;

        let savePromises = [];

        savePromises.push(ipcRenderer.invoke('renderer:save-collection-root', collectionCopy.pathname, collectionRootToSave, collectionCopy.brunoConfig));

        if (collectionCopy.draft?.brunoConfig) {
          savePromises.push(ipcRenderer.invoke('renderer:update-bruno-config', collectionCopy.draft.brunoConfig, collectionCopy.pathname, collectionCopy.root));
        }

        Promise.all(savePromises)
          .then(() => {
            dispatch(saveCollectionDraft({ collectionUid: collectionDraft.collectionUid }));
          })
          .catch((err) => {
            toast.error('Failed to save collection settings!');
            reject(err);
          });
      }
    });

    Promise.all(savePromises)
      .then(resolve)
      .catch((err) => {
        toast.error('Failed to save collection settings!');
        reject(err);
      });
  });
};

export const saveMultipleFolders = (folderDrafts) => (dispatch, getState) => {
  const state = getState();
  const { collections } = state.collections;

  return new Promise((resolve, reject) => {
    const savePromises = [];

    each(folderDrafts, (folderDraft) => {
      const collection = findCollectionByUid(collections, folderDraft.collectionUid);
      const folder = collection ? findItemInCollection(collection, folderDraft.folderUid) : null;

      if (collection && folder) {
        const folderRootToSave = transformFolderRootToSave(folder);
        const folderData = {
          name: folder.name,
          folderPathname: folder.pathname,
          collectionPathname: collection.pathname,
          root: folderRootToSave
        };

        const { ipcRenderer } = window;
        const savePromise = ipcRenderer
          .invoke('renderer:save-folder-root', folderData)
          .then(() => {
            if (folder.draft) {
              dispatch(saveFolderDraft({ collectionUid: folderDraft.collectionUid, folderUid: folderDraft.folderUid }));
            }
          });

        savePromises.push(savePromise);
      }
    });

    Promise.all(savePromises)
      .then(resolve)
      .catch((err) => {
        toast.error('Failed to save folder settings!');
        reject(err);
      });
  });
};

export const sendCollectionOauth2Request = (collectionUid, itemUid) => (dispatch, getState) => {
  const state = getState();
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    let collectionCopy = cloneDeep(collection);

    // add selected global env variables to the collection object
    const globalEnvironmentVariables = getGlobalEnvironmentVariables({
      globalEnvironments,
      activeGlobalEnvironmentUid
    });
    collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;

    const environment = findEnvironmentInCollection(collectionCopy, collection.activeEnvironmentUid);

    _sendCollectionOauth2Request(collectionCopy, environment, collectionCopy.runtimeVariables)
      .then((response) => {
        if (response?.data?.error) {
          toast.error(response?.data?.error);
        } else {
          toast.success('Request made successfully');
        }
        return response;
      })
      .then(resolve)
      .catch((err) => {
        toast.error(err.message);
      });
  });
};

export const wsConnectOnly = (item, collectionUid) => (dispatch, getState) => {
  const state = getState();
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise(async (resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    let collectionCopy = cloneDeep(collection);

    const itemCopy = cloneDeep(item);

    const requestUid = uuid();
    itemCopy.requestUid = requestUid;

    const globalEnvironmentVariables = getGlobalEnvironmentVariables({
      globalEnvironments,
      activeGlobalEnvironmentUid
    });
    collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;

    const environment = findEnvironmentInCollection(collectionCopy, collectionCopy.activeEnvironmentUid);

    connectWS(itemCopy, collectionCopy, environment, collectionCopy.runtimeVariables, { connectOnly: true })
      .then(resolve)
      .catch((err) => {
        toast.error(err.message);
      });
  });
};

/**
 * Extract prompt variables from a request, collection, and environment variables.
 * Tries to respect the hierarchy of the variables and avoid unnecessary prompts as much as possible
 *
 * @param {*} item
 * @param {*} collection
 * @returns {Promise<Object>} A promise that resolves with the prompt variables or null if no prompt variables are found
 */
const extractPromptVariablesForRequest = async (item, collection) => {
  return new Promise(async (resolve, reject) => {
    // Ensure window contains promptForVariables function
    if (typeof window === 'undefined' || typeof window.promptForVariables !== 'function') {
      console.error('Failed to initialize prompt variables: window.promptForVariables is not available. '
        + 'This may indicate an initialization issue with the app environment.');
      return resolve(null);
    }

    const prompts = [];
    const request = item.draft?.request ?? item.request ?? {};
    const allVariables = getAllVariables(collection, item);
    const clientCertConfig = get(collection, 'brunoConfig.clientCertificates.certs', []);
    const requestTreePath = getTreePathFromCollectionToItem(collection, item);
    // Get active headers from collection, folders, and request by priority order
    const headers = mergeHeaders(collection, request, requestTreePath);
    // Get request auth or inherited auth
    const resolvedAuthRequest = resolveInheritedAuth(item, collection);

    for (let clientCert of clientCertConfig) {
      const domain = interpolateUrl({ url: clientCert?.domain, variables: allVariables });

      if (domain) {
        const hostRegex = '^(https:\\/\\/|grpc:\\/\\/|grpcs:\\/\\/)?' + domain.replaceAll('.', '\\.').replaceAll('*', '.*');
        const requestUrl = interpolateUrl({ url: request.url, variables: allVariables });
        if (requestUrl.match(hostRegex)) {
          prompts.push(...extractPromptVariables(clientCert));
        }
      }
    }

    // Attempt to extract unique prompt variables from anywhere in the request and environment variables.
    prompts.push(...extractPromptVariables(allVariables));
    prompts.push(...extractPromptVariables(request.body?.[request.body.mode]));
    prompts.push(...extractPromptVariables(headers));
    prompts.push(...extractPromptVariables(request.params));
    prompts.push(...extractPromptVariables(resolvedAuthRequest.auth));
    prompts.push(...extractPromptVariables(request.url));

    // Remove duplicates
    const uniquePrompts = Array.from(new Set(prompts));

    // If no prompt variables are found, return null
    if (!uniquePrompts?.length) {
      return resolve(null);
    }

    try {
      // Prompt user for values if any prompt variables are found
      const userValues = await window.promptForVariables(uniquePrompts);
      const promptVariables = {};
      // Populate runtimeVariables with user input for prompt variables
      for (const prompt of uniquePrompts) {
        promptVariables[`?${prompt}`] = userValues[prompt] ?? '';
      }

      return resolve(promptVariables);
    } catch (error) {
      return reject(error);
    }
  });
};

export const sendRequest = (item, collectionUid) => (dispatch, getState) => {
  const state = getState();
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
  const collection = findCollectionByUid(state.collections.collections, collectionUid);
  const itemUid = item?.uid;

  return new Promise(async (resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    if (item.response?.stream?.running && item.cancelTokenUid) {
      await dispatch(cancelRequest(item.cancelTokenUid, item, collection));
    }

    let collectionCopy = cloneDeep(collection);

    const itemCopy = cloneDeep(item);

    // add selected global env variables to the collection object
    const globalEnvironmentVariables = getGlobalEnvironmentVariables({
      globalEnvironments,
      activeGlobalEnvironmentUid
    });
    collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;

    const requestUid = uuid();
    itemCopy.requestUid = requestUid;

    try {
      const promptVariables = await extractPromptVariablesForRequest(itemCopy, collectionCopy);
      collectionCopy.promptVariables = promptVariables ?? {};
    } catch (error) {
      if (error === 'cancelled') {
        return resolve(); // Resolve without error if user cancels prompt
      }
      return reject(error);
    }

    await dispatch(
      initRunRequestEvent({
        requestUid,
        itemUid,
        collectionUid
      })
    );

    const environment = findEnvironmentInCollection(collectionCopy, collectionCopy.activeEnvironmentUid);
    const isGrpcRequest = itemCopy.type === 'grpc-request';
    const isWsRequest = itemCopy.type === 'ws-request';
    if (isGrpcRequest) {
      sendGrpcRequest(itemCopy, collectionCopy, environment, collectionCopy.runtimeVariables)
        .then(resolve)
        .catch((err) => {
          toast.error(err.message);
        });
    } else if (isWsRequest) {
      const wsMessages = itemCopy.draft?.request?.body?.ws || itemCopy.request?.body?.ws || [];
      const wsSelectedMessageIndex = Math.max(0, wsMessages.findIndex((msg) => msg.selected));
      sendWsRequest(itemCopy, collectionCopy, environment, collectionCopy.runtimeVariables, wsSelectedMessageIndex)
        .then(resolve)
        .catch((err) => {
          toast.error(err.message);
        });
    } else {
      sendNetworkRequest(itemCopy, collectionCopy, environment, collectionCopy.runtimeVariables)
        .then((response) => {
          const { requestSent, ...responseData } = response;
          // Ensure any timestamps in the response are converted to numbers
          const serializedResponse = {
            ...responseData,
            timeline: responseData.timeline?.map((entry) => ({
              ...entry,
              timestamp: entry.timestamp instanceof Date ? entry.timestamp.getTime() : entry.timestamp
            }))
          };

          return dispatch(
            responseReceived({
              itemUid,
              collectionUid,
              response: serializedResponse,
              requestSent
            })
          );
        })
        .then(resolve)
        .catch((err) => {
          const request = itemCopy.draft?.request || itemCopy.request;
          const requestSent = request ? { url: request.url, method: request.method } : undefined;

          if (err && err.message === 'Error invoking remote method \'send-http-request\': Error: Request cancelled') {
            dispatch(
              responseReceived({
                itemUid,
                collectionUid,
                response: null,
                requestSent
              })
            );
            return;
          }

          const errorResponse = {
            status: 'Error',
            isError: true,
            error: err.message ?? 'Something went wrong',
            size: 0,
            duration: 0
          };

          dispatch(
            responseReceived({
              itemUid,
              collectionUid,
              response: errorResponse,
              requestSent
            })
          );
        });
    }
  });
};

export const cancelRequest = (cancelTokenUid, item, collection) => (dispatch) => {
  return cancelNetworkRequest(cancelTokenUid)
    .then(() => {
      dispatch(
        requestCancelled({
          itemUid: item.uid,
          collectionUid: collection.uid
        })
      );
    })
    .catch((err) => console.log(err));
};

export const cancelRunnerExecution = (cancelTokenUid) => (dispatch) => {
  cancelNetworkRequest(cancelTokenUid).catch((err) => console.log(err));
};

export const runCollectionFolder
  = (collectionUid, folderUid, recursive, delay, tags, selectedRequestUids) => (dispatch, getState) => {
    const state = getState();
    const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    return new Promise((resolve, reject) => {
      if (!collection) {
        return reject(new Error('Collection not found'));
      }

      let collectionCopy = cloneDeep(collection);

      // add selected global env variables to the collection object
      const globalEnvironmentVariables = getGlobalEnvironmentVariables({
        globalEnvironments,
        activeGlobalEnvironmentUid
      });
      collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;

      const folder = findItemInCollection(collectionCopy, folderUid);

      if (folderUid && !folder) {
        return reject(new Error('Folder not found'));
      }

      const environment = findEnvironmentInCollection(collectionCopy, collection.activeEnvironmentUid);

      dispatch(
        resetRunResults({
          collectionUid: collection.uid
        })
      );

      const { ipcRenderer } = window;
      ipcRenderer
        .invoke(
          'renderer:run-collection-folder',
          folder,
          collectionCopy,
          environment,
          collectionCopy.runtimeVariables,
          recursive,
          delay,
          tags,
          selectedRequestUids
        )
        .then(resolve)
        .catch((err) => {
          toast.error(get(err, 'error.message') || 'Something went wrong!');
          reject(err);
        });
    });
  };

// Next sequence for a newly created item so it lands at the END of its parent.
// Uses max(siblingSeq)+1 rather than count+1, because after imports/deletions
// the sequences have gaps or exceed the count and count+1 would land in the
// middle. Prefers the warm index (the source of truth for large/lazy indexed
// collections) and falls back to the classic in-memory items.
const nextSiblingSeq = ({ state, collectionUid, parentPathname, fallbackItems }) => {
  const index = state.collections.collectionIndexes?.[collectionUid];
  if (index?.nodesByUid) {
    const parentNode = parentPathname
      ? Object.values(index.nodesByUid).find((node) => normalizePath(node.pathname) === normalizePath(parentPathname))
      : null;
    const childUids = index.childrenByParentUid?.[parentNode ? parentNode.uid : 'root'] || [];
    if (childUids.length) {
      const max = childUids.reduce((acc, uid) => Math.max(acc, Number(index.nodesByUid[uid]?.seq) || 0), 0);
      return max + 1;
    }
  }
  const items = (fallbackItems || []).filter((i) => isItemAFolder(i) || isItemARequest(i));
  const max = items.reduce((acc, i) => Math.max(acc, Number(i.seq) || 0), 0);
  return Math.max(max + 1, items.length + 1);
};

export const newFolder = (folderName, directoryName, collectionUid, itemUid) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);
  const parentItem = itemUid ? findItemInCollection(collection, itemUid) : collection;
  const seq = nextSiblingSeq({ state, collectionUid, parentPathname: parentItem?.pathname, fallbackItems: parentItem?.items });

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    if (!itemUid) {
      const folderWithSameNameExists = find(
        collection.items,
        (i) => i.type === 'folder' && trim(i.filename) === trim(directoryName)
      );
      if (!folderWithSameNameExists) {
        const fullName = path.join(collection.pathname, directoryName);
        const { ipcRenderer } = window;

        const folderData = {
          meta: {
            name: folderName,
            seq: seq
          },
          request: {
            auth: {
              mode: 'inherit'
            }
          }
        };

        ipcRenderer
          .invoke('renderer:new-folder', { pathname: fullName, folderData, format: collection.format })
          .then(resolve)
          .catch((error) => {
            toast.error('Failed to create a new folder!');
            reject(error);
          });
      } else {
        return reject(new Error('Duplicate folder names under same parent folder are not allowed'));
      }
    } else {
      const currentItem = findItemInCollection(collection, itemUid);
      if (currentItem) {
        const folderWithSameNameExists = find(
          currentItem.items,
          (i) => i.type === 'folder' && trim(i.filename) === trim(directoryName)
        );
        if (!folderWithSameNameExists) {
          const fullName = path.join(currentItem.pathname, directoryName);
          const { ipcRenderer } = window;

          const folderData = {
            meta: {
              name: folderName,
              seq: seq
            },
            request: {
              auth: {
                mode: 'inherit'
              }
            }
          };

          ipcRenderer
            .invoke('renderer:new-folder', { pathname: fullName, folderData, format: collection.format })
            .then(resolve)
            .catch((error) => {
              toast.error('Failed to create a new folder!');
              reject(error);
            });
        } else {
          return reject(new Error('Duplicate folder names under same parent folder are not allowed'));
        }
      } else {
        return reject(new Error('unable to find parent folder'));
      }
    }
  });
};

export const newFolderByPath = ({ collectionUid, parentPathname, folderName, directoryName }) => async (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  if (!collection) {
    throw new Error('Collection not found');
  }

  const result = await callIpc('renderer:new-collection-folder-by-path', {
    parentPathname: parentPathname || collection.pathname,
    collectionPathname: collection.pathname,
    folderName,
    directoryName
  });
  // Insert the one new node instead of re-reading the whole collection.
  if (state.collections.collectionIndexes?.[collectionUid] && result?.pathname) {
    dispatch(collectionIndexNodeAdded({
      collectionUid,
      pathname: result.pathname,
      name: folderName,
      type: 'folder',
      uid: uuid()
    }));
  } else {
    await dispatch(refreshCollectionIndex({ collectionUid }));
  }
  return result;
};

export const renameItem
  = ({ newName, newFilename, itemUid, collectionUid }) =>
    (dispatch, getState) => {
      const state = getState();
      const collection = findCollectionByUid(state.collections.collections, collectionUid);

      return new Promise((resolve, reject) => {
        if (!collection) {
          return reject(new Error('Collection not found'));
        }

        const collectionCopy = cloneDeep(collection);
        const item = findItemInCollection(collectionCopy, itemUid);
        if (!item) {
          return reject(new Error('Unable to locate item'));
        }

        const { ipcRenderer } = window;

        const renameName = async () => {
          return ipcRenderer.invoke('renderer:rename-item-name', { itemPath: item.pathname, newName, collectionPathname: collection.pathname }).catch((err) => {
            toast.error('Failed to rename the item name');
            console.error(err);
            throw new Error('Failed to rename the item name');
          });
        };

        const renameFile = async () => {
          const dirname = path.dirname(item.pathname);
          let newPath = '';
          if (item.type === 'folder') {
            newPath = path.join(dirname, trim(newFilename));
          } else {
            const filename = resolveRequestFilename(newFilename, collection.format);
            newPath = path.join(dirname, filename);
          }

          return ipcRenderer
            .invoke('renderer:rename-item-filename', { oldPath: item.pathname, newPath, newName, newFilename, collectionPathname: collection.pathname })
            .catch((err) => {
              console.error(err);
              throw new Error('Duplicate request names are not allowed under the same folder');
            });
        };

        let renameOperation = null;
        if (newName) renameOperation = renameName;
        if (newFilename) renameOperation = renameFile;

        if (!renameOperation) {
          resolve();
        }

        renameOperation()
          .then(() => {
            toast.success('Item renamed successfully');
            resolve();
          })
          .catch((err) => reject(err));
      });
    };

export const cloneItem = (newName, newFilename, itemUid, collectionUid) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      throw new Error('Collection not found');
    }
    const collectionCopy = cloneDeep(collection);
    const item = findItemInCollection(collectionCopy, itemUid);
    if (!item) {
      throw new Error('Unable to locate item');
    }

    if (isItemAFolder(item)) {
      const parentFolder = findParentItemInCollection(collection, item.uid) || collection;

      const folderWithSameNameExists = find(
        parentFolder.items,
        (i) => i.type === 'folder' && trim(i?.filename) === trim(newFilename)
      );

      if (folderWithSameNameExists) {
        return reject(new Error('Duplicate folder names under same parent folder are not allowed'));
      }

      set(item, 'name', newName);
      set(item, 'filename', newFilename);
      set(item, 'root.meta.name', newName);
      set(item, 'root.meta.seq', parentFolder?.items?.length + 1);

      const collectionPath = path.join(parentFolder.pathname, newFilename);

      const { ipcRenderer } = window;
      ipcRenderer.invoke('renderer:clone-folder', item, collectionPath, collection.pathname).then(resolve).catch(reject);
      return;
    }

    const parentItem = findParentItemInCollection(collectionCopy, itemUid);
    const filename = resolveRequestFilename(newFilename, collection.format);
    const itemToSave = refreshUidsInItem(transformRequestToSaveToFilesystem(item));
    set(itemToSave, 'name', trim(newName));
    set(itemToSave, 'filename', trim(filename));
    if (!parentItem) {
      const reqWithSameNameExists = find(
        collection.items,
        (i) => i.type !== 'folder' && trim(i.filename) === trim(filename)
      );
      if (!reqWithSameNameExists) {
        const fullPathname = path.join(collection.pathname, filename);
        const { ipcRenderer } = window;
        const requestItems = filter(collection.items, (i) => i.type !== 'folder');
        itemToSave.seq = requestItems ? requestItems.length + 1 : 1;

        itemSchema
          .validate(itemToSave)
          .then(() => ipcRenderer.invoke('renderer:new-request', fullPathname, itemToSave))
          .then(resolve)
          .catch(reject);

        dispatch(
          insertTaskIntoQueue({
            uid: uuid(),
            type: 'OPEN_REQUEST',
            collectionUid,
            itemPathname: fullPathname
          })
        );
      } else {
        return reject(new Error('Duplicate request names are not allowed under the same folder'));
      }
    } else {
      const reqWithSameNameExists = find(
        parentItem.items,
        (i) => i.type !== 'folder' && trim(i.filename) === trim(filename)
      );
      if (!reqWithSameNameExists) {
        const dirname = path.dirname(item.pathname);
        const fullName = path.join(dirname, filename);
        const { ipcRenderer } = window;
        const requestItems = filter(parentItem.items, (i) => i.type !== 'folder');
        itemToSave.seq = requestItems ? requestItems.length + 1 : 1;

        itemSchema
          .validate(itemToSave)
          .then(() => ipcRenderer.invoke('renderer:new-request', fullName, itemToSave))
          .then(resolve)
          .catch(reject);

        dispatch(
          insertTaskIntoQueue({
            uid: uuid(),
            type: 'OPEN_REQUEST',
            collectionUid,
            itemPathname: fullName
          })
        );
      } else {
        return reject(new Error('Duplicate request names are not allowed under the same folder'));
      }
    }
  });
};

export const refreshCollectionIndex = ({ collectionUid }) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  if (!collection) {
    return Promise.reject(new Error('Collection not found'));
  }

  return callIpc('renderer:refresh-collection-index', {
    collectionUid,
    collectionPathname: collection.pathname,
    brunoConfig: collection.brunoConfig,
    loadSessionId: uuid()
  });
};

export const cloneCollectionItemByPath = ({ collectionUid, sourcePathname, newName, newFilename }) => async (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  if (!collection) {
    throw new Error('Collection not found');
  }

  const result = await callIpc('renderer:clone-collection-item-by-path', {
    sourcePathname,
    collectionPathname: collection.pathname,
    newName,
    newFilename
  });
  // collectionIndexNodeCloned copies the whole subtree (uids remapped), so
  // folder clones no longer need a full re-index either.
  if (state.collections.collectionIndexes?.[collectionUid] && result?.pathname) {
    dispatch(collectionIndexNodeCloned({
      sourceCollectionUid: collectionUid,
      targetCollectionUid: collectionUid,
      sourcePathname,
      targetPathname: result.pathname,
      rootName: newName
    }));
  } else {
    await dispatch(refreshCollectionIndex({ collectionUid }));
  }
  return result;
};

export const renameCollectionItemByPath = ({ collectionUid, sourcePathname, newName, newFilename }) => async (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  if (!collection) {
    throw new Error('Collection not found');
  }

  const result = await callIpc('renderer:rename-collection-item-by-path', {
    sourcePathname,
    collectionPathname: collection.pathname,
    newName,
    newFilename
  });
  // Apply the rename as a targeted index update — a full re-index reads every
  // file in the collection and blanks the sidebar while it rebuilds.
  if (state.collections.collectionIndexes?.[collectionUid] && result?.pathname) {
    if (path.normalize(result.pathname) !== path.normalize(sourcePathname)) {
      dispatch(collectionIndexNodeMoved({
        collectionUid,
        sourcePathname,
        targetPathname: result.pathname
      }));
    }
    if (newName) {
      dispatch(collectionIndexNodeRenamed({
        collectionUid,
        pathname: result.pathname,
        name: newName
      }));
    }
  } else {
    await dispatch(refreshCollectionIndex({ collectionUid }));
  }
  return result;
};

export const deleteCollectionItemByPath = ({ collectionUid, sourcePathname, type }) => async (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  if (!collection) {
    throw new Error('Collection not found');
  }

  const result = await callIpc('renderer:delete-collection-item-by-path', {
    sourcePathname,
    collectionPathname: collection.pathname,
    type
  });
  if (state.collections.collectionIndexes?.[collectionUid]) {
    dispatch(collectionIndexNodeRemoved({
      collectionUid,
      sourcePathname
    }));
  } else {
    await dispatch(refreshCollectionIndex({ collectionUid }));
  }
  return result;
};

export const pasteItem = (targetCollectionUid, targetItemUid = null) => (dispatch, getState) => {
  const state = getState();

  const clipboardResult = brunoClipboard.read();

  if (!clipboardResult.hasData) {
    return Promise.reject(new Error('No item in clipboard'));
  }

  const targetCollection = findCollectionByUid(state.collections.collections, targetCollectionUid);

  if (!targetCollection) {
    return Promise.reject(new Error('Target collection not found'));
  }

  return new Promise(async (resolve, reject) => {
    try {
      for (const clipboardItem of clipboardResult.items) {
        const copiedItem = cloneDeep(clipboardItem);

        const targetCollectionCopy = cloneDeep(targetCollection);
        let targetItem = null;
        let targetParentPathname = targetCollection.pathname;

        // If targetItemUid is provided, we're pasting into a folder
        if (targetItemUid) {
          targetItem = findItemInCollection(targetCollectionCopy, targetItemUid);
          if (!targetItem) {
            return reject(new Error('Target folder not found'));
          }
          if (!isItemAFolder(targetItem)) {
            return reject(new Error('Target must be a folder or collection'));
          }
          targetParentPathname = targetItem.pathname;
        }

        const existingItems = targetItem ? targetItem.items : targetCollection.items;

        // Handle folder pasting
        if (isItemAFolder(copiedItem)) {
          // Generate unique name for folder
          const { newName, newFilename } = generateUniqueName(copiedItem.name, existingItems, true);

          set(copiedItem, 'name', newName);
          set(copiedItem, 'filename', newFilename);
          set(copiedItem, 'root.meta.name', newName);
          set(copiedItem, 'root.meta.seq', (existingItems?.length ?? 0) + 1);

          const fullPathname = path.join(targetParentPathname, newFilename);
          const { ipcRenderer } = window;

          await ipcRenderer.invoke('renderer:clone-folder', copiedItem, fullPathname, targetCollection.pathname);
        } else {
          // Handle request pasting
          // Generate unique name for request
          const { newName, newFilename } = generateUniqueName(copiedItem.name, existingItems, false);

          const filename = resolveRequestFilename(newFilename, targetCollection.format);
          const itemToSave = refreshUidsInItem(transformRequestToSaveToFilesystem(copiedItem));
          set(itemToSave, 'name', trim(newName));
          set(itemToSave, 'filename', trim(filename));

          const fullPathname = path.join(targetParentPathname, filename);
          const { ipcRenderer } = window;
          const requestItems = filter(existingItems, (i) => i.type !== 'folder');
          itemToSave.seq = requestItems ? requestItems.length + 1 : 1;

          await itemSchema.validate(itemToSave);
          await ipcRenderer.invoke('renderer:new-request', fullPathname, itemToSave, targetCollection.format);

          dispatch(insertTaskIntoQueue({
            uid: uuid(),
            type: 'OPEN_REQUEST',
            collectionUid: targetCollectionUid,
            itemPathname: fullPathname
          }));
        }
      }

      resolve();
    } catch (error) {
      reject(error);
    }
  });
};

export const deleteItem = (itemUid, collectionUid) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const item = findItemInCollection(collection, itemUid);
    if (item) {
      const parentDirectoryItem = findParentItemInCollection(collection, itemUid) || collection;
      const { ipcRenderer } = window;

      ipcRenderer
        .invoke('renderer:delete-item', item.pathname, item.type, collection.pathname)
        .then(async () => {
          // Reorder items in parent directory after deletion
          if (parentDirectoryItem.items) {
            const requestAndFolderTypes = [...REQUEST_TYPES, 'folder'];
            const directoryItemsWithOnlyRequestAndFolders = parentDirectoryItem.items.filter((i) => requestAndFolderTypes.includes(i.type));
            const directoryItemsWithoutDeletedItem = directoryItemsWithOnlyRequestAndFolders.filter((i) => i.uid !== itemUid);
            const reorderedSourceItems = getReorderedItemsInSourceDirectory({
              items: directoryItemsWithoutDeletedItem
            });
            if (reorderedSourceItems?.length) {
              await dispatch(updateItemsSequences({ itemsToResequence: reorderedSourceItems, collectionUid }));
            }
          }
          resolve();
        })
        .catch((error) => reject(error));
    } else {
      return reject(new Error('Unable to locate item'));
    }
  });
};

export const moveCollectionItemByPath = ({
  sourceCollectionUid,
  targetCollectionUid,
  sourcePathname,
  targetPathname,
  dropType
}) => async (dispatch, getState) => {
  const state = getState();
  const sourceCollection = findCollectionByUid(state.collections.collections, sourceCollectionUid);
  const targetCollection = findCollectionByUid(state.collections.collections, targetCollectionUid);
  const shouldRefreshSourceIndex = Boolean(state.collections.collectionIndexes?.[sourceCollectionUid]);
  const shouldRefreshTargetIndex = Boolean(state.collections.collectionIndexes?.[targetCollectionUid]);

  if (!sourceCollection) {
    throw new Error('Source collection not found');
  }

  if (!targetCollection) {
    throw new Error('Target collection not found');
  }

  const result = await callIpc('renderer:move-collection-item-by-path', {
    sourcePathname,
    targetPathname,
    sourceCollectionPathname: sourceCollection.pathname,
    targetCollectionPathname: targetCollection.pathname,
    dropType
  });

  if (sourceCollectionUid === targetCollectionUid && shouldRefreshTargetIndex && result?.pathname && !result?.skipped && result?.type !== 'folder') {
    dispatch(collectionIndexNodeMoved({
      collectionUid: targetCollectionUid,
      sourcePathname,
      targetPathname: result.pathname
    }));
  } else if (sourceCollectionUid !== targetCollectionUid && result?.pathname && !result?.skipped) {
    if (shouldRefreshTargetIndex) {
      dispatch(collectionIndexNodeCloned({
        sourceCollectionUid,
        targetCollectionUid,
        sourcePathname,
        targetPathname: result.pathname
      }));
    }
    if (shouldRefreshSourceIndex) {
      dispatch(collectionIndexNodeRemoved({
        collectionUid: sourceCollectionUid,
        sourcePathname
      }));
    }
  } else if (shouldRefreshTargetIndex && !(sourceCollectionUid === targetCollectionUid && result?.skipped)) {
    // A skipped same-collection move is a no-op on disk (e.g. reordering within
    // the same folder); the renderer resequences the affected siblings, so a
    // full re-index here is wasteful and can transiently duplicate nodes.
    if (sourceCollectionUid === targetCollectionUid && result?.pathname && !result?.skipped && result?.type === 'folder') {
      [sourcePathname, result.pathname].forEach((pathname) => {
        dispatch(collectionUnlinkDirectoryEvent({
          directory: {
            meta: {
              collectionUid: targetCollectionUid,
              pathname
            }
          }
        }));
      });
    }
    await dispatch(refreshCollectionIndex({ collectionUid: targetCollectionUid }));
  }
  if (sourceCollectionUid !== targetCollectionUid && shouldRefreshSourceIndex && (!result?.pathname || result?.skipped)) {
    await dispatch(refreshCollectionIndex({ collectionUid: sourceCollectionUid }));
  }

  return result;
};

export const sortCollections = (payload) => (dispatch) => {
  dispatch(_sortCollections(payload));
};

export const moveItem
  = ({ targetDirname, sourcePathname }) =>
    (dispatch, getState) => {
      return new Promise((resolve, reject) => {
        const { ipcRenderer } = window;

        ipcRenderer.invoke('renderer:move-item', { targetDirname, sourcePathname }).then(resolve).catch(reject);
      });
    };

export const handleCollectionItemDrop
  = ({ targetItem, draggedItem, dropType, collectionUid }) =>
    (dispatch, getState) => {
      const state = getState();
      const collection = findCollectionByUid(state.collections.collections, collectionUid);
      // if its withincollection set the source to current collection,
      // if its cross collection set the source to the source collection
      const sourceCollectionUid = draggedItem.sourceCollectionUid;
      const isCrossCollectionMove = sourceCollectionUid && collectionUid !== sourceCollectionUid;
      const sourceCollection = isCrossCollectionMove ? findCollectionByUid(state.collections.collections, sourceCollectionUid) : collection;
      const { uid: draggedItemUid, pathname: draggedItemPathname } = draggedItem;
      const { uid: targetItemUid, pathname: targetItemPathname } = targetItem;
      const targetItemDirectory = findParentItemInCollection(collection, targetItemUid) || collection;
      const targetItemDirectoryItems = cloneDeep(targetItemDirectory.items);
      const draggedItemDirectory = findParentItemInCollection(sourceCollection, draggedItemUid) || sourceCollection;
      const draggedItemDirectoryItems = cloneDeep(draggedItemDirectory.items);

      const sourceFormat = sourceCollection?.format || 'bru';
      const targetFormat = collection?.format || 'bru';
      const isCrossFormatMove = isCrossCollectionMove && sourceFormat !== targetFormat;

      const handleMoveToNewLocation = async ({
        draggedItem,
        draggedItemDirectoryItems,
        targetItem,
        targetItemDirectoryItems,
        newPathname,
        dropType
      }) => {
        const { uid: targetItemUid } = targetItem;
        const { pathname: draggedItemPathname, uid: draggedItemUid } = draggedItem;

        const newDirname = path.dirname(newPathname);

        if (isCrossFormatMove && isItemARequest(draggedItem)) {
          const { ipcRenderer } = window;
          const result = await ipcRenderer.invoke('renderer:move-item-cross-format', {
            targetDirname: newDirname,
            sourcePathname: draggedItemPathname,
            sourceFormat,
            targetFormat
          });
          newPathname = result.newPathname;
        } else {
          await dispatch(moveItem({
            targetDirname: newDirname,
            sourcePathname: draggedItemPathname
          }));
        }

        // Update sequences in the source directory
        if (draggedItemDirectoryItems?.length) {
          // reorder items in the source directory
          const draggedItemDirectoryItemsWithoutDraggedItem = draggedItemDirectoryItems.filter((i) => i.uid !== draggedItemUid);
          const reorderedSourceItems = getReorderedItemsInSourceDirectory({
            items: draggedItemDirectoryItemsWithoutDraggedItem
          });
          if (reorderedSourceItems?.length) {
            await dispatch(updateItemsSequences({ itemsToResequence: reorderedSourceItems, collectionUid: sourceCollectionUid || collectionUid }));
          }
        }

        // Update sequences in the target directory (if dropping adjacent)
        if (dropType === 'adjacent') {
          const targetItemSequence = targetItemDirectoryItems.find((i) => i.uid === targetItemUid)?.seq;

          const draggedItemWithNewPathAndSequence = {
            ...draggedItem,
            pathname: newPathname,
            seq: targetItemSequence
          };

          // draggedItem is added to the targetItem's directory
          const reorderedTargetItems = getReorderedItemsInTargetDirectory({
            items: [...targetItemDirectoryItems, draggedItemWithNewPathAndSequence],
            targetItemUid,
            draggedItemUid
          });

          if (reorderedTargetItems?.length) {
            await dispatch(updateItemsSequences({ itemsToResequence: reorderedTargetItems, collectionUid }));
          }
        }
      };

      const handleReorderInSameLocation = async ({ draggedItem, targetItem, targetItemDirectoryItems }) => {
        const { uid: targetItemUid } = targetItem;
        const { uid: draggedItemUid } = draggedItem;

        // reorder items in the targetItem's directory
        const reorderedItems = getReorderedItemsInTargetDirectory({
          items: targetItemDirectoryItems,
          targetItemUid,
          draggedItemUid
        });

        if (reorderedItems?.length) {
          await dispatch(updateItemsSequences({ itemsToResequence: reorderedItems, collectionUid }));
        }
      };

      return new Promise(async (resolve, reject) => {
        try {
          const newPathname = calculateDraggedItemNewPathname({
            draggedItem,
            targetItem,
            dropType,
            collectionPathname: collection.pathname
          });
          if (!newPathname) return;
          if (targetItemPathname?.startsWith(draggedItemPathname)) return;

          if (isCrossFormatMove && isItemAFolder(draggedItem)) {
            toast.error('Moving folders between collections with different formats is not supported');
            return;
          }

          // Discard operation if dragging a root item to the collection name (same location)
          const isTargetTheCollection = targetItemPathname === collection.pathname;
          const isDraggedItemAtRoot = draggedItemDirectory === sourceCollection;
          if (isTargetTheCollection && isDraggedItemAtRoot && !isCrossCollectionMove) {
            return;
          }

          if (newPathname !== draggedItemPathname) {
            await handleMoveToNewLocation({
              targetItem,
              targetItemDirectoryItems,
              draggedItem,
              draggedItemDirectoryItems,
              newPathname,
              dropType
            });
          } else {
            await handleReorderInSameLocation({ draggedItem, targetItemDirectoryItems, targetItem });
          }

          if (isCrossCollectionMove) {
            dispatch(closeTabs({ tabUids: [draggedItemUid] }));
          }

          resolve();
        } catch (error) {
          console.error(error);
          toast.error(error?.message);
          reject(error);
        }
      });
    };

export const updateItemsSequences
  = ({ itemsToResequence, collectionUid }) =>
    (dispatch, getState) => {
      return new Promise((resolve, reject) => {
        const state = getState();
        const collection = findCollectionByUid(state.collections.collections, collectionUid);

        if (!collection) {
          return reject(new Error('Collection not found'));
        }

        const { ipcRenderer } = window;

        ipcRenderer.invoke('renderer:resequence-items', itemsToResequence, collection.pathname).then(resolve).catch(reject);
      });
    };

export const newHttpRequest = (params) => (dispatch, getState) => {
  const {
    requestName,
    filename,
    requestType,
    requestUrl,
    requestMethod,
    collectionUid,
    itemUid,
    headers,
    body,
    auth,
    settings,
    isTransient = false
  } = params;

  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    // Get temp directory if isTransient is true
    const tempDirectory = isTransient ? state.collections.tempDirectories?.[collectionUid] : null;

    const parts = splitOnFirst(requestUrl, '?');
    const queryParams = parseQueryParams(parts[1]);
    each(queryParams, (urlParam) => {
      urlParam.enabled = true;
      urlParam.type = 'query';
    });

    const pathParams = parsePathParams(requestUrl);
    each(pathParams, (pathParm) => {
      pathParams.enabled = true;
      pathParm.type = 'path';
    });

    const params = [...queryParams, ...pathParams];

    const item = {
      uid: uuid(),
      type: requestType,
      name: requestName,
      filename,
      isTransient: isTransient,
      request: {
        method: requestMethod,
        url: requestUrl,
        headers: headers ?? [],
        params,
        body: body ?? {
          mode: 'none',
          json: null,
          text: null,
          xml: null,
          sparql: null,
          multipartForm: [],
          formUrlEncoded: [],
          file: []
        },
        vars: {
          req: [],
          res: []
        },
        script: {
          req: null,
          res: null
        },
        assertions: [],
        tests: null,
        auth: auth ?? {
          mode: 'inherit'
        }
      },
      settings: settings ?? {
        encodeUrl: true
      }
    };

    // itemUid is null when we are creating a new request at the root level
    // For transient requests, itemUid is always null
    const resolvedFilename = resolveRequestFilename(filename, collection.format);

    if (isTransient) {
      // Transient requests are always created in temp directory
      // Check for duplicates only among other transient requests
      const allItems = flattenItems(collection.items);
      const transientRequests = filter(
        allItems,
        (i) => isItemARequest(i) && i.pathname && i.pathname.startsWith(tempDirectory)
      );
      const items = filter(collection.items, (i) => isItemAFolder(i) || isItemARequest(i));
      item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: collection?.pathname, fallbackItems: items });

      createTransientRequestFile({
        collection,
        collectionUid,
        dispatch,
        item,
        requestName,
        tempDirectory,
        transientRequests
      }).then(resolve).catch(reject);
    } else if (!itemUid) {
      // Regular request at root level
      const reqWithSameNameExists = find(
        collection.items,
        (i) => i.type !== 'folder' && trim(i.filename) === trim(resolvedFilename)
      );
      const items = filter(collection.items, (i) => isItemAFolder(i) || isItemARequest(i));
      item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: collection?.pathname, fallbackItems: items });

      if (!reqWithSameNameExists) {
        const fullName = path.join(collection.pathname, resolvedFilename);
        const { ipcRenderer } = window;

        ipcRenderer
          .invoke('renderer:new-request', fullName, item)
          .then(() => {
            // task middleware will track this and open the new request in a new tab once request is created
            dispatch(
              insertTaskIntoQueue({
                uid: uuid(),
                type: 'OPEN_REQUEST',
                collectionUid,
                itemPathname: fullName
              })
            );
            resolve();
          })
          .catch(reject);
      } else {
        return reject(new Error('Duplicate request names are not allowed under the same folder'));
      }
    } else {
      const currentItem = findItemInCollection(collection, itemUid);
      if (currentItem) {
        const reqWithSameNameExists = find(
          currentItem.items,
          (i) => i.type !== 'folder' && trim(i.filename) === trim(resolvedFilename)
        );
        const items = filter(currentItem.items, (i) => isItemAFolder(i) || isItemARequest(i));
        item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: currentItem?.pathname, fallbackItems: items });
        if (!reqWithSameNameExists) {
          const fullName = path.join(currentItem.pathname, resolvedFilename);
          const { ipcRenderer } = window;
          ipcRenderer
            .invoke('renderer:new-request', fullName, item)
            .then(() => {
              // task middleware will track this and open the new request in a new tab once request is created
              dispatch(
                insertTaskIntoQueue({
                  uid: uuid(),
                  type: 'OPEN_REQUEST',
                  collectionUid,
                  itemPathname: fullName
                })
              );
              resolve();
            })
            .catch(reject);
        } else {
          return reject(new Error('Duplicate request names are not allowed under the same folder'));
        }
      }
    }
  });
};

export const newGrpcRequest = (params) => (dispatch, getState) => {
  const { requestName, filename, requestUrl, collectionUid, body, auth, headers, itemUid, isTransient = false } = params;

  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    // Get temp directory if isTransient is true
    const tempDirectory = isTransient ? state.collections.tempDirectories?.[collectionUid] : null;

    // do we need to handle query, path params for grpc requests?
    // skipping for now

    const item = {
      uid: uuid(),
      name: requestName,
      filename,
      type: 'grpc-request',
      isTransient: isTransient,
      headers: headers ?? [],
      request: {
        url: requestUrl,
        body: body ?? {
          mode: 'grpc',
          grpc: [
            {
              name: 'message 1',
              content: '{}'
            }
          ]
        },
        auth: auth ?? {
          mode: 'inherit'
        },
        vars: {
          req: [],
          res: []
        },
        script: {
          req: null,
          res: null
        },
        assertions: [],
        tests: null
      }
    };

    // itemUid is null when we are creating a new request at the root level
    // For transient requests, itemUid is always null
    const resolvedFilename = resolveRequestFilename(filename, collection.format);

    if (isTransient) {
      // Transient requests are always created in temp directory
      // Check for duplicates only among other transient requests
      const allItems = flattenItems(collection.items);
      const transientRequests = filter(
        allItems,
        (i) => isItemARequest(i) && i.pathname && i.pathname.startsWith(tempDirectory)
      );

      const items = filter(collection.items, (i) => isItemAFolder(i) || isItemARequest(i));
      item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: collection?.pathname, fallbackItems: items });

      createTransientRequestFile({
        collection,
        collectionUid,
        dispatch,
        item,
        requestName,
        tempDirectory,
        transientRequests
      }).then(resolve).catch(reject);
    } else {
      // Regular request (can be at root or in a folder)
      const parentItem = itemUid ? findItemInCollection(collection, itemUid) : collection;

      if (!parentItem) {
        return reject(new Error('Parent item not found'));
      }

      const reqWithSameNameExists = find(
        parentItem.items,
        (i) => i.type !== 'folder' && trim(i.filename) === trim(resolvedFilename)
      );

      if (reqWithSameNameExists) {
        return reject(new Error('Duplicate request names are not allowed under the same folder'));
      }

      const items = filter(parentItem.items, (i) => isItemAFolder(i) || isItemARequest(i));
      item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: parentItem?.pathname, fallbackItems: items });
      const fullName = path.join(parentItem.pathname, resolvedFilename);
      const { ipcRenderer } = window;
      ipcRenderer
        .invoke('renderer:new-request', fullName, item)
        .then(() => {
          // task middleware will track this and open the new request in a new tab once request is created
          dispatch(
            insertTaskIntoQueue({
              uid: uuid(),
              type: 'OPEN_REQUEST',
              collectionUid,
              itemPathname: fullName
            })
          );
          resolve();
        })
        .catch(reject);
    }
  });
};

export const newWsRequest = (params) => (dispatch, getState) => {
  const { requestName, requestMethod, filename, requestUrl, collectionUid, body, auth, headers, itemUid, isTransient = false } = params;

  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    // Get temp directory if isTransient is true
    const tempDirectory = isTransient ? state.collections.tempDirectories?.[collectionUid] : null;

    const item = {
      uid: uuid(),
      name: requestName,
      filename,
      type: 'ws-request',
      isTransient: isTransient,
      headers: headers ?? [],
      request: {
        url: requestUrl,
        method: requestMethod,
        params: [],
        body: body ?? {
          mode: 'ws',
          ws: [
            {
              uid: uuid(),
              name: 'message 1',
              type: 'json',
              content: '{}'
            }
          ]
        },
        auth: auth ?? {
          mode: 'inherit'
        },
        vars: {
          req: [],
          res: []
        },
        script: {
          req: null,
          res: null
        },
        assertions: [],
        tests: null
      }
    };

    // itemUid is null when we are creating a new request at the root level
    // For transient requests, itemUid is always null
    const resolvedFilename = resolveRequestFilename(filename, collection.format);

    if (isTransient) {
      // Transient requests are always created in temp directory
      // Check for duplicates only among other transient requests
      const allItems = flattenItems(collection.items);
      const transientRequests = filter(
        allItems,
        (i) => isItemARequest(i) && i.pathname && i.pathname.startsWith(tempDirectory)
      );

      const items = filter(collection.items, (i) => isItemAFolder(i) || isItemARequest(i));
      item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: collection?.pathname, fallbackItems: items });

      createTransientRequestFile({
        collection,
        collectionUid,
        dispatch,
        item,
        requestName,
        tempDirectory,
        transientRequests
      }).then(resolve).catch(reject);
    } else {
      // Regular request (can be at root or in a folder)
      const parentItem = itemUid ? findItemInCollection(collection, itemUid) : collection;

      if (!parentItem) {
        return reject(new Error('Parent item not found'));
      }

      const reqWithSameNameExists = find(
        parentItem.items,
        (i) => i.type !== 'folder' && trim(i.filename) === trim(resolvedFilename)
      );

      if (reqWithSameNameExists) {
        return reject(new Error('Duplicate request names are not allowed under the same folder'));
      }

      const items = filter(parentItem.items, (i) => isItemAFolder(i) || isItemARequest(i));
      item.seq = nextSiblingSeq({ state, collectionUid, parentPathname: parentItem?.pathname, fallbackItems: items });
      const fullName = path.join(parentItem.pathname, resolvedFilename);
      const { ipcRenderer } = window;
      ipcRenderer
        .invoke('renderer:new-request', fullName, item)
        .then(() => {
          // task middleware will track this and open the new request in a new tab once request is created
          dispatch(
            insertTaskIntoQueue({
              uid: uuid(),
              type: 'OPEN_REQUEST',
              collectionUid,
              itemPathname: fullName
            })
          );
          resolve();
        })
        .catch(reject);
    }
  });
};

export const loadGrpcMethodsFromReflection = (item, collectionUid, url) => async (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;

  return new Promise(async (resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const itemCopy = cloneDeep(item);
    const requestItem = itemCopy.draft ? itemCopy.draft : itemCopy;
    requestItem.request.url = url;
    const collectionCopy = cloneDeep(collection);
    const globalEnvironmentVariables = getGlobalEnvironmentVariables({
      globalEnvironments,
      activeGlobalEnvironmentUid
    });
    collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;
    const environment = findEnvironmentInCollection(collectionCopy, collectionCopy.activeEnvironmentUid);
    const runtimeVariables = collectionCopy.runtimeVariables;

    try {
      const promptVariables = await extractPromptVariablesForRequest(itemCopy, collectionCopy);
      if (promptVariables) {
        collectionCopy.promptVariables = promptVariables;
      }
    } catch (error) {
      if (error === 'cancelled') {
        return resolve(); // Resolve without error if user cancels prompt
      }
      return reject(error);
    }

    const { ipcRenderer } = window;
    ipcRenderer
      .invoke('grpc:load-methods-reflection', {
        request: requestItem,
        collection: collectionCopy,
        environment,
        runtimeVariables
      })
      .then(resolve)
      .catch(reject);
  });
};

export const generateGrpcurlCommand = (item, collectionUid) => async (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const itemCopy = cloneDeep(item);
    const collectionCopy = cloneDeep(collection);

    const globalEnvironmentVariables = getGlobalEnvironmentVariables({
      globalEnvironments,
      activeGlobalEnvironmentUid
    });
    collectionCopy.globalEnvironmentVariables = globalEnvironmentVariables;
    const environment = findEnvironmentInCollection(collectionCopy, collectionCopy.activeEnvironmentUid);
    const runtimeVariables = collectionCopy.runtimeVariables;

    const { ipcRenderer } = window;
    ipcRenderer
      .invoke('grpc:generate-grpcurl', { request: itemCopy, collection: collectionCopy, environment, runtimeVariables })
      .then(resolve)
      .catch(reject);
  });
};

export const addEnvironment = (name, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const { ipcRenderer } = window;
    ipcRenderer
      .invoke('renderer:create-environment', collection.pathname, name)
      .then(
        dispatch(
          updateLastAction({
            collectionUid,
            lastAction: {
              type: 'ADD_ENVIRONMENT',
              payload: name
            }
          })
        )
      )
      .then(resolve)
      .catch(reject);
  });
};

export const importEnvironment = ({ name, variables, color, collectionUid }) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const sanitizedName = sanitizeName(name);

    const { ipcRenderer } = window;
    ipcRenderer
      .invoke('renderer:create-environment', collection.pathname, sanitizedName, variables, color)
      .then(
        dispatch(
          updateLastAction({
            collectionUid,
            lastAction: {
              type: 'ADD_ENVIRONMENT',
              payload: sanitizedName
            }
          })
        )
      )
      .then(resolve)
      .catch(reject);
  });
};

export const copyEnvironment = (name, baseEnvUid, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const baseEnv = findEnvironmentInCollection(collection, baseEnvUid);
    if (!collection) {
      return reject(new Error('Environment not found'));
    }

    const sanitizedName = sanitizeName(name);

    const { ipcRenderer } = window;

    // strip "ephemeral" metadata
    const variablesToCopy = (baseEnv.variables || [])
      .filter((v) => !v.ephemeral)
      .map(({ ephemeral, ...rest }) => {
        return rest;
      });

    ipcRenderer
      .invoke('renderer:create-environment', collection.pathname, sanitizedName, variablesToCopy)
      .then(
        dispatch(
          updateLastAction({
            collectionUid,
            lastAction: {
              type: 'ADD_ENVIRONMENT',
              payload: sanitizedName
            }
          })
        )
      )
      .then(resolve)
      .catch(reject);
  });
};

export const renameEnvironment = (newName, environmentUid, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);
    const environment = findEnvironmentInCollection(collectionCopy, environmentUid);
    if (!environment) {
      return reject(new Error('Environment not found'));
    }

    const sanitizedName = sanitizeName(newName);
    const oldName = environment.name;
    environment.name = sanitizedName;

    const { ipcRenderer } = window;
    environmentSchema
      .validate(environment)
      .then(() => ipcRenderer.invoke('renderer:rename-environment', collection.pathname, oldName, sanitizedName))
      .then(resolve)
      .catch(reject);
  });
};

export const deleteEnvironment = (environmentUid, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);

    const environment = findEnvironmentInCollection(collectionCopy, environmentUid);
    if (!environment) {
      return reject(new Error('Environment not found'));
    }

    const { ipcRenderer } = window;
    ipcRenderer
      .invoke('renderer:delete-environment', collection.pathname, environment.name)
      .then(resolve)
      .catch(reject);
  });
};

export const saveEnvironment = (variables, environmentUid, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);
    const environment = findEnvironmentInCollection(collectionCopy, environmentUid);
    if (!environment) {
      return reject(new Error('Environment not found'));
    }

    /*
     Modal Save writes what the user sees:
     - Non-ephemeral vars are saved as-is (without metadata)
     - Ephemeral vars:
       - if persistedValue exists, save that (explicit persisted case)
       - otherwise save the current UI value (treat as user-authored)
     */
    const persisted = buildPersistedEnvVariables(variables, { mode: 'save' });
    environment.variables = persisted;

    const { ipcRenderer } = window;
    const envForValidation = cloneDeep(environment);

    environmentSchema
      .validate(environment)
      .then(() => ipcRenderer.invoke('renderer:save-environment', collection.pathname, envForValidation))
      .then(() => {
        // Immediately sync Redux to the saved (persisted) set so old ephemerals
        // aren’t around when the watcher event arrives.
        dispatch(_saveEnvironment({ variables: persisted, environmentUid, collectionUid }));
      })
      .then(resolve)
      .catch(reject);
  });
};

export const updateEnvironmentColor = (environmentUid, color, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);
    const environment = findEnvironmentInCollection(collectionCopy, environmentUid);
    if (!environment) {
      return reject(new Error('Environment not found'));
    }

    environment.color = color;
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:update-environment-color', collection.pathname, environment.name, color)
      .then(() => {
        dispatch(_updateEnvironmentColor({ environmentUid, color, collectionUid }));
        resolve();
      })
      .catch(reject);
  });
};

/**
 * Update a variable value directly in the file without affecting draft state
 * @param {string} pathname - File path
 * @param {Object} variable - Variable object with uid, name, value, type, enabled
 * @param {string} scopeType - Type of scope ('request', 'folder', 'collection')
 * @param {string} collectionUid - Collection UID
 * @param {string} itemUid - Item/Folder UID (for request/folder)
 */
const updateVariableInFile = (pathname, variable, scopeType, collectionUid, itemUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);

    ipcRenderer
      .invoke('renderer:update-variable-in-file', pathname, variable, scopeType, collectionCopy.root, collectionCopy.format)
      .then(() => {
        // Update Redux state to reflect the change
        if (scopeType === 'request') {
          dispatch({
            type: 'collections/updateRequestVarValue',
            payload: { collectionUid, itemUid, variable }
          });
        } else if (scopeType === 'folder') {
          dispatch({
            type: 'collections/updateFolderVarValue',
            payload: { collectionUid, folderUid: itemUid, variable }
          });
        } else if (scopeType === 'collection') {
          dispatch({
            type: 'collections/updateCollectionVarValue',
            payload: { collectionUid, variable }
          });
        }

        resolve();
      })
      .catch(reject);
  });
};

/**
 * Helper: Execute update action with toast notification
 * @param {Function} action - The action to dispatch
 * @param {string} successMessage - Success toast message
 * @returns {Promise}
 */
const executeVariableUpdate = (dispatch, action, successMessage) => {
  return dispatch(action)
    .then(() => {
      toast.success(successMessage);
    });
};

/**
 * Update a variable value in its detected scope (inline editing)
 * @param {string} variableName - Name of the variable to update
 * @param {string} newValue - New value for the variable
 * @param {Object} scopeInfo - Scope information from getVariableScope()
 * @param {string} collectionUid - Collection UID
 */
export const updateVariableInScope = (variableName, newValue, scopeInfo, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    if (!scopeInfo || !variableName) {
      return reject(new Error('Invalid scope information or variable name'));
    }

    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    try {
      const { type, data } = scopeInfo;

      // Handle read-only variables early
      if (type === 'process.env') {
        toast.error('Process environment variables cannot be edited');
        return reject(new Error('Process environment variables are read-only'));
      }

      if (type === 'runtime' || (collection && collection.runtimeVariables && collection.runtimeVariables[variableName])) {
        toast.error('Runtime variables are set by scripts and cannot be edited');
        return reject(new Error('Runtime variables are read-only'));
      }

      // Validate collection for non-global scopes
      if (type !== 'global' && !collection) {
        return reject(new Error('Collection not found'));
      }

      switch (type) {
        case 'environment': {
          const { environment, variable } = data;

          if (!variable) {
            return reject(new Error('Variable not found'));
          }

          const updatedVariables = environment.variables.map((v) => {
            if (v.uid === variable.uid) {
              // Clear ephemeral metadata when user manually edits the value
              const { ephemeral, persistedValue, ...rest } = v;
              return { ...rest, value: newValue };
            }
            return v;
          });

          return dispatch(saveEnvironment(updatedVariables, environment.uid, collectionUid))
            .then(() => {
              toast.success(`Variable "${variableName}" updated`);
            })
            .then(resolve)
            .catch(reject);
        }

        case 'collection': {
          const { variable } = data;

          if (variable) {
            // Update existing variable in draft
            dispatch(updateCollectionVar({
              collectionUid,
              type: 'request',
              var: { ...variable, value: newValue }
            }));
          } else {
            // Create new variable in draft with actual values
            dispatch(addCollectionVar({
              collectionUid,
              type: 'request',
              var: { name: variableName, value: newValue, enabled: true }
            }));
          }

          // Save collection root to persist the changes
          return dispatch(saveCollectionRoot(collectionUid))
            .then(resolve)
            .catch(reject);
        }

        case 'folder': {
          const { folder, variable } = data;

          if (variable) {
            // Update existing variable in draft
            dispatch(updateFolderVar({
              collectionUid,
              folderUid: folder.uid,
              type: 'request',
              var: { ...variable, value: newValue }
            }));
          } else {
            // Create new variable in draft with actual values
            dispatch(addFolderVar({
              collectionUid,
              folderUid: folder.uid,
              type: 'request',
              var: { name: variableName, value: newValue, enabled: true }
            }));
          }

          // Save folder root to persist the changes
          return dispatch(saveFolderRoot(collectionUid, folder.uid))
            .then(resolve)
            .catch(reject);
        }

        case 'request': {
          const { item, variable } = data;

          if (variable) {
            // Update existing variable in draft
            dispatch(updateVar({
              collectionUid,
              itemUid: item.uid,
              type: 'request',
              var: { ...variable, value: newValue }
            }));
          } else {
            // Create new variable in draft with actual values
            dispatch(addVar({
              collectionUid,
              itemUid: item.uid,
              type: 'request',
              var: { name: variableName, value: newValue, local: false, enabled: true }
            }));
          }

          // Save request to persist the changes
          return dispatch(saveRequest(item.uid, collectionUid, true))
            .then(resolve)
            .catch(reject);
        }

        case 'global': {
          const globalEnvironments = state.globalEnvironments?.globalEnvironments || [];
          const activeGlobalEnvUid = state.globalEnvironments?.activeGlobalEnvironmentUid;

          if (!activeGlobalEnvUid) {
            return reject(new Error('No active global environment'));
          }

          const environment = globalEnvironments.find((env) => env.uid === activeGlobalEnvUid);

          if (!environment) {
            return reject(new Error('Global environment not found'));
          }

          const variable = environment.variables.find((v) => v.name === variableName && v.enabled);

          if (!variable) {
            return reject(new Error('Variable not found'));
          }

          const updatedVariables = environment.variables.map((v) => {
            if (v.uid === variable.uid) {
              // Clear ephemeral metadata when user manually edits the value
              const { ephemeral, persistedValue, ...rest } = v;
              return { ...rest, value: newValue };
            }
            return v;
          });

          return dispatch(saveGlobalEnvironment({ variables: updatedVariables, environmentUid: activeGlobalEnvUid }))
            .then(() => {
              toast.success(`Variable "${variableName}" updated`);
            })
            .then(resolve)
            .catch(reject);
        }
        case 'pathParam': {
          const { item } = data;
          const params = item.draft ? get(item, 'draft.request.params', []) : get(item, 'request.params', []);
          const pathParam = params.find((p) => p.type === 'path' && p.name === variableName);

          if (pathParam) {
            const updatedParam = { ...pathParam, value: newValue };
            dispatch(updatePathParam({
              pathParam: updatedParam,
              itemUid: item.uid,
              collectionUid: collection.uid
            }));
          }
          return dispatch(saveRequest(item.uid, collection.uid, true))
            .then(resolve)
            .catch(reject);
        }
        default:
          return reject(new Error(`Unknown scope type: ${type}`));
      }
    } catch (error) {
      toast.error(`Failed to update variable: ${error.message}`);
      reject(error);
    }
  });
};

export const mergeAndPersistEnvironment
  = ({ persistentEnvVariables, collectionUid }) =>
    (_dispatch, getState) => {
      return new Promise((resolve, reject) => {
        const state = getState();
        const collection = findCollectionByUid(state.collections.collections, collectionUid);

        if (!collection) {
          return reject(new Error('Collection not found'));
        }

        const environmentUid = collection.activeEnvironmentUid;
        if (!environmentUid) {
          return reject(new Error('No active environment found'));
        }

        const collectionCopy = cloneDeep(collection);
        const environment = findEnvironmentInCollection(collectionCopy, environmentUid);
        if (!environment) {
          return reject(new Error('Environment not found'));
        }

        // Only proceed if there are persistent variables to save
        if (!persistentEnvVariables || Object.keys(persistentEnvVariables).length === 0) {
          return resolve();
        }

        let existingVars = environment.variables || [];

        let normalizedNewVars = Object.entries(persistentEnvVariables).map(([name, value]) => ({
          uid: uuid(),
          name,
          value,
          type: 'text',
          enabled: true,
          secret: false
        }));

        const merged = existingVars.map((v) => {
          const found = normalizedNewVars.find((nv) => nv.name === v.name);
          if (found) {
            return { ...v, value: found.value };
          }
          return v;
        });
        normalizedNewVars.forEach((nv) => {
          if (!merged.some((v) => v.name === nv.name)) {
            merged.push(nv);
          }
        });

        // Save all non-ephemeral vars and all variables that were previously persisted
        const persistedNames = new Set(Object.keys(persistentEnvVariables));

        // Add all existing non-ephemeral variables to persistedNames so they are preserved
        existingVars.forEach((v) => {
          if (!v.ephemeral) {
            persistedNames.add(v.name);
          }
        });

        const environmentToSave = cloneDeep(environment);
        environmentToSave.variables = buildPersistedEnvVariables(merged, { mode: 'merge', persistedNames });

        const { ipcRenderer } = window;
        environmentSchema
          .validate(environmentToSave)
          .then(() => ipcRenderer.invoke('renderer:save-environment', collection.pathname, environmentToSave))
          .then(resolve)
          .catch(reject);
      });
    };

export const selectEnvironment = (environmentUid, collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);

    const environmentName = environmentUid ? findEnvironmentInCollection(collectionCopy, environmentUid)?.name : null;

    if (environmentUid && !environmentName) {
      return reject(new Error('Environment not found'));
    }

    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:update-ui-state-snapshot', {
      type: 'COLLECTION_ENVIRONMENT',
      data: { collectionPath: collection?.pathname, environmentName }
    });

    dispatch(_selectEnvironment({ environmentUid, collectionUid }));
    resolve();
  });
};

export const removeCollection = (collectionUid) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }
    const { ipcRenderer } = window;

    // Get active workspace to determine which workspace we're removing from
    const { workspaces } = state;
    const activeWorkspace = workspaces.workspaces.find((w) => w.uid === workspaces.activeWorkspaceUid);

    if (!activeWorkspace?.pathname) {
      return reject(new Error('An active workspace is required.'));
    }

    ipcRenderer
      .invoke('renderer:remove-collection', collection.pathname, collectionUid, activeWorkspace.pathname)
      .then(() => {
        // Check if the collection still exists in other workspaces
        return ipcRenderer.invoke('renderer:get-collection-workspaces', collection.pathname);
      })
      .then((remainingWorkspaces) => {
        // Close tabs for this collection
        dispatch(closeAllCollectionTabs({ collectionUid }));

        // Remove collection from workspace in Redux state
        if (activeWorkspace) {
          dispatch(removeCollectionFromWorkspace({
            workspaceUid: activeWorkspace.uid,
            collectionLocation: collection.pathname
          }));
        }

        dispatch(ensureActiveTabInCurrentWorkspace());

        // Only remove from Redux if no workspaces remain
        if (!remainingWorkspaces || remainingWorkspaces.length === 0) {
          return waitForNextTick().then(() => {
            dispatch(_removeCollection({
              collectionUid: collectionUid
            }));
          });
        } else {
          // Collection still exists in other workspaces
        }
      })
      .then(resolve)
      .catch(reject);
  });
};

export const browseDirectory = () => (dispatch, getState) => {
  const { ipcRenderer } = window;

  return new Promise((resolve, reject) => {
    ipcRenderer.invoke('renderer:browse-directory').then(resolve).catch(reject);
  });
};

export const browseFiles = (filters, properties) => (_dispatch, _getState) => {
  const { ipcRenderer } = window;

  return new Promise((resolve, reject) => {
    ipcRenderer.invoke('renderer:browse-files', filters, properties).then(resolve).catch(reject);
  });
};

export const saveCollectionSettings = (collectionUid, brunoConfig = null, silent = false) => (dispatch, getState) => {
  const state = getState();
  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const collectionCopy = cloneDeep(collection);

    // Transform collection root (uses draft if exists)
    const collectionRootToSave = transformCollectionRootToSave(collectionCopy);
    const { ipcRenderer } = window;

    const savePromises = [];

    // Save collection.bru file
    savePromises.push(ipcRenderer.invoke('renderer:save-collection-root', collectionCopy.pathname, collectionRootToSave, collectionCopy.brunoConfig));

    // Save bruno.json if brunoConfig is provided or if there's a brunoConfig draft
    const brunoConfigToSave = brunoConfig || (collectionCopy.draft && collectionCopy.draft.brunoConfig);
    if (brunoConfigToSave) {
      savePromises.push(ipcRenderer.invoke('renderer:update-bruno-config', brunoConfigToSave, collectionCopy.pathname, collectionCopy.root));
    }

    Promise.all(savePromises)
      .then(() => {
        if (!silent) {
          toast.success('Collection Settings saved successfully');
        }
        dispatch(saveCollectionDraft({ collectionUid }));
      })
      .then(resolve)
      .catch((err) => {
        toast.error('Failed to save collection settings!');
        reject(err);
      });
  });
};

export const updateBrunoConfig = (brunoConfig, collectionUid) => (dispatch, getState) => {
  const state = getState();

  const collection = findCollectionByUid(state.collections.collections, collectionUid);

  return new Promise((resolve, reject) => {
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    const { ipcRenderer } = window;
    ipcRenderer
      .invoke('renderer:update-bruno-config', brunoConfig, collection.pathname, collection.root)
      .then(resolve)
      .catch(reject);
  });
};

/**
 * Opens a scratch collection and creates it in Redux state.
 * This is a simplified version of openCollectionEvent for scratch collections,
 * without workspace management, toasts, or sidebar toggles.
 *
 * @param {string} uid - The unique identifier for the scratch collection
 * @param {string} pathname - The filesystem path to the scratch collection
 * @param {Object} brunoConfig - The Bruno configuration object for the collection
 * @returns {Promise} Resolves when the collection is created, rejects on error
 */
export const openScratchCollectionEvent = (uid, pathname, brunoConfig) => (dispatch, getState) => {
  const { ipcRenderer } = window;

  return new Promise((resolve, reject) => {
    const state = getState();
    const existingCollection = state.collections.collections.find(
      (c) => normalizePath(c.pathname) === normalizePath(pathname)
    );

    if (existingCollection) {
      resolve();
      return;
    }

    const collection = {
      version: '1',
      uid,
      name: brunoConfig.name,
      pathname,
      items: [],
      runtimeVariables: {},
      brunoConfig
    };

    ipcRenderer
      .invoke('renderer:get-collection-security-config', pathname)
      .then((securityConfig) => {
        collectionSchema
          .validate(collection)
          .then(() => dispatch(_createCollection({ ...collection, securityConfig })))
          .then(resolve)
          .catch(reject);
      })
      .catch(reject);
  });
};

export const openCollectionEvent = (uid, pathname, brunoConfig, sourceWorkspacePath) => (dispatch, getState) => {
  const { ipcRenderer } = window;

  return new Promise((resolve, reject) => {
    const state = getState();
    const activeWorkspace = state.workspaces.workspaces.find((w) => w.uid === state.workspaces.activeWorkspaceUid);
    const sourceWorkspace = sourceWorkspacePath
      ? state.workspaces.workspaces.find((w) => w.pathname && normalizePath(w.pathname) === normalizePath(sourceWorkspacePath))
      : null;
    const targetWorkspace = sourceWorkspacePath ? sourceWorkspace : activeWorkspace;
    if (!targetWorkspace) {
      resolve();
      return;
    }
    const isActiveWorkspaceTarget = targetWorkspace?.uid === activeWorkspace?.uid;
    const workspaceProcessEnvVariables = targetWorkspace?.processEnvVariables || {};

    const existingCollection = state.collections.collections.find(
      (c) => normalizePath(c.pathname) === normalizePath(pathname)
    );

    const isAlreadyInWorkspace = targetWorkspace?.collections?.some(
      (c) => normalizePath(c.path) === normalizePath(pathname)
    );

    if (existingCollection && isAlreadyInWorkspace) {
      if (isActiveWorkspaceTarget) {
        toast.success('Collection is already opened');
      }
      resolve();
      return;
    }

    if (existingCollection) {
      if (isActiveWorkspaceTarget && state.app.sidebarCollapsed) {
        dispatch(toggleSidebarCollapse());
      }

      if (targetWorkspace) {
        const workspaceCollection = {
          name: brunoConfig.name,
          path: pathname
        };

        ipcRenderer
          .invoke('renderer:add-collection-to-workspace', targetWorkspace.pathname, workspaceCollection)
          .then(() => {
            if (isActiveWorkspaceTarget) {
              toast.success('Collection added to workspace');
            }
          })
          .catch((err) => {
            console.error('Failed to add collection to workspace', err);
            if (isActiveWorkspaceTarget) {
              toast.error('Failed to add collection to workspace');
            }
          });
      }

      if (isActiveWorkspaceTarget) {
        dispatch(workspaceEnvUpdateEvent({ processEnvVariables: workspaceProcessEnvVariables }));
      }

      resolve();
      return;
    }

    const collection = {
      version: '1',
      uid: uid,
      name: brunoConfig.name,
      pathname: pathname,
      items: [],
      runtimeVariables: {},
      workspaceProcessEnvVariables,
      brunoConfig: brunoConfig
    };

    ipcRenderer.invoke('renderer:get-collection-security-config', pathname).then((securityConfig) => {
      collectionSchema
        .validate(collection)
        .then(() => dispatch(_createCollection({ ...collection, securityConfig })))
        .then(() => {
          const currentState = getState();
          const currentActiveWorkspace = currentState.workspaces.workspaces.find(
            (w) => w.uid === currentState.workspaces.activeWorkspaceUid
          );
          const currentTargetWorkspace = sourceWorkspacePath
            ? currentState.workspaces.workspaces.find((w) => w.pathname && normalizePath(w.pathname) === normalizePath(sourceWorkspacePath))
            : currentActiveWorkspace;
          if (!currentTargetWorkspace) {
            resolve();
            return;
          }
          const isCurrentActiveWorkspaceTarget = currentTargetWorkspace?.uid === currentActiveWorkspace?.uid;

          if (isCurrentActiveWorkspaceTarget && currentState.app.sidebarCollapsed) {
            dispatch(toggleSidebarCollapse());
          }

          if (currentTargetWorkspace) {
            ipcRenderer.invoke('renderer:set-collection-workspace', uid, currentTargetWorkspace.pathname);

            const alreadyInWorkspace = currentTargetWorkspace.collections?.some(
              (c) => normalizePath(c.path) === normalizePath(pathname)
            );

            if (!alreadyInWorkspace) {
              const workspaceCollection = {
                name: brunoConfig.name,
                path: pathname
              };

              ipcRenderer
                .invoke('renderer:add-collection-to-workspace', currentTargetWorkspace.pathname, workspaceCollection)
                .catch((err) => {
                  console.error('Failed to add collection to workspace', err);
                  if (isCurrentActiveWorkspaceTarget) {
                    toast.error('Failed to add collection to workspace');
                  }
                });
            }
          }

          resolve();
        })
        .catch(reject);
    });
  });
};

export const createCollection = (collectionName, collectionFolderName, collectionLocation, options = {}) => (dispatch, getState) => {
  const { ipcRenderer } = window;

  if (!options.workspaceId) {
    const { workspaces } = getState();
    const activeWorkspace = workspaces.workspaces.find((w) => w.uid === workspaces.activeWorkspaceUid);

    if (activeWorkspace && activeWorkspace.pathname) {
      options.workspaceId = activeWorkspace.pathname;
    } else {
      throw new Error('An active workspace is required.');
    }
  }

  collectionLocation = path.join(options.workspaceId, 'collections');

  return new Promise((resolve, reject) => {
    ipcRenderer
      .invoke('renderer:create-collection', collectionName, collectionFolderName, collectionLocation, options)
      .then(resolve)
      .catch(reject);
  });
};
export const cloneCollection = (collectionName, collectionFolderName, collectionLocation, previousPath) => () => {
  const { ipcRenderer } = window;

  return ipcRenderer.invoke(
    'renderer:clone-collection',
    collectionName,
    collectionFolderName,
    collectionLocation,
    previousPath
  );
};
export const openCollection = (options = {}) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    const state = getState();
    const activeWorkspace = state.workspaces.workspaces.find((w) => w.uid === state.workspaces.activeWorkspaceUid);

    if (!options.workspaceId) {
      if (!activeWorkspace?.pathname) {
        return reject(new Error('An active workspace is required.'));
      }
      options.workspaceId = activeWorkspace.pathname;
    }

    ipcRenderer.invoke('renderer:open-collection', options)
      .then((result) => {
        resolve(result);
      })
      .catch(reject);
  });
};

export const openMultipleCollections = (collectionPaths, options = {}) => () => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;

    ipcRenderer.invoke('renderer:open-multiple-collections', collectionPaths, options)
      .then(resolve)
      .catch((err) => {
        reject();
      });
  });
};

export const collectionAddEnvFileEvent = (payload) => (dispatch, getState) => {
  const { data: environment, meta } = payload;

  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, meta.collectionUid);
    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    environmentSchema
      .validate(environment)
      .then(() =>
        dispatch(
          _collectionAddEnvFileEvent({
            environment,
            collectionUid: meta.collectionUid
          })
        )
      )
      .then(resolve)
      .catch(reject);
  });
};

export const importCollection = (collection, collectionLocation, options = {}) => (dispatch, getState) => {
  return new Promise(async (resolve, reject) => {
    const { ipcRenderer } = window;

    try {
      const state = getState();
      const activeWorkspace = state.workspaces.workspaces.find((w) => w.uid === state.workspaces.activeWorkspaceUid);
      const isMultiple = Array.isArray(collection);

      if (!activeWorkspace?.pathname) {
        throw new Error('An active workspace is required.');
      }
      collectionLocation = path.join(activeWorkspace.pathname, 'collections');

      const result = await ipcRenderer.invoke('renderer:import-collection', collection, collectionLocation, {
        workspaceId: activeWorkspace.pathname,
        format: options.format || DEFAULT_COLLECTION_FORMAT,
        rawOpenAPISpec: options.rawOpenAPISpec
      });
      const importedPaths = result.success.items;

      if (importedPaths.length > 0 && activeWorkspace && activeWorkspace.pathname) {
        for (const importedItem of importedPaths) {
          const workspaceCollection = {
            name: importedItem.name,
            path: importedItem.path
          };
          await ipcRenderer.invoke('renderer:add-collection-to-workspace', activeWorkspace.pathname, workspaceCollection);
        }
      }

      resolve(isMultiple ? importedPaths : importedPaths[0]);
    } catch (error) {
      reject(error);
    }
  });
};

export const importCollectionFromZip = (zipFilePath, collectionLocation) => async (dispatch, getState) => {
  const { ipcRenderer } = window;
  const state = getState();
  const activeWorkspace = state.workspaces.workspaces.find((w) => w.uid === state.workspaces.activeWorkspaceUid);

  if (!activeWorkspace?.pathname) {
    throw new Error('An active workspace is required.');
  }
  collectionLocation = path.join(activeWorkspace.pathname, 'collections');

  const collectionPath = await ipcRenderer.invoke('renderer:import-collection-zip', zipFilePath, collectionLocation, {
    workspaceId: activeWorkspace.pathname
  });

  if (activeWorkspace && activeWorkspace.pathname) {
    const collectionName = path.basename(collectionPath);
    await ipcRenderer.invoke('renderer:add-collection-to-workspace', activeWorkspace.pathname, {
      name: collectionName,
      path: collectionPath
    });
  }

  return collectionPath;
};

/**
 * Updates Redux collection order and persists it to the active workspace's workspace.yml.
 */
export const moveCollectionAndPersist
  = ({ draggedItem, targetItem }) =>
    (dispatch, getState) => {
      const state = getState();
      const activeWorkspace = state.workspaces.workspaces.find(
        (w) => w.uid === state.workspaces.activeWorkspaceUid
      );
      if (!activeWorkspace?.pathname || !activeWorkspace.collections?.length) {
        return Promise.resolve();
      }

      const workspacePathSet = new Set(
        activeWorkspace.collections.map((wc) => normalizePath(wc.path))
      );
      const collectionsInWorkspace = state.collections.collections
        .filter((c) => workspacePathSet.has(normalizePath(c.pathname)));
      if (collectionsInWorkspace.length === 0) {
        return Promise.resolve();
      }

      const reordered = collectionsInWorkspace.filter((i) => i.uid !== draggedItem.uid);
      const targetIndex = reordered.findIndex((i) => i.uid === targetItem.uid);
      reordered.splice(targetIndex, 0, draggedItem);
      const collectionPaths = reordered.map((c) => c.pathname);

      return window.ipcRenderer
        .invoke('renderer:reorder-workspace-collections', activeWorkspace.pathname, collectionPaths)
        .then(() => {
          dispatch(moveCollection({ draggedItem, targetItem }));
        })
        .catch((err) => {
          console.error('Failed to reorder workspace collections', err);
          return Promise.reject(err);
        });
    };

export const saveCollectionSecurityConfig = (collectionUid, securityConfig) => (dispatch, getState) => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    ipcRenderer
      .invoke('renderer:save-collection-security-config', collection?.pathname, securityConfig)
      .then(async () => {
        await dispatch(setCollectionSecurityConfig({ collectionUid, securityConfig }));
        resolve();
      })
      .catch(reject);
  });
};

export const hydrateCollectionWithUiStateSnapshot = (payload) => (dispatch, getState) => {
  const collectionSnapshotData = payload;
  return new Promise((resolve, reject) => {
    const state = getState();
    try {
      if (!collectionSnapshotData) {
        resolve();
        return;
      }
      const { pathname, selectedEnvironment } = collectionSnapshotData;
      const collection = findCollectionByPathname(state.collections.collections, pathname);
      const collectionCopy = cloneDeep(collection);
      const collectionUid = collectionCopy?.uid;

      // update selected environment
      if (selectedEnvironment) {
        const environment = findEnvironmentInCollectionByName(collectionCopy, selectedEnvironment);
        if (environment) {
          dispatch(_selectEnvironment({ environmentUid: environment?.uid, collectionUid }));
        }
      }

      // todo: add any other redux state that you want to save

      resolve();
    } catch (error) {
      reject(error);
    }
  });
};

export const fetchOauth2Credentials = (payload) => async (dispatch, getState) => {
  const { request, collection, itemUid, folderUid } = payload;
  const state = getState();
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
  const globalEnvironmentVariables = getGlobalEnvironmentVariables({ globalEnvironments, activeGlobalEnvironmentUid });
  request.globalEnvironmentVariables = globalEnvironmentVariables;
  return new Promise((resolve, reject) => {
    window.ipcRenderer
      .invoke('renderer:fetch-oauth2-credentials', { itemUid, request, collection })
      .then(({ credentials, url, collectionUid, credentialsId, debugInfo }) => {
        dispatch(
          collectionAddOauth2CredentialsByUrl({
            credentials,
            url,
            collectionUid,
            credentialsId,
            debugInfo: safeParseJSON(safeStringifyJSON(debugInfo)),
            folderUid: folderUid || null,
            itemUid: !folderUid ? itemUid : null
          })
        );
        resolve(credentials);
      })
      .catch(reject);
  });
};

export const refreshOauth2Credentials = (payload) => async (dispatch, getState) => {
  const { request, collection, folderUid, itemUid } = payload;
  const state = getState();
  const { globalEnvironments, activeGlobalEnvironmentUid } = state.globalEnvironments;
  const globalEnvironmentVariables = getGlobalEnvironmentVariables({ globalEnvironments, activeGlobalEnvironmentUid });
  request.globalEnvironmentVariables = globalEnvironmentVariables;
  return new Promise((resolve, reject) => {
    window.ipcRenderer
      .invoke('renderer:refresh-oauth2-credentials', { itemUid, request, collection })
      .then(({ credentials, url, collectionUid, debugInfo, credentialsId }) => {
        dispatch(
          collectionAddOauth2CredentialsByUrl({
            credentials,
            url,
            collectionUid,
            credentialsId,
            debugInfo: safeParseJSON(safeStringifyJSON(debugInfo)),
            folderUid: folderUid || null,
            itemUid: !folderUid ? itemUid : null
          })
        );
        resolve(credentials);
      })
      .catch(reject);
  });
};

export const clearOauth2Cache = (payload) => async (dispatch, getState) => {
  const { collectionUid, url, credentialsId } = payload;
  return new Promise((resolve, reject) => {
    window.ipcRenderer
      .invoke('clear-oauth2-cache', collectionUid, url, credentialsId)
      .then(() => {
        dispatch(
          collectionClearOauth2CredentialsByUrlAndCredentialsId({
            url,
            collectionUid,
            credentialsId
          })
        );
        resolve();
      })
      .catch(reject);
  });
};

export const isOauth2AuthorizationRequestInProgress = () => async () => {
  return new Promise((resolve, reject) => {
    window.ipcRenderer
      .invoke('renderer:is-oauth2-authorization-request-in-progress')
      .then(resolve)
      .catch(reject);
  });
};

export const cancelOauth2AuthorizationRequest = () => async () => {
  return new Promise((resolve, reject) => {
    window.ipcRenderer
      .invoke('renderer:cancel-oauth2-authorization-request')
      .then(resolve)
      .catch(reject);
  });
};

// todo: could be removed
export const loadRequestViaWorker
  = ({ collectionUid, pathname }) =>
    (dispatch, getState) => {
      return new Promise(async (resolve, reject) => {
        const { ipcRenderer } = window;
        ipcRenderer.invoke('renderer:load-request-via-worker', { collectionUid, pathname }).then(resolve).catch(reject);
      });
    };

// todo: could be removed
export const loadRequest
  = ({ collectionUid, pathname }) =>
    (dispatch, getState) => {
      return new Promise(async (resolve, reject) => {
        const { ipcRenderer } = window;
        ipcRenderer.invoke('renderer:load-request', { collectionUid, pathname })
          .then((file) => {
            if (file?.meta?.pathname) {
              dispatch(collectionAddFileEvent({ file }));
            }
            resolve(file);
          })
          .catch(reject);
      });
    };

export const loadLargeRequest
  = ({ collectionUid, pathname }) =>
    (dispatch, getState) => {
      return new Promise(async (resolve, reject) => {
        const { ipcRenderer } = window;
        ipcRenderer.invoke('renderer:load-large-request', { collectionUid, pathname }).then(resolve).catch(reject);
      });
    };

export const mountCollection
  = ({ collectionUid, collectionPathname, brunoConfig }) =>
    (dispatch, getState) => {
      dispatch(updateCollectionMountStatus({ collectionUid, mountStatus: 'mounting' }));
      return new Promise(async (resolve, reject) => {
        const loadSessionId = uuid();
        callIpc('renderer:mount-collection', { collectionUid, collectionPathname, brunoConfig, loadSessionId })
          .then((mountResult) => {
            const transientDirPath = typeof mountResult === 'string' ? mountResult : mountResult?.tempDirectoryPath;
            dispatch(updateCollectionMountStatus({ collectionUid, mountStatus: 'mounted' }));
            if (transientDirPath) {
              dispatch(addTransientDirectory({ collectionUid, pathname: transientDirPath }));
            }
          })
          .then(resolve)
          .catch(() => {
            dispatch(updateCollectionMountStatus({ collectionUid, mountStatus: 'unmounted' }));
            reject();
          });
      });
    };

export const showInFolder = (collectionPath) => () => {
  return new Promise((resolve, reject) => {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('renderer:show-in-folder', collectionPath).then(resolve).catch(reject);
  });
};

export const updateRunnerConfiguration
  = (collectionUid, selectedRequestItems, requestItemsOrder, delay) => (dispatch) => {
    dispatch(
      _updateRunnerConfiguration({
        collectionUid,
        selectedRequestItems,
        requestItemsOrder,
        delay
      })
    );
  };

export const updateActiveConnectionsInStore = (activeConnectionIds) => (dispatch, getState) => {
  dispatch(updateActiveConnections(activeConnectionIds));
};

export const openCollectionSettings
  = (collectionUid, tabName = 'overview') =>
    (dispatch, getState) => {
      const state = getState();
      const collection = findCollectionByUid(state.collections.collections, collectionUid);

      return new Promise((resolve, reject) => {
        if (!collection) {
          return reject(new Error('Collection not found'));
        }

        dispatch(updateSettingsSelectedTab({
          collectionUid: collection.uid,
          tab: tabName
        }));

        dispatch(addTab({
          uid: collection.uid,
          collectionUid: collection.uid,
          type: 'collection-settings'
        }));

        resolve();
      });
    };

export const saveDotEnvVariables = (collectionUid, variables, filename = '.env') => (dispatch, getState) => {
  const { ipcRenderer } = window;
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    ipcRenderer
      .invoke('renderer:save-dotenv-variables', collection.pathname, variables, filename)
      .then(resolve)
      .catch(reject);
  });
};

export const saveDotEnvRaw = (collectionUid, content, filename = '.env') => (dispatch, getState) => {
  const { ipcRenderer } = window;
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    ipcRenderer
      .invoke('renderer:save-dotenv-raw', collection.pathname, content, filename)
      .then(resolve)
      .catch(reject);
  });
};

export const createDotEnvFile = (collectionUid, filename = '.env') => (dispatch, getState) => {
  const { ipcRenderer } = window;
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    ipcRenderer
      .invoke('renderer:create-dotenv-file', collection.pathname, filename)
      .then(resolve)
      .catch(reject);
  });
};

export const deleteDotEnvFile = (collectionUid, filename = '.env') => (dispatch, getState) => {
  const { ipcRenderer } = window;
  return new Promise((resolve, reject) => {
    const state = getState();
    const collection = findCollectionByUid(state.collections.collections, collectionUid);

    if (!collection) {
      return reject(new Error('Collection not found'));
    }

    ipcRenderer
      .invoke('renderer:delete-dotenv-file', collection.pathname, filename)
      .then(resolve)
      .catch(reject);
  });
};

export const cloneGitRepository = (data) => (dispatch, getState) => {
  const { ipcRenderer } = window;
  return new Promise((resolve, reject) => {
    ipcRenderer
      .invoke('renderer:clone-git-repository', data)
      .then((res) => {
        console.log('clone done', res);
      })
      .then(resolve)
      .catch((err) => {
        toast.custom(<IpcErrorModal error={err?.message} />);
        reject();
      });
  });
};

export const scanForBrunoFiles = (dir) => (dispatch, getState) => {
  const { ipcRenderer } = window;
  return new Promise((resolve, reject) => {
    ipcRenderer
      .invoke('renderer:scan-for-bruno-files', dir)
      .then(resolve)
      .catch((err) => {
        reject();
      });
  });
};

/**
 * If the current active tab belongs to another workspace, focus a tab in the current workspace.
 */
export const ensureActiveTabInCurrentWorkspace = () => (dispatch, getState) => {
  const state = getState();
  const result = getTabToFocusForCurrentWorkspace(state);
  if (!result) {
    return; // Already in workspace, no active workspace, or unfixable (no workspace tabs and no scratch).
  }
  if (result.addOverviewFirst && result.scratchCollectionUid) {
    dispatch(addTab({
      uid: result.uid,
      collectionUid: result.scratchCollectionUid,
      type: 'workspaceOverview'
    }));
  }
  dispatch(focusTab({ uid: result.uid }));
};

/**
 * Close tabs and delete any transient request files from the filesystem.
 * This thunk wraps the closeTabs reducer to handle transient file cleanup automatically.
 * Also drops openapi-sync redux state (drift, storedSpec, tabUiState) for any
 * openapi-sync tab that's about to close — collected BEFORE the close so we can
 * still read the closing tabs' collectionUids from state.
 */
export const closeTabs = ({ tabUids }) => async (dispatch, getState) => {
  const { ipcRenderer } = window;
  const state = getState();
  const collections = state.collections.collections;
  const tempDirectories = state.collections.tempDirectories || {};

  // Find transient items and group by temp directory before closing tabs
  const transientByTempDir = {};
  each(tabUids, (tabUid) => {
    for (const collection of collections) {
      const item = findItemInCollection(collection, tabUid);
      if (item?.isTransient && item.pathname) {
        const tempDir = tempDirectories[collection.uid];
        if (tempDir) {
          if (!transientByTempDir[tempDir]) {
            transientByTempDir[tempDir] = [];
          }
          transientByTempDir[tempDir].push(item.pathname);
        }
        break;
      }
    }
  });

  const closingOpenApiSyncCollectionUids = (state.tabs?.tabs || [])
    .filter((t) => tabUids.includes(t.uid) && t.type === 'openapi-sync' && t.collectionUid)
    .map((t) => t.collectionUid);

  // Close the tabs first
  await dispatch(_closeTabs({ tabUids }));

  // Clear persisted scope AFTER unmount — otherwise useTrackScroll's cleanup flush
  // would rewrite scroll position to localStorage right after we cleared it.
  each(tabUids, (tabUid) => clearPersistedScope(tabUid));

  // After close, the reducer may have set active tab to one from another workspace. Ensure it belongs to this workspace: prefer any open in-workspace tab, then workspace overview if none.
  // Dispatch is synchronous; state is already updated by _closeTabs above.
  await dispatch(ensureActiveTabInCurrentWorkspace());

  // Drop openapi-sync per-collection state (drift, storedSpec, tabUiState) for any closed openapi-sync tabs.
  for (const collectionUid of closingOpenApiSyncCollectionUids) {
    dispatch(clearOpenApiSyncTabState({ collectionUid }));
  }

  // Delete transient files after tabs are closed
  for (const [tempDir, filePaths] of Object.entries(transientByTempDir)) {
    try {
      const results = await ipcRenderer.invoke('renderer:delete-transient-requests', filePaths, tempDir);
      if (results.errors?.length > 0) {
        console.error('Errors deleting transient files:', results.errors);
      }
    } catch (err) {
      console.error('Failed to delete transient request files:', err);
    }
  }
};

/**
 * Reopen last closed tab from the tabs slice stack and ensure active tab/workspace consistency.
 */
export const reopenClosedTab = ({ collectionUid } = {}) => async (dispatch) => {
  dispatch(reopenLastClosedTab({ collectionUid }));
  await dispatch(ensureActiveTabInCurrentWorkspace());
};
