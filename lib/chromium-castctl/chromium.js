'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  CHROMIUM_LAUNCH_CONFIG_VERSION,
  LOCAL_DEVTOOLS_ADDRESS,
  PROFILE_VERSION,
} = require('./constants');
const { CastCtlError, CliError, isErrorCode } = require('./errors');
const { restoreDisplay } = require('./display');
const { browserStartTimeoutMs, cdpTimeoutMs, chromiumCommand, findExecutable } = require('./env');
const { ensureDir, openPrivateAppend, randomToken, writeFileAtomic } = require('./fs-private');
const {
  findProfileBrowserProcesses,
  persistLaunchedBrowserIdentity,
  profileBrowserStillMatches,
  refreshLaunchedBrowserExecutable,
  signalProfileBrowserProcess,
} = require('./chromium-processes');
const { fetchTargets, minimizeChromiumWindow, selectPageTarget } = require('./cdp');
const {
  isPidAlive,
  readProcessIdentity,
  stateHasVerifiedBrowserProcess,
} = require('./process-identity');
const { clearState, readState, writeState } = require('./state');
const { sleep } = require('./util');

// Chromium lifecycle owns the private profile, DevTools startup/reuse, process
// signaling, and failure cleanup. CDP and receiver naming stay in separate
// modules so security review can inspect each boundary independently.
function castAudioEnabled(env = process.env) {
  const value = String(env.CHROMIUM_CASTCTL_CAST_AUDIO || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function chromiumFeatures(env = process.env) {
  const features = ['MediaRouter'];
  if (castAudioEnabled(env)) features.push('PulseaudioLoopbackForCast');
  return features.join(',');
}

function chromiumLaunchEnv(paths, env = process.env) {
  const launchEnv = { ...env, XDG_CONFIG_HOME: paths.launcherConfigDir };
  for (const name of Object.keys(launchEnv)) {
    if (name === 'CHROME_EXTRA_FLAGS'
      || name.startsWith('CHROME_EXTRA_FLAGS_')
      || name === 'CHROME_USER_FLAGS'
      || name === 'CHROMIUM_USER_FLAGS'
      || name === 'CHROMIUM_FLAGS') {
      delete launchEnv[name];
    }
  }
  return launchEnv;
}

function chromiumLaunchArgs(paths, port, env = process.env) {
  return [
    `--user-data-dir=${paths.profileDir}`,
    `--remote-debugging-address=${LOCAL_DEVTOOLS_ADDRESS}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    `--enable-features=${chromiumFeatures(env)}`,
    '--load-media-router-component-extension',
    // Headless otherwise uses an 800x600 primary display, limiting Cast to 800x450.
    '--screen-info={1920x1080}',
    '--window-size=1920,1080',
    '--headless=new',
    'about:blank',
  ];
}

async function waitForCdp(port, options = {}) {
  const timeoutMs = options.browserStartTimeoutMs || browserStartTimeoutMs(options.env || process.env);
  const deadline = options.startupDeadline || Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await fetchTargets(port, { ...options, timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) });
      return true;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  throw lastError || new Error('Timed out waiting for Chromium DevTools');
}

async function stateHasUsableCdp(state, options = {}) {
  const paths = options.paths;
  if (!state || !Number.isInteger(state.pid) || !Number.isInteger(state.port)) return false;
  if (state.remoteDebuggingAddress && state.remoteDebuggingAddress !== LOCAL_DEVTOOLS_ADDRESS) return false;
  if (paths && !stateHasVerifiedBrowserProcess(state, paths)) return false;
  if (!isPidAlive(state.pid)) return false;

  try {
    const targets = await fetchTargets(state.port, { ...options, timeoutMs: 1000 });
    selectPageTarget(targets, state.port);
    return true;
  } catch {
    return false;
  }
}

function stateMatchesProfileConfig(state, paths, env = process.env) {
  if (!state) return false;
  return state.launchMode === 'headless'
    && state.profileVersion === PROFILE_VERSION
    && Boolean(state.castAudio) === castAudioEnabled(env)
    && state.userDataDir === paths.profileDir;
}

function stateMatchesLaunchConfig(state, paths, env = process.env) {
  return stateMatchesProfileConfig(state, paths, env)
    && state.launchConfigVersion === CHROMIUM_LAUNCH_CONFIG_VERSION;
}

function signalBrowserProcess(state, paths, signal) {
  if (!state || !Number.isInteger(state.pid) || state.userDataDir !== paths.profileDir) return false;
  if (state.pid === process.pid) return false;
  if (!stateHasVerifiedBrowserProcess(state, paths)) return false;

  const identity = readProcessIdentity(state.pid);
  if (Number.isInteger(state.processGroupId) && identity && identity.processGroupId === state.processGroupId) {
    try {
      process.kill(-state.processGroupId, signal);
      return true;
    } catch {
      // Fall back to signaling just the verified browser PID below.
    }
  }

  try {
    process.kill(state.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function terminateStateBrowser(state, paths) {
  signalBrowserProcess(state, paths, 'SIGTERM');
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

async function cleanupProfileBrowserProcesses(paths, env = process.env, candidates = findProfileBrowserProcesses(paths, env), options = {}) {
  const unique = [...new Map(candidates.map((candidate) => [candidate.pid, candidate])).values()]
    .filter((candidate) => profileBrowserStillMatches(candidate, paths, env));
  if (unique.length === 0) {
    restoreDisplay(paths, { ...options, env });
    return 0;
  }

  for (const candidate of unique) signalProfileBrowserProcess(candidate, paths, env, 'SIGTERM');
  await Promise.all(unique.map((candidate) => waitForPidExit(candidate.pid, 1500)));

  const remaining = unique.filter((candidate) => isPidAlive(candidate.pid) && profileBrowserStillMatches(candidate, paths, env));
  for (const candidate of remaining) signalProfileBrowserProcess(candidate, paths, env, 'SIGKILL');
  await Promise.all(remaining.map((candidate) => waitForPidExit(candidate.pid, 500)));

  const stuck = unique.filter((candidate) => isPidAlive(candidate.pid) && profileBrowserStillMatches(candidate, paths, env));
  if (stuck.length > 0) {
    throw new CliError(`Failed to stop stale chromium-castctl browser process(es): ${stuck.map((candidate) => `pid=${candidate.pid}`).join(', ')}`, 1);
  }
  restoreDisplay(paths, { ...options, env });
  return unique.length;
}

async function discardStateBrowser(paths, state, options = {}) {
  if (state && Number.isInteger(state.pid) && state.pid !== process.pid && stateHasVerifiedBrowserProcess(state, paths)) {
    terminateStateBrowser(state, paths);
    await waitForPidExit(state.pid, 1500);
    if (isPidAlive(state.pid) && stateHasVerifiedBrowserProcess(state, paths)) {
      signalBrowserProcess(state, paths, 'SIGKILL');
      await waitForPidExit(state.pid, 500);
    }
  }
  clearState(paths);
  restoreDisplay(paths, options);
}

async function shutdownBrowser(paths, browser, client, env = process.env, options = {}) {
  const state = browser || readState(paths);
  if (!state) return (await cleanupProfileBrowserProcesses(paths, env, undefined, options)) > 0;
  if (state.pid === process.pid) {
    clearState(paths);
    restoreDisplay(paths, { ...options, env });
    return true;
  }
  if (!stateHasVerifiedBrowserProcess(state, paths)) {
    clearState(paths);
    restoreDisplay(paths, { ...options, env });
    return true;
  }

  if (client) {
    client.send('Browser.close', {}, 1000).catch(() => null);
    await waitForPidExit(state.pid, 3000);
  }

  if (isPidAlive(state.pid)) {
    terminateStateBrowser(state, paths);
    await waitForPidExit(state.pid, 1500);
  }

  if (isPidAlive(state.pid)) {
    signalBrowserProcess(state, paths, 'SIGKILL');
    await waitForPidExit(state.pid, 500);
  }

  clearState(paths);
  restoreDisplay(paths, { ...options, env });
  return true;
}

function resetIsolatedProfile(paths) {
  const oldProfileDir = `${paths.profileDir}.old-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(paths.profileDir, oldProfileDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return;
  }

  try {
    fs.rmSync(oldProfileDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    // The old isolated profile can be removed manually later; launching uses a fresh path.
  }
}

function writeProfileVersion(paths) {
  writeFileAtomic(paths.profileVersionFile, `${PROFILE_VERSION}\n`, 0o600);
}

function prepareFreshProfile(paths) {
  resetIsolatedProfile(paths);
  writeProfileVersion(paths);
}

function readDevToolsActivePort(paths) {
  const file = path.join(paths.profileDir, 'DevToolsActivePort');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > 4096) {
    throw new CastCtlError('cdp_devtools_active_port_too_large', 'DevToolsActivePort is unexpectedly large');
  }
  const [portText] = raw.split(/\r?\n/);
  const port = Number.parseInt(portText || '', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('DevToolsActivePort did not contain a valid port');
  }
  return port;
}

async function waitForDevToolsActivePort(paths, child, options = {}) {
  const timeoutMs = options.browserStartTimeoutMs || browserStartTimeoutMs(options.env || process.env);
  const deadline = options.startupDeadline || Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || !isPidAlive(child.pid)) {
      throw new Error('Chromium exited before DevTools became available');
    }
    refreshLaunchedBrowserExecutable(paths, child);
    try {
      const port = readDevToolsActivePort(paths);
      if (port) return port;
    } catch (error) {
      lastError = error;
      if (isErrorCode(error, 'cdp_devtools_active_port_too_large')) break;
    }
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw lastError || new Error('Timed out waiting for Chromium DevToolsActivePort');
}

async function getReusableBrowser(paths, options = {}) {
  const env = options.env || process.env;
  const state = readState(paths);
  if (!state) {
    await cleanupProfileBrowserProcesses(paths, env, undefined, options);
    return null;
  }
  const configMatches = options.requireLaunchConfig === false
    ? stateMatchesProfileConfig(state, paths, env)
    : stateMatchesLaunchConfig(state, paths, env);
  if (!configMatches) {
    await discardStateBrowser(paths, state, options);
    await cleanupProfileBrowserProcesses(paths, env, undefined, options);
    return null;
  }
  if (await stateHasUsableCdp(state, { ...options, paths })) return state;

  if (stateHasVerifiedBrowserProcess(state, paths) && isPidAlive(state.pid) && Number.isInteger(state.port)) {
    try {
      await waitForCdp(state.port, {
        ...options,
        browserStartTimeoutMs: options.timeoutMs || cdpTimeoutMs(env),
      });
      return state;
    } catch {
      // Fall through and clear stale/failed state below.
    }
  }

  await discardStateBrowser(paths, state, options);
  await cleanupProfileBrowserProcesses(paths, env, undefined, options);
  return null;
}

async function launchChromium(paths, options = {}) {
  const env = options.env || process.env;
  const launchDeadline = Date.now() + (options.browserStartTimeoutMs || browserStartTimeoutMs(env));
  const executable = findExecutable(chromiumCommand(env), env);
  if (!executable) {
    throw new CliError('Chromium is not installed or not on PATH. Install Chromium and retry.', 1);
  }

  prepareFreshProfile(paths);
  ensureDir(paths.profileDir);
  ensureDir(paths.launcherConfigDir);
  const launchToken = randomToken();
  const args = [...chromiumLaunchArgs(paths, 0, env), `--chromium-castctl-launch-token=${launchToken}`];
  const configuredExecutable = fs.realpathSync(executable);
  const logFd = openPrivateAppend(paths.logFile);
  let child;
  try {
    child = childProcess.spawn(executable, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: chromiumLaunchEnv(paths, env),
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.unref();
  const processIdentity = readProcessIdentity(child.pid) || {};
  let state = {
    pid: child.pid,
    port: null,
    remoteDebuggingAddress: LOCAL_DEVTOOLS_ADDRESS,
    userDataDir: paths.profileDir,
    logFile: paths.logFile,
    launchArgs: args,
    launchMode: 'headless',
    profileVersion: PROFILE_VERSION,
    launchConfigVersion: CHROMIUM_LAUNCH_CONFIG_VERSION,
    castAudio: castAudioEnabled(env),
    processStartTime: processIdentity.startTime || null,
    processGroupId: Number.isInteger(processIdentity.processGroupId) ? processIdentity.processGroupId : child.pid,
    launchNonce: randomToken(),
    startedAt: new Date().toISOString(),
    lastActiveSink: null,
    castRequestStartedAt: null,
    castSessionObserved: false,
  };

  try {
    await persistLaunchedBrowserIdentity(
      paths,
      child,
      configuredExecutable,
      launchToken,
      launchDeadline,
    );
    const startupOptions = { ...options, startupDeadline: launchDeadline };
    const port = await waitForDevToolsActivePort(paths, child, startupOptions);
    refreshLaunchedBrowserExecutable(paths, child);
    state = { ...state, port };
    writeState(paths, state);
    await waitForCdp(port, startupOptions);
    await minimizeChromiumWindow(port, options);
  } catch (error) {
    await discardStateBrowser(paths, state, options);
    throw new CliError(
      `Chromium launched but DevTools did not become available. See log: ${paths.logFile}\n${error.message}`,
      1,
    );
  }

  return state;
}

async function ensureChromium(paths, options = {}) {
  const reusable = await getReusableBrowser(paths, options);
  if (reusable) return reusable;
  return launchChromium(paths, options);
}

module.exports = {
  castAudioEnabled,
  chromiumFeatures,
  chromiumLaunchEnv,
  chromiumLaunchArgs,
  waitForCdp,
  stateHasUsableCdp,
  stateMatchesLaunchConfig,
  signalBrowserProcess,
  terminateStateBrowser,
  waitForPidExit,
  cleanupProfileBrowserProcesses,
  discardStateBrowser,
  shutdownBrowser,
  resetIsolatedProfile,
  writeProfileVersion,
  prepareFreshProfile,
  readDevToolsActivePort,
  waitForDevToolsActivePort,
  getReusableBrowser,
  launchChromium,
  ensureChromium,
  findProfileBrowserProcesses,
};
