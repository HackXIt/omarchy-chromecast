'use strict';

const {
  DEFAULT_CDP_TIMEOUT_MS,
  LOCAL_DEVTOOLS_ADDRESS,
  MAX_CDP_HTTP_RESPONSE_BYTES,
  MAX_CDP_WS_MESSAGE_BYTES,
} = require('./constants');
const { CliError } = require('./errors');
const { cdpTimeoutMs } = require('./env');
const { withTimeout } = require('./util');

// CDP is loopback-only but unauthenticated. Keep URL validation, response
// limits, and WebSocket message limits centralized here.
async function responseTextBounded(response, maxBytes) {
  const contentLength = typeof response.headers?.get === 'function'
    ? Number.parseInt(response.headers.get('content-length') || '', 10)
    : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`CDP HTTP response exceeds ${maxBytes} bytes`);
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => null);
          throw new Error(`CDP HTTP response exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`CDP HTTP response exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  return null;
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new CliError('Node fetch API is unavailable; use a current Node runtime.', 1);
  }

  const timeoutMs = options.timeoutMs || cdpTimeoutMs(options.env || process.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    const text = await responseTextBounded(response, options.maxBytes || MAX_CDP_HTTP_RESPONSE_BYTES);
    if (text !== null) return JSON.parse(text);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTargets(port, options = {}) {
  return fetchJson(`http://${LOCAL_DEVTOOLS_ADDRESS}:${port}/json/list`, options);
}

function validateCdpWebSocketUrl(webSocketDebuggerUrl, expectedPort) {
  let parsed;
  try {
    parsed = new URL(String(webSocketDebuggerUrl || ''));
  } catch {
    throw new CliError(`Invalid CDP WebSocket URL from Chromium: ${webSocketDebuggerUrl}`, 1);
  }

  if (parsed.protocol !== 'ws:'
    || parsed.hostname !== LOCAL_DEVTOOLS_ADDRESS
    || parsed.port !== String(expectedPort)
    || parsed.username
    || parsed.password) {
    throw new CliError(`Invalid CDP WebSocket URL from Chromium: ${webSocketDebuggerUrl}`, 1);
  }
  return webSocketDebuggerUrl;
}

function selectPageTarget(targets, expectedPort = null) {
  if (!Array.isArray(targets)) return null;
  let invalidUrlError = null;
  for (const target of targets) {
    if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
    if (expectedPort === null) return target;
    try {
      validateCdpWebSocketUrl(target.webSocketDebuggerUrl, expectedPort);
      return target;
    } catch (error) {
      invalidUrlError = error;
    }
  }
  if (invalidUrlError) throw invalidUrlError;
  return null;
}

async function createPageTarget(port, options = {}) {
  const url = `http://${LOCAL_DEVTOOLS_ADDRESS}:${port}/json/new?${encodeURIComponent('about:blank')}`;
  try {
    return await fetchJson(url, { ...options, method: 'PUT' });
  } catch {
    return fetchJson(url, { ...options, method: 'GET' });
  }
}

async function getPageTarget(port, options = {}) {
  let targets = await fetchTargets(port, options);
  let target = selectPageTarget(targets, port);
  if (target) return target;

  await createPageTarget(port, options);
  targets = await fetchTargets(port, options);
  target = selectPageTarget(targets, port);
  if (!target) {
    throw new CliError('Chromium CDP has no page target. Try stopping chromium-castctl and retrying.', 1);
  }
  return target;
}

function addWsListener(ws, event, handler, options) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler, options);
    return () => ws.removeEventListener(event, handler, options);
  }
  if (typeof ws.on === 'function') {
    ws.on(event, handler);
    return () => ws.off ? ws.off(event, handler) : ws.removeListener(event, handler);
  }
  throw new Error('WebSocket implementation does not support events');
}

function dataByteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data && Number.isFinite(data.size)) return data.size;
  return Buffer.byteLength(String(data), 'utf8');
}

async function messageDataToString(data, maxBytes = MAX_CDP_WS_MESSAGE_BYTES) {
  const byteLength = dataByteLength(data);
  if (byteLength > maxBytes) throw new Error(`CDP WebSocket message exceeds ${maxBytes} bytes`);

  let text;
  if (typeof data === 'string') text = data;
  else if (Buffer.isBuffer(data)) text = data.toString('utf8');
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
  else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  else if (data && typeof data.text === 'function') text = await data.text();
  else text = String(data);

  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`CDP WebSocket message exceeds ${maxBytes} bytes`);
  return text;
}

class CdpClient {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.maxMessageBytes = options.maxMessageBytes || MAX_CDP_WS_MESSAGE_BYTES;

    addWsListener(ws, 'message', (event) => {
      const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
      this.handleMessage(data).catch((error) => this.rejectAll(error));
    });
    addWsListener(ws, 'close', () => this.rejectAll(new Error('CDP WebSocket closed')));
    addWsListener(ws, 'error', (event) => {
      const error = event && event.error ? event.error : new Error('CDP WebSocket error');
      this.rejectAll(error);
    });
  }

  static async connect(url, options = {}) {
    const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    if (typeof WebSocketImpl !== 'function') {
      throw new CliError('Node WebSocket API is unavailable; use a current Node runtime.', 1);
    }

    const ws = new WebSocketImpl(url);
    await withTimeout(new Promise((resolve, reject) => {
      const offOpen = addWsListener(ws, 'open', () => {
        offOpen();
        offError();
        resolve();
      });
      const offError = addWsListener(ws, 'error', (event) => {
        offOpen();
        offError();
        reject(event && event.error ? event.error : new Error('Failed to open CDP WebSocket'));
      });
    }), options.timeoutMs || cdpTimeoutMs(options.env || process.env), 'Timed out opening CDP WebSocket');

    return new CdpClient(ws, options);
  }

  rejectAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async handleMessage(data) {
    const text = await messageDataToString(data, this.maxMessageBytes);
    const message = JSON.parse(text);

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || JSON.stringify(message.error));
        error.cdpError = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const handlers = this.handlers.get(message.method) || [];
      for (const handler of handlers) handler(message.params || {}, message);
    }
  }

  send(method, params = {}, timeoutMs = DEFAULT_CDP_TIMEOUT_MS) {
    if (this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP WebSocket is not open'));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onEvent(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
    return () => {
      const current = this.handlers.get(method) || [];
      this.handlers.set(method, current.filter((candidate) => candidate !== handler));
    };
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP WebSocket closed'));
    }
    this.pending.clear();
    if (this.ws && this.ws.readyState === 1 && typeof this.ws.close === 'function') {
      this.ws.close();
    }
  }
}

async function minimizePageWindow(client, target, timeoutMs = DEFAULT_CDP_TIMEOUT_MS) {
  const params = target && target.id ? { targetId: target.id } : {};
  const windowInfo = await client.send('Browser.getWindowForTarget', params, timeoutMs);
  if (!windowInfo || !Number.isInteger(windowInfo.windowId)) return false;
  await client.send('Browser.setWindowBounds', {
    windowId: windowInfo.windowId,
    bounds: { windowState: 'minimized' },
  }, timeoutMs);
  return true;
}

async function minimizeChromiumWindow(port, options = {}) {
  try {
    const target = await getPageTarget(port, options);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl, options);
    try {
      return await minimizePageWindow(client, target, options.timeoutMs || cdpTimeoutMs(options.env || process.env));
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

module.exports = {
  responseTextBounded,
  fetchJson,
  fetchTargets,
  validateCdpWebSocketUrl,
  selectPageTarget,
  createPageTarget,
  getPageTarget,
  addWsListener,
  dataByteLength,
  messageDataToString,
  CdpClient,
  minimizePageWindow,
  minimizeChromiumWindow,
};
