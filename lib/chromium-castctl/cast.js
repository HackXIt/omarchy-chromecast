'use strict';

const { DEFAULT_CDP_TIMEOUT_MS, DEFAULT_SINK_WAIT_MS } = require('./constants');
const { CdpClient, getPageTarget } = require('./cdp');
const { cdpTimeoutMs } = require('./env');
const { ensureChromium, getReusableBrowser, shutdownBrowser } = require('./chromium');
const { normalizeSinkList } = require('./sinks');
const { sleep } = require('./util');

// Cast operations are the only place that sends Cast.* CDP methods. They take
// already-normalized sinks from Chromium and keep cleanup responsibility close
// to failed CDP setup or command execution.
async function enableCastAndCollectSinks(client, options = {}) {
  let latest = [];
  let eventCount = 0;
  let enableError = null;
  let resolveNextEvent;
  let nextEvent = new Promise((resolve) => {
    resolveNextEvent = resolve;
  });

  const off = client.onEvent('Cast.sinksUpdated', (params) => {
    try {
      latest = normalizeSinkList(params.sinks || []);
      eventCount += 1;
      resolveNextEvent(latest);
      nextEvent = new Promise((resolve) => {
        resolveNextEvent = resolve;
      });
    } catch (error) {
      enableError = error;
      resolveNextEvent([]);
    }
  });

  const waitMs = options.waitMs ?? DEFAULT_SINK_WAIT_MS;
  const enableTimeoutMs = Math.max(options.timeoutMs || DEFAULT_CDP_TIMEOUT_MS, waitMs + 10000);
  let enableDone = false;
  const enablePromise = client.send('Cast.enable', {}, enableTimeoutMs)
    .then(() => {
      enableDone = true;
      return null;
    })
    .catch((error) => {
      enableDone = true;
      enableError = error;
      return null;
    });

  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (enableError) throw enableError;
      if (latest.some((sink) => sink && sink.name)) {
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
        break;
      }

      const remaining = Math.max(0, deadline - Date.now());
      const waits = [nextEvent, sleep(Math.min(250, remaining))];
      if (!enableDone) waits.push(enablePromise);
      await Promise.race(waits);
    }

    if (enableError && eventCount === 0) throw enableError;
    return latest;
  } finally {
    off();
    enablePromise.catch(() => null);
  }
}

async function collectCastSinks(client, options = {}) {
  const first = await enableCastAndCollectSinks(client, options);
  if (first.some((sink) => sink && sink.name) || options.retryWhenEmpty === false) return first;

  await sleep(options.emptySinkRetryDelayMs ?? 1000);
  return enableCastAndCollectSinks(client, {
    ...options,
    waitMs: options.retryWaitMs ?? Math.min(options.waitMs ?? DEFAULT_SINK_WAIT_MS, 5000),
    retryWhenEmpty: false,
  });
}

async function withCastClient(paths, options, callback) {
  const browser = options.launch === false
    ? await getReusableBrowser(paths, options)
    : await ensureChromium(paths, options);
  if (!browser) return callback({ browser: null, client: null, sinks: [] });

  let client = null;
  try {
    const target = await getPageTarget(browser.port, options);
    client = await CdpClient.connect(target.webSocketDebuggerUrl, options);
    const sinks = await collectCastSinks(client, {
      waitMs: options.waitMs,
      timeoutMs: options.timeoutMs || cdpTimeoutMs(options.env || process.env),
      emptySinkRetryDelayMs: options.emptySinkRetryDelayMs,
    });
    return await callback({ browser, client, sinks });
  } catch (error) {
    await shutdownBrowser(paths, browser, client).catch(() => null);
    throw error;
  } finally {
    if (client) client.close();
  }
}

module.exports = { enableCastAndCollectSinks, collectCastSinks, withCastClient };
