'use strict';

const { EventEmitter } = require('node:events');

function normalizeRelayUrl(value) {
  const fail = () => { throw new Error('Invalid demo relay URL. Use wss://host or ws://127.0.0.1 for local tests.'); };
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || /[?#\\\s]/.test(value)) return fail();
  let url;
  try { url = new URL(value); } catch { return fail(); }
  if (url.username || url.password || !url.hostname) return fail();
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && /^ws:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i.test(value))) return fail();
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/demo') ? pathname : `${pathname}/demo`;
  return url.toString();
}

class DemoRelayClient extends EventEmitter {
  constructor({ url, WebSocketImpl, timeoutMs = 12000 } = {}) {
    super();
    this.url = normalizeRelayUrl(url);
    this.WebSocketImpl = WebSocketImpl || require('ws');
    this.timeoutMs = Math.max(1, Math.min(120000, Number(timeoutMs) || 12000));
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.socket = null;
    this.connection = null;
  }

  _connect() {
    if (this.closed) return Promise.reject(new Error('Demo relay closed. Create a new session.'));
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      this.rejectConnection = reject;
      this.connectionTimer = setTimeout(() => this._finish('connection_timeout'), this.timeoutMs);
      let socket;
      try { socket = this.socket = new this.WebSocketImpl(this.url); }
      catch { this._finish('connection_failed'); return; }
      const on = (name, fn) => {
        if (typeof socket.on === 'function') socket.on(name, fn);
        else socket.addEventListener(name, fn);
      };
      on('open', () => {
        if (this.closed) return;
        clearTimeout(this.connectionTimer);
        this.rejectConnection = null;
        resolve();
      });
      on('message', data => this._receive(data?.data ?? data));
      on('error', () => this._finish('connection_failed'));
      on('close', () => this._finish('disconnected'));
    });
    return this.connection;
  }

  _receive(bytes) {
    if (this.closed) return;
    let message;
    try {
      if (typeof bytes !== 'string') bytes = bytes.toString();
      if (Buffer.byteLength(bytes) > 131072) throw new Error('oversize');
      message = JSON.parse(bytes);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid');
    } catch { this._finish('invalid_message'); return; }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Demo relay request denied.'));
    } else if (message.kind === 'event' && typeof message.event === 'string') {
      this.emit('event', { event: message.event, payload: message.payload });
    } else if (message.kind === 'join-request') {
      this.emit('join-request', { requestId: message.requestId, name: message.name });
    } else if (message.kind === 'closed') {
      this._finish(message.reason || 'disconnected');
    }
  }

  async _request(op, data = {}, timeoutMs = this.timeoutMs, hostAccessCode) {
    await this._connect();
    if (this.closed || this.socket.readyState !== 1) throw new Error('Demo relay closed.');
    if (this.pending.size >= 64) throw new Error('Too many pending demo relay requests.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._finish(op === 'join' ? 'approval_timeout' : 'request_timeout'), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const message = JSON.stringify({ id, op, data, ...(op === 'create' && hostAccessCode !== undefined ? { hostAccessCode } : {}) });
        hostAccessCode = undefined;
        if (Buffer.byteLength(message) > 65536 || this.socket.bufferedAmount > 131072) throw new Error('limit');
        this.socket.send(message);
      } catch { this._finish('send_failed'); }
    });
  }

  create(details = {}, hostAccessCode) { return this._request('create', details, this.timeoutMs, hostAccessCode); }
  async join(options) {
    const metadata = await this._request('join', options, 120000);
    this.emit('approved', metadata);
    return metadata;
  }
  approve(requestId, allow) { return this._request('approve', { requestId, allow }); }
  update(details) { return this._request('update', details); }
  start() { return this._request('start'); }
  async send(message) { await this._request('broadcast', message); return 'ok'; }
  token() { return this._request('token'); }
  end() { return this._request('end'); }
  close() { this._finish('client_closed'); }

  _finish(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectionTimer);
    const error = new Error(`Demo relay closed: ${reason}.`);
    this.rejectConnection?.(error);
    this.rejectConnection = null;
    for (const { timer, reject } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        if (socket.readyState === 0 && typeof socket.terminate === 'function') socket.terminate();
        else if (socket.readyState < 2) socket.close(1000, 'client_closed');
      } catch { /* The transport may have already failed. */ }
    }
    this.emit('closed', { reason });
  }
}

module.exports = { DemoRelayClient, normalizeRelayUrl };
