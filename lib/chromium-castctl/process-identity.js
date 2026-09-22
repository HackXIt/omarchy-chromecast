'use strict';

const fs = require('node:fs');

// Process identity and ownership checks are the guard rail before signaling or
// reusing any local Chromium controller process.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function parseProcStat(statText) {
  const endComm = statText.lastIndexOf(') ');
  if (endComm === -1) return null;
  const beforeComm = statText.slice(0, endComm + 1);
  const pidText = beforeComm.slice(0, beforeComm.indexOf(' '));
  const rest = statText.slice(endComm + 2).trim().split(/\s+/);
  return {
    pid: Number.parseInt(pidText, 10),
    processGroupId: Number.parseInt(rest[2] || '', 10),
    startTime: rest[19] || null,
  };
}

function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (!stat || !stat.startTime) return null;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      cmdline = '';
    }
    return { ...stat, cmdline };
  } catch {
    return null;
  }
}

function stateHasVerifiedBrowserProcess(state, paths) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return false;
  if (state.userDataDir !== paths.profileDir) return false;
  if (!state.processStartTime) return false;

  const identity = readProcessIdentity(state.pid);
  if (!identity || identity.startTime !== String(state.processStartTime)) return false;
  if (state.pid === process.pid) return true;
  if (Number.isInteger(state.processGroupId) && identity.processGroupId !== state.processGroupId) return false;

  return processUsesProfile(identity, paths);
}

function cmdlineArgs(identity) {
  return String(identity?.cmdline || '').split('\0').filter(Boolean);
}

function flattenedCmdlineHasArgument(commandLine, argument, prefix = false, allowPositionalAfter = false) {
  let offset = 0;
  while (offset <= commandLine.length) {
    const index = commandLine.indexOf(argument, offset);
    if (index === -1) return false;

    const beforeMatches = index === 0 || commandLine[index - 1] === ' ';
    const afterIndex = index + argument.length;
    // Only the random launch token may use a positional argument as its boundary.
    const afterMatches = prefix
      ? afterIndex < commandLine.length && commandLine[afterIndex] !== ' '
      : afterIndex === commandLine.length
        || commandLine.startsWith(' --', afterIndex)
        || (allowPositionalAfter && commandLine[afterIndex] === ' ');
    if (beforeMatches && afterMatches) return true;
    offset = index + 1;
  }
  return false;
}

function cmdlineHasArgument(identity, argument) {
  const args = cmdlineArgs(identity);
  if (args.includes(argument)) return true;
  return args.length === 1 && flattenedCmdlineHasArgument(args[0], argument);
}

function cmdlineHasArgumentPrefix(identity, prefix) {
  const args = cmdlineArgs(identity);
  if (args.some((arg) => arg.startsWith(prefix))) return true;
  return args.length === 1 && flattenedCmdlineHasArgument(args[0], prefix, true);
}

function cmdlineHasLaunchToken(identity, launchToken) {
  if (!/^[A-Za-z0-9-]+$/.test(String(launchToken || ''))) return false;
  const argument = `--chromium-castctl-launch-token=${launchToken}`;
  const args = cmdlineArgs(identity);
  if (args.includes(argument)) return true;
  return args.length === 1 && flattenedCmdlineHasArgument(args[0], argument, false, true);
}

function processUsesProfile(identity, paths) {
  return cmdlineHasArgument(identity, `--user-data-dir=${paths.profileDir}`);
}

function processExecutable(pid) {
  try {
    return fs.realpathSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

function processExecutableIdentity(pid) {
  let fd;
  try {
    fd = fs.openSync(`/proc/${pid}/exe`, fs.constants.O_RDONLY);
    const stat = fs.fstatSync(fd, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = {
  isPidAlive,
  parseProcStat,
  readProcessIdentity,
  stateHasVerifiedBrowserProcess,
  cmdlineArgs,
  cmdlineHasArgument,
  cmdlineHasArgumentPrefix,
  cmdlineHasLaunchToken,
  processUsesProfile,
  processExecutable,
  processExecutableIdentity,
};
