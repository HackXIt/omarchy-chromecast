const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const mod = require('../bin/chromium-castctl');
const bin = path.join(__dirname, '..', 'bin', 'chromium-castctl');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-castctl-test-'));
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function waitForChildExit(child, timeoutMs = 2500) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
  };
}

function jsonTextResponse(value) {
  const body = JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null) },
    async text() {
      return body;
    },
    async json() {
      return value;
    },
  };
}

function cdpPageTarget(port = 9222) {
  return { type: 'page', id: 'page-1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1` };
}

class PrototypeDataEvent {
  constructor(data) {
    this._data = data;
  }

  get data() {
    return this._data;
  }
}

class EmptySinkWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    setImmediate(() => {
      this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, result: {} })));
      if (message.method === 'Cast.enable') {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({
          method: 'Cast.sinksUpdated',
          params: { sinks: [] },
        })));
      }
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    setImmediate(() => {
      const result = message.method === 'Browser.getWindowForTarget' ? { windowId: 42 } : {};
      this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, result })));
      if (message.method === 'Cast.enable') {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({
          method: 'Cast.sinksUpdated',
          params: { sinks: [{ name: 'Wohnzimmer', session: null }] },
        })));
      }
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}


class StopFailingWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    StopFailingWebSocket.instances.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    setImmediate(() => {
      if (message.method === 'Cast.enable') {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, result: {} })));
        this.emit('message', new PrototypeDataEvent(JSON.stringify({
          method: 'Cast.sinksUpdated',
          params: { sinks: [
            { name: 'Living Room', session: { id: 'one' } },
            { name: 'Bedroom', session: { id: 'two' } },
          ] },
        })));
      } else if (message.method === 'Cast.stopCasting' && message.params.sinkName === 'Living Room') {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, error: { message: 'receiver refused stop' } })));
      } else {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, result: {} })));
      }
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

class ControlNameWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    ControlNameWebSocket.instances.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    setImmediate(() => {
      this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, result: {} })));
      if (message.method === 'Cast.enable') {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({
          method: 'Cast.sinksUpdated',
          params: { sinks: [
            { name: 'Good\nBad', session: null },
            { name: 'Esc\u001bBad', session: null },
            { name: 'Bidi\u202eBad', session: null },
            { name: '<b>Wohnzimmer</b> & "TV"', session: null },
          ] },
        })));
      }
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}


class DuplicateNameWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }

  send(raw) {
    const message = JSON.parse(raw);
    setImmediate(() => {
      this.emit('message', new PrototypeDataEvent(JSON.stringify({ id: message.id, result: {} })));
      if (message.method === 'Cast.enable') {
        this.emit('message', new PrototypeDataEvent(JSON.stringify({
          method: 'Cast.sinksUpdated',
          params: { sinks: [
            { name: 'Trusted TV', id: 'a', session: null },
            { name: 'Trusted TV', id: 'b', session: null },
          ] },
        })));
      }
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

class OversizedMessageWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }

  send() {
    setImmediate(() => {
      this.emit('message', new PrototypeDataEvent(`${'{'}"id":1,"result":"${'x'.repeat(2 * 1024 * 1024)}"${'}'}`));
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

test('XDG paths use isolated chromium-castctl locations and ignore relative XDG roots', () => {
  const home = tempHome();
  const paths = mod.resolvePaths({ HOME: home, XDG_DATA_HOME: 'relative-data', XDG_STATE_HOME: 'relative-state', XDG_CACHE_HOME: 'relative-cache' });
  assert.equal(paths.profileDir, path.join(home, '.local', 'share', 'chromium-castctl', 'chromium-profile'));
  assert.equal(paths.stateFile, path.join(home, '.local', 'state', 'chromium-castctl', 'state.json'));
  assert.equal(paths.logFile, path.join(home, '.cache', 'chromium-castctl', 'chromium.log'));
});

test('state read/write round-trips JSON state with private file permissions', () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  const state = { pid: 1234, port: 4567, remoteDebuggingAddress: '127.0.0.1', lastActiveSink: 'Wohnzimmer' };
  mod.writeState(paths, state);
  assert.deepEqual(mod.readState(paths), state);
  assert.equal(fs.statSync(paths.stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(paths.stateFile)).mode & 0o777, 0o700);
});

test('executable lookup respects an explicitly empty PATH', () => {
  assert.equal(mod.findExecutable('node', { PATH: '' }), null);
});

test('executable lookup falls back to the process PATH when PATH is absent', () => {
  assert.equal(mod.findExecutable(process.execPath, {}), process.execPath);
  assert.ok(mod.findExecutable('node', {}));
});

test('chromium launch args use an isolated headless profile and localhost-only DevTools', () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  const args = mod.chromiumLaunchArgs(paths, 9333, {});
  assert.ok(args.includes(`--user-data-dir=${paths.profileDir}`));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--enable-features=MediaRouter'));
  assert.ok(!args.some((arg) => arg.includes('PulseaudioLoopbackForCast')));
  assert.ok(!args.some((arg) => arg.includes('.config/chromium')));
});

test('chromium audio loopback is opt-in', () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  const args = mod.chromiumLaunchArgs(paths, 9333, { CHROMIUM_CASTCTL_CAST_AUDIO: '1' });
  assert.ok(args.includes('--enable-features=MediaRouter,PulseaudioLoopbackForCast'));
});

test('browser launch honors the browser startup timeout separately from the CDP timeout', async () => {
  const home = tempHome();
  const fakeBin = path.join(home, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, 'chromium'), '#!/bin/sh\nprofile=\nfor arg in "$@"; do case "$arg" in --user-data-dir=*) profile=${arg#--user-data-dir=};; esac; done\nmkdir -p "$profile"\nprintf "9333\\n/devtools/browser/fake\\n" > "$profile/DevToolsActivePort"\n/bin/sleep 1\n');

  const paths = mod.resolvePaths({ HOME: home });
  let listCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/json/list')) {
      listCalls += 1;
      if (listCalls === 1) throw new Error('CDP not ready yet');
      return jsonResponse([cdpPageTarget(9333)]);
    }
    if (url.includes('/json/new?')) return jsonResponse({});
    throw new Error(`Unexpected URL: ${url}`);
  };
  let stdout = '';
  let stderr = '';

  const code = await mod.run(
    ['sinks'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    {
      HOME: home,
      PATH: fakeBin,
      CHROMIUM_CASTCTL_CDP_TIMEOUT_MS: '1',
      CHROMIUM_CASTCTL_BROWSER_TIMEOUT_MS: '800',
      CHROMIUM_CASTCTL_SINK_WAIT_MS: '1',
    },
    { paths, fetchImpl, WebSocketImpl: FakeWebSocket },
  );

  assert.equal(code, 0, stderr);
  assert.match(stdout, /Wohnzimmer/);
  assert.ok(listCalls >= 2);
});

test('status --waybar renders idle JSON without launching Chromium', async () => {
  const home = tempHome();
  const paths = mod.resolvePaths({ HOME: home });
  const json = mod.renderWaybarStatus({ activeSink: null, stale: false }, paths);
  assert.deepEqual(JSON.parse(json), {
    text: '',
    class: 'idle',
    tooltip: 'Chromecast: idle',
  });
});

test('status cleanup clears unverified stale same-profile browser state without signaling the PID', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });

  try {
    mod.writeState(paths, {
      pid: child.pid,
      port: 9222,
      remoteDebuggingAddress: '127.0.0.1',
      userDataDir: paths.profileDir,
      launchMode: 'headless',
      profileVersion: 4,
      castAudio: false,
      processStartTime: 'definitely-not-the-live-process-start-time',
      processGroupId: child.pid,
    });
    const fetchImpl = async () => { throw new Error('CDP is unavailable'); };

    const status = await mod.getStatus(paths, { fetchImpl, timeoutMs: 1, waitMs: 1 });

    assert.equal(status.browser, false);
    assert.equal(await waitForChildExit(child, 300), false);
    assert.equal(mod.readState(paths), null);
  } finally {
    if (mod.isPidAlive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        process.kill(child.pid, 'SIGKILL');
      }
    }
  }
});

test('failed browser launch clears the written state file', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  let stderr = '';
  const code = await mod.run(
    ['sinks'],
    {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    {
      HOME: paths.home,
      PATH: '',
      CHROMIUM_CASTCTL_CHROMIUM: process.execPath,
      CHROMIUM_CASTCTL_BROWSER_TIMEOUT_MS: '1',
      CHROMIUM_CASTCTL_CDP_TIMEOUT_MS: '1',
    },
    { paths, fetchImpl: async () => { throw new Error('CDP never became ready'); } },
  );

  assert.equal(code, 1);
  assert.match(stderr, /DevTools did not become available/);
  assert.equal(mod.readState(paths), null);
});

test('pick starts the only Avahi sink directly without Walker', async () => {
  const home = tempHome();
  const fakeBin = path.join(home, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, 'avahi-browse'), '#!/bin/sh\nprintf \'%s\\n\' \'=;wlan0;IPv4;Chromecast;_googlecast._tcp;local;host;10.0.0.2;8009;"id=1" "fn=Wohnzimmer"\'\n');
  writeExecutable(path.join(fakeBin, 'chromium'), '#!/bin/sh\nprofile=\nfor arg in "$@"; do case "$arg" in --user-data-dir=*) profile=${arg#--user-data-dir=};; esac; done\nmkdir -p "$profile"\nprintf "9333\\n/devtools/browser/fake\\n" > "$profile/DevToolsActivePort"\n/bin/sleep 1\n');

  const paths = mod.resolvePaths({ HOME: home });
  const fetchImpl = async (url) => {
    if (url.endsWith('/json/list')) return jsonResponse([cdpPageTarget(9333)]);
    if (url.includes('/json/new?')) return jsonResponse({});
    throw new Error(`Unexpected URL: ${url}`);
  };
  let stdout = '';
  let stderr = '';

  const code = await mod.run(
    ['pick'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    {
      HOME: home,
      PATH: fakeBin,
      CHROMIUM_CASTCTL_SINK_WAIT_MS: '1',
    },
    { paths, fetchImpl, WebSocketImpl: FakeWebSocket },
  );

  assert.equal(code, 0, stderr);
  assert.match(stdout, /Started desktop mirroring to Wohnzimmer/);
});

test('status --waybar renders active sink JSON', () => {
  const json = mod.renderWaybarStatus({ activeSink: 'Wohnzimmer' });
  assert.deepEqual(JSON.parse(json), {
    text: ' Wohnzimmer',
    class: 'active',
    tooltip: 'Casting to Wohnzimmer',
  });
});

test('status --waybar escapes markup-shaped sink names and errors', () => {
  const active = JSON.parse(mod.renderWaybarStatus({ activeSink: '<img src="http://example.test/pixel"> & TV' }));
  assert.deepEqual(active, {
    text: ' &lt;img src=&quot;http://example.test/pixel&quot;&gt; &amp; TV',
    class: 'active',
    tooltip: 'Casting to &lt;img src=&quot;http://example.test/pixel&quot;&gt; &amp; TV',
  });

  const error = JSON.parse(mod.renderWaybarStatus({ error: new Error('<b>boom</b> & retry'), stale: false }));
  assert.deepEqual(error, {
    text: '',
    class: 'error',
    tooltip: 'Chromecast: &lt;b&gt;boom&lt;/b&gt; &amp; retry',
  });

  const busy = JSON.parse(mod.renderWaybarStatus({ busy: { label: '<i>Scanning</i> & waiting' } }));
  assert.deepEqual(busy, {
    text: ' ...',
    class: 'busy',
    tooltip: '&lt;i&gt;Scanning&lt;/i&gt; &amp; waiting',
  });
});

test('status --waybar renders busy discovery JSON', () => {
  const json = mod.renderWaybarStatus({ busy: { label: 'Discovering Chromecast targets…' } });
  assert.deepEqual(JSON.parse(json), {
    text: ' ...',
    class: 'busy',
    tooltip: 'Discovering Chromecast targets…',
  });
});

test('sink matching is exact first and then case-insensitive', () => {
  const sinks = [{ name: 'Kitchen' }, { name: 'Wohnzimmer' }];
  assert.deepEqual(mod.matchSink(sinks, 'Wohnzimmer'), { name: 'Wohnzimmer' });
  assert.deepEqual(mod.matchSink(sinks, 'wohnzimmer'), { name: 'Wohnzimmer' });
  assert.equal(mod.matchSink(sinks, 'Bedroom'), null);
});

test('Avahi Google Cast output parses sink names from TXT fn records', () => {
  const output = `+;wlan0;IPv4;Chromecast-fb8;_googlecast._tcp;local\n=;wlan0;IPv4;Chromecast-fb8;_googlecast._tcp;local;fb8.local;10.1.1.47;8009;"id=fb8" "md=Chromecast" "fn=Wohnzimmer" "rs="\n=;wlan0;IPv4;Other;_googlecast._tcp;local;other.local;10.1.1.48;8009;"id=other" "fn=Kitchen TV"\n`;
  assert.deepEqual(mod.parseAvahiBrowseOutput(output), [
    { name: 'Wohnzimmer', id: 'fb8', source: 'avahi' },
    { name: 'Kitchen TV', id: 'other', source: 'avahi' },
  ]);
});

test('Avahi discovery deduplicates repeated advertisements by receiver identity', () => {
  const output = `=;wlan0;IPv4;Chromecast-fb8;_googlecast._tcp;local;fb8.local;10.1.1.47;8009;"id=fb8" "fn=Living Room"\n=;wlan0;IPv6;Chromecast-fb8;_googlecast._tcp;local;fb8.local;fe80::1;8009;"id=fb8" "fn=Living Room"\n=;wlan0;IPv4;Chromecast-other;_googlecast._tcp;local;other.local;10.1.1.48;8009;"id=other" "fn=Living Room"\n`;
  assert.deepEqual(mod.parseAvahiBrowseOutput(output), [
    { name: 'Living Room', id: 'fb8', source: 'avahi' },
    { name: 'Living Room', id: 'other', source: 'avahi' },
  ]);
});

test('page target selection ignores browser targets', () => {
  const target = mod.selectPageTarget([
    { type: 'browser', webSocketDebuggerUrl: 'ws://browser' },
    { type: 'page', webSocketDebuggerUrl: 'ws://page' },
  ]);
  assert.equal(target.webSocketDebuggerUrl, 'ws://page');
});

test('getPageTarget creates an about:blank page when no page target exists', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/json/list') && calls.length === 1) return jsonResponse([{ type: 'browser' }]);
    if (url.includes('/json/new?')) return jsonResponse({});
    return jsonResponse([cdpPageTarget(9222)]);
  };

  const target = await mod.getPageTarget(9222, { fetchImpl });
  assert.equal(target.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/page/page-1');
  assert.equal(calls[1].method, 'PUT');
});

test('CDP client increments JSON-RPC IDs and collects Cast sinks', async () => {
  FakeWebSocket.instances = [];
  const client = await mod.CdpClient.connect('ws://fake-devtools', { WebSocketImpl: FakeWebSocket, timeoutMs: 1000 });
  const sinks = await mod.enableCastAndCollectSinks(client, { waitMs: 1000, timeoutMs: 1000 });
  await client.send('Cast.startDesktopMirroring', { sinkName: 'Wohnzimmer' }, 1000);

  const ws = FakeWebSocket.instances[0];
  assert.deepEqual(sinks, [{ name: 'Wohnzimmer', session: null }]);
  assert.equal(ws.sent[0].id, 1);
  assert.equal(ws.sent[0].method, 'Cast.enable');
  assert.equal(ws.sent[1].id, 2);
  assert.equal(ws.sent[1].method, 'Cast.startDesktopMirroring');
  client.close();
});

test('sink collection retries once when the media router initially reports no sinks', async () => {
  const client = {
    enableCount: 0,
    handler: null,
    onEvent(method, handler) {
      assert.equal(method, 'Cast.sinksUpdated');
      this.handler = handler;
      return () => {};
    },
    async send(method) {
      assert.equal(method, 'Cast.enable');
      this.enableCount += 1;
      const sinks = this.enableCount === 1 ? [] : [{ name: 'Wohnzimmer' }];
      setImmediate(() => this.handler({ sinks }));
      return {};
    },
  };

  const sinks = await mod.collectCastSinks(client, {
    waitMs: 50,
    timeoutMs: 100,
    emptySinkRetryDelayMs: 0,
  });

  assert.deepEqual(sinks, [{ name: 'Wohnzimmer' }]);
  assert.equal(client.enableCount, 2);
});

test('minimizing Chromium uses CDP Browser window bounds', async () => {
  FakeWebSocket.instances = [];
  const client = await mod.CdpClient.connect('ws://fake-devtools', { WebSocketImpl: FakeWebSocket, timeoutMs: 1000 });
  assert.equal(await mod.minimizePageWindow(client, { id: 'page-1' }, 1000), true);

  const ws = FakeWebSocket.instances[0];
  assert.deepEqual(ws.sent.map((message) => message.method), [
    'Browser.getWindowForTarget',
    'Browser.setWindowBounds',
  ]);
  assert.deepEqual(ws.sent[0].params, { targetId: 'page-1' });
  assert.deepEqual(ws.sent[1].params, { windowId: 42, bounds: { windowState: 'minimized' } });
  client.close();
});

test('CLI formats async command errors without a stack trace', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  mod.writeState(paths, {
    pid: process.pid,
    port: 9222,
    remoteDebuggingAddress: '127.0.0.1',
    userDataDir: paths.profileDir,
    launchMode: 'headless',
    profileVersion: 4,
    castAudio: false,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    processGroupId: process.pid,
  });
  const fetchImpl = async () => jsonResponse([cdpPageTarget(9222)]);
  let stdout = '';
  let stderr = '';

  const code = await mod.run(
    ['start', 'Wohnzimmer'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_SINK_WAIT_MS: '1' },
    { paths, fetchImpl, WebSocketImpl: EmptySinkWebSocket },
  );

  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Sink not found: Wohnzimmer/);
  assert.doesNotMatch(stderr, /CliError|\n\s+at /);
});


test('doctor --quickshell does not require Walker picker', async () => {
  const home = tempHome();
  const fakeBin = path.join(home, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of ['chromium', 'avahi-browse', 'hyprland-preview-share-picker']) {
    const file = path.join(fakeBin, name);
    fs.writeFileSync(file, '#!/usr/bin/env sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }

  const paths = mod.resolvePaths({ HOME: home });
  let stdout = '';
  let stderr = '';
  const code = await mod.run(
    ['doctor', '--quickshell'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { HOME: home, PATH: fakeBin },
    { paths },
  );

  assert.equal(code, 0, stderr);
  assert.match(stdout, /ok Quickshell picker: provided by Omarchy shell plugin/);
  assert.doesNotMatch(stdout, /Walker executable/);
});

test('CLI status --waybar is valid idle JSON with an empty temp HOME', () => {
  const home = tempHome();
  const result = childProcess.spawnSync(process.execPath, [bin, 'status', '--waybar'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: '', XDG_STATE_HOME: '', XDG_CACHE_HOME: '' },
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).class, 'idle');
});


test('sink matching keeps duplicate id-less advertisements usable', () => {
  assert.deepEqual(
    mod.matchSink([{ name: 'Trusted TV' }, { name: 'Trusted TV' }], 'Trusted TV'),
    { name: 'Trusted TV' },
  );
});

test('sink matching prefers established identity over an id-less duplicate', () => {
  assert.deepEqual(
    mod.matchSink([{ name: 'Trusted TV' }, { name: 'Trusted TV', id: 'receiver-a' }], 'Trusted TV'),
    { name: 'Trusted TV', id: 'receiver-a', source: 'chromium' },
  );
});

test('active sink enumeration deduplicates advertisements and preserves sessions', () => {
  assert.deepEqual(mod.activeSinks([
    { name: 'Trusted TV', id: 'receiver-a', session: null },
    { name: 'Trusted TV', session: { id: 'cast-session' } },
  ]), [
    { name: 'Trusted TV', id: 'receiver-a', source: 'chromium', session: { id: 'cast-session' } },
  ]);
});

test('getPageTarget rejects hostile CDP WebSocket URLs', async () => {
  const cases = [
    'ws://localhost:9222/devtools/page/page-1',
    'ws://127.0.0.1:9223/devtools/page/page-1',
    'wss://127.0.0.1:9222/devtools/page/page-1',
    'ws://user:pass@127.0.0.1:9222/devtools/page/page-1',
    'ws://[::1]:9222/devtools/page/page-1',
  ];

  for (const webSocketDebuggerUrl of cases) {
    await assert.rejects(
      () => mod.getPageTarget(9222, { fetchImpl: async () => jsonResponse([{ type: 'page', webSocketDebuggerUrl }]) }),
      /invalid CDP WebSocket URL/i,
      webSocketDebuggerUrl,
    );
  }
});

test('CDP client rejects oversized WebSocket messages deterministically', async () => {
  const client = await mod.CdpClient.connect('ws://127.0.0.1:9222/devtools/page/page-1', {
    WebSocketImpl: OversizedMessageWebSocket,
    timeoutMs: 1000,
  });

  await assert.rejects(
    () => client.send('Cast.enable', {}, 1000),
    /CDP WebSocket message exceeds/i,
  );
  client.close();
});

test('sinks --json returns structured safe records and rejects record-boundary controls', async () => {
  ControlNameWebSocket.instances = [];
  const paths = mod.resolvePaths({ HOME: tempHome() });
  mod.writeState(paths, {
    pid: process.pid,
    port: 9222,
    remoteDebuggingAddress: '127.0.0.1',
    userDataDir: paths.profileDir,
    launchMode: 'headless',
    profileVersion: 4,
    castAudio: false,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    processGroupId: process.pid,
  });
  const fetchImpl = async () => jsonResponse([cdpPageTarget(9222)]);
  let stdout = '';
  let stderr = '';

  const code = await mod.run(
    ['sinks', '--json'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_SINK_WAIT_MS: '1' },
    { paths, fetchImpl, WebSocketImpl: ControlNameWebSocket },
  );

  assert.equal(code, 0, stderr);
  const data = JSON.parse(stdout);
  assert.deepEqual(data.sinks, [
    {
      name: '<b>Wohnzimmer</b> & "TV"',
      displayName: '<b>Wohnzimmer</b> & "TV"',
      startable: true,
      ambiguous: false,
      duplicateCount: 1,
    },
  ]);
});

test('stop tries every active sink and clears local controller state after stop errors', async () => {
  StopFailingWebSocket.instances = [];
  const paths = mod.resolvePaths({ HOME: tempHome() });
  mod.writeState(paths, {
    pid: process.pid,
    port: 9222,
    remoteDebuggingAddress: '127.0.0.1',
    userDataDir: paths.profileDir,
    launchMode: 'headless',
    profileVersion: 4,
    castAudio: false,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    processGroupId: process.pid,
  });
  const fetchImpl = async () => jsonResponse([cdpPageTarget(9222)]);
  let stdout = '';
  let stderr = '';

  const code = await mod.run(
    ['stop'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_SINK_WAIT_MS: '1' },
    { paths, fetchImpl, WebSocketImpl: StopFailingWebSocket },
  );

  const stopTargets = StopFailingWebSocket.instances[0].sent
    .filter((message) => message.method === 'Cast.stopCasting')
    .map((message) => message.params.sinkName);
  assert.equal(code, 1);
  assert.deepEqual(stopTargets, ['Living Room', 'Bedroom']);
  assert.match(stderr, /Failed to stop casting for Living Room; local Chromium cleanup was attempted/);
  assert.equal(stdout, '');
  assert.equal(mod.readState(paths), null);
});

test('stop clears local controller state when CDP target setup fails', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  mod.writeState(paths, {
    pid: process.pid,
    port: 9222,
    remoteDebuggingAddress: '127.0.0.1',
    userDataDir: paths.profileDir,
    launchMode: 'headless',
    profileVersion: 4,
    castAudio: false,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    processGroupId: process.pid,
  });
  let stderr = '';
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return jsonResponse([cdpPageTarget(9222)]);
    throw new Error('CDP target lookup failed');
  };

  const code = await mod.run(
    ['stop'],
    {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_SINK_WAIT_MS: '1' },
    { paths, fetchImpl, WebSocketImpl: EmptySinkWebSocket },
  );

  assert.equal(code, 1);
  assert.match(stderr, /CDP target lookup failed/);
  assert.equal(mod.readState(paths), null);
});

test('an old lock remains owned by its live verified process', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  fs.mkdirSync(paths.lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    nonce: 'existing-owner',
  }));
  const old = new Date(Date.now() - 300000);
  fs.utimesSync(paths.lockDir, old, old);
  let stderr = '';

  const code = await mod.run(
    ['sinks'],
    {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_LOCK_TIMEOUT_MS: '0' },
    { paths },
  );

  assert.equal(code, 1);
  assert.match(stderr, /already in progress/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.lockDir, 'owner.json'), 'utf8')).nonce, 'existing-owner');
});

test('stale lock takeover recovers a prior quarantine safely', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  fs.mkdirSync(paths.lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.lockDir, 'owner.json'), JSON.stringify({
    pid: 2147483647,
    nonce: 'dead-owner',
  }));
  fs.mkdirSync(`${paths.lockDir}.stale`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(`${paths.lockDir}.stale`, 'owner.json'), JSON.stringify({
    pid: 2147483647,
    nonce: 'earlier-dead-owner',
  }));
  let stderr = '';

  const code = await mod.run(
    ['status', '--waybar'],
    {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_LOCK_TIMEOUT_MS: '100' },
    { paths },
  );

  assert.equal(code, 0, stderr);
  assert.equal(fs.existsSync(paths.lockDir), false);
  assert.equal(fs.existsSync(`${paths.lockDir}.stale`), false);
});

test('status does not inspect or clean state owned by another locked command', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  fs.mkdirSync(paths.lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    nonce: 'active-command',
  }));
  const state = {
    pid: process.pid,
    port: 9222,
    remoteDebuggingAddress: '127.0.0.1',
    userDataDir: paths.profileDir,
    launchMode: 'headless',
    profileVersion: 4,
    castAudio: false,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    processGroupId: process.pid,
  };
  mod.writeState(paths, state);
  let fetchCalls = 0;
  let stderr = '';

  const code = await mod.run(
    ['status', '--waybar'],
    {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_LOCK_TIMEOUT_MS: '0' },
    {
      paths,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('status must not reach CDP');
      },
    },
  );

  assert.equal(code, 1);
  assert.match(stderr, /already in progress/);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(mod.readState(paths), state);
});


test('sinks --json marks duplicate friendly names as ambiguous and not startable', async () => {
  const paths = mod.resolvePaths({ HOME: tempHome() });
  mod.writeState(paths, {
    pid: process.pid,
    port: 9222,
    remoteDebuggingAddress: '127.0.0.1',
    userDataDir: paths.profileDir,
    launchMode: 'headless',
    profileVersion: 4,
    castAudio: false,
    processStartTime: mod.readProcessIdentity(process.pid).startTime,
    processGroupId: process.pid,
  });
  const fetchImpl = async () => jsonResponse([cdpPageTarget(9222)]);
  let stdout = '';
  let stderr = '';

  const code = await mod.run(
    ['sinks', '--json'],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    { ...process.env, HOME: paths.home, CHROMIUM_CASTCTL_SINK_WAIT_MS: '1' },
    { paths, fetchImpl, WebSocketImpl: DuplicateNameWebSocket },
  );

  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).sinks, [
    {
      name: 'Trusted TV',
      displayName: 'Trusted TV (ambiguous: 2 devices)',
      startable: false,
      ambiguous: true,
      duplicateCount: 2,
      receivers: [
        { id: 'a', source: 'chromium' },
        { id: 'b', source: 'chromium' },
      ],
    },
  ]);
});

test('duplicate Chromium advertisements with one identity remain startable', () => {
  const sinks = [
    { name: 'Trusted TV', id: 'same-receiver' },
    { name: 'Trusted TV', id: 'same-receiver' },
  ];
  assert.deepEqual(mod.matchSink(sinks, 'Trusted TV'), {
    name: 'Trusted TV', id: 'same-receiver', source: 'chromium',
  });
});
