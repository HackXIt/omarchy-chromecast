'use strict';

const { STATUS_SINK_WAIT_MS } = require('./constants');
const { discardStateBrowser } = require('./chromium');
const { restoreDisplay } = require('./display');
const { withCastClient } = require('./cast');
const { readState, freshUiState } = require('./state');
const { activeSinks } = require('./sinks');

async function getStatus(paths, options = {}) {
  const busy = options.ignoreUiState ? null : freshUiState(paths);
  if (busy) return { busy, activeSink: null, sinks: [], browser: false, stale: false };

  return withCastClient(paths, {
    ...options,
    launch: false,
    waitMs: options.waitMs ?? STATUS_SINK_WAIT_MS,
  }, async ({ browser, sinks }) => {
    if (!browser) {
      restoreDisplay(paths, options);
      return { activeSink: null, sinks: [], browser: false, stale: false };
    }
    const active = activeSinks(sinks);
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
