'use strict';

const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');
const P = require('../../browser-extension/protocol');
const { EXTENSION_ID, LIMITS } = P;
const systemClock = { now: () => Date.now(), setTimeout, clearTimeout };

class TabBridge {
  constructor({ onUpdate = () => {}, onResult = () => {}, WebSocketServer, clock = systemClock } = {}) {
    this.onUpdate = onUpdate;
    this.onResult = onResult;
    this.Server = WebSocketServer || require('ws').WebSocketServer;
    this.clock = clock;
    this.generation = 0;
    this.peers = new Set();
    this.sockets = new Set();
    this.pending = new Map();
    this.tabs = new Map();
    this.events = [];
    this.used = new Set();
    this.observe = false;
    this.close = false;
  }

  async start({ sessionId, observeConsent, closeConsent, protectedHosts = [] } = {}) {
    const cleanup = this.stop();
    const startGeneration = this.generation;
    await cleanup;
    if (startGeneration !== this.generation) throw new Error('Tab bridge start superseded');
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('A session is required');
    const hosts = P.protectedHosts(protectedHosts);
    if (observeConsent !== true) return { pairingCode: null, extensionId: EXTENSION_ID };
    const generation = ++this.generation;
    this.sessionId = sessionId;
    this.epoch = randomUUID();
    this.secret = randomBytes(32).toString('base64url');
    this.expiresAt = this.clock.now() + LIMITS.pairingMs;
    this.hosts = hosts;
    this.observe = true;
    this.close = closeConsent === true;
    this.peerClose = false;
    this.consumed = false;
    this.attempts = 0;
    this.seq = 0;
    this.eventSeq = 0;
    const http = createServer({ maxHeaderSize: 8192, requestTimeout: LIMITS.authMs, headersTimeout: LIMITS.authMs,
      connectionsCheckingInterval: 1000 }, (req, res) => { res.writeHead(403, { Connection: 'close' }); res.end(); });
    this.http = http;
    http.maxConnections = LIMITS.maxPeers + 2;
    http.maxRequestsPerSocket = 1;
    http.keepAliveTimeout = 1000;
    http.setTimeout(LIMITS.authMs, socket => socket.destroy());
    http.on('clientError', (error, socket) => socket.destroy());
    http.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const server = new this.Server({ server: http, maxPayload: LIMITS.maxPayload,
      perMessageDeflate: false,
      verifyClient: (info, done) => {
        const req = info.req;
        const allowed = generation === this.generation && this.observe && !this.consumed &&
          this.clock.now() < this.expiresAt && this.attempts < LIMITS.maxAttempts && this.peers.size < LIMITS.maxPeers &&
          info.origin === `chrome-extension://${EXTENSION_ID}` && req.headers.origin === info.origin &&
          req.url === '/' && req.headers.host === `127.0.0.1:${server.address()?.port}` && req.socket.remoteAddress === '127.0.0.1';
        if (allowed) this.attempts++;
        done(Boolean(allowed), 403);
      }
    });
    this.server = server;
    server.on('connection', peer => this._connect(peer, generation));
    server.on('error', () => { if (generation === this.generation) this.stop(); });
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', () => reject(new Error('Tab bridge unavailable')));
        server.once('close', () => reject(new Error('Tab bridge stopped')));
        http.listen(0, '127.0.0.1');
      });
      if (generation !== this.generation || !this.observe) throw new Error('Tab bridge stopped');
      const pairingCode = `trv1.${Buffer.from(JSON.stringify({ v: 1, port: server.address().port, secret: this.secret,
        epoch: this.epoch, expiresAt: this.expiresAt, extensionId: EXTENSION_ID })).toString('base64url')}`;
      this.pairTimer = this._timer(() => this.stop(), LIMITS.pairingMs);
      this._publish();
      return { pairingCode, extensionId: EXTENSION_ID };
    } catch {
      if (generation === this.generation) this.stop();
      throw new Error('Tab bridge unavailable');
    }
  }

  getState() {
    return { tabs: [...this.tabs.values()].map(({ id, hostname, active, protected: guarded, revision }) =>
      ({ id, hostname, active, protected: guarded, revision })), events: this.events.map(event => ({ ...event })),
    connected: Boolean(this.peer && this.observe), observeConsent: this.observe,
    closeConsent: Boolean(this.peer && this.observe && this.close && this.peerClose) };
  }

  setConsent({ observeConsent, closeConsent } = {}) {
    if (observeConsent !== true) { this.stop(); return this.getState(); }
    if (!this.observe || !this.server) return this.getState();
    this.close = closeConsent === true;
    if (!this.close) for (const id of [...this.pending.keys()]) this._finish(id, 'denied');
    if (this.peer) this._send(this.peer, { type: 'consent', observeConsent: true, closeConsent: this.close && this.peerClose });
    this._publish();
    return this.getState();
  }

  stop() {
    ++this.generation;
    this.observe = false;
    this.close = false;
    this.secret = null;
    this.consumed = true;
    this.clock.clearTimeout(this.pairTimer);
    this.pairTimer = null;
    for (const id of [...this.pending.keys()]) this._finish(id, 'unavailable');
    this.peer = null;
    for (const peer of this.peers) { this.clock.clearTimeout(peer.authTimer); this.clock.clearTimeout(peer.idleTimer); peer.terminate(); }
    this.peers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.tabs.clear();
    this.events = [];
    this.used.clear();
    this.sessionId = null;
    this.epoch = null;
    this.browserInstance = null;
    this.windowId = null;
    const server = this.server;
    const http = this.http;
    this.server = null;
    this.http = null;
    this._publish();
    const close = resource => new Promise(resolve => { if (!resource) return resolve(); try { resource.close(() => resolve()); } catch { resolve(); } });
    return Promise.all([close(server), close(http)]).then(() => undefined);
  }

  async closeTab({ id, revision, sessionId } = {}) {
    if (!this.observe || !this.peer) return { status: 'unavailable' };
    if (!this.close || !this.peerClose) return { status: 'denied' };
    const tab = [...this.tabs.values()].find(tab => tab.id === id);
    if (!tab || !P.integer(revision) || revision !== tab.revision || (sessionId !== undefined && sessionId !== this.sessionId)) return { status: 'stale' };
    if (tab.protected) return { status: 'denied' };
    const target = `${id}:${revision}`;
    if (this.used.has(target)) return { status: 'stale' };
    if (this.pending.size >= LIMITS.maxPending || this.used.size >= LIMITS.maxCommands) return { status: 'unavailable' };
    this.used.add(target);
    const command = { type: 'close', commandId: randomUUID(), epoch: this.epoch, browserInstance: this.browserInstance,
      windowId: this.windowId, tabId: tab.tabId, revision, expiresAt: this.clock.now() + LIMITS.commandMs };
    return new Promise(resolve => {
      const pending = { command, id, resolve, removed: false };
      this.pending.set(command.commandId, pending);
      pending.timer = this._timer(() => this._finish(command.commandId, 'failed'), LIMITS.commandMs);
      if (!this._send(this.peer, command)) this._finish(command.commandId, 'unavailable');
    });
  }

  _timer(fn, ms) { const timer = this.clock.setTimeout(fn, ms); timer?.unref?.(); return timer; }
  _publish() { try { this.onUpdate(this.getState()); } catch { /* A consumer cannot interrupt revocation. */ } }
  _send(peer, value) {
    if (!peer || peer.readyState !== 1 || peer.bufferedAmount > LIMITS.maxPayload) return false;
    try { peer.send(JSON.stringify(value)); return true; } catch { return false; }
  }
  _finish(commandId, status) {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    this.clock.clearTimeout(pending.timer);
    if (status !== 'closed') this._send(this.peer, { type: 'cancel', commandId });
    const result = { status, id: pending.id, revision: pending.command.revision };
    pending.resolve(result);
    try { this.onResult({ ...result }); } catch { /* Results remain available through closeTab(). */ }
  }
  _connect(peer, generation) {
    if (generation !== this.generation || !this.observe || this.consumed) return peer.terminate();
    this.peers.add(peer);
    peer.rate = { at: this.clock.now(), count: 0 };
    peer.authTimer = this._timer(() => peer.terminate(), LIMITS.authMs);
    peer.on('error', () => peer.terminate());
    peer.on('close', () => {
      this.clock.clearTimeout(peer.authTimer);
      this.clock.clearTimeout(peer.idleTimer);
      this.peers.delete(peer);
      if (this.peer === peer) this.stop();
    });
    peer.on('message', (raw, binary) => {
      if (generation !== this.generation || !this.observe) return peer.terminate();
      try {
        if (binary || raw.length > LIMITS.maxPayload) throw new Error('Payload rejected');
        if (this.clock.now() - peer.rate.at >= 1000) peer.rate = { at: this.clock.now(), count: 0 };
        if (++peer.rate.count > LIMITS.messagesPerSecond) throw new Error('Rate exceeded');
        const message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
        if (peer !== this.peer) return this._pair(peer, message);
        this.clock.clearTimeout(peer.idleTimer);
        peer.idleTimer = this._timer(() => this.stop(), LIMITS.idleMs);
        if (message.type === 'ping' && P.keys(message, ['type'])) this._send(peer, { type: 'pong' });
        else if (message.type === 'stop' && P.keys(message, ['type'])) this.stop();
        else if (message.type === 'inventory') this._inventory(message);
        else if (message.type === 'result') this._result(message);
        else throw new Error('Invalid message');
      } catch { peer.terminate(); }
    });
  }
  _pair(peer, message) {
    const secret = typeof message.secret === 'string' ? Buffer.from(message.secret) : Buffer.alloc(0);
    const expected = Buffer.from(this.secret || '');
    if (!P.keys(message, ['type', 'secret', 'epoch', 'browserInstance', 'windowId', 'observeConsent', 'closeConsent']) ||
      message.type !== 'pair' || this.consumed || this.clock.now() >= this.expiresAt || message.epoch !== this.epoch ||
      !P.token(message.browserInstance) || !P.integer(message.windowId) || message.observeConsent !== true ||
      typeof message.closeConsent !== 'boolean' || secret.length !== expected.length || !timingSafeEqual(secret, expected)) return peer.terminate();
    this.consumed = true;
    this.secret = null;
    this.peer = peer;
    this.peerClose = message.closeConsent;
    this.browserInstance = message.browserInstance;
    this.windowId = message.windowId;
    this.clock.clearTimeout(this.pairTimer);
    this.clock.clearTimeout(peer.authTimer);
    peer.idleTimer = this._timer(() => this.stop(), LIMITS.idleMs);
    for (const other of this.peers) if (other !== peer) other.terminate();
    if (!this._send(peer, { type: 'paired', epoch: this.epoch, observeConsent: true,
      closeConsent: this.close && this.peerClose, protectedHosts: this.hosts })) return this.stop();
    this._publish();
  }
  _inventory(message) {
    if (!P.keys(message, ['type', 'epoch', 'browserInstance', 'windowId', 'seq', 'tabs', 'events']) ||
      message.epoch !== this.epoch || message.browserInstance !== this.browserInstance || message.windowId !== this.windowId ||
      message.seq !== this.seq + 1 || !Array.isArray(message.tabs) || message.tabs.length > LIMITS.maxTabs ||
      !Array.isArray(message.events) || message.events.length > LIMITS.maxEvents) throw new Error('Invalid inventory');
    const next = new Map();
    for (const input of message.tabs) {
      if (!P.keys(input, ['tabId', 'hostname', 'active', 'revision']) || !P.integer(input.tabId) ||
        !P.integer(input.revision) || input.revision < 1 || !P.hostname(input.hostname) || typeof input.active !== 'boolean' ||
        next.has(input.tabId)) throw new Error('Invalid tab');
      const old = this.tabs.get(input.tabId);
      if (old && (input.revision < old.revision || (input.hostname !== old.hostname && input.revision === old.revision))) throw new Error('Stale tab');
      next.set(input.tabId, { ...input, id: old?.id || randomUUID(), protected: P.protectedHost(input.hostname, this.hosts) });
    }
    if ([...next.values()].filter(tab => tab.active).length > 1) throw new Error('Invalid active tabs');
    const events = [];
    const removed = new Set();
    for (const event of message.events) {
      if (!P.keys(event, ['kind', 'tabId', 'revision', 'hostname']) || !P.integer(event.tabId) || !P.integer(event.revision) ||
        !P.hostname(event.hostname)) throw new Error('Invalid event');
      const old = this.tabs.get(event.tabId), current = next.get(event.tabId);
      const target = ['removed', 'detached'].includes(event.kind) ? old : current;
      if (!target || target.revision !== event.revision || target.hostname !== event.hostname) throw new Error('Invalid event target');
      if (['removed', 'detached'].includes(event.kind)) { if (current) throw new Error('Tab still present'); }
      else if (['created', 'attached'].includes(event.kind)) { if (old) throw new Error('Tab already present'); }
      else if (event.kind === 'navigated') { if (!old || current.revision <= old.revision) throw new Error('Invalid navigation'); }
      else if (event.kind === 'activated') { if (!old || !current.active) throw new Error('Invalid activation'); }
      else throw new Error('Invalid event kind');
      if (event.kind === 'removed') removed.add(event.tabId);
      events.push({ kind: event.kind, id: target.id, revision: event.revision, hostname: event.hostname, sequence: ++this.eventSeq });
    }
    this.seq = message.seq;
    this.tabs = next;
    this.events = [...this.events, ...events].slice(-LIMITS.maxEvents);
    for (const [id, pending] of this.pending) {
      const current = next.get(pending.command.tabId);
      if (removed.has(pending.command.tabId)) pending.removed = true;
      else if (!pending.removed && (!current || current.revision !== pending.command.revision)) this._finish(id, 'stale');
    }
    this._publish();
  }
  _result(message) {
    if (!P.keys(message, ['type', 'commandId', 'epoch', 'browserInstance', 'windowId', 'tabId', 'revision', 'expiresAt', 'status', 'removed'])) throw new Error('Invalid result');
    const pending = this.pending.get(message.commandId);
    if (!pending) return;
    const exact = ['epoch', 'browserInstance', 'windowId', 'tabId', 'revision', 'expiresAt'].every(key => message[key] === pending.command[key]);
    const statuses = ['closed', 'stale', 'denied', 'unavailable', 'failed'];
    const status = !exact || !statuses.includes(message.status) ? 'failed' : message.status;
    const verified = pending.removed && message.removed === true && this.clock.now() < pending.command.expiresAt && this.observe && this.close && this.peerClose;
    this._finish(message.commandId, status === 'closed' && !verified ? 'failed' : status);
  }
}

module.exports = { TabBridge, EXTENSION_ID, LIMITS };
