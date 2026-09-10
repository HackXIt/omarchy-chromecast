'use strict';

const { STATUS_SINK_WAIT_MS } = require('./constants');
const { discardStateBrowser, shutdownBrowser } = require('./chromium');
const { restoreDisplay } = require('./display');
const { castRequestGraceActive, hasPendingCastRequest, withCastClient } = require('./cast');
const { readState, freshUiState, updateState } = require('./state');
const { activeSinks } = require('./sinks');

async function getStatus(paths, options = {}) {
  const busy = options.ignoreUiState ? null : freshUiState(paths);
  if (busy) return { busy, activeSink: null, sinks: [], browser: false, stale: false };

  return withCastClient(paths, {
    ...options,
    launch: false,
    waitMs: options.waitMs ?? STATUS_SINK_WAIT_MS,
  }, async ({ browser, client, sinks }) => {
    if (!browser) {
      restoreDisplay(paths, options);
      return { activeSink: null, sinks: [], browser: false, stale: false };
    }
    const active = activeSinks(sinks);
    const state = readState(paths);
    if (active.length > 0 && hasPendingCastRequest(state)) {
      updateState(paths, (current) => ({ ...current, castRequestStartedAt: null }));
    } else if (active.length === 0 && hasPendingCastRequest(state)
      && !castRequestGraceActive(state, options.now ?? Date.now())) {
      await shutdownBrowser(paths, browser, client, options.env, options);
      return { activeSink: null, sinks, browser: false, stale: false };
    }
    return {
      activeSink: active[0] ? active[0].name : null,
      sinks,
      browser: true,
      stale: false,
    };
  }).catch(async (error) => {
    const state = readState(paths);
    if (state) await discardStateBrowser(paths, state, options);
    restoreDisplay(paths, options);
    return { activeSink: null, sinks: [], browser: false, stale: true, error };
  });
}

module.exports = { getStatus };
