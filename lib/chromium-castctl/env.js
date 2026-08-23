'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_BROWSER_START_TIMEOUT_MS,
  DEFAULT_CDP_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_SINK_WAIT_MS,
} = require('./constants');

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(command, env = process.env) {
  if (!command) return null;
  if (command.includes('/')) {
    const full = path.resolve(command);
    return isExecutable(full) ? full : null;
  }

  const pathValue = Object.prototype.hasOwnProperty.call(env, 'PATH')
    ? (env.PATH || '')
    : (process.env.PATH || '');
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function chromiumCommand(env = process.env) {
  return env.CHROMIUM_CASTCTL_CHROMIUM || 'chromium';
}

function sinkWaitMs(env = process.env, fallback = DEFAULT_SINK_WAIT_MS) {
  const value = Number.parseInt(env.CHROMIUM_CASTCTL_SINK_WAIT_MS || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function browserStartTimeoutMs(env = process.env) {
  const value = Number.parseInt(env.CHROMIUM_CASTCTL_BROWSER_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BROWSER_START_TIMEOUT_MS;
}

function cdpTimeoutMs(env = process.env) {
  const value = Number.parseInt(env.CHROMIUM_CASTCTL_CDP_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CDP_TIMEOUT_MS;
}

function avahiTimeoutMs(env = process.env) {
  const value = Number.parseInt(env.CHROMIUM_CASTCTL_AVAHI_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : 1500;
}

function lockTimeoutMs(env = process.env) {
  const value = Number.parseInt(env.CHROMIUM_CASTCTL_LOCK_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LOCK_TIMEOUT_MS;
}

module.exports = {
  isExecutable,
  findExecutable,
  chromiumCommand,
  sinkWaitMs,
  browserStartTimeoutMs,
  cdpTimeoutMs,
  avahiTimeoutMs,
  lockTimeoutMs,
};
