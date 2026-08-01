// Runs a workspace package's rollup build, and survives an older Node.
//
// The packages that build to dist (bruno-common, bruno-converters, bruno-filestore,
// bruno-requests) pull in @rollup/plugin-terser, whose serialize-javascript
// dependency reads the global WebCrypto. That global only exists unflagged from
// Node 19, so on Node 18 the build dies with `ReferenceError: crypto is not
// defined`. The damage is not the failed build: each package's `prebuild` runs
// `rimraf dist` FIRST, so a failed run leaves NO dist at all — and dist is
// gitignored and is what every consumer resolves through, which means the app is
// broken until someone rebuilds on a newer Node. That is a sharp edge to leave
// lying around for a one-flag problem.
//
// So: on Node < 19 we add the flag that makes the build work, rather than
// failing after having already deleted the output.
//
//   node scripts/build-package.js bruno-common
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const packageName = process.argv[2];
if (!packageName) {
  console.error('usage: node scripts/build-package.js <package-name>');
  process.exit(1);
}

const rootDir = path.join(__dirname, '..');
const packageDir = path.join(rootDir, 'packages', packageName);
if (!fs.existsSync(packageDir)) {
  console.error(`No such package: packages/${packageName}`);
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const env = { ...process.env };

if (nodeMajor < 19) {
  const flag = '--experimental-global-webcrypto';
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag;
  console.log(`Node ${process.versions.node}: building with ${flag} (WebCrypto is not global before 19).`);
}

const result = spawnSync('npm', ['run', 'build', '--workspace', `packages/${packageName}`], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true,
  env
});

if (result.status !== 0) {
  const distDir = path.join(packageDir, 'dist');
  console.error('');
  console.error(`Building ${packageName} FAILED.`);
  if (!fs.existsSync(distDir)) {
    // prebuild already removed it, so the tree is now in a worse state than
    // before the command was run. Say so plainly rather than letting someone
    // discover it as a broken app.
    console.error(`packages/${packageName}/dist no longer exists — its prebuild removed it before the build failed.`);
    console.error('Consumers resolve through dist, so the app is broken until this succeeds.');
    console.error(`Repo pins Node ${fs.readFileSync(path.join(rootDir, '.nvmrc'), 'utf8').trim()}; you are on ${process.versions.node}.`);
  }
  process.exit(result.status || 1);
}
