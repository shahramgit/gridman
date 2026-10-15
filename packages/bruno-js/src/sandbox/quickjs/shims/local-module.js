const path = require('path');
const fs = require('fs');
const { marshallToVm } = require('../utils');

// Only require() receives this handle. Publishing a source loader on the VM
// global would also let scripts read local files without executing a module.
const createLocalModuleLoaderHandle = (vm, collectionPath) => {
  return vm.newFunction('loadLocalModule', function (module) {
    const filename = vm.dump(module);

    // Check if the filename has an extension
    const hasExtension = path.extname(filename) !== '';
    const resolvedFilename = hasExtension ? filename : `${filename}.js`;

    let realCollectionPath;
    let filePath;
    try {
      // Check the actual target, including directory symlinks and junctions.
      realCollectionPath = fs.realpathSync(collectionPath);
      filePath = fs.realpathSync(path.resolve(realCollectionPath, resolvedFilename));
    } catch (error) {
      throw new Error(`Cannot find module ${filename}`);
    }
    const relativePath = path.relative(realCollectionPath, filePath);

    // Ensure the resolved file path is inside the collectionPath
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error('Access to files outside of the collectionPath is not allowed.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Cannot find module ${filename}`);
    }

    const code = fs.readFileSync(filePath).toString();

    return marshallToVm(code, vm);
  });
};

module.exports = createLocalModuleLoaderHandle;
