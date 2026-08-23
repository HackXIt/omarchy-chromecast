'use strict';

const childProcess = require('node:child_process');

const { MAX_AVAHI_OUTPUT_BYTES, MAX_SINKS } = require('./constants');
const { CliError } = require('./errors');
const { avahiTimeoutMs, findExecutable } = require('./env');
const { distinctSinksByIdentity, normalizeSink } = require('./sinks');

// Avahi is a fast hint source only. Chromium remains authoritative for Cast
// operations, so discovered receiver identities are normalized before use.
function parseAvahiBrowseOutput(output) {
  const sinks = [];
  const text = String(output || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_AVAHI_OUTPUT_BYTES) {
    throw new CliError(`avahi-browse output exceeds ${MAX_AVAHI_OUTPUT_BYTES} bytes`, 1);
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('_googlecast._tcp')) continue;

    const quoted = line.matchAll(/"((?:\\.|[^"])*)"/g);
    let receiverId = null;
    let name = null;
    for (const match of quoted) {
      const token = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (token.startsWith('id=')) receiverId = token.slice(3).trim();
      if (token.startsWith('fn=')) name = token.slice(3).trim();
    }
    if (!name) continue;
    const normalized = normalizeSink({ name, id: receiverId, source: 'avahi' });
    if (!normalized) continue;
    if (normalized.id && sinks.some((sink) => sink.id === normalized.id)) continue;
    if (sinks.length >= MAX_SINKS) throw new CliError(`More than ${MAX_SINKS} Chromecast targets were reported`, 1);
    sinks.push(normalized);
  }

  return distinctSinksByIdentity(sinks);
}

function discoverAvahiSinks(options = {}) {
  const env = options.env || process.env;
  const avahi = findExecutable('avahi-browse', env);
  if (!avahi) return [];

  const result = childProcess.spawnSync(avahi, ['-rpt', '_googlecast._tcp'], {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_AVAHI_OUTPUT_BYTES,
    timeout: avahiTimeoutMs(env),
  });

  if (result.error && result.error.code === 'ENOBUFS') {
    throw new CliError(`avahi-browse output exceeds ${MAX_AVAHI_OUTPUT_BYTES} bytes`, 1);
  }

  return parseAvahiBrowseOutput(result.stdout || '');
}

module.exports = { parseAvahiBrowseOutput, discoverAvahiSinks };
