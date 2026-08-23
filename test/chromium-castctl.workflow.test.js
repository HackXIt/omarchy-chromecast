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

function makeEnv(home, browserExecutable = process.execPath) {
  const fakeBin = path.join(home, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, 'chromium'), `#!/bin/sh\nexec ${JSON.stringify(browserExecutable)} ${JSON.stringify(dummyChromium)} "$@"\n`);

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

function runCastctlAsync(args, env) {
  const child = childProcess.spawn(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr: `${stderr}\ntimed out` });
    }, 10000);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function waitForFile(file, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
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

test('status cleans a wrapped orphan after its browser executable is replaced', () => {
  const home = tempHome();
  const browserExecutable = path.join(home, 'bin', 'dummy-node');
  const oldBrowserExecutable = `${browserExecutable}.old`;
  fs.mkdirSync(path.dirname(browserExecutable), { recursive: true });
  fs.copyFileSync(process.execPath, browserExecutable);
  fs.chmodSync(browserExecutable, 0o755);
  const env = makeEnv(home, browserExecutable);
  const paths = mod.resolvePaths(env);
  let browserPid;

  try {
    const start = runCastctl(['start', 'Dummy Living Room'], env);
    assert.equal(start.status, 0, start.stderr);
    const state = mod.readState(paths);
    assert.ok(state && mod.isPidAlive(state.pid));
    browserPid = state.pid;
    fs.renameSync(browserExecutable, oldBrowserExecutable);
    fs.copyFileSync(process.execPath, browserExecutable);
    fs.chmodSync(browserExecutable, 0o755);
    fs.rmSync(oldBrowserExecutable);
    fs.rmSync(paths.stateFile);

    const status = runCastctl(['status', '--waybar'], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).class, 'idle');
    assert.equal(mod.isPidAlive(browserPid), false);
    assert.equal(mod.readState(paths), null);
  } finally {
    if (browserPid && mod.isPidAlive(browserPid)) {
      try {
        process.kill(-browserPid, 'SIGKILL');
      } catch {
        process.kill(browserPid, 'SIGKILL');
      }
    }
  }
});

test('status cleans a wrapped orphan after controller startup is interrupted', async () => {
  const home = tempHome();
  const env = { ...makeEnv(home), CHROMIUM_CASTCTL_DUMMY_DEVTOOLS_DELAY_MS: '2000' };
  const paths = mod.resolvePaths(env);
  const controller = childProcess.spawn(process.execPath, [bin, 'start', 'Dummy Living Room'], {
    env,
    stdio: 'ignore',
  });
  let browserPid;

  try {
    await waitForFile(paths.browserIdentityFile);
    const launched = JSON.parse(fs.readFileSync(paths.browserIdentityFile, 'utf8'));
    browserPid = launched.pid;
    assert.equal(mod.readState(paths), null);
    assert.equal(mod.isPidAlive(browserPid), true);

    controller.kill('SIGKILL');
    await new Promise((resolve) => controller.once('exit', resolve));

    const status = runCastctl(['status', '--waybar'], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).class, 'idle');
    assert.equal(mod.isPidAlive(browserPid), false);
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
    if (browserPid && mod.isPidAlive(browserPid)) {
      try {
        process.kill(-browserPid, 'SIGKILL');
      } catch {
        process.kill(browserPid, 'SIGKILL');
      }
    }
  }
});

test('concurrent discovery commands serialize controller state and leave no active browser state', async () => {
  const home = tempHome();
  const env = makeEnv(home);
  const paths = mod.resolvePaths(env);

  const [first, second] = await Promise.all([
    runCastctlAsync(['sinks'], env),
    runCastctlAsync(['sinks'], env),
  ]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout.trim(), 'Dummy Living Room');
  assert.equal(second.stdout.trim(), 'Dummy Living Room');
  assert.equal(mod.readState(paths), null);
});
