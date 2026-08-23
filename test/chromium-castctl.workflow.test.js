const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const mod = require('../bin/chromium-castctl');

const bin = path.join(__dirname, '..', 'bin', 'chromium-castctl');
const dummyChromium = path.join(__dirname, 'fixtures', 'dummy-chromium-cast');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-castctl-workflow-'));
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function makeEnv(home) {
  const fakeBin = path.join(home, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, 'chromium'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(dummyChromium)} "$@"\n`);

  return {
    HOME: home,
    PATH: fakeBin,
    CHROMIUM_CASTCTL_BROWSER_TIMEOUT_MS: '3000',
    CHROMIUM_CASTCTL_CDP_TIMEOUT_MS: '1000',
    CHROMIUM_CASTCTL_SINK_WAIT_MS: '100',
    CHROMIUM_CASTCTL_DUMMY_SINK_NAME: 'Dummy Living Room',
  };
}

function runCastctl(args, env) {
  return childProcess.spawnSync(process.execPath, [bin, ...args], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('dummy Cast backend exercises plugin helper workflow commands', () => {
  const home = tempHome();
  const env = makeEnv(home);
  const paths = mod.resolvePaths(env);

  try {
    const sinks = runCastctl(['sinks'], env);
    assert.equal(sinks.status, 0, sinks.stderr);
    assert.equal(sinks.stdout.trim(), 'Dummy Living Room');
    assert.equal(mod.readState(paths), null, 'discovery without an active cast closes the control browser');

    const start = runCastctl(['start', 'Dummy Living Room'], env);
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /Started desktop mirroring to Dummy Living Room/);
    const activeState = mod.readState(paths);
    assert.ok(activeState && mod.isPidAlive(activeState.pid), 'start leaves the dummy control browser running');

    const activeStatus = runCastctl(['status', '--waybar'], env);
    assert.equal(activeStatus.status, 0, activeStatus.stderr);
    assert.deepEqual(JSON.parse(activeStatus.stdout), {
      text: ' Dummy Living Room',
      class: 'active',
      tooltip: 'Casting to Dummy Living Room',
    });

    const stop = runCastctl(['stop'], env);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /Stopped casting to Dummy Living Room and closed Chromium control browser/);
    assert.equal(mod.readState(paths), null);

    const idleStatus = runCastctl(['status', '--waybar'], env);
    assert.equal(idleStatus.status, 0, idleStatus.stderr);
    assert.deepEqual(JSON.parse(idleStatus.stdout), {
      text: '',
      class: 'idle',
      tooltip: 'Chromecast: idle',
    });
  } finally {
    const state = mod.readState(paths);
    if (state && mod.isPidAlive(state.pid)) {
      try {
        process.kill(-state.pid, 'SIGKILL');
      } catch {
        process.kill(state.pid, 'SIGKILL');
      }
    }
  }
});
