'use strict';

const os = require('node:os');
const path = require('node:path');

function absoluteOrFallback(value, fallback) {
  return value && path.isAbsolute(value) ? value : fallback;
}

function resolvePaths(env = process.env) {
  const fallbackHome = os.homedir();
  const home = absoluteOrFallback(env.HOME, fallbackHome);
  const dataHome = absoluteOrFallback(env.XDG_DATA_HOME, path.join(home, '.local', 'share'));
  const stateHome = absoluteOrFallback(env.XDG_STATE_HOME, path.join(home, '.local', 'state'));
  const cacheHome = absoluteOrFallback(env.XDG_CACHE_HOME, path.join(home, '.cache'));

  const dataDir = path.join(dataHome, 'chromium-castctl');
  const stateDir = path.join(stateHome, 'chromium-castctl');
  const cacheDir = path.join(cacheHome, 'chromium-castctl');

  return {
    home,
    dataDir,
    stateDir,
    cacheDir,
    profileDir: path.join(dataDir, 'chromium-profile'),
    launcherConfigDir: path.join(dataDir, 'chromium-config'),
    stateFile: path.join(stateDir, 'state.json'),
    displayStateFile: path.join(stateDir, 'display-state.json'),
    browserIdentityFile: path.join(stateDir, 'browser-identity.json'),
    uiStateFile: path.join(stateDir, 'ui-state.json'),
    lockDir: path.join(stateDir, 'operation.lock'),
    logFile: path.join(cacheDir, 'chromium.log'),
    profileVersionFile: path.join(dataDir, 'profile-version'),
    hyprPortalConfig: path.join(home, '.config', 'hypr', 'xdph.conf'),
  };
}

module.exports = { absoluteOrFallback, resolvePaths };
