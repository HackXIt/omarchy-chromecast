'use strict';

const fs = require('node:fs');

const { chromiumCommand, findExecutable } = require('./env');
const { writeFileAtomic } = require('./fs-private');
const {
  cmdlineArgs,
  cmdlineHasArgument,
  cmdlineHasArgumentPrefix,
  cmdlineHasLaunchToken,
  isPidAlive,
  processExecutable,
  processExecutableIdentity,
  processUsesProfile,
  readProcessIdentity,
} = require('./process-identity');
const { sleep } = require('./util');

// Browser identity records bridge the untrusted /proc view and our private
// launch token. Only verified same-user, same-profile controller processes are
// candidates for reuse or cleanup.
function configuredBrowserExecutable(env = process.env) {
  const executable = findExecutable(chromiumCommand(env), env);
  if (!executable) return null;
  try {
    return fs.realpathSync(executable);
  } catch {
    return null;
  }
}

function readBrowserIdentity(paths) {
  try {
    const identity = JSON.parse(fs.readFileSync(paths.browserIdentityFile, 'utf8'));
    if (!identity || typeof identity !== 'object') return null;
    if (typeof identity.configuredExecutable !== 'string') return null;
    if (identity.browserExecutable !== null && typeof identity.browserExecutable !== 'string') return null;
    if (identity.browserDevice !== null && typeof identity.browserDevice !== 'string') return null;
    if (identity.browserInode !== null && typeof identity.browserInode !== 'string') return null;
    if (identity.argumentsVerified !== undefined && typeof identity.argumentsVerified !== 'boolean') return null;
    if (!Number.isInteger(identity.pid) || identity.pid <= 0) return null;
    if (typeof identity.processStartTime !== 'string' || !identity.processStartTime) return null;
    if (typeof identity.launchToken !== 'string' || !identity.launchToken) return null;
    return identity;
  } catch {
    return null;
  }
}

function writeBrowserIdentity(paths, identity) {
  writeFileAtomic(paths.browserIdentityFile, `${JSON.stringify(identity, null, 2)}\n`, 0o600);
}

async function persistLaunchedBrowserIdentity(paths, child, configuredExecutable, launchToken, deadline) {
  let provisionalIdentity = null;
  while (Date.now() < deadline) {
    const processIdentity = readProcessIdentity(child.pid);
    const browserExecutable = processExecutable(child.pid);
    const browserIdentity = processExecutableIdentity(child.pid);
    if (!provisionalIdentity && processIdentity?.startTime && browserExecutable && browserIdentity) {
      provisionalIdentity = {
        configuredExecutable,
        browserExecutable,
        browserDevice: browserIdentity.device,
        browserInode: browserIdentity.inode,
        pid: child.pid,
        processStartTime: processIdentity.startTime,
        launchToken,
        argumentsVerified: false,
      };
      writeBrowserIdentity(paths, provisionalIdentity);
    }
    if (processIdentity?.startTime
      && cmdlineHasLaunchToken(processIdentity, launchToken)) {
      writeBrowserIdentity(paths, {
        ...provisionalIdentity,
        configuredExecutable,
        browserExecutable: browserExecutable || null,
        browserDevice: browserIdentity?.device || null,
        browserInode: browserIdentity?.inode || null,
        pid: child.pid,
        processStartTime: processIdentity.startTime,
        launchToken,
        argumentsVerified: true,
      });
      return;
    }
    if (!isPidAlive(child.pid)) break;
    await sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Could not verify launched Chromium executable');
}

function refreshLaunchedBrowserExecutable(paths, child) {
  const launched = readBrowserIdentity(paths);
  if (!launched || launched.pid !== child.pid) return;
  const browserExecutable = processExecutable(child.pid);
  const browserIdentity = processExecutableIdentity(child.pid);
  if (!browserExecutable || !browserIdentity) return;
  if (launched.browserExecutable === browserExecutable
    && launched.browserDevice === browserIdentity.device
    && launched.browserInode === browserIdentity.inode) {
    return;
  }
  writeBrowserIdentity(paths, {
    ...launched,
    browserExecutable,
    browserDevice: browserIdentity.device,
    browserInode: browserIdentity.inode,
  });
}

function processIsProfileBrowser(identity, paths, env = process.env) {
  const args = cmdlineArgs(identity);
  const actualExecutable = processExecutable(identity.pid);
  const actualExecutableIdentity = processExecutableIdentity(identity.pid);
  const configuredExecutable = configuredBrowserExecutable(env);
  if (!configuredExecutable) return false;

  const launched = readBrowserIdentity(paths);
  const matchesLaunch = Boolean(launched
    && launched.configuredExecutable === configuredExecutable
    && launched.pid === identity.pid
    && launched.processStartTime === String(identity.startTime));
  const matchesRecordedExecutable = Boolean(actualExecutableIdentity
    && launched
    && launched.browserDevice === actualExecutableIdentity.device
    && launched.browserInode === actualExecutableIdentity.inode);
  if (matchesLaunch
    && launched.argumentsVerified === false
    && matchesRecordedExecutable) {
    return true;
  }
  // Chromium's flattened argv is ambiguous; the private launch record has
  // already verified its token and is stronger than reparsing process.title.
  if (args.length === 1) {
    return Boolean(matchesLaunch
      && launched.argumentsVerified === true
      && (matchesRecordedExecutable || cmdlineHasLaunchToken(identity, launched.launchToken)));
  }

  if (!cmdlineHasArgument(identity, `--user-data-dir=${paths.profileDir}`)
    || cmdlineHasArgumentPrefix(identity, '--type=')) {
    return false;
  }
  if (actualExecutable === configuredExecutable) return true;

  return matchesLaunch
    && cmdlineHasLaunchToken(identity, launched.launchToken);
}

function findProfileBrowserProcesses(paths, env = process.env) {
  let entries;
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return [];
  }

  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;

    const identity = readProcessIdentity(pid);
    if (!identity || !identity.startTime || !processIsProfileBrowser(identity, paths, env)) continue;
    processes.push({
      pid,
      processGroupId: Number.isInteger(identity.processGroupId) ? identity.processGroupId : null,
      processStartTime: identity.startTime,
    });
  }
  return processes;
}

function profileBrowserStillMatches(candidate, paths, env = process.env) {
  if (!candidate || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return false;
  const identity = readProcessIdentity(candidate.pid);
  return Boolean(identity
    && identity.startTime === String(candidate.processStartTime)
    && processIsProfileBrowser(identity, paths, env));
}

function signalProfileBrowserProcess(candidate, paths, env, signal) {
  if (!profileBrowserStillMatches(candidate, paths, env)) return false;
  if (candidate.processGroupId === candidate.pid) {
    try {
      process.kill(-candidate.processGroupId, signal);
      return true;
    } catch {
      // Fall back to signaling just the verified browser PID below.
    }
  }

  try {
    process.kill(candidate.pid, signal);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  configuredBrowserExecutable,
  readBrowserIdentity,
  writeBrowserIdentity,
  persistLaunchedBrowserIdentity,
  refreshLaunchedBrowserExecutable,
  processIsProfileBrowser,
  findProfileBrowserProcesses,
  profileBrowserStillMatches,
  signalProfileBrowserProcess,
};
