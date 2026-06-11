#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GITHUB_API = 'api.github.com';
const GITHUB_UPLOADS = 'uploads.github.com';

function usage() {
  console.log(`Usage:
  node scripts/github-release-upload.js --repo owner/repo --tag v1.2.3 --jobs 1 [--resume] --assets <files...>

Uploads release assets with real byte progress. Existing assets with the same
filename are deleted before upload unless --resume finds a matching uploaded
asset.`);
}

function parseArgs(argv) {
  const args = {
    repo: null,
    tag: null,
    jobs: 1,
    resume: false,
    assets: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') {
      args.repo = argv[++i];
    } else if (arg === '--tag') {
      args.tag = argv[++i];
    } else if (arg === '--jobs') {
      args.jobs = Number(argv[++i]);
    } else if (arg === '--resume') {
      args.resume = true;
    } else if (arg === '--assets') {
      args.assets = argv.slice(i + 1);
      break;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.repo || !/^[^/]+\/[^/]+$/.test(args.repo)) {
    throw new Error('--repo must be in owner/repo format.');
  }
  if (!args.tag) {
    throw new Error('--tag is required.');
  }
  if (![1, 2].includes(args.jobs)) {
    throw new Error('--jobs must be 1 or 2.');
  }
  if (!args.assets.length) {
    throw new Error('--assets must include at least one file.');
  }
  for (const asset of args.assets) {
    if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) {
      throw new Error(`Asset does not exist or is not a file: ${asset}`);
    }
  }

  return args;
}

function getToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error("Unable to read GitHub token from 'gh auth token'. Run 'gh auth login' first.");
  }
}

function requestJson({ method = 'GET', host = GITHUB_API, path: requestPath, token, body }) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'gridman-release-uploader',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }

  return new Promise((resolve, reject) => {
    const req = https.request({ method, host, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${requestPath} failed with ${res.statusCode}: ${text}`));
          return;
        }

        if (!text) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(new Error(`${method} ${requestPath} returned invalid JSON: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function getRelease({ owner, repo, tag, token }) {
  return requestJson({
    token,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`
  });
}

async function listReleaseAssets({ owner, repo, releaseId, token }) {
  const assets = [];
  let page = 1;

  while (true) {
    const batch = await requestJson({
      token,
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${releaseId}/assets?per_page=100&page=${page}`
    });
    assets.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return assets;
}

async function deleteAsset({ owner, repo, assetId, token }) {
  await requestJson({
    method: 'DELETE',
    token,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`
  });
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function existingAssetMatchesFile(existing, file) {
  if (!existing || existing.state !== 'uploaded') {
    return { matches: false, reason: existing ? `asset state is ${existing.state || 'unknown'}` : 'asset missing' };
  }

  const localSize = fs.statSync(file).size;
  if (typeof existing.size === 'number' && existing.size !== localSize) {
    return {
      matches: false,
      reason: `size differs: GitHub has ${formatBytes(existing.size)}, local file is ${formatBytes(localSize)}`
    };
  }

  if (typeof existing.digest === 'string' && existing.digest.startsWith('sha256:')) {
    const localDigest = await sha256File(file);
    const remoteDigest = existing.digest.slice('sha256:'.length).toLowerCase();
    return {
      matches: remoteDigest === localDigest,
      reason: remoteDigest === localDigest ? 'sha256 digest matches' : 'sha256 digest differs'
    };
  }

  if (typeof existing.size === 'number') {
    return { matches: true, reason: 'size matches; GitHub did not return a digest' };
  }

  return { matches: false, reason: 'GitHub asset has no size or digest to compare' };
}

function progressBar(percent, width = 28) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${'='.repeat(filled)}${' '.repeat(width - filled)}`;
}

class ProgressReporter {
  constructor(files, jobs) {
    this.jobs = jobs;
    this.fileTotals = new Map(files.map((file) => [file, fs.statSync(file).size]));
    this.fileUploaded = new Map(files.map((file) => [file, 0]));
    this.totalBytes = [...this.fileTotals.values()].reduce((sum, size) => sum + size, 0);
    this.lastRender = 0;
    this.currentFile = null;
    this.activeFiles = new Set();
    this.completedFiles = new Set();
    this.renderedLineCount = 0;
  }

  startFile(file) {
    this.currentFile = file;
    this.activeFiles.add(file);
    this.render(true);
  }

  update(file, uploaded) {
    this.fileUploaded.set(file, uploaded);
    this.render(false);
  }

  finishFile(file) {
    this.fileUploaded.set(file, this.fileTotals.get(file));
    this.activeFiles.delete(file);
    this.completedFiles.add(file);
    this.render(true);
    if (this.jobs === 1 && process.stdout.isTTY) {
      process.stdout.write('\n');
    } else if (this.jobs > 1 && process.stdout.isTTY && this.activeFiles.size === 0) {
      process.stdout.write('\n');
      this.renderedLineCount = 0;
    }
  }

  clearRenderedBlock() {
    if (!process.stdout.isTTY) {
      return;
    }

    process.stdout.cursorTo(0);
    if (this.renderedLineCount === 0) {
      process.stdout.clearLine(0);
      return;
    }

    for (let i = 0; i < this.renderedLineCount; i += 1) {
      process.stdout.clearLine(0);
      if (i < this.renderedLineCount - 1) {
        process.stdout.moveCursor(0, 1);
      }
    }
    process.stdout.moveCursor(0, -(this.renderedLineCount - 1));
    this.renderedLineCount = 0;
  }

  log(message) {
    this.clearRenderedBlock();
    if (process.stdout.isTTY) {
      process.stdout.cursorTo(0);
      process.stdout.clearLine(0);
    }
    console.log(message);
  }

  render(force) {
    const now = Date.now();
    const minRenderInterval = this.jobs === 1 ? 200 : 1000;
    if (!force && now - this.lastRender < minRenderInterval) {
      return;
    }
    this.lastRender = now;

    const uploadedTotal = [...this.fileUploaded.values()].reduce((sum, size) => sum + size, 0);
    const totalPercent = this.totalBytes ? (uploadedTotal / this.totalBytes) * 100 : 100;

    if (this.jobs === 1) {
      const file = this.currentFile;
      const uploaded = this.fileUploaded.get(file) || 0;
      const total = this.fileTotals.get(file) || 0;
      const filePercent = total ? (uploaded / total) * 100 : 100;
      const line = `${path.basename(file)} [${progressBar(filePercent)}] ${filePercent.toFixed(1)}% (${formatBytes(uploaded)} / ${formatBytes(total)}) total ${totalPercent.toFixed(1)}%`;

      if (process.stdout.isTTY) {
        process.stdout.cursorTo(0);
        process.stdout.clearLine(0);
        process.stdout.write(line);
      } else if (force || Math.round(filePercent) % 10 === 0) {
        console.log(line);
      }
      return;
    }

    const filesToShow = [...new Set([...this.activeFiles, ...this.completedFiles])];
    const lines = [
      `Total [${progressBar(totalPercent)}] ${totalPercent.toFixed(1)}% (${formatBytes(uploadedTotal)} / ${formatBytes(this.totalBytes)})`
    ];

    for (const file of filesToShow) {
      const uploaded = this.fileUploaded.get(file) || 0;
      const total = this.fileTotals.get(file) || 0;
      const percent = total ? (uploaded / total) * 100 : 100;
      const state = this.completedFiles.has(file) ? 'done' : 'uploading';
      lines.push(`  ${state.padEnd(9)} ${path.basename(file)} [${progressBar(percent, 18)}] ${percent.toFixed(1)}% (${formatBytes(uploaded)} / ${formatBytes(total)})`);
    }

    if (process.stdout.isTTY) {
      this.clearRenderedBlock();
      process.stdout.cursorTo(0);
      process.stdout.write(lines.join('\n'));
      this.renderedLineCount = lines.length;
      return;
    }

    console.log(lines.join('\n'));
  }
}

async function uploadAsset({ owner, repo, releaseId, token, file, reporter }) {
  const fileName = path.basename(file);
  const size = fs.statSync(file).size;
  const requestPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;

  reporter.startFile(file);

  await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: GITHUB_UPLOADS,
      path: requestPath,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'User-Agent': 'gridman-release-uploader',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Upload ${fileName} failed with ${res.statusCode}: ${text}`));
          return;
        }
        reporter.finishFile(file);
        resolve();
      });
    });

    req.on('error', reject);

    let uploaded = 0;
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => {
      uploaded += chunk.length;
      reporter.update(file, uploaded);
    });
    stream.on('error', reject);
    stream.pipe(req);
  });
}

async function runQueue(items, jobs, worker) {
  const failures = [];
  let index = 0;

  async function next() {
    while (index < items.length && failures.length === 0) {
      const current = items[index];
      index += 1;
      try {
        await worker(current);
      } catch (err) {
        failures.push({ item: current, error: err });
      }
    }
  }

  await Promise.all(Array.from({ length: jobs }, next));

  if (failures.length) {
    const failure = failures[0];
    throw new Error(`Failed to upload ${path.basename(failure.item)}: ${failure.error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [owner, repo] = args.repo.split('/');
  const token = getToken();

  console.log(`Reading release ${args.repo}@${args.tag}`);
  const release = await getRelease({ owner, repo, tag: args.tag, token });
  const existingAssets = await listReleaseAssets({ owner, repo, releaseId: release.id, token });
  const existingByName = new Map(existingAssets.map((asset) => [asset.name, asset]));
  const assetsToUpload = [];
  const skippedAssets = [];

  for (const file of args.assets) {
    const fileName = path.basename(file);
    const existing = existingByName.get(fileName);
    if (existing) {
      if (args.resume) {
        const match = await existingAssetMatchesFile(existing, file);
        if (match.matches) {
          console.log(`Skipping existing asset: ${fileName} (${match.reason})`);
          skippedAssets.push(file);
          continue;
        }
        console.log(`Replacing existing asset: ${fileName} (${match.reason})`);
      } else {
        console.log(`Replacing existing asset: ${fileName}`);
      }
      await deleteAsset({ owner, repo, assetId: existing.id, token });
    }
    assetsToUpload.push(file);
  }

  if (assetsToUpload.length) {
    const reporter = new ProgressReporter(assetsToUpload, args.jobs);
    await runQueue(assetsToUpload, args.jobs, async (file) => {
      reporter.log(`Uploading ${path.basename(file)} (${formatBytes(fs.statSync(file).size)})`);
      await uploadAsset({ owner, repo, releaseId: release.id, token, file, reporter });
    });

    reporter.clearRenderedBlock();
    if (process.stdout.isTTY) {
      process.stdout.write('\n');
    }
  } else {
    console.log('All release assets already exist; nothing to upload.');
  }

  if (assetsToUpload.length) {
    console.log('Uploaded assets:');
    for (const file of assetsToUpload) {
      console.log(`- ${path.basename(file)} (${formatBytes(fs.statSync(file).size)})`);
    }
  }

  if (skippedAssets.length) {
    console.log('Skipped existing assets:');
    for (const file of skippedAssets) {
      console.log(`- ${path.basename(file)} (${formatBytes(fs.statSync(file).size)})`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
