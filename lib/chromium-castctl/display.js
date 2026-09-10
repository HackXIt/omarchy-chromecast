'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { findExecutable } = require('./env');
const { ensureDir, writeFileAtomic } = require('./fs-private');

const DISPLAY_STATE_VERSION = 1;
const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 1080;

function fitDisplayEnabled(env = process.env) {
  const value = String(env.CHROMIUM_CASTCTL_FIT_DISPLAY || '').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function parseMode(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)@(\d+(?:\.\d+)?)(?:Hz)?$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const refreshRate = Number(match[3]);
  if (width <= 0 || height <= 0 || !Number.isFinite(refreshRate) || refreshRate <= 0) return null;
  return { width, height, refreshRate, value: `${width}x${height}@${match[3]}` };
}

function isSixteenNine(mode) {
  return mode && Math.abs((mode.width / mode.height) - (16 / 9)) <= 0.01;
}

function selectSixteenNineMode(values) {
  const modes = values.map(parseMode).filter(isSixteenNine);
  modes.sort((left, right) => {
    const leftExact = left.width === TARGET_WIDTH && left.height === TARGET_HEIGHT;
    const rightExact = right.width === TARGET_WIDTH && right.height === TARGET_HEIGHT;
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    const leftDistance = Math.abs(left.width - TARGET_WIDTH) + Math.abs(left.height - TARGET_HEIGHT);
    const rightDistance = Math.abs(right.width - TARGET_WIDTH) + Math.abs(right.height - TARGET_HEIGHT);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return (right.width * right.height) - (left.width * left.height) || right.refreshRate - left.refreshRate;
  });
  return modes[0] || null;
}

function currentMode(monitor) {
  const candidates = (monitor.availableModes || []).map(parseMode).filter((mode) => (
    mode.width === monitor.width && mode.height === monitor.height
  ));
  candidates.sort((left, right) => Math.abs(left.refreshRate - monitor.refreshRate) - Math.abs(right.refreshRate - monitor.refreshRate));
  if (candidates[0]) return candidates[0].value;
  if (!Number.isInteger(monitor.width) || !Number.isInteger(monitor.height) || !Number.isFinite(monitor.refreshRate)) return null;
  return `${monitor.width}x${monitor.height}@${monitor.refreshRate}`;
}

function readDisplayState(paths) {
  try {
    const state = JSON.parse(fs.readFileSync(paths.displayStateFile, 'utf8'));
    return state && state.version === DISPLAY_STATE_VERSION ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeDisplayState(paths, state) {
  ensureDir(path.dirname(paths.displayStateFile));
  writeFileAtomic(paths.displayStateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function clearDisplayState(paths) {
  fs.rmSync(paths.displayStateFile, { force: true });
}

function runHyprctl(args, options = {}) {
  if (options.hyprctl) return options.hyprctl(args);
  const env = options.env || process.env;
  const executable = findExecutable('hyprctl', env);
  if (!executable) return { status: 127, stdout: '', stderr: 'hyprctl not found' };
  return childProcess.spawnSync(executable, args, { encoding: 'utf8', env, timeout: 3000 });
}

function monitorExpression(state) {
  return `hl.monitor({ output = ${JSON.stringify(state.output)}, mode = ${JSON.stringify(state.mode)}, position = ${JSON.stringify(state.position)}, scale = ${state.scale}, transform = ${state.transform} })`;
}

function applyMonitor(state, options = {}) {
  if (!state || typeof state.output !== 'string' || typeof state.mode !== 'string'
    || typeof state.position !== 'string' || !Number.isFinite(state.scale)
    || !Number.isInteger(state.transform)) return false;
  const result = runHyprctl(['eval', monitorExpression(state)], options);
  return !result.error && result.status === 0;
}

function prepareDisplayForCast(paths, options = {}) {
  const env = options.env || process.env;
  if (options.fitDisplay === false || !fitDisplayEnabled(env)) return false;
  if (readDisplayState(paths)) return false;

  const result = runHyprctl(['monitors', '-j'], options);
  if (result.error || result.status !== 0) return false;

  let monitors;
  try {
    monitors = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  const monitor = Array.isArray(monitors) ? monitors.find((candidate) => candidate && candidate.focused && !candidate.disabled) : null;
  if (!monitor || isSixteenNine(monitor)) return false;

  const selected = selectSixteenNineMode(Array.isArray(monitor.availableModes) ? monitor.availableModes : []);
  const mode = currentMode(monitor);
  if (!selected || !mode || typeof monitor.name !== 'string'
    || !Number.isFinite(monitor.x) || !Number.isFinite(monitor.y)
    || !Number.isFinite(monitor.scale) || !Number.isInteger(monitor.transform)) return false;

  const restoreState = {
    version: DISPLAY_STATE_VERSION,
    output: monitor.name,
    mode,
    position: `${monitor.x}x${monitor.y}`,
    scale: monitor.scale,
    transform: monitor.transform,
    temporaryMode: selected.value,
    createdAt: new Date().toISOString(),
  };
  writeDisplayState(paths, restoreState);

  const changed = applyMonitor({ ...restoreState, mode: selected.value }, options);
  if (!changed) {
    clearDisplayState(paths);
    return false;
  }
  return true;
}

function restoreDisplay(paths, options = {}) {
  const state = readDisplayState(paths);
  if (!state) return false;
  if (!applyMonitor(state, options)) return false;
  clearDisplayState(paths);
  return true;
}

module.exports = {
  DISPLAY_STATE_VERSION,
  fitDisplayEnabled,
  parseMode,
  isSixteenNine,
  selectSixteenNineMode,
  currentMode,
  readDisplayState,
  writeDisplayState,
  clearDisplayState,
  monitorExpression,
  applyMonitor,
  prepareDisplayForCast,
  restoreDisplay,
};
