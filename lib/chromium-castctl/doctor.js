'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');

const { LOCAL_DEVTOOLS_ADDRESS } = require('./constants');
const { chromiumCommand, findExecutable } = require('./env');
const { findProfileBrowserProcesses, stateHasUsableCdp } = require('./chromium');
const { readState } = require('./state');

function serviceIsActive(service, env = process.env) {
  const systemctl = findExecutable('systemctl', env);
  if (!systemctl) return null;
  const result = childProcess.spawnSync(systemctl, ['--user', 'is-active', '--quiet', service], {
    env,
    timeout: 3000,
  });
  return result.status === 0;
}

function readPortalConfig(paths) {
  try {
    return fs.readFileSync(paths.hyprPortalConfig, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function addDoctorResult(results, status, name, detail) {
  results.push({ status, name, detail });
}

async function collectDoctorResults(paths, options = {}) {
  const env = options.env || process.env;
  const results = [];

  addDoctorResult(results, 'ok', 'repository paths', `profile=${paths.profileDir}`);
  addDoctorResult(results, 'ok', 'normal Chromium profile untouched', 'uses chromium-castctl isolated user-data-dir');
  addDoctorResult(results, 'ok', 'DevTools bind address', LOCAL_DEVTOOLS_ADDRESS);

  addDoctorResult(results, 'ok', 'Node', process.version);
  addDoctorResult(results, typeof globalThis.fetch === 'function' ? 'ok' : 'fail', 'Node fetch API', typeof globalThis.fetch);
  addDoctorResult(results, typeof globalThis.WebSocket === 'function' ? 'ok' : 'fail', 'Node WebSocket API', typeof globalThis.WebSocket);

  const chromium = findExecutable(chromiumCommand(env), env);
  addDoctorResult(results, chromium ? 'ok' : 'fail', 'Chromium executable', chromium || chromiumCommand(env));

  if (options.uiMode === 'quickshell') {
    addDoctorResult(results, 'ok', 'Quickshell picker', 'provided by Omarchy shell plugin');
  } else {
    const walker = findExecutable('walker', env);
    addDoctorResult(results, walker ? 'ok' : 'warn', 'Walker executable', walker || 'not found; pick requires walker');
  }

  const avahi = findExecutable('avahi-browse', env);
  addDoctorResult(results, avahi ? 'ok' : 'warn', 'Avahi browse executable', avahi || 'not found; pick will fall back to slower Chromium discovery');

  const picker = findExecutable('hyprland-preview-share-picker', env);
  addDoctorResult(results, picker ? 'ok' : 'warn', 'Hyprland preview share picker', picker || 'not found');

  const portalConfig = readPortalConfig(paths);
  addDoctorResult(results, portalConfig !== null ? 'ok' : 'warn', 'Hyprland portal config', paths.hyprPortalConfig);
  if (portalConfig !== null) {
    const allowsTokens = /^\s*allow_token_by_default\s*=\s*true\s*$/m.test(portalConfig);
    addDoctorResult(results, allowsTokens ? 'ok' : 'warn', 'portal restore tokens', 'allow_token_by_default = true');
  }

  for (const service of ['xdg-desktop-portal-hyprland.service', 'pipewire.service', 'pipewire-pulse.service']) {
    const active = serviceIsActive(service, env);
    addDoctorResult(results, active ? 'ok' : 'warn', service, active ? 'active' : active === null ? 'systemctl not available' : 'not active');
  }

  const state = readState(paths);
  const profileBrowsers = findProfileBrowserProcesses(paths, env);
  if (state) {
    const usable = await stateHasUsableCdp(state, { ...options, paths, timeoutMs: 1000 }).catch(() => false);
    addDoctorResult(results, usable ? 'ok' : 'warn', 'existing chromium-castctl browser', usable ? `pid=${state.pid} port=${state.port}` : 'stale state will be replaced on next start');
    const extraBrowsers = profileBrowsers.filter((browser) => browser.pid !== state.pid);
    if (extraBrowsers.length > 0) {
      addDoctorResult(results, 'warn', 'extra chromium-castctl browser process', extraBrowsers.map((browser) => `pid=${browser.pid}`).join(', '));
    }
    if (state.remoteDebuggingAddress && state.remoteDebuggingAddress !== LOCAL_DEVTOOLS_ADDRESS) {
      addDoctorResult(results, 'fail', 'existing DevTools bind address', state.remoteDebuggingAddress);
    }
  } else if (profileBrowsers.length > 0) {
    addDoctorResult(results, 'warn', 'existing chromium-castctl browser', `orphaned profile process(es): ${profileBrowsers.map((browser) => `pid=${browser.pid}`).join(', ')}; next command will clean them up`);
  } else {
    addDoctorResult(results, 'ok', 'existing chromium-castctl browser', 'not running');
  }

  return results;
}

function doctorOptionsFromArgs(args = []) {
  const uiMode = args.includes('--quickshell') || args.includes('--ui=quickshell') ? 'quickshell' : 'walker';
  return { uiMode };
}

module.exports = {
  serviceIsActive,
  readPortalConfig,
  addDoctorResult,
  collectDoctorResults,
  doctorOptionsFromArgs,
};
