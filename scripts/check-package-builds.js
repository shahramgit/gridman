// Workspace packages (bruno-common, bruno-converters, bruno-filestore,
// bruno-requests) resolve through package.json main/module to dist/, their dist
// is gitignored, and NOTHING in the normal flow rebuilds them: `npm run dev`
// does not, and scripts/build-electron.sh only builds the renderer. Only
// scripts/setup.js builds them, i.e. once, at first setup.
//
// So a fix edited in one of those packages is invisible to both the dev app and
// a release build until its build:bruno-* script is run by hand. That is not
// hypothetical: the yml-request classifier fix (65ade78d2) sat in src while
// every export still used the stale dist, which is exactly how a "fixed" bug
// keeps getting reported.
//
// This compares the newest mtime under src/ against dist/ and says so.
//   node scripts/check-package-builds.js          -> warn, exit 0
//   node scripts/check-package-builds.js --strict -> fail the build, exit 1
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Only the packages whose consumers resolve to dist. bruno-lang and bruno-schema
// point main at src/, so they are always current.
const BUILT_PACKAGES = [
  { name: 'bruno-common', script: 'build:bruno-common' },
  { name: 'bruno-converters', script: 'build:bruno-converters' },
  { name: 'bruno-filestore', script: 'build:bruno-filestore' },
  { name: 'bruno-requests', script: 'build:bruno-requests' }
];

const newestMtime = (dir) => {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      try {
        const { mtimeMs } = fs.statSync(entryPath);
        if (mtimeMs > newest) newest = mtimeMs;
      } catch (_err) {
        // a file that vanished mid-walk cannot be the newest one that matters
      }
    }
  };
  walk(dir);
  return newest;
};

const strict = process.argv.includes('--strict');
const problems = [];

for (const pkg of BUILT_PACKAGES) {
  const packageDir = path.join(rootDir, 'packages', pkg.name);
  const srcDir = path.join(packageDir, 'src');
  const distDir = path.join(packageDir, 'dist');

  if (!fs.existsSync(srcDir)) continue;

  if (!fs.existsSync(distDir)) {
    problems.push({ pkg, reason: 'dist/ is missing entirely' });
    continue;
  }

  const srcTime = newestMtime(srcDir);
  const distTime = newestMtime(distDir);
  if (srcTime > distTime) {
    const ageInMinutes = Math.round((srcTime - distTime) / 60000);
    problems.push({ pkg, reason: `src/ is ${ageInMinutes} minute(s) newer than dist/` });
  }
}

if (!problems.length) {
  if (strict) console.log('✓ workspace package builds are current');
  process.exit(0);
}

const label = strict ? 'ERROR' : 'WARNING';
console.log('');
console.log(`${label}: workspace package builds are STALE. Consumers resolve to dist/, so these changes are NOT in the app:`);
for (const { pkg, reason } of problems) {
  console.log(`  - ${pkg.name}: ${reason}`);
}
console.log('');
console.log('Rebuild them with:');
console.log(`  ${problems.map(({ pkg }) => `npm run ${pkg.script}`).join(' && ')}`);

// The rollup builds need the pinned Node; on 18 @rollup/plugin-terser dies with
// "ReferenceError: crypto is not defined", and prebuild has already run rimraf
// on dist by then, so a failed build leaves you with no dist at all.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.log('');
  console.log(`Node ${process.versions.node} cannot run those builds (.nvmrc pins v22.12.0).`);
  console.log('Use the pinned version first — on Node 18 the build deletes dist and then fails.');
}
console.log('');

process.exit(strict ? 1 : 0);
