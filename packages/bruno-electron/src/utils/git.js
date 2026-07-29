const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const { parseRequest } = require('@usebruno/filestore');
const { DEFAULT_GITIGNORE } = require('./filesystem');
const { readWorkspaceConfig, resolveAndFilterWorkspaceCollections, getWorkspaceUid } = require('./workspace-config');
const { runCancellableGitCommand } = require('./git-progress');

let collectionPathToGitRootPathMap = new Map();
let gitBinaryPath;

const simpleGitInstances = new Map();
const windowsLongPathsConfiguredRoots = new Set();

const getGitInstallHelpMessage = () => {
  if (process.platform === 'win32') {
    return 'Git was not found on this Windows machine. Install Git for Windows from https://git-scm.com/download/win, keep "Git from the command line" enabled during setup, then close and reopen Gridman.';
  }

  return 'Git was not found on this machine. Install Git and restart Gridman.';
};

const resolveGitBinaryPath = () => {
  if (gitBinaryPath) {
    return gitBinaryPath;
  }

  const pathResult = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (!pathResult.error) {
    gitBinaryPath = 'git';
    return gitBinaryPath;
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'git.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'git.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'git.exe')
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        gitBinaryPath = candidate;
        return gitBinaryPath;
      }
    }
  }

  return null;
};

const ensureGitAvailable = () => {
  const binary = resolveGitBinaryPath();
  if (!binary) {
    throw new Error(getGitInstallHelpMessage());
  }
  return binary;
};

const getGitVersion = () => {
  return new Promise((resolve, reject) => {
    const binary = resolveGitBinaryPath();
    if (!binary) {
      return resolve(null);
    }

    execFile(binary, ['--version'], (error, stdout, stderr) => {
      if (error) {
        return resolve(null);
      }
      const gitVersion = stdout.trim();
      return resolve(gitVersion);
    });
  });
};

const getSimpleGitInstanceForPath = (gitRootPath) => {
  const binary = ensureGitAvailable();
  const key = `${binary}:${gitRootPath}`;
  let git = simpleGitInstances.get(key);
  if (!git) {
    git = simpleGit({
      baseDir: gitRootPath,
      binary
    });
    simpleGitInstances.set(key, git);
  }
  return git;
};

const normalizeGitPath = (filePath = '') => filePath.replace(/\\/g, '/');

const isProtectedWorkspaceGitPath = (filePath = '') => {
  const normalizedPath = normalizeGitPath(filePath);

  return normalizedPath === '.env'
    || normalizedPath.startsWith('.env.')
    || normalizedPath.startsWith('environments/')
    || normalizedPath.includes('/environments/');
};

const stringifyGitErrorPart = (value) => {
  if (!value) return '';
  if (Array.isArray(value)) {
    return value.map(stringifyGitErrorPart).filter(Boolean).join('\n');
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    return [
      stringifyGitErrorPart(value.stderr),
      stringifyGitErrorPart(value.stdout),
      stringifyGitErrorPart(value.all),
      stringifyGitErrorPart(value.errors),
      stringifyGitErrorPart(value.output)
    ].filter(Boolean).join('\n');
  }
  return String(value).trim();
};

const getGitErrorMessage = (err, fallback = 'Git command failed') => {
  const parts = [
    stringifyGitErrorPart(err?.message),
    stringifyGitErrorPart(err?.git),
    stringifyGitErrorPart(err?.task?.commands)
  ].filter(Boolean);

  const uniqueParts = [...new Set(parts)];
  return uniqueParts.join('\n').trim() || fallback;
};

const createGitError = (err, fallback) => {
  const error = new Error(getGitErrorMessage(err, fallback));
  error.cause = err;
  return error;
};

const isWindowsLongPathError = (message = '') => {
  return process.platform === 'win32'
    && /filename too long|file name too long|path too long|cannot create directory at/i.test(message);
};

const getWindowsLongPathsHelpMessage = (message) => {
  return [
    message,
    '',
    'Windows blocked Git because this repository contains long nested collection paths.',
    'Gridman already enabled Git long paths for this workspace. If this still fails, Windows long paths are disabled at the OS level.',
    '',
    'Ask an administrator to run PowerShell as Administrator and execute:',
    'New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force',
    '',
    'Then reopen Gridman and try again. If Git still reports long paths, also run:',
    'git config --system core.longpaths true'
  ].join('\n');
};

const ensureWindowsGitLongPaths = async (gitRootPath) => {
  if (process.platform !== 'win32' || !gitRootPath || windowsLongPathsConfiguredRoots.has(gitRootPath)) {
    return;
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);

  await new Promise((resolve) => {
    git.raw(['config', 'core.longpaths', 'true'], () => {
      windowsLongPathsConfiguredRoots.add(gitRootPath);
      resolve();
    });
  });
};

const handleGitOutput = ({ win, processUid, sendStdout = false }) => (command, stdout, stderr) => {
  const sendProgressUpdate = (data) => {
    win.webContents.send('main:update-git-operation-progress', {
      uid: processUid,
      data: data.toString()
    });
  };

  stderr.on('data', sendProgressUpdate);

  if (sendStdout) {
    stdout.on('data', sendProgressUpdate);
  }
};

const notifyWorkspaceConfigUpdated = (win, workspacePath) => {
  if (!win || win.isDestroyed?.()) {
    return;
  }

  try {
    const workspaceConfig = readWorkspaceConfig(workspacePath);
    const workspaceUid = getWorkspaceUid(workspacePath);
    win.webContents.send('main:workspace-config-updated', workspacePath, workspaceUid, {
      ...workspaceConfig,
      name: path.basename(workspacePath),
      remoteWorkspaceName: workspaceConfig.name,
      collections: resolveAndFilterWorkspaceCollections(workspacePath, workspaceConfig.collections)
    });
  } catch (error) {
    const message = error?.message || '';
    if (message.includes('unresolved Git conflicts')) {
      win.webContents.send('main:workspace-config-conflicted', workspacePath, getWorkspaceUid(workspacePath));
      return;
    }

    console.error('Error refreshing workspace config after Git operation:', error);
  }
};

const findGitRootPath = (collectionPath) => {
  const gitPath = path.join(collectionPath, '.git');
  try {
    if (fs.existsSync(gitPath)) {
      return gitPath?.split('.git')?.[0];
    } else {
      const parentDir = path.dirname(collectionPath);
      if (parentDir === collectionPath) {
        return null;
      } else {
        return findGitRootPath(parentDir);
      }
    }
  } catch (err) {
    console.error('Error finding .git path:', err);
    return null;
  }
};

const getCollectionGitRootPath = (collectionPath) => {
  let savedGitRootPath = collectionPathToGitRootPathMap.get(collectionPath);
  if (savedGitRootPath) {
    return savedGitRootPath;
  }
  let gitRootPath = findGitRootPath(collectionPath);
  collectionPathToGitRootPathMap.set(collectionPath, gitRootPath);
  return gitRootPath;
};

const getWorkspaceGitRootPath = (workspacePath) => {
  if (!workspacePath) {
    return null;
  }

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const gitPath = path.join(resolvedWorkspacePath, '.git');

  try {
    return fs.existsSync(gitPath) ? resolvedWorkspacePath : null;
  } catch (err) {
    console.error('Error finding workspace .git path:', err);
    return null;
  }
};

const runGitCommand = (args, options = {}) => {
  return new Promise((resolve) => {
    const binary = resolveGitBinaryPath();
    if (!binary) {
      return resolve({
        ok: false,
        code: 'ENOENT',
        signal: null,
        stdout: '',
        stderr: '',
        message: getGitInstallHelpMessage()
      });
    }

    execFile(binary, args, {
      cwd: options.cwd,
      timeout: options.timeout || 15000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        SSH_ASKPASS: 'echo',
        ...options.env
      }
    }, (error, stdout = '', stderr = '') => {
      const timedOut = error?.signal === 'SIGTERM' && !stderr && !stdout;
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: timedOut ? 'Git command timed out before completing.' : (stderr || stdout || error?.message || '').trim()
      });
    });
  });
};

const runSystemCommand = (command, args = [], options = {}) => {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeout || 15000,
      env: {
        ...process.env,
        ...options.env
      }
    }, (error, stdout = '', stderr = '') => {
      const timedOut = error?.signal === 'SIGTERM' && !stderr && !stdout;
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: timedOut ? 'Command timed out before completing.' : (stderr || stdout || error?.message || '').trim()
      });
    });
  });
};

const detectRemoteProtocol = (remoteUrl = '') => {
  const value = remoteUrl.trim();

  if (!value) return 'none';
  if (/^https?:\/\//i.test(value)) return 'https';
  if (/^ssh:\/\//i.test(value) || /^(?:[^@]+@)?[^:]+:.+/.test(value)) return 'ssh';
  if (/^file:\/\//i.test(value) || path.isAbsolute(value)) return 'file';

  return 'unknown';
};

const getRemoteConnectionInfo = (remoteUrl = '') => {
  const value = remoteUrl.trim();
  const protocol = detectRemoteProtocol(value);
  const result = {
    protocol,
    host: '',
    port: '',
    user: '',
    path: '',
    url: value
  };

  if (!value) {
    return result;
  }

  try {
    if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
      const parsed = new URL(value);
      result.host = parsed.hostname;
      result.port = parsed.port || (parsed.protocol === 'ssh:' ? '22' : '');
      result.user = decodeURIComponent(parsed.username || '');
      result.path = parsed.pathname.replace(/^\/+/, '');
      return result;
    }
  } catch (_) {
  }

  const scpStyleMatch = value.match(/^(?:(?<user>[^@]+)@)?(?<host>[^:]+):(?<path>.+)$/);
  if (scpStyleMatch?.groups) {
    result.host = scpStyleMatch.groups.host;
    result.port = '22';
    result.user = scpStyleMatch.groups.user || '';
    result.path = scpStyleMatch.groups.path || '';
  }

  return result;
};

const getRemoteHost = (remoteUrl = '') => {
  const value = remoteUrl.trim();

  if (!value) return '';

  try {
    if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
      return new URL(value).hostname;
    }
  } catch (_) {
  }

  const scpStyleMatch = value.match(/^(?:[^@]+@)?([^:]+):.+$/);
  return scpStyleMatch?.[1] || '';
};

const detectGitProvider = (remoteUrl = '') => {
  const host = getRemoteHost(remoteUrl).toLowerCase();

  if (!host) return { id: 'unknown', name: 'Unknown provider', host: '' };
  if (host.includes('github.com')) return { id: 'github', name: 'GitHub', host };
  if (host.includes('gitlab.com')) return { id: 'gitlab', name: 'GitLab', host };
  if (host.includes('bitbucket.org')) return { id: 'bitbucket', name: 'Bitbucket', host };
  if (host.includes('azure.com') || host.includes('visualstudio.com')) return { id: 'azure', name: 'Azure DevOps', host };

  return { id: 'custom', name: host, host };
};

const getProviderHelpLinks = (providerId) => {
  const links = {
    github: {
      https: 'https://docs.github.com/en/get-started/getting-started-with-git/caching-your-github-credentials-in-git',
      token: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      ssh: 'https://docs.github.com/en/authentication/connecting-to-github-with-ssh'
    },
    gitlab: {
      https: 'https://docs.gitlab.com/user/profile/personal_access_tokens/',
      token: 'https://docs.gitlab.com/user/profile/personal_access_tokens/',
      ssh: 'https://docs.gitlab.com/user/ssh/'
    },
    bitbucket: {
      https: 'https://support.atlassian.com/bitbucket-cloud/docs/using-app-passwords/',
      token: 'https://support.atlassian.com/bitbucket-cloud/docs/using-app-passwords/',
      ssh: 'https://support.atlassian.com/bitbucket-cloud/docs/set-up-personal-ssh-keys-on-macos/'
    },
    azure: {
      https: 'https://learn.microsoft.com/en-us/azure/devops/repos/git/auth-overview',
      token: 'https://learn.microsoft.com/en-us/azure/devops/repos/git/auth-overview',
      ssh: 'https://learn.microsoft.com/en-us/azure/devops/repos/git/use-ssh-keys-to-authenticate'
    }
  };

  return links[providerId] || {
    https: 'https://git-scm.com/book/en/v2/Git-Tools-Credential-Storage',
    token: 'https://git-scm.com/book/en/v2/Git-Tools-Credential-Storage',
    ssh: 'https://git-scm.com/book/en/v2/Git-on-the-Server-Setting-Up-the-Server'
  };
};

const getCredentialHelper = async (gitRootPath) => {
  const [local, global, system] = await Promise.all([
    runGitCommand(['config', '--local', '--get-all', 'credential.helper'], { cwd: gitRootPath }),
    runGitCommand(['config', '--global', '--get-all', 'credential.helper'], { cwd: gitRootPath }),
    runGitCommand(['config', '--system', '--get-all', 'credential.helper'], { cwd: gitRootPath })
  ]);

  const value = local.stdout || global.stdout || system.stdout || '';
  const scope = local.stdout ? 'local' : global.stdout ? 'global' : system.stdout ? 'system' : 'none';

  return {
    configured: Boolean(value),
    value,
    scope
  };
};

const getSshKeyStatus = () => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const keyNames = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa'];

  const keys = keyNames
    .map((name) => ({
      name,
      privateKeyPath: path.join(sshDir, name),
      publicKeyPath: path.join(sshDir, `${name}.pub`)
    }))
    .filter((key) => fs.existsSync(key.privateKeyPath) || fs.existsSync(key.publicKeyPath))
    .map((key) => ({
      name: key.name,
      hasPrivateKey: fs.existsSync(key.privateKeyPath),
      hasPublicKey: fs.existsSync(key.publicKeyPath),
      publicKeyPath: key.publicKeyPath
    }));

  return {
    sshDir,
    hasSshDir: fs.existsSync(sshDir),
    hasKeys: keys.some((key) => key.hasPrivateKey),
    keys
  };
};

const getPublicSshKey = async () => {
  const ssh = getSshKeyStatus();
  const key = ssh.keys.find((item) => item.name === 'id_ed25519' && item.hasPublicKey)
    || ssh.keys.find((item) => item.hasPublicKey);

  if (!key) {
    return '';
  }

  return fs.promises.readFile(key.publicKeyPath, 'utf8').then((value) => value.trim()).catch(() => '');
};

const getSshVersion = async () => {
  const result = await runSystemCommand('ssh', ['-V'], { timeout: 5000 });

  return {
    available: result.ok || /openssh/i.test(result.message),
    version: result.message || result.stderr || result.stdout || '',
    message: result.message
  };
};

const getKnownHostStatus = async ({ host, port }) => {
  if (!host) {
    return {
      checked: false,
      configured: false,
      host: '',
      port: '',
      message: 'No SSH host detected.'
    };
  }

  const lookupHost = port && port !== '22' ? `[${host}]:${port}` : host;
  const args = ['-F', lookupHost, '-f', path.join(os.homedir(), '.ssh', 'known_hosts')];

  const result = await runSystemCommand('ssh-keygen', args, { timeout: 5000 });

  return {
    checked: true,
    configured: result.ok,
    host,
    port: port || '22',
    message: result.ok ? 'Host key is already trusted.' : 'Host key is not in known_hosts.'
  };
};

const getWindowsLongPathsStatus = async () => {
  if (process.platform !== 'win32') {
    return {
      platform: process.platform,
      checked: false,
      enabled: null,
      requiresAdmin: false,
      message: 'Windows long paths are only relevant on Windows.'
    };
  }

  const result = await runSystemCommand('reg', [
    'query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
    '/v',
    'LongPathsEnabled'
  ], { timeout: 5000 });

  const enabled = /\bLongPathsEnabled\b[\s\S]*0x1\b/i.test(`${result.stdout}\n${result.stderr}`);

  return {
    platform: process.platform,
    checked: result.ok,
    enabled,
    requiresAdmin: !enabled,
    message: enabled ? 'Windows long paths are enabled.' : 'Windows long paths are disabled or could not be verified.'
  };
};

const getGitConfigValue = async (gitRootPath, scope, key) => {
  const result = await runGitCommand(['config', scope, '--get', key], { cwd: gitRootPath });
  return {
    configured: Boolean(result.stdout),
    value: result.stdout || '',
    message: result.stdout || result.message
  };
};

const classifyAuthError = (message = '') => {
  const lower = message.toLowerCase();

  if (lower.includes('authentication failed') || lower.includes('could not read username') || lower.includes('terminal prompts disabled')) {
    return 'https-auth-required';
  }
  if (lower.includes('permission denied') && lower.includes('publickey')) {
    return 'ssh-key-required';
  }
  if (lower.includes('host key verification failed')) {
    return 'ssh-host-key';
  }
  if (lower.includes('repository not found') || lower.includes('not found')) {
    return 'not-found-or-no-access';
  }
  if (lower.includes('could not resolve hostname') || lower.includes('could not resolve host') || lower.includes('name or service not known')) {
    return 'network-or-dns';
  }
  if (lower.includes('timed out')) {
    return 'timeout';
  }

  return 'unknown';
};

const getGitAuthDiagnostics = async ({ gitRootPath, remote = 'origin', remoteUrl = '' }) => {
  const remotes = gitRootPath ? await fetchRemotes(gitRootPath).catch(() => []) : [];
  const selectedRemote = remotes.find((item) => item.name === remote) || remotes[0];
  const url = remoteUrl || selectedRemote?.refs?.fetch || '';
  const protocol = detectRemoteProtocol(url);
  const provider = detectGitProvider(url);

  const [credentialHelper, ssh] = await Promise.all([
    gitRootPath ? getCredentialHelper(gitRootPath) : Promise.resolve({ configured: false, value: '', scope: 'none' }),
    Promise.resolve(getSshKeyStatus())
  ]);

  return {
    remote,
    remoteUrl: url,
    protocol,
    provider,
    credentialHelper,
    ssh,
    helpLinks: getProviderHelpLinks(provider.id)
  };
};

const testGitAuthentication = async ({ gitRootPath, remote = 'origin', remoteUrl = '' }) => {
  const diagnostics = await getGitAuthDiagnostics({ gitRootPath, remote, remoteUrl });

  if (!diagnostics.remoteUrl) {
    return {
      ...diagnostics,
      ok: false,
      errorType: 'no-remote',
      message: 'Remote URL is not configured.'
    };
  }

  const result = await runGitCommand(['ls-remote', '--heads', diagnostics.remoteUrl], {
    cwd: gitRootPath,
    timeout: 20000
  });

  return {
    ...diagnostics,
    ok: result.ok,
    errorType: result.ok ? null : classifyAuthError(result.message),
    message: result.ok ? 'Connection test succeeded.' : (result.message || 'Connection test failed.')
  };
};

const getWorkspaceGitSetupDiagnostics = async ({ gitRootPath, remote = 'origin', remoteUrl = '' }) => {
  const remotes = gitRootPath ? await fetchRemotes(gitRootPath).catch(() => []) : [];
  const selectedRemote = remotes.find((item) => item.name === remote) || remotes[0];
  const url = remoteUrl || selectedRemote?.refs?.fetch || '';
  const remoteInfo = getRemoteConnectionInfo(url);
  const provider = detectGitProvider(url);
  const isSshRemote = remoteInfo.protocol === 'ssh';

  const [
    gitVersion,
    sshVersion,
    ssh,
    publicKey,
    gitUserName,
    gitUserEmail,
    gitLongPathsGlobal,
    gitLongPathsSystem,
    windowsLongPaths
  ] = await Promise.all([
    getGitVersion(),
    getSshVersion(),
    Promise.resolve(getSshKeyStatus()),
    getPublicSshKey(),
    getGitConfigValue(gitRootPath, '--global', 'user.name'),
    getGitConfigValue(gitRootPath, '--global', 'user.email'),
    getGitConfigValue(gitRootPath, '--global', 'core.longpaths'),
    getGitConfigValue(gitRootPath, '--system', 'core.longpaths'),
    getWindowsLongPathsStatus()
  ]);

  const knownHost = isSshRemote
    ? await getKnownHostStatus({ host: remoteInfo.host, port: remoteInfo.port })
    : {
        checked: false,
        configured: true,
        host: '',
        port: '',
        message: 'Known hosts are only needed for SSH remotes.'
      };

  const gitLongPathsEnabled = /^true$/i.test(gitLongPathsGlobal.value) || /^true$/i.test(gitLongPathsSystem.value);
  const gitAvailable = Boolean(gitVersion);

  return {
    platform: process.platform,
    remote,
    remoteUrl: url,
    remoteInfo,
    protocol: remoteInfo.protocol,
    provider,
    helpLinks: getProviderHelpLinks(provider.id),
    git: {
      available: gitAvailable,
      version: gitVersion || '',
      message: gitAvailable ? gitVersion : getGitInstallHelpMessage()
    },
    sshClient: {
      available: sshVersion.available,
      version: sshVersion.version,
      required: isSshRemote,
      message: sshVersion.available ? sshVersion.version : 'OpenSSH client was not found.'
    },
    sshKey: {
      ...ssh,
      required: isSshRemote,
      publicKey,
      preferredPublicKeyPath: path.join(os.homedir(), '.ssh', 'id_ed25519.pub')
    },
    knownHost: {
      ...knownHost,
      required: isSshRemote
    },
    gitIdentity: {
      name: gitUserName.value,
      email: gitUserEmail.value,
      configured: Boolean(gitUserName.value && gitUserEmail.value),
      message: gitUserName.value && gitUserEmail.value ? 'Git identity is configured.' : 'Git user.name and user.email are required for commits.'
    },
    gitLongPaths: {
      configured: gitLongPathsEnabled,
      global: gitLongPathsGlobal.value,
      system: gitLongPathsSystem.value,
      message: gitLongPathsEnabled ? 'Git long paths are enabled.' : 'Git long paths are not enabled.'
    },
    windowsLongPaths,
    connectionTest: {
      ready: Boolean(url && gitAvailable && (!isSshRemote || (sshVersion.available && ssh.hasKeys && knownHost.configured))),
      protocol: remoteInfo.protocol
    },
    adminCommands: [
      'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
      'New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force',
      'git config --system core.longpaths true'
    ]
  };
};

const createGitSshKey = async ({ email = '' } = {}) => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const privateKeyPath = path.join(sshDir, 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
    return {
      created: false,
      privateKeyPath,
      publicKeyPath,
      publicKey: await fs.promises.readFile(publicKeyPath, 'utf8').then((value) => value.trim()).catch(() => ''),
      message: 'An id_ed25519 SSH key already exists. Gridman did not overwrite it.'
    };
  }

  await fs.promises.mkdir(sshDir, { recursive: true, mode: 0o700 });

  const result = await runSystemCommand('ssh-keygen', [
    '-t',
    'ed25519',
    '-C',
    email || 'gridman-user',
    '-f',
    privateKeyPath,
    '-N',
    ''
  ], { timeout: 20000 });

  if (!result.ok) {
    throw new Error(result.message || 'Failed to create SSH key.');
  }

  return {
    created: true,
    privateKeyPath,
    publicKeyPath,
    publicKey: await fs.promises.readFile(publicKeyPath, 'utf8').then((value) => value.trim()).catch(() => ''),
    message: 'SSH key created.'
  };
};

const scanGitKnownHost = async ({ host, port }) => {
  if (!host) {
    throw new Error('SSH host is required.');
  }

  const args = [];
  if (port && port !== '22') {
    args.push('-p', String(port));
  }
  args.push(host);

  const result = await runSystemCommand('ssh-keyscan', args, { timeout: 15000 });

  if (!result.ok || !result.stdout) {
    throw new Error(result.message || 'Failed to scan SSH host key.');
  }

  return {
    host,
    port: port || '22',
    hostKey: result.stdout
  };
};

const addGitKnownHost = async ({ host, port, hostKey }) => {
  const scan = hostKey ? { host, port: port || '22', hostKey } : await scanGitKnownHost({ host, port });
  const sshDir = path.join(os.homedir(), '.ssh');
  const knownHostsPath = path.join(sshDir, 'known_hosts');
  const currentContent = await fs.promises.readFile(knownHostsPath, 'utf8').catch(() => '');
  const nextLines = scan.hostKey
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !currentContent.includes(line));

  if (!nextLines.length) {
    return {
      added: false,
      knownHostsPath,
      message: 'Host key is already present in known_hosts.'
    };
  }

  await fs.promises.mkdir(sshDir, { recursive: true, mode: 0o700 });
  await fs.promises.appendFile(
    knownHostsPath,
    `${currentContent.endsWith('\n') || !currentContent ? '' : '\n'}${nextLines.join('\n')}\n`,
    'utf8'
  );

  return {
    added: true,
    knownHostsPath,
    message: 'Host key added to known_hosts.'
  };
};

const setGitIdentity = async ({ gitRootPath, name, email }) => {
  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim();

  if (!trimmedName || !trimmedEmail) {
    throw new Error('Git user name and email are required.');
  }

  const nameResult = await runGitCommand(['config', '--global', 'user.name', trimmedName], { cwd: gitRootPath });
  const emailResult = await runGitCommand(['config', '--global', 'user.email', trimmedEmail], { cwd: gitRootPath });

  if (!nameResult.ok || !emailResult.ok) {
    throw new Error(nameResult.message || emailResult.message || 'Failed to save Git identity.');
  }

  return {
    name: trimmedName,
    email: trimmedEmail,
    message: 'Git identity saved.'
  };
};

const enableGitGlobalLongPaths = async ({ gitRootPath }) => {
  const result = await runGitCommand(['config', '--global', 'core.longpaths', 'true'], { cwd: gitRootPath });

  if (!result.ok) {
    throw new Error(result.message || 'Failed to enable Git long paths.');
  }

  return {
    message: 'Git global core.longpaths enabled.'
  };
};

const testGitSshConnection = async ({ gitRootPath, remote = 'origin', remoteUrl = '' }) => {
  const diagnostics = await getWorkspaceGitSetupDiagnostics({ gitRootPath, remote, remoteUrl });

  if (!diagnostics.remoteUrl) {
    return { ...diagnostics, ok: false, errorType: 'no-remote', message: 'Remote URL is not configured.' };
  }

  if (diagnostics.protocol === 'ssh') {
    const { host, port, user } = diagnostics.remoteInfo;
    const args = ['-T', '-o', 'BatchMode=yes'];
    if (port && port !== '22') {
      args.push('-p', String(port));
    }
    args.push(`${user || 'git'}@${host}`);

    const result = await runSystemCommand('ssh', args, { cwd: gitRootPath, timeout: 20000 });
    const message = result.message || result.stderr || result.stdout || '';
    const accepted = result.ok || /successfully authenticated|welcome|authenticated/i.test(message);

    return {
      ...diagnostics,
      ok: accepted,
      errorType: accepted ? null : classifyAuthError(message),
      message: accepted ? 'SSH connection test succeeded.' : (message || 'SSH connection test failed.')
    };
  }

  return testGitAuthentication({ gitRootPath, remote, remoteUrl: diagnostics.remoteUrl });
};

const getWorkspaceGitTargetPath = ({ workspacePath }) => {
  return workspacePath;
};

const getCollectionGitRepoUrl = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.listRemote(['--get-url', 'origin'], (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data.trim());
    });
  });
};

const initGit = async (gitRootPath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  await git.init();
  // Create and checkout main branch -> This is specific for use with Bruno
  return await git.raw(['branch', '-M', 'main']);
};

const ensureWorkspaceGitFiles = async (workspacePath) => {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  const defaultGitignoreLines = `${DEFAULT_GITIGNORE}\n`
    .split('\n')
    .map((line) => line.trimEnd());

  if (fs.existsSync(gitignorePath)) {
    const currentGitignore = await fs.promises.readFile(gitignorePath, 'utf8');
    const currentLines = currentGitignore.split('\n').map((line) => line.trimEnd());
    const missingLines = defaultGitignoreLines.filter((line) => !currentLines.includes(line));

    if (missingLines.length) {
      const nextContent = [
        currentGitignore.trimEnd(),
        currentGitignore.trim().length ? '' : null,
        ...missingLines
      ].filter((line) => line !== null).join('\n');

      await fs.promises.writeFile(gitignorePath, `${nextContent}\n`, 'utf8');
    }
  } else {
    await fs.promises.writeFile(gitignorePath, `${DEFAULT_GITIGNORE}\n`, 'utf8');
  }
};

const normalizeWorkspaceGitInput = (input) => {
  if (typeof input === 'string') {
    return { workspacePath: input, collectionPaths: [], preferCollectionParent: false, fetchRemote: false, remote: 'origin' };
  }

  return {
    workspacePath: input?.workspacePath,
    collectionPaths: input?.collectionPaths || [],
    preferCollectionParent: Boolean(input?.preferCollectionParent),
    fetchRemote: Boolean(input?.fetchRemote),
    remote: input?.remote || 'origin'
  };
};

const initWorkspaceGit = async (input) => {
  const { workspacePath, collectionPaths, preferCollectionParent } = normalizeWorkspaceGitInput(input);

  if (!workspacePath) {
    throw new Error('Workspace path is required');
  }
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  const gitTargetPath = getWorkspaceGitTargetPath({ workspacePath, collectionPaths, preferCollectionParent });

  if (!fs.existsSync(gitTargetPath)) {
    throw new Error(`Git target path does not exist: ${gitTargetPath}`);
  }

  const existingGitRootPath = getWorkspaceGitRootPath(gitTargetPath);
  if (existingGitRootPath) {
    await ensureWorkspaceGitFiles(existingGitRootPath);
    return getWorkspaceGitData({ workspacePath, collectionPaths, preferCollectionParent });
  }

  await ensureWorkspaceGitFiles(gitTargetPath);
  await initGit(gitTargetPath);
  collectionPathToGitRootPathMap.delete(gitTargetPath);
  return getWorkspaceGitData({ workspacePath, collectionPaths, preferCollectionParent });
};

const stageChanges = async (gitRootPath, files) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.add(files, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isGitIndexLockError = (error) => {
  const message = getGitErrorMessage(error);
  return message.includes('index.lock') || message.includes('Another git process seems to be running');
};

const runGitRawWithIndexLockRetry = async (git, args, attempts = 6) => {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await git.raw(args);
    } catch (error) {
      lastError = error;
      if (!isGitIndexLockError(error) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(500);
    }
  }

  throw lastError;
};

const stageRelativeFiles = async (gitRootPath, files) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const pathspecPath = path.join(gitRootPath, '.git', `bruno-pathspec-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  try {
    fs.writeFileSync(pathspecPath, `${files.join('\0')}\0`, 'utf8');
    await runGitRawWithIndexLockRetry(git, [
      'add',
      '--all',
      '--pathspec-from-file',
      pathspecPath,
      '--pathspec-file-nul'
    ]);
  } finally {
    fs.rmSync(pathspecPath, { force: true });
  }
};

const unstageChanges = async (gitRootPath, files) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);

    // First check the status to see which files are actually staged
    git.status(['--porcelain'], (err, status) => {
      if (err) {
        reject(err);
        return;
      }

      // Filter files to only include those that are actually staged
      const stagedFiles = files.filter((fullPath) => {
        const relativePath = path.relative(gitRootPath, fullPath);
        // Normalize path separators for cross-platform compatibility
        const normalizedPath = relativePath.replace(/\\/g, '/');
        return status.files.some((file) =>
          file.path === normalizedPath
          && (file.index === 'M' || file.index === 'A' || file.index === 'D')
        );
      });

      // If no files are actually staged, just resolve
      if (stagedFiles.length === 0) {
        resolve();
        return;
      }

      // Unstage only the files that are actually staged
      git.reset(['HEAD', '--', ...stagedFiles], (err, res) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  });
};

// Which conflict stages exist for a path: 2 = "ours", 3 = "theirs". A plain
// content conflict has both; a modify/delete conflict has only one.
const getConflictStages = async (git, filePath) => {
  let raw = '';
  try {
    raw = String(await git.raw(['ls-files', '-u', '--', filePath]) || '');
  } catch (_err) {
    return new Set();
  }
  const stages = new Set();
  for (const line of raw.split('\n')) {
    // format: "<mode> <sha> <stage>\t<path>"
    const stage = line.trim().split(/\s+/)[2];
    if (stage) {
      stages.add(stage);
    }
  }
  return stages;
};

const resolveConflictFile = async (gitRootPath, filePath, side) => {
  if (side !== 'ours' && side !== 'theirs') {
    throw new Error('Invalid conflict resolution side');
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);

  // MODIFY/DELETE conflicts (one side deleted the file, the other changed it)
  // have no blob for the deleting side, and `git checkout --ours|--theirs`
  // fails with "path '<file>' does not have their/our version" — reported by a
  // user after a folder was deleted/renamed on one side while edited on the
  // other. Choosing the side that deleted the file means ACCEPT THE DELETION.
  const stages = await getConflictStages(git, filePath);
  const wantedStage = side === 'ours' ? '2' : '3';
  if (stages.size && !stages.has(wantedStage)) {
    await git.raw(['rm', '-f', '--', filePath]);
    return { path: filePath, side, deleted: true };
  }

  await git.raw(['checkout', `--${side}`, '--', filePath]);
  await stageChanges(gitRootPath, [path.join(gitRootPath, filePath)]);
  return { path: filePath, side, deleted: false };
};

const discardChanges = async (gitRootPath, filePaths) => {
  return new Promise(async (resolve, reject) => {
    try {
      const git = getSimpleGitInstanceForPath(gitRootPath);

      // Get current git status to categorize files
      git.status(['--porcelain'], async (err, status) => {
        if (err) {
          reject(err);
          return;
        }

        // Create a map of file paths to their status
        const fileStatusMap = {};
        status.files.forEach((file) => {
          fileStatusMap[file.path] = file;
        });

        // Categorize files based on their git status
        const trackedFiles = [];
        const untrackedFiles = [];

        filePaths.forEach((filePath) => {
          // Normalize paths for comparison
          const relativePath = filePath.startsWith(gitRootPath)
            ? path.relative(gitRootPath, filePath) : filePath;

          // Normalize path separators for cross-platform compatibility
          const normalizedPath = relativePath.replace(/\\/g, '/');
          const fileStatus = fileStatusMap[normalizedPath];

          // If the file is untracked, we need to delete it from the filesystem
          // ? means untracked
          if (fileStatus && fileStatus.working_dir === '?') {
            // Untracked file - needs to be deleted from filesystem
            untrackedFiles.push(filePath);
          } else if (fileStatus) {
            // Tracked file - can be discarded with git checkout
            trackedFiles.push(filePath);
          } else {
            // File not in status - might be already deleted, renamed, or doesn't exist
            console.warn(`File not found in git status: ${relativePath}. File may have been already deleted or moved.`);

            // Check if it's an absolute path that needs to be treated as untracked
            if (filePath.startsWith(gitRootPath) && fs.existsSync(filePath)) {
              console.log(`Treating unknown file as untracked: ${relativePath}`);
              untrackedFiles.push(filePath);
            }
          }
        });

        // Handle tracked and untracked files sequentially
        try {
          // Handle tracked files with git checkout
          if (trackedFiles.length > 0) {
            await new Promise((checkoutResolve, checkoutReject) => {
              git.checkout(trackedFiles, (err, res) => {
                if (err) {
                  console.error('Error discarding tracked files:', err);
                  checkoutReject(err);
                } else {
                  console.log(`Discarded ${trackedFiles.length} tracked files`);
                  checkoutResolve(res);
                }
              });
            });
          }

          // Handle untracked files by deleting them from filesystem
          if (untrackedFiles.length > 0) {
            for (const filePath of untrackedFiles) {
              const fullPath = filePath.startsWith(gitRootPath) ? filePath : path.join(gitRootPath, filePath);

              // Check if file exists before trying to delete
              if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
                console.log(`Deleted untracked file: ${fullPath}`);
              }
            }
          }

          resolve({
            trackedFilesDiscarded: trackedFiles.length,
            untrackedFilesDeleted: untrackedFiles.length
          });
        } catch (discardError) {
          console.error('Error during discard operation:', discardError);
          reject(discardError);
        }
      });
    } catch (gitStatusError) {
      reject(gitStatusError);
    }
  });
};

const commitChanges = async (gitRootPath, message) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.commit(message, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
};

const getStagedFileDiff = async (gitRootPath, filePath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.diff(['--no-prefix', '--staged', '--', filePath], (err, stagedChanges) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stagedChanges);
    });
  });
};

const getRenamedFileDiff = async (gitRootPath, file) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.diff(['--staged', '--', file.from, file.to], (err, stagedChanges) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stagedChanges);
    });
  });
};

const getUnstagedFileDiff = async (gitRootPath, filePath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);

    git.status((err, status) => {
      if (err) {
        reject(err);
        return;
      }

      const isFileTracked = status.files.some((file) => {
        const statusFilePath = path.join(gitRootPath, file.path);
        return filePath === statusFilePath && file.index !== '?' && file.working_dir !== '?';
      });

      if (isFileTracked) {
        git.diff(['--no-prefix', '--diff-filter=ACMD', '--', filePath], (err, tracked) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(tracked);
        });
      } else {
        fs.readFile(filePath, 'utf8', (err, content) => {
          if (err) {
            reject(err);
            return;
          }

          const prefixedLines = content
            .split('\n')
            .map((line) => `+${line}`);
          const lineCount = prefixedLines.length;
          const lines = prefixedLines.join('\n');

          let diff
            = [
              `diff --git a/${filePath} b/${filePath}`,
              `new file mode 100644`,
              `--- a/${filePath}`,
              `+++ b/${filePath}`,
              `@@ -0,0 +1,${lineCount} @@`,
              `${lines}`
            ].join('\n') + '\n';

          resolve(diff);
        });
      }
    });
  });
};

const getCollectionGitBranches = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.branchLocal((err, branches) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(branches.all);
    });
  });
};

const getCurrentGitBranch = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.branchLocal((err, branches) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(branches.current);
    });
  });
};

const getDefaultGitBranch = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.raw(['symbolic-ref', '--short', 'HEAD'], (err, branch) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(branch.trim());
    });
  });
};

const getRemoteDefaultBranch = async ({ gitRootPath, remote = 'origin' }) => {
  if (!remote) {
    return '';
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);

  try {
    const branch = await git.raw(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    return branch.trim().replace(new RegExp(`^${remote}/`), '');
  } catch (_) {
  }

  try {
    const remoteInfo = await git.raw(['ls-remote', '--symref', remote, 'HEAD']);
    const match = remoteInfo.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    return match?.[1] || '';
  } catch (_) {
    return '';
  }
};

const getGitBranchMetadata = async ({ gitRootPath, remote = 'origin' }) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const [status, localBranches, remoteBranches, remoteDefaultBranch] = await Promise.all([
    getGitStatus(gitRootPath),
    getCollectionGitBranches(gitRootPath).catch(() => []),
    fetchRemoteBranches({ gitRootPath, remote }).catch(() => []),
    getRemoteDefaultBranch({ gitRootPath, remote }).catch(() => '')
  ]);
  const currentBranch = status.current || await getCurrentGitBranch(gitRootPath).catch(() => '');
  const trackingBranch = status.tracking || '';

  return {
    currentBranch,
    trackingBranch,
    remoteDefaultBranch: remoteDefaultBranch || 'main',
    localBranches,
    remoteBranches,
    hasUpstream: Boolean(trackingBranch),
    canPublishCurrentBranch: Boolean(currentBranch && !trackingBranch),
    upstreamRemote: trackingBranch.includes('/') ? trackingBranch.split('/')[0] : remote,
    upstreamBranch: trackingBranch.includes('/') ? trackingBranch.split('/').slice(1).join('/') : ''
  };
};

const getTrackingTarget = async ({ gitRootPath, remote = 'origin', remoteBranch }) => {
  const status = await getGitStatus(gitRootPath);
  const currentBranch = status.current || await getCurrentGitBranch(gitRootPath).catch(() => '');

  if (remoteBranch) {
    return { remote, branch: remoteBranch, currentBranch, trackingBranch: status.tracking || '' };
  }

  if (status.tracking) {
    const [trackingRemote, ...trackingBranchParts] = status.tracking.split('/');
    return {
      remote: trackingRemote || remote,
      branch: trackingBranchParts.join('/'),
      currentBranch,
      trackingBranch: status.tracking
    };
  }

  throw new Error(`Branch ${currentBranch || 'HEAD'} is not published. Publish the branch or set an upstream before pulling, pushing, or syncing.`);
};

const checkoutGitBranch = async (win, { gitRootPath, branchName, processUid, shouldCreate = false, startPoint = '' }) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.outputHandler(handleGitOutput({ win, processUid }));

    const checkoutArgs = shouldCreate
      ? ['--progress', '--no-track', '-b', branchName, ...(startPoint ? [startPoint] : [])]
      : branchName;
    git.checkout(checkoutArgs, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
};

const mergeGitBranch = async (win, { gitRootPath, processUid, branchName, noFastForward = false }) => {
  const sourceBranch = String(branchName || '').trim();
  if (!sourceBranch) {
    throw new Error('A branch to merge from is required.');
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);
  git.outputHandler(handleGitOutput({ win, processUid, sendStdout: true }));
  await ensureWindowsGitLongPaths(gitRootPath);

  const currentBranch = await getCurrentGitBranch(gitRootPath).catch(() => '');
  if (currentBranch && currentBranch === sourceBranch) {
    throw new Error(`"${sourceBranch}" is the current branch. Choose a different branch to merge from.`);
  }

  const mergeArgs = ['merge'];
  if (process.platform === 'win32') {
    mergeArgs.unshift('-c', 'core.longpaths=true');
  }
  if (noFastForward) {
    mergeArgs.push('--no-ff');
  }
  mergeArgs.push(sourceBranch);

  try {
    const result = await git.raw(mergeArgs);
    notifyWorkspaceConfigUpdated(win, gitRootPath);
    return {
      merged: true,
      mergeInProgress: false,
      sourceBranch,
      currentBranch,
      message: (typeof result === 'string' && result.trim())
        ? result.trim()
        : `Merged ${sourceBranch} into ${currentBranch || 'current branch'}.`
    };
  } catch (err) {
    const message = getGitErrorMessage(err, `Failed to merge ${sourceBranch}.`);

    if (isWindowsLongPathError(message)) {
      await ensureWindowsGitLongPaths(gitRootPath);
      throw new Error(getWindowsLongPathsHelpMessage(message));
    }

    const mergeInProgress = fs.existsSync(path.join(gitRootPath, '.git', 'MERGE_HEAD'));
    if (
      mergeInProgress
      || message.includes('CONFLICT')
      || message.includes('Automatic merge failed')
      || message.includes('unresolved conflict')
    ) {
      // Surface the same conflict state pull uses so the existing
      // resolve/abort/continue flow takes over.
      return {
        merged: false,
        mergeInProgress: true,
        sourceBranch,
        currentBranch,
        message
      };
    }

    throw createGitError(err, `Failed to merge ${sourceBranch}.`);
  }
};

const publishGitBranch = async (win, { gitRootPath, processUid, remote = 'origin', branchName }) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  git.outputHandler(handleGitOutput({ win, processUid, sendStdout: true }));
  const branch = branchName || await getCurrentGitBranch(gitRootPath);
  if (!branch) {
    throw new Error('Current branch could not be detected.');
  }
  return git.push(['--set-upstream', remote, branch]);
};

const setGitBranchUpstream = async ({ gitRootPath, remote = 'origin', branchName, remoteBranch }) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const localBranch = branchName || await getCurrentGitBranch(gitRootPath);
  const targetBranch = remoteBranch || localBranch;
  if (!localBranch || !targetBranch) {
    throw new Error('Local and remote branch are required to set upstream.');
  }
  return git.raw(['branch', '--set-upstream-to', `${remote}/${targetBranch}`, localBranch]);
};

const ensureWorkspaceGitBranch = async ({ gitRootPath, branchName }) => {
  const branch = String(branchName || '').trim();
  if (!branch) {
    return null;
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);
  await git.raw(['check-ref-format', '--branch', branch]);

  const currentBranch = await getCurrentGitBranch(gitRootPath).catch(() => '');
  if (currentBranch === branch) {
    return currentBranch;
  }

  const hasCommits = await hasGitCommits(gitRootPath);
  if (!hasCommits) {
    await git.raw(['branch', '-M', branch]);
    return branch;
  }

  const localBranches = await getCollectionGitBranches(gitRootPath).catch(() => []);
  if (localBranches.includes(branch)) {
    await git.checkout(branch);
    return branch;
  }

  await git.checkout(['-b', branch]);
  return branch;
};

const checkoutRemoteGitBranch = async (win, { gitRootPath, remoteName, branchName, processUid }) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.outputHandler(handleGitOutput({ win, processUid }));

    const remoteBranchName = `${remoteName}/${branchName}`;

    // Check if the remote branch exists
    git.branch(['-r'], async (err, branches) => {
      if (err) {
        reject(err);
        return;
      }

      const remoteBranches = branches.all.map((branch) => branch.trim());
      const remoteBranchExists = remoteBranches.includes(remoteBranchName);

      if (remoteBranchExists) {
        try {
          const localBranches = await getCollectionGitBranches(gitRootPath);
          const localBranchExists = localBranches.includes(branchName);
          if (localBranchExists) {
            // Set the local branch to track the remote branch
            git.branch(['--set-upstream-to', remoteBranchName, branchName], async (err, res) => {
              if (err) {
                reject(err);
              } else {
                git.checkout(branchName, (err, res) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve(res);
                  }
                });
              }
            });
          } else {
            git.checkout(['-b', branchName, '--track', remoteBranchName, '--progress'], (err, res) => {
              if (err) {
                reject(err);
              } else {
                resolve(res);
              }
            });
          }
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`Remote branch ${remoteBranchName} does not exist`));
      }
    });
  });
};

const getCollectionGitLogs = async (gitRootPath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);

  try {
    // Get logs with shortstat for file change info
    const result = await git.raw([
      'log',
      '--format=%H|%s|%an|%aI',
      '--shortstat',
      '-n', '500'
    ]);

    if (!result || !result.trim()) {
      return [];
    }

    const commits = [];
    const lines = result.split('\n');
    let currentCommit = null;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Check if this is a commit line (contains | separators)
      if (trimmedLine.includes('|')) {
        // If we have a pending commit, push it
        if (currentCommit) {
          commits.push(currentCommit);
        }

        const parts = trimmedLine.split('|');
        if (parts.length >= 4) {
          currentCommit = {
            hash: parts[0],
            message: parts[1],
            author_name: parts[2],
            date: parts[3],
            filesChanged: 0,
            insertions: 0,
            deletions: 0
          };
        }
      } else if (currentCommit && trimmedLine.includes('changed')) {
        // This is a shortstat line, parse it
        // Format: " 3 files changed, 45 insertions(+), 12 deletions(-)"
        const filesMatch = trimmedLine.match(/(\d+) files? changed/);
        const insertionsMatch = trimmedLine.match(/(\d+) insertions?\(\+\)/);
        const deletionsMatch = trimmedLine.match(/(\d+) deletions?\(-\)/);

        if (filesMatch) currentCommit.filesChanged = parseInt(filesMatch[1], 10);
        if (insertionsMatch) currentCommit.insertions = parseInt(insertionsMatch[1], 10);
        if (deletionsMatch) currentCommit.deletions = parseInt(deletionsMatch[1], 10);
      }
    }

    // Push the last commit if exists
    if (currentCommit) {
      commits.push(currentCommit);
    }

    return commits;
  } catch (err) {
    console.error('Error getting git logs:', err);
    return [];
  }
};

const getCollectionGitTagsWithDetails = (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git
      .tags(['-l', '--format=%(refname:short)||%(creatordate)||%(creator)'])
      .then((tags) => {
        const tagDetails = tags.all?.map((tag) => {
          const [name, date, author] = tag.split('||');
          return { name, date, author };
        });
        resolve(tagDetails);
      })
      .catch(reject);
  });
};

const canPush = async (gitRootPath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
  const remote = await git.listRemote(['--get-url', 'origin']);

  if (!remote) {
    throw new Error('Remote not configured');
  }

  const remoteInfo = await git.lsRemote(['--refs', remote]);
  const logs = await git.log({ maxCount: 1 });
  const localHead = logs.latest.hash;
  const remoteRefs = remoteInfo.split('\n');
  const remoteHeads = remoteRefs.reduce((acc, ref) => {
    const [hash, refName] = ref.split('\t');
    acc[refName.replace('refs/heads/', '')] = hash;
    return acc;
  }, {});
  const remoteHead = remoteHeads[branch];

  if (localHead === remoteHead) {
    return false;
  }

  return true;
};

const pushGitChanges = async (win, { gitRootPath, processUid, remote = 'origin', remoteBranch }) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const trackingTarget = await getTrackingTarget({ gitRootPath, remote, remoteBranch });

  // Check if the local branch exists before pushing
  const branchSummary = await new Promise((resolve, reject) => {
    git.branch((err, summary) => (err ? reject(err) : resolve(summary)));
  });

  if (!branchSummary.branches[trackingTarget.currentBranch]) {
    throw new Error(`Branch ${trackingTarget.currentBranch} does not exist.`);
  }

  // Spawned directly (not through simple-git) so the push can stream
  // --progress output to the renderer and be cancelled by processUid.
  const result = await runCancellableGitCommand({
    binary: ensureGitAvailable(),
    args: ['push', '--progress', trackingTarget.remote, trackingTarget.branch],
    cwd: gitRootPath,
    processUid,
    win
  });

  return (result.stderr || result.stdout || '').trim();
};

const pullGitChanges = async (win, data) => {
  const { gitRootPath, processUid, remote, remoteBranch, strategy } = data;
  if (strategy !== '--no-rebase' && strategy !== '--ff-only') {
    throw new Error('Invalid strategy');
  }

  const getMergeConflictResult = (err) => {
    const mergeInProgress = fs.existsSync(path.join(gitRootPath, '.git', 'MERGE_HEAD'));
    const message = getGitErrorMessage(err, 'Merge conflicts need to be resolved before sync can continue.');

    if (
      mergeInProgress
      || message.includes('CONFLICT')
      || message.includes('Automatic merge failed')
      || message.includes('unresolved conflict')
    ) {
      return {
        mergeInProgress: true,
        message
      };
    }

    return null;
  };

  const trackingTarget = await getTrackingTarget({ gitRootPath, remote, remoteBranch });

  // Spawned directly (not through simple-git) so the pull can stream
  // --progress output to the renderer and be cancelled by processUid.
  const pull = async (args) => {
    const command = ['-c', 'core.quotePath=false'];
    if (process.platform === 'win32') {
      command.push('-c', 'core.longpaths=true');
    }
    command.push('pull', '--progress', trackingTarget.remote, trackingTarget.branch, ...args);

    const result = await runCancellableGitCommand({
      binary: ensureGitAvailable(),
      args: command,
      cwd: gitRootPath,
      processUid,
      win
    });
    return result.stdout;
  };

  await ensureWindowsGitLongPaths(gitRootPath);

  let allowUnrelatedHistories = false;
  const safetyCommitFiles = [];
  const protectedBackupFiles = [];
  const localBackupFiles = [];
  let protectedBackupPath = '';
  let localBackupPath = '';
  const initialSafetyCommit = await saveLocalWorkspaceFilesBeforePull(gitRootPath);

  if (initialSafetyCommit.skippedFiles.length) {
    throw new Error([
      'Git pull would overwrite local files that Gridman will not auto-commit.',
      'Move, delete, or manually commit these files before pulling:',
      ...initialSafetyCommit.skippedFiles
    ].join('\n'));
  }

  if (initialSafetyCommit.committed) {
    safetyCommitFiles.push(...initialSafetyCommit.files);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const args = allowUnrelatedHistories ? [strategy, '--allow-unrelated-histories'] : [strategy];
      const result = await pull(args);
      notifyWorkspaceConfigUpdated(win, gitRootPath);
      return safetyCommitFiles.length || protectedBackupFiles.length || localBackupFiles.length
        ? {
            ...result,
            safetyCommitCreated: Boolean(safetyCommitFiles.length),
            safetyCommitFiles,
            protectedFilesBackedUp: Boolean(protectedBackupFiles.length),
            protectedBackupFiles,
            protectedBackupPath,
            localFilesBackedUp: Boolean(localBackupFiles.length),
            localBackupFiles,
            localBackupPath
          }
        : result;
    } catch (err) {
      if (err?.cancelled) {
        // User-cancelled pull. If git was killed mid-merge, MERGE_HEAD remains
        // and the next status refresh surfaces the existing conflict
        // continue/abort flow for recovery.
        throw err;
      }

      const message = getGitErrorMessage(err);

      if (isWindowsLongPathError(message)) {
        await ensureWindowsGitLongPaths(gitRootPath);
        throw new Error(getWindowsLongPathsHelpMessage(message));
      }

      if (strategy === '--no-rebase' && message.includes('refusing to merge unrelated histories') && !allowUnrelatedHistories) {
        allowUnrelatedHistories = true;
        continue;
      }

      const overwriteFiles = extractUntrackedOverwriteFiles(message);
      if (strategy === '--no-rebase' && overwriteFiles.length) {
        const protectedBackup = backupFilesBeforePull(gitRootPath, overwriteFiles, {
          protectedOnly: true
        });
        const overwriteFilesToCommit = overwriteFiles
          .map(normalizeGitPath)
          .filter((filePath) => {
            if (!filePath || isProtectedWorkspaceGitPath(filePath)) {
              return false;
            }

            const absolutePath = path.resolve(gitRootPath, filePath);
            const relativeToRoot = path.relative(gitRootPath, absolutePath);
            const isInsideGitRoot = relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
            return isInsideGitRoot && fs.existsSync(absolutePath);
          });
        const safetyCommit = await saveLocalWorkspaceFilesBeforePull(gitRootPath, overwriteFilesToCommit);

        if (protectedBackup.skippedFiles.length) {
          throw new Error([
            'Git pull would overwrite protected local files that Gridman could not back up.',
            'Move, delete, or manually commit these files before pulling:',
            ...protectedBackup.skippedFiles
          ].join('\n'));
        }

        if (safetyCommit.skippedFiles.length) {
          throw new Error([
            'Git pull would overwrite local files that Gridman will not auto-commit.',
            'Move, delete, or manually commit these files before pulling:',
            ...safetyCommit.skippedFiles
          ].join('\n'));
        }

        const localBackup = safetyCommit.committed
          ? { files: [], skippedFiles: [], backupPath: '' }
          : backupFilesBeforePull(gitRootPath, overwriteFiles, {
              protectedOnly: false,
              excludeProtected: true
            });

        if (localBackup.skippedFiles.length) {
          throw new Error([
            'Git pull would overwrite local files that Gridman could not commit or back up.',
            'Move, delete, or manually commit these files before pulling:',
            ...localBackup.skippedFiles
          ].join('\n'));
        }

        if (!safetyCommit.committed && !protectedBackup.files.length && !localBackup.files.length) {
          throw createGitError(err, 'Git pull would overwrite local files, and Gridman could not create a safety commit.');
        }

        safetyCommitFiles.push(...safetyCommit.files);
        protectedBackupFiles.push(...protectedBackup.files);
        localBackupFiles.push(...localBackup.files);
        protectedBackupPath = protectedBackup.backupPath || protectedBackupPath;
        localBackupPath = localBackup.backupPath || localBackupPath;
        allowUnrelatedHistories = true;
        continue;
      }

      const conflictResult = getMergeConflictResult(err);
      if (conflictResult) {
        notifyWorkspaceConfigUpdated(win, gitRootPath);
        return safetyCommitFiles.length || protectedBackupFiles.length || localBackupFiles.length
          ? {
              ...conflictResult,
              safetyCommitCreated: Boolean(safetyCommitFiles.length),
              safetyCommitFiles,
              protectedFilesBackedUp: Boolean(protectedBackupFiles.length),
              protectedBackupFiles,
              protectedBackupPath,
              localFilesBackedUp: Boolean(localBackupFiles.length),
              localBackupFiles,
              localBackupPath
            }
          : conflictResult;
      }

      throw createGitError(err, 'Git pull failed');
    }
  }

  throw new Error('Git pull still reports local files that would be overwritten after several safety commits. Commit or move the remaining local files, then pull again.');
};

async function getChangedFilesInCollectionGit(_gitRootPath, _collectionPath) {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(_gitRootPath);
    git.status(['--porcelain', _gitRootPath], async (err, status) => {
      if (err) {
        reject(err);
        return;
      }

      const totalFiles = status?.files?.length || 0;
      if (totalFiles > 5000) {
        return resolve({
          staged: [],
          unstaged: [],
          totalFiles,
          tooManyFiles: true
        });
      }

      const isConflictStatus = (file) => {
        const statusCode = `${file.index || ' '}${file.working_dir || ' '}`;
        return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(statusCode);
      };

      const unstaged = await Promise.all(
        status.files
          .filter(
            (file) => !isConflictStatus(file) && (file.index === '?' || file.index === ' ' || file.working_dir === '?' || file.working_dir === 'M')
          )
          .map(async (file) => {
            return { path: file.path, type: 'unstaged', fileIndex: file.index, working_dir: file.working_dir };
          })
      );

      const renamed = await Promise.all(
        status.renamed.map(async (file) => {
          return { path: file.to, to: file.to, from: file.from, type: 'renamed', fileIndex: 'R', working_dir: '' };
        })
      );

      const staged = await Promise.all(
        status.files
          .filter(
            (file) =>
              !isConflictStatus(file)
              && (file.index === 'M' || file.index === 'A' || file.index === 'D')
              && (file.working_dir === 'M' || file.working_dir === ' ')
          )
          .map(async (file) => {
            return { path: file.path, type: 'staged', fileIndex: file.index, working_dir: file.working_dir };
          })
      );

      const conflicted = await Promise.all(
        status.files.filter(isConflictStatus).map(async (file) => {
          return {
            path: file.path,
            type: 'conflicted',
            fileIndex: file.index,
            working_dir: file.working_dir,
            status: `${file.index || ' '}${file.working_dir || ' '}`.trim()
          };
        }) || []
      );

      resolve({
        staged: [...staged, ...renamed],
        unstaged,
        totalFiles,
        tooManyFiles: false,
        conflicted
      });
    });
  });
}

const getCollectionGitData = async (gitRootPath, collectionPath) => {
  if (!gitRootPath) return {};
  const [branches, currentGitBranch, defaultGitBranch, gitRepoUrl] = await Promise.all([
    getCollectionGitBranches(gitRootPath),
    getCurrentGitBranch(gitRootPath),
    getDefaultGitBranch(gitRootPath),
    getCollectionGitRepoUrl(gitRootPath)
  ]);

  const logs = branches.length ? await getCollectionGitLogs(gitRootPath) : [];

  return {
    gitRootPath,
    gitRepoUrl,
    branches,
    currentGitBranch,
    defaultGitBranch,
    logs
  };
};

const cloneGitRepository = async (win, data) => {
  const { url, path: clonePath, processUid } = data;
  const binary = ensureGitAvailable();

  // Spawned directly (not through simple-git) so the operation can be
  // cancelled by processUid and progress can be streamed to the renderer.
  const result = await runCancellableGitCommand({
    binary,
    args: ['clone', '--progress', url, clonePath],
    cwd: path.dirname(path.resolve(clonePath)),
    processUid,
    win
  });

  return result.stdout || result.stderr;
};

const fetchRemotes = (gitRootPath) => {
  return new Promise((resolve, reject) => {
    if (!gitRootPath) return resolve([]);
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.getRemotes(true)
      .then((remoteList) => {
        resolve(remoteList);
      })
      .catch((err) => {
        console.error('Error fetching remotes:', err);
        reject(err);
      });
  });
};

const fetchChanges = (gitRootPath, remote = 'origin', { win, processUid } = {}) => {
  // With a processUid the fetch is spawned directly so it reports progress and
  // can be cancelled; without one (background status refreshes) it keeps the
  // original simple-git path.
  if (processUid) {
    return runCancellableGitCommand({
      binary: ensureGitAvailable(),
      args: ['fetch', '--progress', remote],
      cwd: gitRootPath,
      processUid,
      win
    });
  }

  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.fetch(remote, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
};

const getGitStatus = (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.status((err, status) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(status);
    });
  });
};

const hasGitCommits = (gitRootPath) => {
  return new Promise((resolve) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.raw(['rev-parse', '--verify', 'HEAD'], (err) => {
      resolve(!err);
    });
  });
};

const extractUntrackedOverwriteFiles = (message = '') => {
  const lines = message.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes('untracked working tree files would be overwritten by merge'));
  if (startIndex === -1) {
    return [];
  }

  const files = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.includes('Please move or remove them') || line.includes('Aborting')) {
      break;
    }

    const filePath = line.trim();
    if (filePath) {
      files.push(filePath);
    }
  }

  return files;
};

const createBackupId = () => {
  return new Date().toISOString().replace(/[:.]/g, '-');
};

const findBackupTargetsForMissingGitPath = (gitRootPath, filePath) => {
  const normalizedPath = normalizeGitPath(filePath);
  const replacementCharIndex = normalizedPath.indexOf('\uFFFD');
  const searchablePath = replacementCharIndex === -1
    ? normalizedPath
    : normalizedPath.slice(0, replacementCharIndex);
  const slashIndex = searchablePath.lastIndexOf('/');

  if (slashIndex === -1) {
    return [];
  }

  const parentPath = searchablePath.slice(0, slashIndex);
  const leafPrefix = searchablePath.slice(slashIndex + 1);
  const absoluteParentPath = path.resolve(gitRootPath, parentPath);
  const relativeParentPath = path.relative(gitRootPath, absoluteParentPath);
  const isInsideGitRoot = relativeParentPath && !relativeParentPath.startsWith('..') && !path.isAbsolute(relativeParentPath);

  if (!isInsideGitRoot || !fs.existsSync(absoluteParentPath)) {
    return [];
  }

  return fs.readdirSync(absoluteParentPath)
    .filter((entryName) => entryName.startsWith(leafPrefix))
    .map((entryName) => normalizeGitPath(path.posix.join(parentPath, entryName)));
};

const getBackupTargetsForGitPath = (gitRootPath, filePath) => {
  const normalizedPath = normalizeGitPath(filePath);
  const absolutePath = path.resolve(gitRootPath, normalizedPath);
  const relativeToRoot = path.relative(gitRootPath, absolutePath);
  const isInsideGitRoot = relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);

  if (!isInsideGitRoot) {
    return {
      files: [],
      skippedFiles: [filePath]
    };
  }

  if (fs.existsSync(absolutePath)) {
    return {
      files: [normalizedPath],
      skippedFiles: []
    };
  }

  const matchedFiles = findBackupTargetsForMissingGitPath(gitRootPath, normalizedPath);
  return matchedFiles.length
    ? {
        files: matchedFiles,
        skippedFiles: []
      }
    : {
        files: [],
        skippedFiles: [filePath]
      };
};

const backupFilesBeforePull = (gitRootPath, files, options = {}) => {
  const { protectedOnly = false, excludeProtected = false } = options;
  const normalizedFiles = [...new Set(files.map(normalizeGitPath).filter(Boolean))];
  const filesToBackup = normalizedFiles.filter((filePath) => {
    const isProtected = isProtectedWorkspaceGitPath(filePath);
    if (protectedOnly) {
      return isProtected;
    }
    if (excludeProtected) {
      return !isProtected;
    }
    return true;
  });

  if (!filesToBackup.length) {
    return {
      files: [],
      skippedFiles: [],
      backupPath: ''
    };
  }

  const backupRoot = path.join(gitRootPath, '.git', 'bruno-workspace-backups', createBackupId());
  const backedUpFiles = [];
  const skippedFiles = [];

  for (const filePath of filesToBackup) {
    const normalizedFilePath = normalizeGitPath(filePath);
    if (backedUpFiles.some((backedUpFilePath) => normalizedFilePath.startsWith(`${backedUpFilePath}/`))) {
      continue;
    }

    const backupTargets = getBackupTargetsForGitPath(gitRootPath, filePath);
    if (backupTargets.skippedFiles.length) {
      skippedFiles.push(...backupTargets.skippedFiles);
      continue;
    }

    for (const backupFilePath of backupTargets.files) {
      const absolutePath = path.resolve(gitRootPath, backupFilePath);
      const relativeToRoot = path.relative(gitRootPath, absolutePath);
      const targetPath = path.join(backupRoot, relativeToRoot);

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.renameSync(absolutePath, targetPath);
      backedUpFiles.push(backupFilePath);
    }
  }

  return {
    files: backedUpFiles,
    skippedFiles,
    backupPath: backedUpFiles.length ? backupRoot : ''
  };
};

const parsePorcelainStatusPaths = (output = '') => {
  const entries = output.split('\0');
  const files = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;

    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) {
      files.push(filePath);
    }

    if (status[0] === 'R' || status[0] === 'C') {
      i += 1;
    }
  }

  return [...new Set(files.map(normalizeGitPath).filter(Boolean))];
};

const getLocalWorkspaceFilesForSafetyCommit = async (gitRootPath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const status = await git.raw(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all']);
  return parsePorcelainStatusPaths(status).filter((filePath) => !isProtectedWorkspaceGitPath(filePath));
};

const saveLocalWorkspaceFilesBeforePull = async (gitRootPath, additionalFiles = []) => {
  const committableFiles = [
    ...await getLocalWorkspaceFilesForSafetyCommit(gitRootPath),
    ...additionalFiles
  ];
  return createSafetyCommitForFiles(gitRootPath, committableFiles);
};

const hasStagedChanges = async (gitRootPath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const status = await git.raw(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=no']);
  return status
    .split('\0')
    .filter(Boolean)
    .some((entry) => {
      const indexStatus = entry[0];
      return indexStatus && indexStatus !== ' ' && indexStatus !== '?';
    });
};

const createSafetyCommitForFiles = async (gitRootPath, files, message = 'Save local workspace files before pull') => {
  const normalizedFiles = [...new Set(files.map(normalizeGitPath).filter(Boolean))];
  if (!normalizedFiles.length) {
    return {
      committed: false,
      files: [],
      skippedFiles: []
    };
  }

  const committableFiles = [];
  const skippedFiles = [];

  for (const filePath of normalizedFiles) {
    const absolutePath = path.resolve(gitRootPath, filePath);
    const relativeToRoot = path.relative(gitRootPath, absolutePath);
    const isInsideGitRoot = relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
    const isGitInternal = filePath === '.git' || filePath.startsWith('.git/');

    if (!isInsideGitRoot || isGitInternal) {
      skippedFiles.push(filePath);
      continue;
    }

    committableFiles.push(filePath);
  }

  if (!committableFiles.length) {
    return {
      committed: false,
      files: [],
      skippedFiles
    };
  }

  await stageRelativeFiles(gitRootPath, committableFiles);
  if (!await hasStagedChanges(gitRootPath)) {
    return {
      committed: false,
      files: [],
      skippedFiles
    };
  }

  await commitChanges(gitRootPath, message);
  return {
    committed: true,
    files: committableFiles,
    skippedFiles
  };
};

const adoptExistingRemoteWorkspace = async (win, { gitRootPath, processUid, remote = 'origin', remoteBranch }) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  git.outputHandler(handleGitOutput({ win, processUid, sendStdout: true }));

  const branch = remoteBranch || await getRemoteDefaultBranch({ gitRootPath, remote }).catch(() => '') || 'main';
  const currentBranch = await getCurrentGitBranch(gitRootPath).catch(() => '') || branch;
  await fetchChanges(gitRootPath, remote);

  const localStatus = await git.raw(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all']);
  const localFiles = parsePorcelainStatusPaths(localStatus).filter((filePath) => {
    return filePath && filePath !== '.git' && !filePath.startsWith('.git/');
  });
  const localBackup = backupFilesBeforePull(gitRootPath, localFiles);

  if (localBackup.skippedFiles.length) {
    throw new Error([
      'Gridman could not back up local starter files before pulling the existing workspace.',
      'Move, delete, or manually commit these files before pulling:',
      ...localBackup.skippedFiles
    ].join('\n'));
  }

  await git.raw(['checkout', '-B', currentBranch, `${remote}/${branch}`]);
  await setGitBranchUpstream({
    gitRootPath,
    remote,
    branchName: currentBranch,
    remoteBranch: branch
  }).catch(() => {});

  notifyWorkspaceConfigUpdated(win, gitRootPath);

  return {
    pulled: true,
    localFilesBackedUp: Boolean(localBackup.files.length),
    localBackupFiles: localBackup.files,
    localBackupPath: localBackup.backupPath,
    message: localBackup.files.length
      ? `Existing remote workspace pulled. Local starter files were backed up at: ${localBackup.backupPath}`
      : 'Existing remote workspace pulled.'
  };
};

const getWorkspaceGitStatusForClient = (status = {}) => ({
  current: status.current || '',
  tracking: status.tracking || null,
  ahead: Number(status.ahead || 0),
  behind: Number(status.behind || 0),
  created: Array.isArray(status.created) ? status.created : [],
  deleted: Array.isArray(status.deleted) ? status.deleted : [],
  modified: Array.isArray(status.modified) ? status.modified : [],
  not_added: Array.isArray(status.not_added) ? status.not_added : [],
  renamed: Array.isArray(status.renamed)
    ? status.renamed.map((file) => ({
        from: file.from,
        to: file.to
      }))
    : []
});

const getRemotesForClient = (remotes = []) => {
  if (!Array.isArray(remotes)) {
    return [];
  }

  return remotes.map((remote) => ({
    name: remote.name,
    refs: {
      fetch: remote.refs?.fetch || '',
      push: remote.refs?.push || ''
    }
  }));
};

const getAheadBehindForClient = (aheadBehind = {}) => ({
  ahead: Number(aheadBehind.ahead || 0),
  behind: Number(aheadBehind.behind || 0),
  aheadCommits: Array.isArray(aheadBehind.aheadCommits) ? aheadBehind.aheadCommits : [],
  behindCommits: Array.isArray(aheadBehind.behindCommits) ? aheadBehind.behindCommits : []
});

const getWorkspaceGitData = async (input) => {
  const { workspacePath, collectionPaths, preferCollectionParent, fetchRemote, remote } = normalizeWorkspaceGitInput(input);
  const gitTargetPath = getWorkspaceGitTargetPath({ workspacePath, collectionPaths, preferCollectionParent });
  const gitRootPath = getWorkspaceGitRootPath(gitTargetPath);
  if (!gitRootPath) {
    return {
      isGitRepository: false,
      gitRootPath: null,
      gitTargetPath
    };
  }
  ensureGitAvailable();

  const remotes = await fetchRemotes(gitRootPath).catch(() => []);
  const remoteNames = remotes.map((item) => item.name).filter(Boolean);
  const remoteToFetch = remoteNames.includes(remote) ? remote : remoteNames[0];

  if (fetchRemote && remoteToFetch) {
    await fetchChanges(gitRootPath, remoteToFetch);
  }

  const [status, remotesForClient, branchMetadata, currentGitBranch, defaultGitBranch, aheadBehind, hasCommits, auth, remoteBranchNamesFromRemote] = await Promise.all([
    getGitStatus(gitRootPath),
    Promise.resolve(remotes),
    getGitBranchMetadata({ gitRootPath, remote: remoteToFetch || remote }).catch(() => ({
      currentBranch: '',
      trackingBranch: '',
      remoteDefaultBranch: 'main',
      localBranches: [],
      remoteBranches: [],
      hasUpstream: false,
      canPublishCurrentBranch: false,
      upstreamRemote: remoteToFetch || remote,
      upstreamBranch: ''
    })),
    getCurrentGitBranch(gitRootPath).catch(() => ''),
    getDefaultGitBranch(gitRootPath).catch(() => ''),
    getAheadBehindCount(gitRootPath).catch(() => ({ ahead: 0, behind: 0, aheadCommits: [], behindCommits: [] })),
    hasGitCommits(gitRootPath),
    getGitAuthDiagnostics({ gitRootPath, remote: remoteToFetch || remote }).catch(() => null),
    fetchRemoteBranchNamesFromRemote({ gitRootPath, remote: remoteToFetch || remote }).catch(() => [])
  ]);

  const changedFiles = await getChangedFilesInCollectionGit(gitRootPath, gitRootPath);
  const mergeInProgress = fs.existsSync(path.join(gitRootPath, '.git', 'MERGE_HEAD'));

  return {
    isGitRepository: true,
    gitRootPath,
    gitTargetPath,
    status: getWorkspaceGitStatusForClient(status),
    changedFiles,
    remotes: getRemotesForClient(remotesForClient),
    branches: branchMetadata.localBranches,
    localBranches: branchMetadata.localBranches,
    remoteBranches: branchMetadata.remoteBranches,
    currentGitBranch: branchMetadata.currentBranch || currentGitBranch || defaultGitBranch || branchMetadata.remoteDefaultBranch || 'main',
    currentBranch: branchMetadata.currentBranch || currentGitBranch || defaultGitBranch || branchMetadata.remoteDefaultBranch || 'main',
    defaultGitBranch: branchMetadata.remoteDefaultBranch || defaultGitBranch || 'main',
    remoteDefaultBranch: branchMetadata.remoteDefaultBranch || defaultGitBranch || 'main',
    trackingBranch: branchMetadata.trackingBranch,
    hasUpstream: branchMetadata.hasUpstream,
    canPublishCurrentBranch: branchMetadata.canPublishCurrentBranch,
    upstreamRemote: branchMetadata.upstreamRemote,
    upstreamBranch: branchMetadata.upstreamBranch,
    hasCommits,
    remoteHasBranches: remoteBranchNamesFromRemote.length > 0,
    remoteBranchNames: remoteBranchNamesFromRemote,
    aheadBehind: getAheadBehindForClient(aheadBehind),
    auth,
    mergeInProgress
  };
};

const syncGitChanges = async (win, { gitRootPath, processUid, remote = 'origin', remoteBranch, strategy = '--no-rebase' }) => {
  await fetchChanges(gitRootPath, remote, { win, processUid });
  const status = await getGitStatus(gitRootPath);
  const trackingTarget = await getTrackingTarget({ gitRootPath, remote, remoteBranch });
  const branch = trackingTarget.branch;
  const targetRemote = trackingTarget.remote;
  const shouldPull = status.behind > 0 || await remoteBranchExists({ gitRootPath, remote: targetRemote, branch });
  const result = {
    fetched: true,
    pulled: false,
    pushed: false
  };

  if (shouldPull) {
    const pullResult = await pullGitChanges(win, { gitRootPath, processUid, remote: targetRemote, remoteBranch: branch, strategy });
    result.pulled = true;

    if (pullResult?.mergeInProgress) {
      return {
        ...result,
        mergeInProgress: true,
        message: pullResult.message
      };
    }
  }

  const nextStatus = await getGitStatus(gitRootPath);
  if (nextStatus.ahead > 0) {
    await pushGitChanges(win, { gitRootPath, processUid, remote: targetRemote, remoteBranch: branch });
    result.pushed = true;
  }

  return result;
};

const performGuidedWorkspaceGitAction = async (win, {
  gitRootPath,
  processUid,
  remote = 'origin',
  action,
  message = '',
  remoteBranch = '',
  strategy = '--no-rebase'
}) => {
  if (!gitRootPath) {
    throw new Error('Git root path is required.');
  }

  const commitMessage = String(message || '').trim();
  const currentBranch = await getCurrentGitBranch(gitRootPath).catch(() => '');
  const result = {
    action,
    committed: false,
    commitFiles: [],
    skippedProtectedFiles: [],
    pulled: false,
    pushed: false,
    published: false,
    mergeInProgress: false,
    message: ''
  };

  const shouldCommit = ['save', 'publish-workspace', 'sync-full'].includes(action);
  if (shouldCommit) {
    if (!commitMessage) {
      throw new Error('Commit message is required.');
    }

    const safeFiles = await getLocalWorkspaceFilesForSafetyCommit(gitRootPath);
    const allStatus = await getSimpleGitInstanceForPath(gitRootPath)
      .raw(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all']);
    const allFiles = parsePorcelainStatusPaths(allStatus);
    const protectedFiles = allFiles.filter(isProtectedWorkspaceGitPath);

    result.skippedProtectedFiles = protectedFiles;

    if (!safeFiles.length) {
      result.message = protectedFiles.length
        ? 'Only protected local environment files changed. Nothing was committed.'
        : 'No workspace changes to commit.';
    } else {
      const commitResult = await createSafetyCommitForFiles(gitRootPath, safeFiles, commitMessage);
      result.committed = Boolean(commitResult.committed);
      result.commitFiles = commitResult.files || [];
      result.skippedProtectedFiles = [...new Set([
        ...protectedFiles,
        ...(commitResult.skippedFiles || [])
      ])];
    }
  }

  if (action === 'publish-workspace' || action === 'publish-branch') {
    await publishGitBranch(win, { gitRootPath, processUid, remote, branchName: currentBranch });
    result.published = true;
    result.pushed = true;
  } else if (action === 'push') {
    await pushGitChanges(win, { gitRootPath, processUid, remote });
    result.pushed = true;
  } else if (action === 'pull' || action === 'pull-existing') {
    const targetRemoteBranch = action === 'pull-existing'
      ? (remoteBranch || await getRemoteDefaultBranch({ gitRootPath, remote }).catch(() => '') || 'main')
      : remoteBranch;

    const pullResult = action === 'pull-existing' && !await hasGitCommits(gitRootPath)
      ? await adoptExistingRemoteWorkspace(win, {
          gitRootPath,
          processUid,
          remote,
          remoteBranch: targetRemoteBranch
        })
      : await pullGitChanges(win, { gitRootPath, processUid, remote, remoteBranch: targetRemoteBranch, strategy });

    result.pulled = true;
    result.localFilesBackedUp = Boolean(pullResult?.localFilesBackedUp);
    result.localBackupFiles = pullResult?.localBackupFiles || [];
    result.localBackupPath = pullResult?.localBackupPath || '';

    if (pullResult?.mergeInProgress) {
      result.mergeInProgress = true;
      result.message = pullResult.message || 'Merge conflicts need to be resolved.';
    } else if (pullResult?.message) {
      result.message = pullResult.message;
    } else if (action === 'pull-existing') {
      await setGitBranchUpstream({
        gitRootPath,
        remote,
        branchName: currentBranch || targetRemoteBranch,
        remoteBranch: targetRemoteBranch
      }).catch(() => {});
    }
  } else if (action === 'sync' || action === 'sync-full') {
    const syncResult = await syncGitChanges(win, { gitRootPath, processUid, remote, strategy });
    result.pulled = Boolean(syncResult?.pulled);
    result.pushed = Boolean(syncResult?.pushed);
    if (syncResult?.mergeInProgress) {
      result.mergeInProgress = true;
      result.message = syncResult.message || 'Merge conflicts need to be resolved.';
    }
  }

  if (!result.message) {
    const parts = [];
    if (result.committed) parts.push('committed');
    if (result.pulled) parts.push('pulled');
    if (result.published) parts.push('published');
    else if (result.pushed) parts.push('pushed');
    result.message = parts.length ? `Guided Git action completed: ${parts.join(', ')}.` : 'Guided Git action completed.';
  }

  return result;
};

const fetchRemoteBranches = ({ gitRootPath, remote }) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.branch(['-r'], (err, branches) => {
      if (err) {
        reject(err);
      } else {
        const branchNames = branches?.all
          .filter((branch) => branch.startsWith(`${remote}/`))
          .filter((branch) => !branch.includes(' -> '))
          .map((branch) => branch.slice(remote.length + 1));
        resolve(branchNames);
      }
    });
  });
};

const fetchRemoteBranchNamesFromRemote = async ({ gitRootPath, remote }) => {
  if (!gitRootPath || !remote) {
    return [];
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);
  try {
    const result = await git.raw(['ls-remote', '--heads', remote]);
    return result
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/refs\/heads\/(.+)$/);
        return match?.[1] || '';
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
};

const remoteBranchExists = async ({ gitRootPath, remote, branch }) => {
  if (!remote || !branch) {
    return false;
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);
  try {
    await git.raw(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
    return true;
  } catch (_) {
    return false;
  }
};

const addRemote = ({ gitRootPath, remoteName, remoteUrl }) => {
  return new Promise(async (resolve, reject) => {
    try {
      const git = getSimpleGitInstanceForPath(gitRootPath);
      console.log('Adding remote:', { gitRootPath, remoteName, remoteUrl });
      await git.addRemote(remoteName, remoteUrl);
      const remotes = await fetchRemotes(gitRootPath);
      resolve(remotes);
    } catch (err) {
      console.error('Error adding remote:', err);
      reject(err);
    }
  });
};

const upsertRemote = async ({ gitRootPath, remoteName = 'origin', remoteUrl, branchName = '' }) => {
  if (!remoteUrl?.trim()) {
    throw new Error('Remote URL is required');
  }

  const git = getSimpleGitInstanceForPath(gitRootPath);
  const existingRemotes = await fetchRemotes(gitRootPath).catch(() => []);
  const remoteExists = existingRemotes.some((remote) => remote.name === remoteName);

  if (remoteExists) {
    await git.raw(['remote', 'set-url', remoteName, remoteUrl.trim()]);
  } else {
    await git.addRemote(remoteName, remoteUrl.trim());
  }

  await ensureWorkspaceGitBranch({ gitRootPath, branchName });

  const remotes = await fetchRemotes(gitRootPath);
  return getRemotesForClient(remotes);
};

const removeRemote = ({ gitRootPath, remoteName }) => {
  return new Promise(async (resolve, reject) => {
    try {
      const git = getSimpleGitInstanceForPath(gitRootPath);
      console.log('Removing remote:', { gitRootPath, remoteName });
      await git.removeRemote(remoteName);
      const remotes = await fetchRemotes(gitRootPath);
      resolve(remotes);
    } catch (err) {
      console.error('Error removing remote:', err);
      reject(err);
    }
  });
};

const getBehindCount = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);

    // First try to get status which includes tracking info and counts
    git.status((err, status) => {
      if (err) {
        reject(err);
        return;
      }

      // Check if we have tracking branch information
      const trackingBranch = status.tracking;
      if (!trackingBranch) {
        // No tracking branch set
        resolve({
          behind: 0,
          commits: []
        });
        return;
      }

      // Use status.behind if available, otherwise calculate manually
      const behindCount = status.behind || 0;

      if (behindCount === 0) {
        resolve({
          behind: 0,
          commits: []
        });
        return;
      }

      // Get the actual commits that are behind
      git.log(['HEAD..' + trackingBranch], (err, log) => {
        if (err) {
          // If log fails, return the count from status but empty commits
          resolve({
            behind: behindCount,
            commits: []
          });
          return;
        }

        const commits = log.all.map((commit) => ({
          hash: commit.hash,
          message: commit.message,
          author: commit.author_name,
          time: new Date(commit.date).toLocaleString()
        }));

        resolve({
          behind: behindCount,
          commits
        });
      });
    });
  });
};

const getAheadCount = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);

    // First try to get status which includes tracking info and counts
    git.status((err, status) => {
      if (err) {
        reject(err);
        return;
      }

      // Check if we have tracking branch information
      const trackingBranch = status.tracking;
      if (!trackingBranch) {
        // No tracking branch set - get all local commits as "ahead"
        git.log(['HEAD'], (err, allLog) => {
          if (err) {
            resolve({
              ahead: 0,
              commits: []
            });
            return;
          }

          const commits = allLog.all.map((commit) => ({
            hash: commit.hash,
            message: commit.message,
            author: commit.author_name,
            time: new Date(commit.date).toLocaleString()
          }));

          resolve({
            ahead: commits.length,
            commits
          });
        });
        return;
      }

      // Use status.ahead if available, otherwise calculate manually
      const aheadCount = status.ahead || 0;

      if (aheadCount === 0) {
        resolve({
          ahead: 0,
          commits: []
        });
        return;
      }

      // Get commits that are ahead (in local but not on remote)
      git.log([trackingBranch + '..HEAD'], (err, log) => {
        if (err) {
          // If remote doesn't exist, get all local commits (they're all "ahead")
          git.log(['HEAD'], (err, allLog) => {
            if (err) {
              resolve({
                ahead: aheadCount,
                commits: []
              });
              return;
            }

            const commits = allLog.all.map((commit) => ({
              hash: commit.hash,
              message: commit.message,
              author: commit.author_name,
              time: new Date(commit.date).toLocaleString()
            }));

            resolve({
              ahead: aheadCount,
              commits
            });
          });
          return;
        }

        const commits = log.all.map((commit) => ({
          hash: commit.hash,
          message: commit.message,
          author: commit.author_name,
          time: new Date(commit.date).toLocaleString()
        }));

        resolve({
          ahead: aheadCount,
          commits
        });
      });
    });
  });
};

const getAheadBehindCount = async (gitRootPath) => {
  try {
    const [behindStatus, aheadStatus] = await Promise.all([
      getBehindCount(gitRootPath),
      getAheadCount(gitRootPath)
    ]);

    return {
      behind: behindStatus.behind,
      ahead: aheadStatus.ahead,
      behindCommits: behindStatus.commits,
      aheadCommits: aheadStatus.commits
    };
  } catch (error) {
    console.error('Error getting ahead/behind count:', error);
    // Return safe defaults
    return {
      behind: 0,
      ahead: 0,
      behindCommits: [],
      aheadCommits: []
    };
  }
};

const abortConflictResolution = async (gitRootPath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    if (fs.existsSync(path.join(gitRootPath, '.git', 'MERGE_HEAD'))) {
      git.raw(['merge', '--abort'], (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    } else {
      reject(new Error('No merge in progress'));
    }
  });
};

const continueMerge = async (gitRootPath, conflictedFiles, commitMessage) => {
  return new Promise(async (resolve, reject) => {
    try {
      const fsPromises = require('fs/promises');

      // Step 1: Write all conflicted files' final state to disk
      for (const file of conflictedFiles) {
        // file.path is relative to gitRootPath, convert to absolute path
        const fullFilePath = path.join(gitRootPath, file.path);

        // Ensure directory exists
        const dir = path.dirname(fullFilePath);
        await fsPromises.mkdir(dir, { recursive: true });

        // Write the resolved content
        await fsPromises.writeFile(fullFilePath, file.content, 'utf8');
      }

      // Step 2: Stage the conflicted files
      const filePaths = conflictedFiles.map((f) => f.path);
      const fullPaths = filePaths.map((p) => path.join(gitRootPath, p));
      await stageChanges(gitRootPath, fullPaths);

      // Step 3: Write commit message to .git/MERGE_MSG
      const mergeMsgPath = path.join(gitRootPath, '.git', 'MERGE_MSG');
      await fsPromises.writeFile(mergeMsgPath, commitMessage, 'utf8');

      // Step 4: Call git merge --continue
      execFile(ensureGitAvailable(), ['-c', 'core.editor=:', 'merge', '--continue'], { cwd: gitRootPath }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        notifyWorkspaceConfigUpdated(null, gitRootPath);
        resolve(stdout);
      });
    } catch (error) {
      reject(error);
    }
  });
};

const continueResolvedMerge = async (gitRootPath, conflictedFilePaths, commitMessage) => {
  return new Promise(async (resolve, reject) => {
    try {
      const fsPromises = require('fs/promises');
      const fullPaths = conflictedFilePaths.map((filePath) => path.join(gitRootPath, filePath));

      if (fullPaths.length) {
        await stageChanges(gitRootPath, fullPaths);
      }

      if (commitMessage) {
        const mergeMsgPath = path.join(gitRootPath, '.git', 'MERGE_MSG');
        await fsPromises.writeFile(mergeMsgPath, commitMessage, 'utf8');
      }

      execFile(ensureGitAvailable(), ['-c', 'core.editor=:', 'merge', '--continue'], { cwd: gitRootPath }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        notifyWorkspaceConfigUpdated(null, gitRootPath);
        resolve(stdout);
      });
    } catch (error) {
      reject(error);
    }
  });
};

const getCommitFiles = async (gitRootPath, commitHash) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    // Get the list of files changed in this commit with stats
    git.raw(['show', '--stat', '--name-status', '--format=', commitHash], (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      const lines = result.trim().split('\n').filter((line) => line.trim());
      const files = [];

      for (const line of lines) {
        // Parse name-status format: M<tab>filename or A<tab>filename or D<tab>filename
        const match = line.match(/^([AMDRC])\t(.+)$/);
        if (match) {
          const [, status, filePath] = match;
          files.push({
            path: filePath,
            status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : status === 'R' ? 'renamed' : 'changed'
          });
        }
      }

      resolve(files);
    });
  });
};

const getCommitFileDiff = async (gitRootPath, commitHash, filePath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    // Get the diff for a specific file in a commit (compare with parent)
    git.raw(['show', '--no-prefix', '-p', commitHash, '--', filePath], (err, diff) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(diff);
    });
  });
};

/**
 * Get the list of files changed between two commits
 * @param {string} gitRootPath - Path to git repository
 * @param {string} fromCommit - Base commit hash (older)
 * @param {string} toCommit - Target commit hash (newer)
 * @returns {Promise<Array>} List of changed files with status
 */
const getCommitCompareFiles = async (gitRootPath, fromCommit, toCommit) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    // Get the list of files changed between two commits
    git.raw(['diff', '--name-status', fromCommit, toCommit], (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      const lines = result.trim().split('\n').filter((line) => line.trim());
      const files = [];

      for (const line of lines) {
        // Parse name-status format: M<tab>filename or A<tab>filename or D<tab>filename
        const match = line.match(/^([AMDRC])\t(.+)$/);
        if (match) {
          const [, status, filePath] = match;
          files.push({
            path: filePath,
            status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : status === 'R' ? 'renamed' : 'changed'
          });
        }
      }

      resolve(files);
    });
  });
};

/**
 * Get the diff for a specific file between two commits
 * @param {string} gitRootPath - Path to git repository
 * @param {string} fromCommit - Base commit hash (older)
 * @param {string} toCommit - Target commit hash (newer)
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} Diff string
 */
const getCommitCompareFileDiff = async (gitRootPath, fromCommit, toCommit, filePath) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    // Get the diff for a specific file between two commits
    git.raw(['diff', '--no-prefix', fromCommit, toCommit, '--', filePath], (err, diff) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(diff);
    });
  });
};

/**
 * Get git history for a specific file
 * @param {string} gitRootPath - Path to git repository
 * @param {string} filePath - Path to the file (relative to git root)
 * @returns {Promise<Array>} List of commits that touched this file
 */
const getFileGitHistory = async (gitRootPath, filePath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);

  try {
    const result = await git.raw([
      'log',
      '--format=%H|%s|%an|%aI',
      '--follow',
      '-n', '100',
      '--', filePath
    ]);

    if (!result || !result.trim()) {
      return [];
    }

    const commits = [];
    const lines = result.trim().split('\n');

    for (const line of lines) {
      if (line.includes('|')) {
        const [hash, message, author, date] = line.split('|');
        commits.push({
          hash,
          message,
          author_name: author,
          date
        });
      }
    }

    return commits;
  } catch (err) {
    console.error('Error getting file git history:', err);
    return [];
  }
};

/**
 * Get git graph data for visualization
 * Gets commits from branch with parent info in a single git log call
 * Only includes branch commits that fall within the time range of the main line
 */
/**
 * Create a new stash with a message
 * @param {string} gitRootPath - Path to git repository
 * @param {string} message - Stash message/identifier
 * @returns {Promise<void>}
 */
const createStash = async (gitRootPath, message) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    // Use --include-untracked to stash untracked files as well
    git.stash(['push', '--include-untracked', '-m', message], (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
};

/**
 * Get stash diff stats (files changed, insertions, deletions)
 * Includes both tracked and untracked files
 * @param {object} git - simple-git instance
 * @param {number} stashIndex - Index of the stash
 * @returns {Promise<object>} Object with filesChanged, insertions, deletions
 */
const getStashStats = async (git, stashIndex) => {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  try {
    // Get stats for tracked files
    const trackedResult = await git.raw(['stash', 'show', '--numstat', `stash@{${stashIndex}}`]);

    if (trackedResult) {
      const lines = trackedResult.trim().split('\n').filter((line) => line.trim());
      filesChanged += lines.length;

      lines.forEach((line) => {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const added = parseInt(parts[0], 10) || 0;
          const removed = parseInt(parts[1], 10) || 0;
          insertions += added;
          deletions += removed;
        }
      });
    }
  } catch (err) {
    // No tracked changes or error, continue
  }

  try {
    // Get stats for untracked files (stored in stash^3)
    // First check if the third parent exists (untracked files commit)
    const untrackedResult = await git.raw(['diff', '--numstat', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', `stash@{${stashIndex}}^3`]);

    if (untrackedResult) {
      const lines = untrackedResult.trim().split('\n').filter((line) => line.trim());
      filesChanged += lines.length;

      lines.forEach((line) => {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const added = parseInt(parts[0], 10) || 0;
          // Untracked files are all additions
          insertions += added;
        }
      });
    }
  } catch (err) {
    // No untracked files in stash or stash^3 doesn't exist, that's fine
  }

  return { filesChanged, insertions, deletions };
};

/**
 * List all stashes
 * @param {string} gitRootPath - Path to git repository
 * @returns {Promise<Array>} List of stashes with index, message, date, and diff stats
 */
const listStashes = async (gitRootPath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);

  try {
    const stashList = await git.stashList();
    const stashEntries = stashList.all || [];

    // Fetch stats for each stash in parallel
    const stashesWithStats = await Promise.all(
      stashEntries.map(async (stash, index) => {
        const stats = await getStashStats(git, index);
        return {
          index: index,
          hash: stash.hash,
          message: stash.message,
          date: stash.date,
          filesChanged: stats.filesChanged,
          insertions: stats.insertions,
          deletions: stats.deletions
        };
      })
    );

    return stashesWithStats;
  } catch (err) {
    throw err;
  }
};

/**
 * Apply a stash by index (restores changes but keeps stash)
 * @param {string} gitRootPath - Path to git repository
 * @param {number} stashIndex - Index of the stash to apply
 * @returns {Promise<void>}
 */
const applyStash = async (gitRootPath, stashIndex) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.stash(['apply', `stash@{${stashIndex}}`], (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
};

/**
 * Drop (delete) a stash by index
 * @param {string} gitRootPath - Path to git repository
 * @param {number} stashIndex - Index of the stash to drop
 * @returns {Promise<void>}
 */
const dropStash = async (gitRootPath, stashIndex) => {
  return new Promise((resolve, reject) => {
    const git = getSimpleGitInstanceForPath(gitRootPath);
    git.stash(['drop', `stash@{${stashIndex}}`], (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
};

/**
 * Get list of files in a stash (both tracked and untracked)
 * @param {string} gitRootPath - Path to git repository
 * @param {number} stashIndex - Index of the stash
 * @returns {Promise<Array>} List of files with status
 */
const getStashFiles = async (gitRootPath, stashIndex) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const files = [];

  try {
    // Get tracked files from stash
    const trackedResult = await git.raw(['stash', 'show', '--name-status', `stash@{${stashIndex}}`]);

    if (trackedResult) {
      const lines = trackedResult.trim().split('\n').filter((line) => line.trim());
      for (const line of lines) {
        const match = line.match(/^([AMDRC])\t(.+)$/);
        if (match) {
          const [, status, filePath] = match;
          files.push({
            path: filePath,
            status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : status === 'R' ? 'renamed' : 'changed',
            isUntracked: false
          });
        }
      }
    }
  } catch (err) {
    // No tracked files or error
  }

  try {
    // Get untracked files from stash^3
    const untrackedResult = await git.raw(['ls-tree', '-r', '--name-only', `stash@{${stashIndex}}^3`]);

    if (untrackedResult) {
      const lines = untrackedResult.trim().split('\n').filter((line) => line.trim());
      for (const filePath of lines) {
        files.push({
          path: filePath,
          status: 'added',
          isUntracked: true
        });
      }
    }
  } catch (err) {
    // No untracked files in stash
  }

  return files;
};

/**
 * Get diff for a specific file in a stash
 * @param {string} gitRootPath - Path to git repository
 * @param {number} stashIndex - Index of the stash
 * @param {string} filePath - Path to the file
 * @param {boolean} isUntracked - Whether the file is untracked
 * @returns {Promise<string>} Diff string
 */
const getStashFileDiff = async (gitRootPath, stashIndex, filePath, isUntracked = false) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);

  try {
    if (isUntracked) {
      // For untracked files, show the full content as a diff against empty
      const content = await git.raw(['show', `stash@{${stashIndex}}^3:${filePath}`]);
      // Format as a unified diff showing all lines as additions
      const lines = content.split('\n');
      const diffLines = [
        `diff --git a/${filePath} b/${filePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`)
      ];
      return diffLines.join('\n');
    } else {
      // For tracked files, use git diff to compare stash against its parent
      // stash@{n}^ is the parent commit, stash@{n} is the stash commit
      const diff = await git.raw(['diff', `stash@{${stashIndex}}^`, `stash@{${stashIndex}}`, '--', filePath]);
      return diff;
    }
  } catch (err) {
    throw err;
  }
};

/**
 * Get file content at a specific commit
 * @param {string} gitRootPath - Path to git repository
 * @param {string} commitHash - Commit hash
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} File content
 */
const getFileContentAtCommit = async (gitRootPath, commitHash, filePath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  try {
    const content = await git.raw(['show', `${commitHash}:${filePath}`]);
    return content;
  } catch (err) {
    // File might not exist at this commit (e.g., newly added file)
    return null;
  }
};

/**
 * Check if file supports visual diff
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if file supports visual diff
 */
const supportsVisualDiff = (filePath) => {
  if (!filePath) return false;

  const fileName = filePath.split('/').pop();
  const excludedFiles = ['folder.yml', 'folder.bru', 'opencollection.yml', 'collection.bru'];
  if (excludedFiles.includes(fileName)) {
    return false;
  }

  return filePath.endsWith('.bru') || filePath.endsWith('.yml');
};

/**
 * Parse content for visual diff viewer
 * Uses parseRequest to get consistent BrunoItem structure for both .bru and .yml files
 * @param {string} content - Raw file content
 * @param {string} filePath - Path to the file
 * @returns {object|null} Parsed BrunoItem or null if parsing fails
 */
const parseContentForVisualDiff = (content, filePath) => {
  if (!content) return null;
  try {
    if (filePath?.endsWith('.bru')) {
      return parseRequest(content, { format: 'bru' });
    } else if (filePath?.endsWith('.yml')) {
      return parseRequest(content, { format: 'yml' });
    }
    return null;
  } catch (err) {
    console.error('Error parsing content for visual diff:', err);
    return null;
  }
};

/**
 * Get old and new file content for visual diff
 * @param {string} gitRootPath - Path to git repository
 * @param {string} commitHash - Commit hash
 * @param {string} filePath - Path to the file
 * @returns {Promise<{oldContent: string|null, newContent: string|null, oldParsed: object|null, newParsed: object|null}>} Old and new file content
 */
const getFileContentForVisualDiff = async (gitRootPath, commitHash, filePath) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const canParseVisualDiff = supportsVisualDiff(filePath);

  try {
    // Get the new content (at the commit)
    let newContent = null;
    try {
      newContent = await git.raw(['show', `${commitHash}:${filePath}`]);
    } catch (err) {
      // File might be deleted in this commit
      newContent = null;
    }

    // Get the old content (at the parent commit)
    let oldContent = null;
    try {
      oldContent = await git.raw(['show', `${commitHash}^:${filePath}`]);
    } catch (err) {
      // File might not exist in parent (newly added)
      oldContent = null;
    }

    // Parse content if applicable
    let oldParsed = null;
    let newParsed = null;

    if (canParseVisualDiff) {
      oldParsed = parseContentForVisualDiff(oldContent, filePath);
      newParsed = parseContentForVisualDiff(newContent, filePath);
    }

    return { oldContent, newContent, oldParsed, newParsed };
  } catch (err) {
    throw err;
  }
};

/**
 * Get old and new file content for visual diff (for staged/unstaged changes)
 * @param {string} gitRootPath - Path to git repository
 * @param {string} filePath - Path to the file (relative to git root)
 * @param {string} type - Type of change: 'staged', 'unstaged', or 'renamed'
 * @returns {Promise<{oldContent: string|null, newContent: string|null, oldParsed: object|null, newParsed: object|null}>} Old and new file content
 */
const getWorkingFileContentForVisualDiff = async (gitRootPath, filePath, type) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const fullPath = path.join(gitRootPath, filePath);
  const canParseVisualDiff = supportsVisualDiff(filePath);

  try {
    let oldContent = null;
    let newContent = null;

    if (type === 'staged') {
      // For staged changes: old = HEAD, new = index (staged)
      try {
        oldContent = await git.raw(['show', `HEAD:${filePath}`]);
      } catch (err) {
        // File might be newly added
        oldContent = null;
      }

      try {
        newContent = await git.raw(['show', `:${filePath}`]);
      } catch (err) {
        // File might be deleted
        newContent = null;
      }
    } else if (type === 'unstaged') {
      // For unstaged changes: old = index or HEAD, new = working directory
      try {
        // Try to get from index first (if there are staged changes)
        oldContent = await git.raw(['show', `:${filePath}`]);
      } catch (err) {
        try {
          // Fall back to HEAD
          oldContent = await git.raw(['show', `HEAD:${filePath}`]);
        } catch (err2) {
          // File might be untracked
          oldContent = null;
        }
      }

      // Read working directory content
      try {
        newContent = fs.readFileSync(fullPath, 'utf8');
      } catch (err) {
        // File might be deleted
        newContent = null;
      }
    }

    // Parse content if applicable
    let oldParsed = null;
    let newParsed = null;

    if (canParseVisualDiff) {
      oldParsed = parseContentForVisualDiff(oldContent, filePath);
      newParsed = parseContentForVisualDiff(newContent, filePath);
    }

    return { oldContent, newContent, oldParsed, newParsed };
  } catch (err) {
    throw err;
  }
};

/**
 * Get old and new file content for visual diff (for stash)
 * @param {string} gitRootPath - Path to git repository
 * @param {number} stashIndex - Index of the stash
 * @param {string} filePath - Path to the file
 * @param {boolean} isUntracked - Whether the file is untracked
 * @returns {Promise<{oldContent: string|null, newContent: string|null, oldParsed: object|null, newParsed: object|null}>} Old and new file content
 */
const getStashFileContentForVisualDiff = async (gitRootPath, stashIndex, filePath, isUntracked = false) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);
  const canParseVisualDiff = supportsVisualDiff(filePath);

  try {
    let oldContent = null;
    let newContent = null;

    if (isUntracked) {
      // For untracked files in stash, old is null (didn't exist)
      oldContent = null;
      try {
        newContent = await git.raw(['show', `stash@{${stashIndex}}^3:${filePath}`]);
      } catch (err) {
        newContent = null;
      }
    } else {
      // For tracked files: old = stash parent, new = stash content
      try {
        oldContent = await git.raw(['show', `stash@{${stashIndex}}^:${filePath}`]);
      } catch (err) {
        oldContent = null;
      }

      try {
        newContent = await git.raw(['show', `stash@{${stashIndex}}:${filePath}`]);
      } catch (err) {
        newContent = null;
      }
    }

    // Parse content if applicable
    let oldParsed = null;
    let newParsed = null;

    if (canParseVisualDiff) {
      oldParsed = parseContentForVisualDiff(oldContent, filePath);
      newParsed = parseContentForVisualDiff(newContent, filePath);
    }

    return { oldContent, newContent, oldParsed, newParsed };
  } catch (err) {
    throw err;
  }
};

const getGitGraph = async (gitRootPath, branchName, limit = 50) => {
  const git = getSimpleGitInstanceForPath(gitRootPath);

  try {
    // Get commits with parent info, request one extra to check if there are more
    const result = await git.raw([
      'log',
      '--format=%H|%P|%s|%an|%aI',
      '--first-parent',
      '-n', String(limit + 1), // Request one extra to check hasMore
      branchName || 'HEAD'
    ]);

    if (!result || !result.trim()) {
      return { commits: [], branches: [], hasMore: false };
    }

    const lines = result.trim().split('\n');

    // Check if there are more commits beyond this page
    const hasMore = lines.length > limit;
    const commitLines = hasMore ? lines.slice(0, limit) : lines;

    const commits = [];
    const mainLineHashes = new Set();

    // Parse main line commits
    for (const line of commitLines) {
      const [hash, parents, message, author, date] = line.split('|');
      const parentList = parents ? parents.split(' ').filter((p) => p) : [];
      const isMerge = parentList.length > 1;

      commits.push({
        hash,
        message,
        author_name: author,
        date,
        isMerge,
        parents: parentList
      });
      mainLineHashes.add(hash);
    }

    // Get the time range of the main line commits
    // First commit is newest, last commit is oldest
    const oldestMainCommitDate = commits.length > 0 ? commits[commits.length - 1].date : null;

    // For merge commits, get branch commits (only within main line time range)
    const branches = [];

    for (const commit of commits) {
      if (commit.isMerge && commit.parents[1]) {
        try {
          // Build git log command with --since to limit to main line time range
          const logArgs = [
            'log',
            '--format=%H|%P|%s|%an|%aI',
            '--first-parent',
            '-n', '50'
          ];

          // Only include commits since the oldest main line commit
          if (oldestMainCommitDate) {
            logArgs.push('--since=' + oldestMainCommitDate);
          }

          logArgs.push(commit.parents[1]);

          const branchResult = await git.raw(logArgs);

          if (branchResult && branchResult.trim()) {
            const branchLines = branchResult.trim().split('\n');
            const branchCommits = [];

            for (const bLine of branchLines) {
              const [bHash, bParents, bMessage, bAuthor, bDate] = bLine.split('|');

              // Stop if we hit main line
              if (mainLineHashes.has(bHash)) break;

              branchCommits.push({
                hash: bHash,
                message: bMessage,
                author_name: bAuthor,
                date: bDate,
                parents: bParents ? bParents.split(' ').filter((p) => p) : []
              });
            }

            if (branchCommits.length > 0) {
              branches.push({
                mergeCommitHash: commit.hash,
                commits: branchCommits
              });
            }
          }
        } catch (err) {
          // Ignore errors for individual branch traversal
        }
      }
    }

    return { commits, branches, hasMore };
  } catch (err) {
    console.error('Error getting git graph:', err);
    return { commits: [], branches: [], hasMore: false };
  }
};

module.exports = {
  getCollectionGitRootPath,
  getWorkspaceGitRootPath,
  getCollectionGitRepoUrl,
  getWorkspaceGitData,
  initWorkspaceGit,
  getGitStatus,
  stageChanges,
  unstageChanges,
  resolveConflictFile,
  discardChanges,
  commitChanges,
  getChangedFilesInCollectionGit,
  getCollectionGitBranches,
  getDefaultGitBranch,
  getCurrentGitBranch,
  checkoutGitBranch,
  mergeGitBranch,
  getCollectionGitLogs,
  getCollectionGitTagsWithDetails,
  canPush,
  pushGitChanges,
  pullGitChanges,
  initGit,
  getCollectionGitData,
  getStagedFileDiff,
  getUnstagedFileDiff,
  getRenamedFileDiff,
  cloneGitRepository,
  fetchChanges,
  syncGitChanges,
  performGuidedWorkspaceGitAction,
  fetchRemotes,
  fetchRemoteBranches,
  checkoutRemoteGitBranch,
  publishGitBranch,
  setGitBranchUpstream,
  getGitVersion,
  addRemote,
  upsertRemote,
  removeRemote,
  getGitAuthDiagnostics,
  testGitAuthentication,
  getWorkspaceGitSetupDiagnostics,
  createGitSshKey,
  scanGitKnownHost,
  addGitKnownHost,
  setGitIdentity,
  enableGitGlobalLongPaths,
  testGitSshConnection,
  getAheadBehindCount,
  getAheadCount,
  getBehindCount,
  abortConflictResolution,
  continueMerge,
  continueResolvedMerge,
  getCommitFiles,
  getCommitFileDiff,
  getCommitCompareFiles,
  getCommitCompareFileDiff,
  getFileGitHistory,
  getGitGraph,
  createStash,
  listStashes,
  applyStash,
  dropStash,
  getStashFiles,
  getStashFileDiff,
  getFileContentAtCommit,
  getFileContentForVisualDiff,
  getWorkingFileContentForVisualDiff,
  getStashFileContentForVisualDiff
};
