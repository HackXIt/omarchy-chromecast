'use strict';

const {
  CONTROL_OR_BIDI_PATTERN,
  MAX_SINK_ID_CHARS,
  MAX_SINK_NAME_CHARS,
  MAX_SINKS,
  MAX_TERMINAL_TEXT_CHARS,
} = require('./constants');
const { CliError } = require('./errors');

// Receiver names and ids come from the network or Chromium. Normalize them once
// before they cross into CLI output, picker input, or Cast start/stop calls.
function truncateText(value, maxChars = MAX_TERMINAL_TEXT_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function stripControlsForDisplay(value, maxChars = MAX_TERMINAL_TEXT_CHARS) {
  // Same control/bidi ranges as CONTROL_OR_BIDI_PATTERN, with /g to replace every occurrence.
  return truncateText(String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '�'), maxChars);
}

function normalizeSink(sink) {
  if (!sink || typeof sink !== 'object') return null;
  const name = String(sink.name || '').trim();
  if (!name) return null;
  if (name.length > MAX_SINK_NAME_CHARS) return null;
  if (CONTROL_OR_BIDI_PATTERN.test(name)) return null;
  const rawId = sink.id === undefined || sink.id === null ? '' : String(sink.id).trim();
  const id = rawId && rawId.length <= MAX_SINK_ID_CHARS && !CONTROL_OR_BIDI_PATTERN.test(rawId) ? rawId : null;
  const normalized = { ...sink, name };
  if (id) {
    normalized.id = id;
    normalized.source = sink.source === 'avahi' ? 'avahi' : 'chromium';
  } else {
    delete normalized.id;
    if (sink.source === 'avahi') normalized.source = 'avahi';
    else delete normalized.source;
  }
  return normalized;
}

function normalizeSinkList(sinks) {
  if (!Array.isArray(sinks)) return [];
  if (sinks.length > MAX_SINKS) throw new CliError(`More than ${MAX_SINKS} Chromecast targets were reported`, 1);
  const normalized = [];
  for (const sink of sinks) {
    const next = normalizeSink(sink);
    if (!next) continue;
    normalized.push(next);
    if (normalized.length > MAX_SINKS) throw new CliError(`More than ${MAX_SINKS} Chromecast targets were usable`, 1);
  }
  return distinctNormalizedSinks(normalized);
}

function sinkIsActive(sink) {
  return Boolean(sink && sink.session);
}

function activeSinks(sinks) {
  return normalizeSinkList(sinks || []).filter(sinkIsActive);
}

function sinkNameKey(name) {
  return String(name || '').toLocaleLowerCase();
}

function distinctNormalizedSinks(normalized) {
  const distinct = [];
  const identityIndexes = new Map();
  const firstIdentityByName = new Map();
  for (const sink of normalized) {
    if (sink.id && !firstIdentityByName.has(sinkNameKey(sink.name))) {
      firstIdentityByName.set(sinkNameKey(sink.name), sink.id);
    }
  }
  for (const sink of normalized) {
    const nameKey = sinkNameKey(sink.name);
    const id = sink.id || firstIdentityByName.get(nameKey);
    const key = id ? `id:${id}` : `unknown:${nameKey}`;
    if (identityIndexes.has(key)) {
      const index = identityIndexes.get(key);
      const current = distinct[index];
      const preferred = current.id ? current : sink.id ? sink : current;
      const active = sinkIsActive(current) ? current : sinkIsActive(sink) ? sink : null;
      distinct[index] = active && !sinkIsActive(preferred) ? { ...preferred, session: active.session } : preferred;
      continue;
    }
    identityIndexes.set(key, distinct.length);
    distinct.push(sink);
  }
  return distinct;
}

function distinctSinksByIdentity(sinks) {
  return normalizeSinkList(sinks || []);
}

function groupedSinkRows(sinks) {
  const normalized = distinctSinksByIdentity(sinks || []);
  const groups = new Map();
  for (const sink of normalized) {
    const key = sinkNameKey(sink.name);
    const group = groups.get(key) || [];
    group.push(sink);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const name = group[0].name;
    const duplicateCount = group.length;
    const ambiguous = duplicateCount > 1;
    const row = {
      name,
      displayName: ambiguous ? `${stripControlsForDisplay(name, MAX_SINK_NAME_CHARS)} (ambiguous: ${duplicateCount} devices)` : stripControlsForDisplay(name, MAX_SINK_NAME_CHARS),
      startable: !ambiguous,
      ambiguous,
      duplicateCount,
    };
    const receivers = group
      .filter((sink) => sink.id)
      .map((sink) => ({ id: sink.id, source: sink.source }));
    if (receivers.length > 0) row.receivers = receivers;
    return row;
  });
}

function assertNoAmbiguousSinks(sinks) {
  const ambiguous = groupedSinkRows(sinks).filter((row) => row.ambiguous);
  if (ambiguous.length > 0) {
    throw new CliError(
      `Ambiguous Chromecast target name: ${ambiguous.map((row) => row.name).join(', ')}. Rename one receiver or choose a unique target.`,
      1,
    );
  }
}

function matchSink(sinks, requestedName) {
  const requested = String(requestedName || '').trim();
  if (!requested) return null;
  if (requested.length > MAX_SINK_NAME_CHARS || CONTROL_OR_BIDI_PATTERN.test(requested)) {
    throw new CliError('Unsafe Chromecast target name; refusing to start desktop mirroring.', 1);
  }

  const normalized = distinctSinksByIdentity(sinks || []);
  const exact = normalized.filter((sink) => sink.name === requested);
  if (exact.length > 1) throw new CliError(`Ambiguous Chromecast target name: ${requested}. Rename one receiver or choose a unique target.`, 1);
  if (exact.length === 1) return exact[0];

  const lower = requested.toLocaleLowerCase();
  const caseInsensitive = normalized.filter((sink) => sinkNameKey(sink.name) === lower);
  if (caseInsensitive.length > 1) throw new CliError(`Ambiguous Chromecast target name: ${requested}. Rename one receiver or choose a unique target.`, 1);
  return caseInsensitive[0] || null;
}

function formatSinkList(sinks) {
  return groupedSinkRows(sinks).map((row) => row.displayName).filter(Boolean).join('\n');
}

function formatSinkJson(sinks) {
  return JSON.stringify({ sinks: groupedSinkRows(sinks) });
}

module.exports = {
  truncateText,
  stripControlsForDisplay,
  normalizeSink,
  normalizeSinkList,
  sinkIsActive,
  activeSinks,
  sinkNameKey,
  distinctNormalizedSinks,
  distinctSinksByIdentity,
  groupedSinkRows,
  assertNoAmbiguousSinks,
  matchSink,
  formatSinkList,
  formatSinkJson,
};
