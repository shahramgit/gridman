const createLocalModuleLoaderHandle = require('./local-module');

// The loader is passed into a closure rather than published on the VM global.
// Module code is compiled in global scope so it cannot read that closure.
function getRequireFactoryCode() {
  return `
    (loadLocalModule) => {
      // Capture the compiler before user code can replace the global Function
      // with a callback that receives the module's raw source.
      const compileModule = Function;
      globalThis.require = (mod) => {
        const lib = globalThis.requireObject[mod];
        const isModuleAPath = (module) => (module?.startsWith('.') || (typeof bru !== 'undefined' && module?.startsWith(bru.cwd())));
        if (lib) {
          return lib;
        }
        if (isModuleAPath(mod)) {
          const localModuleCode = loadLocalModule(mod);
          const module = { exports: {} };
          const require = (subModule) => isModuleAPath(subModule)
            ? globalThis.require(path.resolve(bru.cwd(), mod, '..', subModule))
            : globalThis.require(subModule);
          new compileModule('module', 'exports', 'require', localModuleCode)(module, module.exports, require);
          globalThis.requireObject[mod] = module.exports;
          return module.exports;
        }
        throw new Error('Cannot find module ' + mod);
      };
    }
  `;
}

function addRequireShimToContext(vm, collectionPath) {
  createLocalModuleLoaderHandle(vm, collectionPath).consume((loadLocalModule) => {
    const evalCode = vm.evalCodeRetained || vm.evalCode;
    const factory = vm.unwrapResult(evalCode.call(vm, getRequireFactoryCode()));
    try {
      vm.unwrapResult(vm.callFunction(factory, vm.global, loadLocalModule)).dispose();
    } finally {
      factory.dispose();
    }
  });
}

module.exports = { getRequireFactoryCode, addRequireShimToContext };
