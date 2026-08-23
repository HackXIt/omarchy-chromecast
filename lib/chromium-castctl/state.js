'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { LOCK_RETRY_MS, LOCK_STALE_MS } = require('./constants');
const { CliError } = require('./errors');
const { findExecutable, lockTimeoutMs } = require('./env');
const { ensureDir, randomToken, writeFileAtomic } = require('./fs-private');
const { isPidAlive, readProcessIdentity } = require('./process-identity');
const { sleep } = require('./util');

// Local state, lock ownership, and UI-busy state live under private XDG paths.
// This module is intentionally filesystem-only: callers decide which browser,
// CDP, or Cast operation is allowed while the lock is held.
function readState(paths) {
  try {
    const raw = fs.readFileSync(paths.stateFile, 'utf8');
    const state = JSON.parse(raw);
    return state && typeof state === 'object' ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeState(paths, state) {
  ensureDir(path.dirname(paths.stateFile));
  writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function clearState(paths) {
  try {
    fs.rmSync(paths.stateFile, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function updateState(paths, updater) {
  const current = readState(paths) || {};
  const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
  writeState(paths, next);
  return next;
}

function readLockOwner(paths) {
  try {
    const raw = fs.readFileSync(path.join(paths.lockDir, 'owner.json'), 'utf8');
    const owner = JSON.parse(raw);
    return owner && typeof owner === 'object' ? owner : null;
  } catch {
    return null;
  }
}

function lockIsStale(paths) {
  let stat;
  try {
    stat = fs.lstatSync(paths.lockDir);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;

  const ageMs = Date.now() - stat.mtimeMs;
  const owner = readLockOwner(paths);
  if (!owner || !Number.isInteger(owner.pid)) return ageMs > LOCK_STALE_MS;
  if (!isPidAlive(owner.pid)) return true;
  if (owner.processStartTime) {
    const identity = readProcessIdentity(owner.pid);
    if (!identity || identity.startTime !== String(owner.processStartTime)) return true;
    return false;
  }
  return ageMs > LOCK_STALE_MS;
}

async function acquireStateLock(paths, options = {}) {
  const env = options.env || process.env;
  const timeoutMs = options.lockTimeoutMs ?? lockTimeoutMs(env);
  const deadline = Date.now() + timeoutMs;
  const staleLockDir = `${paths.lockDir}.stale`;
  ensureDir(paths.stateDir);

  while (true) {
    const owner = {
      pid: process.pid,
      processStartTime: readProcessIdentity(process.pid)?.startTime || null,
      nonce: randomToken(),
      createdAt: new Date().toISOString(),
    };

    try {
      fs.mkdirSync(paths.lockDir, { mode: 0o700 });
      writeFileAtomic(path.join(paths.lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 0o600);
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(paths)) {
        try {
          fs.renameSync(paths.lockDir, staleLockDir);
        } catch (renameError) {
          if (renameError.code === 'ENOENT') continue;
          if (renameError.code !== 'EEXIST' && renameError.code !== 'ENOTEMPTY') throw renameError;
          if (lockIsStale(paths)) fs.rmSync(staleLockDir, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError('Chromecast action already in progress.', 1);
      }
      await sleep(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
    }
  }
}

function releaseStateLock(paths, owner) {
  const current = readLockOwner(paths);
  if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid) return;
  fs.rmSync(paths.lockDir, { recursive: true, force: true });
  fs.rmSync(`${paths.lockDir}.stale`, { recursive: true, force: true });
}

async function withStateLock(paths, options, callback) {
  const owner = await acquireStateLock(paths, options);
  try {
    return await callback();
  } finally {
    releaseStateLock(paths, owner);
  }
}

function readUiState(paths) {
  try {
    const raw = fs.readFileSync(paths.uiStateFile, 'utf8');
    const state = JSON.parse(raw);
    return state && typeof state === 'object' ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeUiState(paths, state) {
  ensureDir(path.dirname(paths.uiStateFile));
  writeFileAtomic(paths.uiStateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function clearUiState(paths, token = null) {
  const current = readUiState(paths);
  if (token && current && current.token !== token) return;
  try {
    fs.rmSync(paths.uiStateFile, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function freshUiState(paths) {
  const state = readUiState(paths);
  if (!state) return null;

  const startedAt = Date.parse(state.startedAt || '');
  const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
  const pidAlive = !state.pid || isPidAlive(state.pid);
  if (ageMs > 120000 || !pidAlive) {
    clearUiState(paths, state.token || null);
    return null;
  }
  return state;
}

function signalWaybar(env = process.env) {
  const pkill = findExecutable('pkill', env);
  if (!pkill) return;
  childProcess.spawnSync(pkill, ['-RTMIN+12', 'waybar'], { env, timeout: 1000 });
}

function beginUiState(paths, label, env = process.env) {
  const existing = freshUiState(paths);
  if (existing && existing.pid !== process.pid) return null;

  const token = `${process.pid}-${Date.now()}`;
  writeUiState(paths, {
    status: 'busy',
    label,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  });
  signalWaybar(env);
  return token;
}

function updateUiStateLabel(paths, token, label, env = process.env) {
  const current = freshUiState(paths);
  if (!current || current.token !== token) return;
  writeUiState(paths, { ...current, label });
  signalWaybar(env);
}

function finishUiState(paths, token, env = process.env) {
  clearUiState(paths, token);
  signalWaybar(env);
}

async function withUiState(paths, label, options, callback) {
  const env = options.env || process.env;
  const existingToken = env.CHROMIUM_CASTCTL_UI_TOKEN || null;
  if (existingToken) {
    const current = freshUiState(paths);
    if (current && current.token === existingToken) {
      try {
        return await callback(existingToken);
      } finally {
        finishUiState(paths, existingToken, env);
      }
    }
  }

  const token = beginUiState(paths, label, env);
  if (!token) throw new CliError('Chromecast action already in progress.', 1);
  try {
    return await callback(token);
  } finally {
    finishUiState(paths, token, env);
  }
}

module.exports = {
  readState,
  writeState,
  clearState,
  updateState,
  readLockOwner,
  lockIsStale,
  acquireStateLock,
  releaseStateLock,
  withStateLock,
  readUiState,
  writeUiState,
  clearUiState,
  freshUiState,
  signalWaybar,
  beginUiState,
  updateUiStateLabel,
  finishUiState,
  withUiState,
};
