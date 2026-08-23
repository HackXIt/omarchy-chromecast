'use strict';

const { ICON, MAX_TERMINAL_TEXT_CHARS } = require('./constants');
const { stripControlsForDisplay } = require('./sinks');

function escapeUiText(value) {
  return stripControlsForDisplay(value, MAX_TERMINAL_TEXT_CHARS)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderWaybarStatus(status) {
  if (status && status.busy) {
    return JSON.stringify({
      text: `${ICON} ...`,
      class: 'busy',
      tooltip: escapeUiText(status.busy.label || 'Chromecast action in progress…'),
    });
  }

  if (status && status.activeSink) {
    const activeSink = escapeUiText(status.activeSink);
    return JSON.stringify({
      text: `${ICON} ${activeSink}`,
      class: 'active',
      tooltip: `Casting to ${activeSink}`,
    });
  }

  if (status && status.error && !status.stale) {
    return JSON.stringify({
      text: ICON,
      class: 'error',
      tooltip: `Chromecast: ${escapeUiText(status.error.message)}`,
    });
  }

  return JSON.stringify({
    text: ICON,
    class: 'idle',
    tooltip: 'Chromecast: idle',
  });
}

function writeLine(io, message = '') {
  io.stdout.write(`${message}\n`);
}

function writeError(io, message = '') {
  io.stderr.write(`${message}\n`);
}

module.exports = { escapeUiText, renderWaybarStatus, writeLine, writeError };
