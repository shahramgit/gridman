const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const cli = path.resolve(__dirname, '../../bin/bru.js');
const scriptBlock = (name, script) => script ? `\nscript:${name} {\n${script.split('\n').map((line) => '  ' + line).join('\n')}\n}\n` : '';
const requestFile = (name, seq, url, script = '', responseScript = '') => `meta {
  name: ${name}
  type: http
  seq: ${seq}
}

get {
  url: ${url}
  body: none
  auth: none
}
${scriptBlock('pre-request', script)}${scriptBlock('post-response', responseScript)}\n`;

const run = (cwd, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, 'run', '--noproxy', '--sandbox', 'developer', ...args], { cwd });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, output }));
});

describe('CLI runner control flow', () => {
  let dir, server, url, received;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-runner-sync-'));
    fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify({ version: '1', name: 'Runner regressions', type: 'collection', ignore: [] }));
    received = [];
    server = http.createServer((req, res) => {
      received.push(req.url); res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks later requests skipped when a response script stops the run', async () => {
    fs.writeFileSync(path.join(dir, 'Stop.bru'), requestFile('Stop', 1, `${url}/stop`, '', 'bru.runner.stopExecution();'));
    fs.writeFileSync(path.join(dir, 'Never.bru'), requestFile('Never', 2, `${url}/never`));
    const result = await run(dir, ['--reporter-json', 'report.json']);
    if (!received.length) throw new Error(result.output);
    expect(result).toMatchObject({ code: 0 });
    expect(received).toEqual(['/stop']);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
    expect(report.results).toHaveLength(2);
    expect(report.results[1]).toMatchObject({ skipped: true, skipReason: 'stopExecution' });
  });

  it('propagates a nested request stop to the outer request and the whole run', async () => {
    fs.writeFileSync(path.join(dir, 'Outer.bru'), requestFile('Outer', 1, `${url}/outer`, 'await bru.runRequest("Stop");'));
    fs.writeFileSync(path.join(dir, 'Stop.bru'), requestFile('Stop', 2, `${url}/stop`, '', 'bru.runner.stopExecution();'));
    fs.writeFileSync(path.join(dir, 'Never.bru'), requestFile('Never', 3, `${url}/never`));
    const result = await run(dir, ['--reporter-json', 'report.json']);
    if (!received.length) throw new Error(result.output);
    expect(result.output).toContain('Stop');
    expect(result.code).toBe(0);
    expect(received).toEqual(['/stop']);
    expect(result.output).not.toContain('Something went wrong');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
    expect(report.results.slice(1).map((entry) => entry.skipReason)).toEqual(['stopExecution', 'stopExecution']);
  });

  it('preserves asynchronous onFail variable updates for the next request without writing the environment', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const environment = 'vars {\n  envMarker: original\n}\n';
    fs.mkdirSync(path.join(dir, 'environments'));
    fs.writeFileSync(path.join(dir, 'environments/local.bru'), environment);
    fs.writeFileSync(path.join(dir, 'Fail.bru'), requestFile('Fail', 1, `http://127.0.0.1:${port}/fail`, `req.onFail(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  bru.setVar('failMarker', 'runtime');
  bru.setEnvVar('envMarker', 'updated');
});`));
    fs.writeFileSync(path.join(dir, 'Check.bru'), requestFile('Check', 2, `${url}/{{failMarker}}/{{envMarker}}`));
    const result = await run(dir, ['--env', 'local']);
    if (!received.length) throw new Error(result.output);
    expect(result.output).toContain('Check');
    expect(received).toEqual(['/runtime/updated']);
    expect(result.output).not.toContain('Error executing onFail handler');
    expect(fs.readFileSync(path.join(dir, 'environments/local.bru'), 'utf8')).toBe(environment);
  });

  it('blocks unsupported inherited JSON environments without sending a partial request', async () => {
    fs.writeFileSync(path.join(dir, 'Request.bru'), requestFile('Request', 1, `${url}/never`));
    fs.writeFileSync(path.join(dir, 'inherited.json'), JSON.stringify({ name: 'Team', extends: ['Base'], variables: [] }));
    const result = await run(dir, ['--env-file', 'inherited.json']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Environment inheritance is not supported');
    expect(received).toEqual([]);
  });
});
