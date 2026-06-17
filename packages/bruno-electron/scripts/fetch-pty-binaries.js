#!/usr/bin/env node
/**
 * Fetch the prebuilt @lydell/node-pty binary packages for one or more target
 * platforms so the app can be cross-packaged from any host.
 *
 * npm only installs the optional binary package that matches the *host*
 * os/cpu (e.g. on an arm64 Mac you only get @lydell/node-pty-darwin-arm64),
 * so a Linux/Windows AppImage built on a Mac ships without its native
 * `pty.node` and crashes at startup with:
 *   "could not find the binary package for it: @lydell/node-pty-linux-x64/pty.node"
 *
 * These packages are *prebuilt* (no compilation), so we can simply download
 * and extract the right tarball into node_modules alongside the others.
 *
 * Usage:
 *   node scripts/fetch-pty-binaries.js <filter> [<filter> ...]
 *   filter: a substring matched against the package name, e.g.
 *           "linux", "win32", "darwin", "linux-x64". Omit for all targets.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const tar = require('tar');

const ptyPkgJson = require.resolve('@lydell/node-pty/package.json');
const lydellDir = path.dirname(path.dirname(ptyPkgJson)); // .../node_modules/@lydell
const { optionalDependencies = {} } = require(ptyPkgJson);

const filters = process.argv.slice(2).filter(Boolean);
const matches = (name) => filters.length === 0 || filters.some((f) => name.includes(f));

const download = (url, dest) =>
  new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https
        .get(currentUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return request(res.headers.location);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Download failed (${res.statusCode}) for ${currentUrl}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    request(url);
  });

const registryTarball = (name, version) => {
  const unscoped = name.split('/').pop();
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
};

(async () => {
  const targets = Object.entries(optionalDependencies).filter(
    ([name]) => name.includes('node-pty-') && matches(name)
  );

  if (targets.length === 0) {
    console.log(`[fetch-pty-binaries] no targets matched ${JSON.stringify(filters)}`);
    return;
  }

  // win32 ships conpty.node rather than pty.node, so just look for any native binary.
  const hasBinary = (dir) =>
    fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.node'));

  for (const [name, version] of targets) {
    const destDir = path.join(lydellDir, name.split('/').pop());
    if (hasBinary(destDir)) {
      console.log(`[fetch-pty-binaries] ${name}@${version} already present`);
      continue;
    }

    const tmp = path.join(os.tmpdir(), `${name.split('/').pop()}-${version}.tgz`);
    const url = registryTarball(name, version);
    console.log(`[fetch-pty-binaries] downloading ${name}@${version}`);
    await download(url, tmp);

    fs.mkdirSync(destDir, { recursive: true });
    // tarballs wrap everything in a top-level "package/" dir; strip it.
    await tar.x({ file: tmp, cwd: destDir, strip: 1 });
    fs.rmSync(tmp, { force: true });

    if (!hasBinary(destDir)) {
      throw new Error(`[fetch-pty-binaries] ${name} extracted but no .node binary was found`);
    }
    console.log(`[fetch-pty-binaries] installed ${name}@${version}`);
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
