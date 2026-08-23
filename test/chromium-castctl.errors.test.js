const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CastCtlError, CliError, isErrorCode } = require('../lib/chromium-castctl/errors');
const { readDevToolsActivePort } = require('../lib/chromium-castctl/chromium');
const { resolvePaths } = require('../lib/chromium-castctl/paths');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-castctl-errors-'));
}

test('classified errors carry sentinel codes across CLI and lifecycle boundaries', () => {
  const lifecycleError = new CastCtlError('cdp_devtools_active_port_too_large', 'DevToolsActivePort is unexpectedly large');
  assert.equal(lifecycleError.code, 'cdp_devtools_active_port_too_large');
  assert.equal(isErrorCode(lifecycleError, 'cdp_devtools_active_port_too_large'), true);

  const cliError = new CliError('unsafe sink', 1, 'sink_name_unsafe');
  assert.equal(cliError.code, 'sink_name_unsafe');
  assert.equal(cliError.exitCode, 1);
});

test('DevToolsActivePort parser exposes oversized files as a structured lifecycle error', () => {
  const paths = resolvePaths({ HOME: tempHome() });
  fs.mkdirSync(paths.profileDir, { recursive: true });
  fs.writeFileSync(path.join(paths.profileDir, 'DevToolsActivePort'), '9'.repeat(4097));

  assert.throws(
    () => readDevToolsActivePort(paths),
    (error) => isErrorCode(error, 'cdp_devtools_active_port_too_large'),
  );
});
