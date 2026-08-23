'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const { STATUS_SINK_WAIT_MS } = require('./constants');
const { CliError } = require('./errors');
const { browserStartTimeoutMs, cdpTimeoutMs, findExecutable, sinkWaitMs } = require('./env');
const { resolvePaths } = require('./paths');
const { discoverAvahiSinks } = require('./discovery');
const { withCastClient } = require('./cast');
const { ensureChromium, shutdownBrowser } = require('./chromium');
const { collectDoctorResults, doctorOptionsFromArgs } = require('./doctor');
const { getStatus } = require('./status');
const { renderWaybarStatus, writeError, writeLine } = require('./format');
const {
  assertNoAmbiguousSinks,
  activeSinks,
  formatSinkJson,
  formatSinkList,
  matchSink,
  normalizeSinkList,
  stripControlsForDisplay,
} = require('./sinks');
const {
  beginUiState,
  freshUiState,
  readState,
  readUiState,
  signalWaybar,
  updateState,
  updateUiStateLabel,
  withStateLock,
  withUiState,
  writeUiState,
} = require('./state');

const DEFAULT_HELPER_BIN = path.join(__dirname, '..', '..', 'bin', 'chromium-castctl');

function helperBinPath(options = {}) {
  return options.binPath || DEFAULT_HELPER_BIN;
}

async function commandSinks(paths, options, io, args = []) {
  const jsonOutput = args.includes('--json');
  return withCastClient(paths, {
    ...options,
    waitMs: options.waitMs ?? sinkWaitMs(options.env),
  }, async ({ browser, client, sinks }) => {
    const output = jsonOutput ? formatSinkJson(sinks) : formatSinkList(sinks);
    if (output) writeLine(io, output);
    if (activeSinks(sinks).length === 0) await shutdownBrowser(paths, browser, client);
    return 0;
  });
}

async function commandStart(paths, options, io, requestedName) {
  if (!requestedName) throw new CliError('Usage: chromium-castctl start <sink-name>', 2);

  return withUiState(paths, 'Starting Chromecast cast…', options, () => withCastClient(paths, {
    ...options,
    waitMs: options.waitMs ?? sinkWaitMs(options.env),
  }, async ({ browser, client, sinks }) => {
    const sink = matchSink(sinks, requestedName);
    if (!sink) {
      await shutdownBrowser(paths, browser, client);
      const available = formatSinkList(sinks) || '(none)';
      throw new CliError(`Sink not found: ${requestedName}\nAvailable sinks:\n${available}`, 1);
    }

    await client.send('Cast.startDesktopMirroring', { sinkName: sink.name }, 10000);
    updateState(paths, (state) => ({ ...state, lastActiveSink: sink.name }));
    writeLine(io, `Started desktop mirroring to ${stripControlsForDisplay(sink.name)}. Confirm the Wayland screen-share portal if prompted.`);
    return 0;
  }));
}

async function commandStop(paths, options, io) {
  return withUiState(paths, 'Stopping Chromecast cast…', options, () => withCastClient(paths, {
    ...options,
    launch: false,
    waitMs: options.waitMs ?? sinkWaitMs(options.env, STATUS_SINK_WAIT_MS),
  }, async ({ browser, client, sinks }) => {
    if (!browser || !client) {
      writeLine(io, 'No chromium-castctl Chromium instance is running; no active cast to stop.');
      return 0;
    }

    const active = activeSinks(sinks);
    if (active.length === 0) {
      updateState(paths, (state) => ({ ...state, lastActiveSink: null }));
      await shutdownBrowser(paths, browser, client);
      writeLine(io, 'No active cast; closed Chromium control browser.');
      return 0;
    }

    const failed = [];
    for (const sink of active) {
      try {
        await client.send('Cast.stopCasting', { sinkName: sink.name }, 10000);
      } catch (error) {
        failed.push({ sink, error });
      }
    }

    updateState(paths, (state) => ({ ...state, lastActiveSink: null }));
    await shutdownBrowser(paths, browser, client);

    if (failed.length > 0) {
      writeError(io, `Failed to stop casting for ${failed.map(({ sink }) => stripControlsForDisplay(sink.name)).join(', ')}; local Chromium cleanup was attempted.`);
      return 1;
    }

    writeLine(io, `Stopped casting to ${active.map((sink) => stripControlsForDisplay(sink.name)).join(', ')} and closed Chromium control browser.`);
    return 0;
  }));
}

function spawnPrewarmBrowser(options = {}) {
  const env = options.env || process.env;
  const child = childProcess.spawn(process.execPath, [helperBinPath(options), 'prewarm-browser'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return child;
}

function requireWalker(env = process.env) {
  const walker = findExecutable('walker', env);
  if (!walker) throw new CliError('walker is not installed or not on PATH; run chromium-castctl start <sink-name> instead.', 1);
  return walker;
}

function runWalker(sinks, options = {}) {
  const env = options.env || process.env;
  const walker = requireWalker(env);
  const normalized = normalizeSinkList(sinks);

  assertNoAmbiguousSinks(normalized);
  const input = `${normalized.map((sink) => sink.name).join('\n')}\n`;
  const result = childProcess.spawnSync(walker, ['--dmenu', '--placeholder', 'Cast to…'], {
    input,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

async function commandPick(paths, options, io) {
  let token = null;
  return withUiState(paths, 'Discovering Chromecast targets…', options, async () => {
    const env = options.env || process.env;
    const current = freshUiState(paths);
    token = current && current.pid === process.pid ? current.token : null;

    const avahiSinks = discoverAvahiSinks(options);
    if (avahiSinks.length > 0) {
      assertNoAmbiguousSinks(avahiSinks);
      let selected = avahiSinks.length === 1 ? avahiSinks[0].name : null;
      if (!selected) {
        requireWalker(env);
        if (token) updateUiStateLabel(paths, token, 'Choose a Chromecast target in Walker…', env);
        selected = runWalker(avahiSinks, options);
      }

      if (!selected) {
        await shutdownBrowser(paths, readState(paths), null);
        writeLine(io, 'No sink selected; closed Chromium control browser.');
        return 0;
      }

      if (token) updateUiStateLabel(paths, token, `Starting cast to ${stripControlsForDisplay(selected)}…`, env);
      return withCastClient(paths, {
        ...options,
        waitMs: options.waitMs ?? sinkWaitMs(options.env),
      }, async ({ browser, client, sinks }) => {
        const sink = matchSink(sinks, selected);
        if (!sink) {
          await shutdownBrowser(paths, browser, client);
          const available = formatSinkList(sinks) || '(none)';
          throw new CliError(`Sink not found in Chromium: ${selected}\nAvailable Chromium sinks:\n${available}`, 1);
        }

        await client.send('Cast.startDesktopMirroring', { sinkName: sink.name }, 10000);
        updateState(paths, (state) => ({ ...state, lastActiveSink: sink.name }));
        writeLine(io, `Started desktop mirroring to ${stripControlsForDisplay(sink.name)}. Confirm the Wayland screen-share portal if prompted.`);
        return 0;
      });
    }

    return withCastClient(paths, {
      ...options,
      waitMs: options.waitMs ?? sinkWaitMs(options.env),
    }, async ({ browser, client, sinks }) => {
      const namedSinks = normalizeSinkList(sinks).filter((sink) => sink.name);
      if (namedSinks.length === 0) {
        await shutdownBrowser(paths, browser, client);
        throw new CliError('No Cast sinks found. Check that Chromium can see the Chromecast and both devices are on the same network.', 1);
      }

      assertNoAmbiguousSinks(namedSinks);
      let selected = namedSinks.length === 1 ? namedSinks[0].name : null;
      if (!selected) {
        if (token) updateUiStateLabel(paths, token, 'Choose a Chromecast target in Walker…', env);
        try {
          selected = runWalker(namedSinks, options);
        } catch (error) {
          await shutdownBrowser(paths, browser, client);
          throw error;
        }
      }
      if (!selected) {
        await shutdownBrowser(paths, browser, client);
        writeLine(io, 'No sink selected; closed Chromium control browser.');
        return 0;
      }

      const sink = matchSink(namedSinks, selected);
      if (!sink) throw new CliError(`Selected sink disappeared: ${selected}`, 1);
      await client.send('Cast.startDesktopMirroring', { sinkName: sink.name }, 10000);
      updateState(paths, (state) => ({ ...state, lastActiveSink: sink.name }));
      writeLine(io, `Started desktop mirroring to ${stripControlsForDisplay(sink.name)}. Confirm the Wayland screen-share portal if prompted.`);
      return 0;
    });
  });
}

async function commandToggle(paths, options, io) {
  const workerToken = options.env && options.env.CHROMIUM_CASTCTL_UI_TOKEN;
  const busy = workerToken ? null : freshUiState(paths);
  if (busy) {
    writeLine(io, busy.label || 'Chromecast action already in progress…');
    return 0;
  }

  const status = await getStatus(paths, { ...options, ignoreUiState: Boolean(workerToken) });
  if (status.activeSink) return commandStop(paths, options, io);
  return commandPick(paths, options, io);
}

async function commandWaybarToggle(paths, options, io) {
  const env = options.env || process.env;
  const busy = freshUiState(paths);
  if (busy) return 0;

  const status = await getStatus(paths, { ...options, ignoreUiState: true });
  const label = status.activeSink ? 'Stopping Chromecast cast…' : 'Discovering Chromecast targets…';
  const token = beginUiState(paths, label, env);
  if (!token) return 0;

  const child = childProcess.spawn(process.execPath, [helperBinPath(options), 'toggle'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      CHROMIUM_CASTCTL_UI_TOKEN: token,
    },
  });
  child.unref();

  const current = readUiState(paths);
  if (current && current.token === token) {
    writeUiState(paths, { ...current, pid: child.pid });
    signalWaybar(env);
  }

  writeLine(io, label);
  return 0;
}

async function commandQuitBrowser(paths, io) {
  const closed = await shutdownBrowser(paths, readState(paths), null);
  writeLine(io, closed ? 'Closed Chromium control browser.' : 'No chromium-castctl Chromium instance is running.');
  return 0;
}

async function commandPrewarmBrowser(paths, options) {
  await ensureChromium(paths, options);
  return 0;
}

async function commandStatus(paths, options, io, waybar = false) {
  const status = await getStatus(paths, options);
  if (waybar) {
    writeLine(io, renderWaybarStatus(status));
    return 0;
  }

  if (status.busy) {
    writeLine(io, `busy: ${status.busy.label || 'Chromecast action in progress…'}`);
  } else if (status.activeSink) {
    writeLine(io, `active: ${stripControlsForDisplay(status.activeSink)}`);
  } else {
    writeLine(io, 'idle');
  }
  if (status.stale) writeLine(io, 'stale state was removed');
  return 0;
}

async function commandDoctor(paths, options, io, args = []) {
  const results = await collectDoctorResults(paths, { ...options, ...doctorOptionsFromArgs(args) });
  for (const result of results) {
    const prefix = result.status === 'ok' ? 'ok' : result.status === 'warn' ? 'warn' : 'fail';
    writeLine(io, `${prefix} ${result.name}${result.detail ? `: ${result.detail}` : ''}`);
  }
  return results.some((result) => result.status === 'fail') ? 1 : 0;
}

function usage() {
  return `Usage: chromium-castctl <command> [args]

Commands:
  doctor [--quickshell] Check local Chromium/Cast/portal prerequisites
  sinks [--json]         List Cast sinks as names or structured JSON
  pick                   Pick a sink with Walker, or start the only sink directly
  start <sink-name>      Start desktop mirroring to a sink
  stop                   Stop active casting sessions
  toggle                 Stop if active, otherwise open the sink picker
  waybar-toggle          Waybar click helper: show busy state, then toggle in background
  status [--waybar]      Print human status or Waybar JSON
  quit-browser           Close the isolated Chromium control browser
  help                   Show this help
`;
}

function commandUsesStateLock(command) {
  return ['sinks', 'pick', 'start', 'stop', 'toggle', 'waybar-toggle', 'status', 'quit-browser', 'prewarm-browser'].includes(command);
}

async function dispatchCommand(command, args, paths, options, io) {
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      io.stdout.write(usage());
      return 0;
    case 'doctor':
      return commandDoctor(paths, options, io, args);
    case 'sinks':
      return commandSinks(paths, options, io, args);
    case 'pick':
      return commandPick(paths, options, io);
    case 'start':
      return commandStart(paths, options, io, args.join(' '));
    case 'stop':
      return commandStop(paths, options, io);
    case 'toggle':
      return commandToggle(paths, options, io);
    case 'waybar-toggle':
      return commandWaybarToggle(paths, options, io);
    case 'status':
      return commandStatus(paths, options, io, args.includes('--waybar'));
    case 'quit-browser':
      return commandQuitBrowser(paths, io);
    case 'prewarm-browser':
      return commandPrewarmBrowser(paths, options);
    default:
      throw new CliError(`Unknown command: ${command}\n\n${usage()}`, 2);
  }
}

async function run(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }, env = process.env, deps = {}) {
  const paths = deps.paths || resolvePaths(env);
  const options = {
    env,
    fetchImpl: deps.fetchImpl,
    WebSocketImpl: deps.WebSocketImpl,
    timeoutMs: cdpTimeoutMs(env),
    browserStartTimeoutMs: browserStartTimeoutMs(env),
  };

  const [command, ...args] = argv;
  try {
    if (commandUsesStateLock(command)) {
      return await withStateLock(paths, options, () => dispatchCommand(command, args, paths, options, io));
    }
    return await dispatchCommand(command, args, paths, options, io);
  } catch (error) {
    if (error instanceof CliError) {
      writeError(io, error.message);
      return error.exitCode;
    }
    const state = readState(paths);
    const logHint = state && state.logFile ? `\nChromium log: ${state.logFile}` : '';
    writeError(io, `${error.message || String(error)}${logHint}`);
    return 1;
  }
}

module.exports = {
  helperBinPath,
  commandSinks,
  commandStart,
  commandStop,
  spawnPrewarmBrowser,
  requireWalker,
  runWalker,
  commandPick,
  commandToggle,
  commandWaybarToggle,
  commandQuitBrowser,
  commandPrewarmBrowser,
  commandStatus,
  commandDoctor,
  usage,
  commandUsesStateLock,
  dispatchCommand,
  run,
};
