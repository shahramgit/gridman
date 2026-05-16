const fs = require('fs');
const path = require('path');
const fsExtra = require('fs-extra');
const archiver = require('archiver');
const extractZip = require('extract-zip');
const { ipcMain, dialog } = require('electron');
const isDev = require('electron-is-dev');
const { createDirectory, sanitizeName, writeFile, DEFAULT_GITIGNORE, isValidCollectionDirectory } = require('../utils/filesystem');
const yaml = require('js-yaml');
const LastOpenedWorkspaces = require('../store/last-opened-workspaces');
const { globalEnvironmentsManager } = require('../store/workspace-environments');
const { globalEnvironmentsStore } = require('../store/global-environments');
const { resolveDefaultLocation } = require('../utils/default-location');

const {
  createWorkspaceConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  validateWorkspaceConfig,
  updateWorkspaceName,
  updateWorkspaceDocs,
  addCollectionToWorkspace,
  removeCollectionFromWorkspace,
  setCollectionGitRemote,
  clearCollectionGitRemote,
  reorderWorkspaceCollections,
  getWorkspaceCollections,
  resolveAndFilterWorkspaceCollections,
  normalizeCollectionEntry,
  isPathInsideDirectory,
  isWorkspaceCollectionPath,
  validateWorkspacePath,
  validateWorkspaceDirectory,
  getWorkspaceUid
} = require('../utils/workspace-config');

const DEFAULT_WORKSPACE_NAME = 'My Workspace';

const assertWorkspaceCollectionFolder = (workspacePath, collectionPath) => {
  const collectionsDir = path.join(workspacePath, 'collections');
  const absolutePath = path.resolve(collectionPath);
  const isInsideCollectionsDir = isPathInsideDirectory(collectionsDir, absolutePath);

  if (!isInsideCollectionsDir || !isValidCollectionDirectory(absolutePath)) {
    throw new Error('Only valid collection folders inside this workspace can be removed.');
  }

  return absolutePath;
};

const prepareWorkspaceConfigForClient = (workspaceConfig, workspacePath) => {
  const config = {
    ...workspaceConfig,
    collections: resolveAndFilterWorkspaceCollections(workspacePath, workspaceConfig.collections)
  };
  const remoteWorkspaceName = workspaceConfig.name;

  return {
    ...config,
    name: path.basename(workspacePath),
    remoteWorkspaceName
  };
};

const getWorkspaceCollectionReconciliation = (workspacePath) => {
  validateWorkspacePath(workspacePath);

  const workspaceConfig = readWorkspaceConfig(workspacePath);
  const configuredEntries = (workspaceConfig.collections || [])
    .map((collection) => {
      if (!collection?.path) return null;
      if (path.isAbsolute(collection.path)) return null;
      const absolutePath = path.resolve(workspacePath, collection.path);
      if (!isWorkspaceCollectionPath(workspacePath, absolutePath)) return null;
      return {
        name: collection.name || path.basename(absolutePath),
        path: absolutePath,
        relativePath: path.relative(workspacePath, absolutePath).replace(/\\/g, '/')
      };
    })
    .filter(Boolean);

  const configuredPaths = new Set(configuredEntries.map((entry) => path.normalize(entry.path)));
  const collectionsDir = path.join(workspacePath, 'collections');
  const collectionFolders = fs.existsSync(collectionsDir)
    ? fs.readdirSync(collectionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(collectionsDir, entry.name))
        .filter((collectionPath) => isValidCollectionDirectory(collectionPath))
    : [];

  const orphanCollections = collectionFolders
    .filter((collectionPath) => !configuredPaths.has(path.normalize(collectionPath)))
    .map((collectionPath) => ({
      name: path.basename(collectionPath),
      path: collectionPath,
      relativePath: path.relative(workspacePath, collectionPath).replace(/\\/g, '/')
    }));

  const missingCollections = configuredEntries
    .filter((entry) => !isValidCollectionDirectory(entry.path))
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath
    }));

  return {
    orphanCollections,
    missingCollections
  };
};

const ensureInitialWorkspace = async () => {
  const workspaceParent = resolveDefaultLocation();
  const workspacePath = path.join(workspaceParent, DEFAULT_WORKSPACE_NAME);
  const workspaceFilePath = path.join(workspacePath, 'workspace.yml');

  if (fs.existsSync(workspaceFilePath)) {
    validateWorkspacePath(workspacePath);
    const workspaceConfig = readWorkspaceConfig(workspacePath);
    validateWorkspaceConfig(workspaceConfig);
    return { workspacePath, workspaceConfig };
  }

  if (fs.existsSync(workspacePath)) {
    const files = fs.readdirSync(workspacePath);
    if (files.length > 0) {
      throw new Error(`workspace: ${workspacePath} already exists and is not a Gridman workspace`);
    }
  } else {
    await createDirectory(workspacePath);
  }

  await createDirectory(path.join(workspacePath, 'collections'));
  await createDirectory(path.join(workspacePath, 'environments'));

  const workspaceConfig = createWorkspaceConfig(DEFAULT_WORKSPACE_NAME);
  await writeWorkspaceConfig(workspacePath, workspaceConfig);
  await writeFile(path.join(workspacePath, '.gitignore'), DEFAULT_GITIGNORE);

  return { workspacePath, workspaceConfig };
};

const registerWorkspaceIpc = (mainWindow, workspaceWatcher) => {
  const lastOpenedWorkspaces = new LastOpenedWorkspaces();

  ipcMain.handle('renderer:create-workspace',
    async (event, workspaceName, workspaceFolderName, workspaceLocation) => {
      try {
        workspaceFolderName = sanitizeName(workspaceFolderName);
        const dirPath = path.join(workspaceLocation, workspaceFolderName);

        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath);
          if (files.length > 0) {
            throw new Error(`workspace: ${dirPath} already exists and is not empty`);
          }
        }

        validateWorkspaceDirectory(dirPath);

        if (!fs.existsSync(dirPath)) {
          await createDirectory(dirPath);
        }

        await createDirectory(path.join(dirPath, 'collections'));

        const workspaceUid = getWorkspaceUid(dirPath);
        const workspaceConfig = createWorkspaceConfig(workspaceName);

        await writeWorkspaceConfig(dirPath, workspaceConfig);
        await writeFile(path.join(dirPath, '.gitignore'), DEFAULT_GITIGNORE);

        lastOpenedWorkspaces.add(dirPath);

        const configForClient = prepareWorkspaceConfigForClient(workspaceConfig, dirPath);

        mainWindow.webContents.send('main:workspace-opened', dirPath, workspaceUid, configForClient);

        if (workspaceWatcher) {
          workspaceWatcher.addWatcher(mainWindow, dirPath);
        }

        return {
          workspaceConfig: configForClient,
          workspaceUid,
          workspacePath: dirPath
        };
      } catch (error) {
        throw error;
      }
    });

  ipcMain.handle('renderer:open-workspace', async (event, workspacePath) => {
    try {
      validateWorkspacePath(workspacePath);

      const workspaceConfig = readWorkspaceConfig(workspacePath);
      validateWorkspaceConfig(workspaceConfig);

      const workspaceUid = getWorkspaceUid(workspacePath);
      const configForClient = prepareWorkspaceConfigForClient(workspaceConfig, workspacePath);

      lastOpenedWorkspaces.add(workspacePath);

      mainWindow.webContents.send('main:workspace-opened', workspacePath, workspaceUid, configForClient);

      if (workspaceWatcher) {
        workspaceWatcher.addWatcher(mainWindow, workspacePath);
      }

      return {
        workspaceConfig: configForClient,
        workspaceUid,
        workspacePath
      };
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:open-workspace-dialog', async (event) => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Open Workspace',
        buttonLabel: 'Open Workspace'
      });

      if (canceled || filePaths.length === 0) {
        return null;
      }

      const workspacePath = filePaths[0];
      validateWorkspacePath(workspacePath);

      const workspaceConfig = readWorkspaceConfig(workspacePath);
      validateWorkspaceConfig(workspaceConfig);

      const workspaceUid = getWorkspaceUid(workspacePath);
      const configForClient = prepareWorkspaceConfigForClient(workspaceConfig, workspacePath);

      lastOpenedWorkspaces.add(workspacePath);

      mainWindow.webContents.send('main:workspace-opened', workspacePath, workspaceUid, configForClient);

      if (workspaceWatcher) {
        workspaceWatcher.addWatcher(mainWindow, workspacePath);
      }

      return {
        workspaceConfig: configForClient,
        workspaceUid,
        workspacePath
      };
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:load-workspace-collections', async (event, workspacePath) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is undefined');
      }

      validateWorkspacePath(workspacePath);
      return getWorkspaceCollections(workspacePath);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:reorder-workspace-collections', async (event, workspacePath, collectionPaths) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is undefined');
      }
      validateWorkspacePath(workspacePath);
      await reorderWorkspaceCollections(workspacePath, collectionPaths);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:load-workspace-apispecs', async (event, workspacePath) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is undefined');
      }

      const workspaceFilePath = path.join(workspacePath, 'workspace.yml');

      if (!fs.existsSync(workspaceFilePath)) {
        throw new Error('Invalid workspace: workspace.yml not found');
      }

      const yamlContent = fs.readFileSync(workspaceFilePath, 'utf8');
      const workspaceConfig = yaml.load(yamlContent);

      if (!workspaceConfig || typeof workspaceConfig !== 'object') {
        return [];
      }

      const specs = workspaceConfig.specs || [];

      const resolvedSpecs = specs
        .map((spec) => {
          if (spec.path && !path.isAbsolute(spec.path)) {
            return {
              ...spec,
              path: path.join(workspacePath, spec.path)
            };
          }
          return spec;
        })
        .filter((spec) => spec.path && fs.existsSync(spec.path));

      return resolvedSpecs;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:get-last-opened-workspaces', async () => {
    try {
      const workspacePaths = lastOpenedWorkspaces.getAll();
      const validWorkspaces = [];
      const invalidPaths = [];

      for (const workspacePath of workspacePaths) {
        const workspaceYmlPath = path.join(workspacePath, 'workspace.yml');

        if (fs.existsSync(workspaceYmlPath)) {
          validWorkspaces.push(workspacePath);
        } else {
          invalidPaths.push(workspacePath);
        }
      }

      for (const invalidPath of invalidPaths) {
        lastOpenedWorkspaces.remove(invalidPath);
      }

      return validWorkspaces;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:rename-workspace', async (event, workspacePath, newName) => {
    try {
      await updateWorkspaceName(workspacePath, newName);
      return { success: true };
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:close-workspace', async (event, workspacePath) => {
    try {
      lastOpenedWorkspaces.remove(workspacePath);
      globalEnvironmentsStore.removeActiveGlobalEnvironmentUidForWorkspace(workspacePath);

      if (workspaceWatcher) {
        workspaceWatcher.removeWatcher(workspacePath);
      }

      return { success: true };
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:export-workspace', async (event, workspacePath, workspaceName) => {
    try {
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        throw new Error('Workspace path does not exist');
      }

      const defaultFileName = `${sanitizeName(workspaceName)}.zip`;
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Workspace',
        defaultPath: defaultFileName,
        filters: [{ name: 'Zip Files', extensions: ['zip'] }]
      });

      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }

      const ignoredDirectories = ['node_modules', '.git'];

      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
          resolve();
        });

        archive.on('error', (err) => {
          reject(err);
        });

        archive.pipe(output);

        const addDirectoryToArchive = (dirPath, archivePath) => {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const entryArchivePath = archivePath ? path.join(archivePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
              if (!ignoredDirectories.includes(entry.name)) {
                addDirectoryToArchive(fullPath, entryArchivePath);
              }
            } else {
              archive.file(fullPath, { name: entryArchivePath });
            }
          }
        };

        addDirectoryToArchive(workspacePath, '');
        archive.finalize();
      });

      return { success: true, filePath };
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:import-workspace', async (event, zipFilePath, extractLocation) => {
    try {
      if (!zipFilePath || !fs.existsSync(zipFilePath)) {
        throw new Error('Zip file does not exist');
      }

      if (!extractLocation || !fs.existsSync(extractLocation)) {
        throw new Error('Extract location does not exist');
      }

      const tempDir = path.join(extractLocation, `_bruno_temp_${Date.now()}`);
      await fsExtra.ensureDir(tempDir);

      try {
        await extractZip(zipFilePath, { dir: tempDir });

        const extractedItems = fs.readdirSync(tempDir);
        let workspaceDir = tempDir;

        if (extractedItems.length === 1) {
          const singleItem = path.join(tempDir, extractedItems[0]);
          if (fs.statSync(singleItem).isDirectory()) {
            workspaceDir = singleItem;
          }
        }

        const workspaceYmlPath = path.join(workspaceDir, 'workspace.yml');
        if (!fs.existsSync(workspaceYmlPath)) {
          throw new Error('Invalid workspace: workspace.yml not found in the zip file');
        }

        const workspaceConfig = yaml.load(fs.readFileSync(workspaceYmlPath, 'utf8'));
        const workspaceName = workspaceConfig.info.name || 'Imported Workspace';
        const sanitizedName = sanitizeName(workspaceName);

        let finalWorkspacePath = path.join(extractLocation, sanitizedName);
        let counter = 1;
        while (fs.existsSync(finalWorkspacePath)) {
          finalWorkspacePath = path.join(extractLocation, `${sanitizedName} (${counter})`);
          counter++;
        }

        if (workspaceDir !== tempDir) {
          await fsExtra.move(workspaceDir, finalWorkspacePath);
          await fsExtra.remove(tempDir);
        } else {
          await fsExtra.move(tempDir, finalWorkspacePath);
        }

        validateWorkspacePath(finalWorkspacePath);

        const finalConfig = readWorkspaceConfig(finalWorkspacePath);
        validateWorkspaceConfig(finalConfig);

        const workspaceUid = getWorkspaceUid(finalWorkspacePath);
        const configForClient = prepareWorkspaceConfigForClient(finalConfig, finalWorkspacePath);

        lastOpenedWorkspaces.add(finalWorkspacePath);

        mainWindow.webContents.send('main:workspace-opened', finalWorkspacePath, workspaceUid, configForClient);

        if (workspaceWatcher) {
          workspaceWatcher.addWatcher(mainWindow, finalWorkspacePath);
        }

        return {
          success: true,
          workspaceConfig: configForClient,
          workspaceUid,
          workspacePath: finalWorkspacePath
        };
      } catch (error) {
        await fsExtra.remove(tempDir).catch(() => {});
        throw error;
      }
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:save-workspace-docs', async (event, workspacePath, docs) => {
    try {
      return await updateWorkspaceDocs(workspacePath, docs);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:load-workspace-environments', async (event, workspacePath) => {
    try {
      const result = await globalEnvironmentsManager.getGlobalEnvironments(workspacePath);
      return result.globalEnvironments;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:create-workspace-environment', async (event, workspacePath, environmentName) => {
    try {
      return await globalEnvironmentsManager.createGlobalEnvironment(workspacePath, {
        name: environmentName,
        variables: []
      });
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:delete-workspace-environment', async (event, workspacePath, environmentUid) => {
    try {
      return await globalEnvironmentsManager.deleteGlobalEnvironment(workspacePath, { environmentUid });
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:import-workspace-environment', async (event, workspacePath, environmentData) => {
    try {
      return await globalEnvironmentsManager.createGlobalEnvironment(workspacePath, {
        name: environmentData.name || 'Imported Environment',
        variables: environmentData.variables || []
      });
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:update-workspace-environment', async (event, workspacePath, environmentUid, environmentData) => {
    try {
      return await globalEnvironmentsManager.saveGlobalEnvironment(workspacePath, {
        environmentUid,
        variables: environmentData.variables || []
      });
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:rename-workspace-environment', async (event, workspacePath, environmentUid, newName) => {
    try {
      return await globalEnvironmentsManager.renameGlobalEnvironment(workspacePath, {
        environmentUid,
        name: newName
      });
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:copy-workspace-environment', async (event, workspacePath, environmentUid, newName) => {
    try {
      const result = await globalEnvironmentsManager.getGlobalEnvironments(workspacePath);
      const sourceEnv = result.globalEnvironments.find((env) => env.uid === environmentUid);

      if (!sourceEnv) {
        throw new Error('Source environment not found');
      }

      // Create new environment with copied variables
      return await globalEnvironmentsManager.createGlobalEnvironment(workspacePath, {
        name: newName,
        variables: sourceEnv.variables || []
      });
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:add-collection-to-workspace', async (event, workspacePath, collection) => {
    try {
      const normalizedCollection = normalizeCollectionEntry(workspacePath, collection);
      const updatedCollections = await addCollectionToWorkspace(workspacePath, normalizedCollection);

      const workspaceConfig = readWorkspaceConfig(workspacePath);
      const workspaceUid = getWorkspaceUid(workspacePath);
      const configForClient = prepareWorkspaceConfigForClient(workspaceConfig, workspacePath);
      mainWindow.webContents.send('main:workspace-config-updated', workspacePath, workspaceUid, configForClient);

      return updatedCollections;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:ensure-collections-folder', async (event, workspacePath) => {
    try {
      const collectionsPath = path.join(workspacePath, 'collections');
      if (!fs.existsSync(collectionsPath)) {
        await createDirectory(collectionsPath);
      }
      return collectionsPath;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:start-workspace-watcher', async (event, workspacePath) => {
    try {
      if (workspaceWatcher) {
        workspaceWatcher.addWatcher(mainWindow, workspacePath);
      }
      return true;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:remove-collection-from-workspace', async (event, workspaceUid, workspacePath, collectionPath, options = {}) => {
    try {
      const absoluteCollectionPath = assertWorkspaceCollectionFolder(workspacePath, collectionPath);
      const result = await removeCollectionFromWorkspace(workspacePath, collectionPath);

      if (fs.existsSync(absoluteCollectionPath)) {
        await fsExtra.remove(absoluteCollectionPath);
      }

      const correctWorkspaceUid = getWorkspaceUid(workspacePath);
      const configForClient = prepareWorkspaceConfigForClient(result.updatedConfig, workspacePath);
      mainWindow.webContents.send('main:workspace-config-updated', workspacePath, correctWorkspaceUid, configForClient);

      return true;
    } catch (error) {
      throw error;
    }
  });

  const broadcastWorkspaceConfig = (workspacePath, config) => {
    const workspaceUid = getWorkspaceUid(workspacePath);
    const configForClient = prepareWorkspaceConfigForClient(config, workspacePath);
    mainWindow.webContents.send('main:workspace-config-updated', workspacePath, workspaceUid, configForClient);
  };

  ipcMain.handle('renderer:get-workspace-collection-reconciliation', async (event, workspacePath) => {
    try {
      return getWorkspaceCollectionReconciliation(workspacePath);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:add-orphan-workspace-collections', async (event, workspacePath, orphanCollections = []) => {
    try {
      validateWorkspacePath(workspacePath);

      if (!Array.isArray(orphanCollections) || orphanCollections.length === 0) {
        return [];
      }

      const addedCollections = [];
      for (const collection of orphanCollections) {
        const absolutePath = path.resolve(collection.path);
        if (!isWorkspaceCollectionPath(workspacePath, absolutePath) || !isValidCollectionDirectory(absolutePath)) {
          continue;
        }

        const relativePath = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
        await addCollectionToWorkspace(workspacePath, {
          name: collection.name || path.basename(absolutePath),
          path: relativePath
        });
        addedCollections.push({
          name: collection.name || path.basename(absolutePath),
          path: absolutePath,
          relativePath
        });
      }

      broadcastWorkspaceConfig(workspacePath, readWorkspaceConfig(workspacePath));
      return addedCollections;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:delete-orphan-workspace-collections', async (event, workspacePath, orphanCollections = []) => {
    try {
      validateWorkspacePath(workspacePath);

      if (!Array.isArray(orphanCollections) || orphanCollections.length === 0) {
        return [];
      }

      const deletedCollections = [];
      for (const collection of orphanCollections) {
        const absolutePath = assertWorkspaceCollectionFolder(workspacePath, collection.path);
        await fsExtra.remove(absolutePath);
        deletedCollections.push({
          name: collection.name || path.basename(absolutePath),
          path: absolutePath,
          relativePath: path.relative(workspacePath, absolutePath).replace(/\\/g, '/')
        });
      }

      return deletedCollections;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:remove-missing-workspace-collections', async (event, workspacePath, missingCollections = []) => {
    try {
      validateWorkspacePath(workspacePath);

      if (!Array.isArray(missingCollections) || missingCollections.length === 0) {
        return [];
      }

      const removedCollections = [];
      for (const collection of missingCollections) {
        const absolutePath = path.isAbsolute(collection.path)
          ? collection.path
          : path.resolve(workspacePath, collection.path);
        const result = await removeCollectionFromWorkspace(workspacePath, absolutePath);
        if (result.removedCollection) {
          removedCollections.push(result.removedCollection);
        }
      }

      broadcastWorkspaceConfig(workspacePath, readWorkspaceConfig(workspacePath));
      return removedCollections;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:connect-collection-to-git', async (event, workspacePath, collectionPath, remoteUrl) => {
    try {
      if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
        throw new Error('A Git remote URL is required');
      }

      const trimmedUrl = remoteUrl.trim();
      if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/).+/.test(trimmedUrl)) {
        throw new Error('Invalid Git remote URL');
      }

      const updatedConfig = await setCollectionGitRemote(workspacePath, collectionPath, trimmedUrl);
      broadcastWorkspaceConfig(workspacePath, updatedConfig);
      return true;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:disconnect-collection-from-git', async (event, workspacePath, collectionPath) => {
    try {
      const updatedConfig = await clearCollectionGitRemote(workspacePath, collectionPath);
      broadcastWorkspaceConfig(workspacePath, updatedConfig);
      return true;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('renderer:get-collection-workspaces', async (event, collectionPath) => {
    try {
      const workspacePaths = lastOpenedWorkspaces.getAll();
      const workspacesWithCollection = [];

      for (const workspacePath of workspacePaths) {
        try {
          const workspaceYmlPath = path.join(workspacePath, 'workspace.yml');
          if (fs.existsSync(workspaceYmlPath)) {
            const workspaceConfig = yaml.load(fs.readFileSync(workspaceYmlPath, 'utf8')) || {};
            const collections = workspaceConfig.collections || [];

            const hasCollection = collections.some((c) => {
              const resolvedPath = path.isAbsolute(c.path)
                ? c.path
                : path.resolve(workspacePath, c.path);
              return resolvedPath === collectionPath;
            });

            if (hasCollection) {
              workspacesWithCollection.push(workspacePath);
            }
          }
        } catch (error) {
          console.warn('Failed to check workspace collection:', error.message);
        }
      }

      return workspacesWithCollection;
    } catch (error) {
      return [];
    }
  });

  // Guard to prevent main:renderer-ready from running multiple times (only needed in dev mode due to strict mode)
  let rendererReadyProcessed = false;

  ipcMain.on('main:renderer-ready', async (win) => {
    if (isDev && rendererReadyProcessed) {
      return;
    }
    rendererReadyProcessed = true;

    try {
      const workspacePaths = lastOpenedWorkspaces.getAll();
      const invalidPaths = [];
      let openedWorkspaceCount = 0;

      for (const workspacePath of workspacePaths) {
        const workspaceYmlPath = path.join(workspacePath, 'workspace.yml');

        if (fs.existsSync(workspaceYmlPath)) {
          try {
            const workspaceConfig = readWorkspaceConfig(workspacePath);
            validateWorkspaceConfig(workspaceConfig);
            const workspaceUid = getWorkspaceUid(workspacePath);
            const configForClient = prepareWorkspaceConfigForClient(workspaceConfig, workspacePath);

            win.webContents.send('main:workspace-opened', workspacePath, workspaceUid, configForClient);
            openedWorkspaceCount++;

            if (workspaceWatcher) {
              workspaceWatcher.addWatcher(win, workspacePath);
            }
          } catch (error) {
            console.error(`Error loading workspace ${workspacePath}:`, error);
            invalidPaths.push(workspacePath);
          }
        } else {
          invalidPaths.push(workspacePath);
        }
      }

      for (const invalidPath of invalidPaths) {
        lastOpenedWorkspaces.remove(invalidPath);
      }

      if (openedWorkspaceCount === 0) {
        try {
          const { workspacePath, workspaceConfig } = await ensureInitialWorkspace();
          const workspaceUid = getWorkspaceUid(workspacePath);
          const configForClient = prepareWorkspaceConfigForClient(workspaceConfig, workspacePath);

          lastOpenedWorkspaces.add(workspacePath);
          win.webContents.send('main:workspace-opened', workspacePath, workspaceUid, configForClient);

          if (workspaceWatcher) {
            workspaceWatcher.addWatcher(win, workspacePath);
          }
        } catch (error) {
          console.error('Error creating initial workspace:', error);
        }
      }
    } catch (error) {
      console.error('Error initializing workspaces:', error);
    }

    ipcMain.emit('main:workspaces-ready', win);
  });
};

module.exports = registerWorkspaceIpc;
