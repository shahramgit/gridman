// @rollup/plugin-terser pulls in serialize-javascript, which calls the GLOBAL
// crypto.getRandomValues. WebCrypto is not a global before Node 19, so on
// Node 18 this script failed before writing anything — and its output is
// gitignored, so the previous bundle silently stayed in place. That is how
// releases 4.1.0-vasl.3 to .5 all shipped an April bundle with no ajv in it,
// and every safe-mode script failed with "Cannot find module ajv" (the QuickJS
// test shim requires it on every run).
//
// Assigning globalThis.crypto here is NOT enough: terser minifies in worker
// threads, which get their globals from the process flags, not from this
// module. So re-run under the flag, as scripts/build-package.js does for the
// build:bruno-* packages.
const WEBCRYPTO_FLAG = '--experimental-global-webcrypto';
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 19 && !process.execArgv.includes(WEBCRYPTO_FLAG)) {
  const { spawnSync } = require('child_process');
  const rerun = spawnSync(
    process.execPath,
    [WEBCRYPTO_FLAG, ...process.execArgv, __filename, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  process.exit(rerun.status === null ? 1 : rerun.status);
}

const rollup = require('rollup');
const { nodeResolve } = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const json = require('@rollup/plugin-json');
const fs = require('fs');
const terser = require('@rollup/plugin-terser').default;

const bundleLibraries = async () => {
  const codeScript = `
    import { expect, assert } from 'chai';
    import { Buffer } from "buffer";
    import moment from "moment";
    import btoa from "btoa";
    import atob from "atob";
    import * as cryptoJs from 'crypto-js';
    import tv4 from "tv4";
    import Ajv from "ajv";
    import addFormats from "ajv-formats";
    globalThis.expect = expect;
    globalThis.assert = assert;
    globalThis.moment = moment;
    globalThis.btoa = btoa;
    globalThis.atob = atob;
    globalThis.Buffer = Buffer;
    globalThis.tv4 = tv4;
    globalThis.Ajv = Ajv;
    globalThis.addFormats = addFormats;
    globalThis.requireObject = {
      ...(globalThis.requireObject || {}),
      'chai': { expect, assert },
      'moment': moment,
      'buffer': { Buffer },
      'btoa': btoa,
      'atob': atob,
      'crypto-js': cryptoJs,
      'tv4': tv4,
      'ajv': Ajv,
      'ajv-formats': addFormats
    };
`;

  const config = {
    input: {
      input: 'inline-code',
      plugins: [
        {
          name: 'inline-code-plugin',
          resolveId(id) {
            if (id === 'inline-code') {
              return id;
            }
            return null;
          },
          load(id) {
            if (id === 'inline-code') {
              return codeScript;
            }
            return null;
          }
        },
        nodeResolve({
          preferBuiltins: false,
          browser: false
        }),
        commonjs(),
        json(),
        terser()
      ]
    },
    output: {
      file: './src/sandbox/bundle-browser-rollup.js',
      format: 'iife',
      name: 'MyBundle'
    }
  };

  try {
    const bundle = await rollup.rollup(config.input);
    const { output } = await bundle.generate(config.output);
    fs.writeFileSync(
      './src/sandbox/bundle-browser-rollup.js',
      `
      const getBundledCode = () => {
        return function(){
          ${output?.map((o) => o.code).join('\n')}
        }()
      }
      module.exports = getBundledCode;
    `
    );
  } catch (error) {
    console.error('Error while bundling:', error);
  }
};

bundleLibraries();

module.exports = bundleLibraries;
