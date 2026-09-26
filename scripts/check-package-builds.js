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

// The QuickJS (safe mode) sandbox resolves require() from a generated,
// gitignored bundle, and only scripts/setup.js regenerates it — as its LAST
// step, after everything else has already built. When that step failed (it did
// on Node 18 until bundle-libraries.js learned to re-run itself with WebCrypto),
// the old bundle silently stayed and got packaged. 4.1.0-vasl.3 through .5 all
// shipped an April bundle with no ajv, so every safe-mode script failed with
// "Cannot find module ajv".
//
// mtime says nothing useful here (a checkout touches the bundler, not the
// bundle), so compare content: every module bundle-libraries.js registers in
// requireObject must be registered in the bundle's requireObject literal.
const SANDBOX_BUNDLER = path.join(rootDir, 'packages', 'bruno-js', 'src', 'sandbox', 'bundle-libraries.js');
const SANDBOX_BUNDLE = path.join(rootDir, 'packages', 'bruno-js', 'src', 'sandbox', 'bundle-browser-rollup.js');
const SANDBOX_SCRIPT = 'npm run sandbox:bundle-libraries --workspace=packages/bruno-js';

const declaredSandboxModules = () => {
  const source = fs.readFileSync(SANDBOX_BUNDLER, 'utf8');
  const block = source.match(/globalThis\.requireObject\s*=\s*\{([\s\S]*?)\};/);
  if (!block) return [];
  return [...block[1].matchAll(/['"]([^'"]+)['"]\s*:/g)].map((match) => match[1]);
};

const bundledSandboxModules = () => {
  const bundle = fs.readFileSync(SANDBOX_BUNDLE, 'utf8');
  const literal = bundle.match(/requireObject=\{\.\.\.globalThis\.requireObject\|\|\{\},([^;]*)/);
  if (!literal) return null;
  return new Set([...literal[1].matchAll(/(?:^|[{,])\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)].map((m) => m[1] || m[2]));
};

const findSandboxBundleProblem = () => {
  if (!fs.existsSync(SANDBOX_BUNDLER)) return null;
  if (!fs.existsSync(SANDBOX_BUNDLE)) return 'the bundle is missing entirely';

  const declared = declaredSandboxModules();
  const bundled = bundledSandboxModules();
  if (!bundled) return 'the bundle has no requireObject registration (unrecognised format)';

  const missing = declared.filter((name) => !bundled.has(name));
  return missing.length ? `it does not provide ${missing.join(', ')}` : null;
};

// Returns the stale packages and reports them. NEVER exits the process: this is
// also called in-process by scripts/dev.js, where a process.exit() would kill
// the dev server before it started.
const reportStalePackageBuilds = ({ strict = false } = {}) => {
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

  const sandboxProblem = findSandboxBundleProblem();
  if (sandboxProblem) {
    problems.push({
      pkg: { name: 'bruno-js sandbox bundle', script: null, command: SANDBOX_SCRIPT },
      reason: `${sandboxProblem} — every safe-mode script will fail`
    });
  }

  if (!problems.length) {
    if (strict) console.log('\u2713 workspace package builds and the sandbox bundle are current');
    return problems;
  }

  const label = strict ? 'ERROR' : 'WARNING';
  console.log('');
  console.log(`${label}: generated build output is STALE, so these are NOT what the app runs:`);
  for (const { pkg, reason } of problems) {
    console.log(`  - ${pkg.name}: ${reason}`);
  }
  console.log('');
  console.log('Rebuild them with:');
  console.log(`  ${problems.map(({ pkg }) => pkg.command || `npm run ${pkg.script}`).join(' && ')}`);
  console.log('');

  return problems;
};

module.exports = { reportStalePackageBuilds };

if (require.main === module) {
  const strict = process.argv.includes('--strict');
  const problems = reportStalePackageBuilds({ strict });
  process.exit(strict && problems.length ? 1 : 0);
}
