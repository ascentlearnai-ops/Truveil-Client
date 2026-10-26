(function (root) {
  'use strict';
  const P = typeof module !== 'undefined' && module.exports ? require('./protocol') : root.TruveilTabProtocol;
  const { LIMITS } = P;
  const systemClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

  class WindowSharing {
    constructor({ chrome, WebSocket, clock = systemClock, randomId = () => crypto.randomUUID(), onState = () => {} }) {
      this.chrome = chrome;
      this.Socket = WebSocket;
      this.clock = clock;
      this.randomId = randomId;
      this.onState = onState;
      this.generation = 0;
      this.status = 'Not sharing';
      this._listen();
      this._notify();
    }

    getState() {
      const context = this.context;
      return { connected: Boolean(context?.paired), observeConsent: Boolean(context),
        closeConsent: Boolean(context?.paired && context.localClose && context.remoteClose),
        windowId: context?.windowId ?? null, tabCount: context?.tabs.size || 0, status: this.status };
    }

    async share({ pairingCode, windowId, observeConsent, closeConsent } = {}) {
      if (this.context) throw new Error('Stop sharing before pairing again');
      if (observeConsent !== true || typeof closeConsent !== 'boolean' || !P.integer(windowId)) throw new Error('Explicit window consent is required');
      const code = P.decodePairingCode(pairingCode, this.clock.now());
      if (this.chrome.runtime.id !== P.EXTENSION_ID) throw new Error('Extension identity does not match');
      const generation = ++this.generation;
      const window = await this.chrome.windows.get(windowId);
      if (generation !== this.generation) throw new Error('Sharing cancelled');
      if (window.id !== windowId || window.type !== 'normal' || window.incognito !== false || window.focused !== true) throw new Error('Choose a focused normal interview window');
      if (this.clock.now() >= code.expiresAt) throw new Error('Pairing code expired');
      const context = { generation, epoch: code.epoch, browserInstance: this.randomId(), windowId,
        localClose: closeConsent, remoteClose: false, paired: false, tabs: new Map(), pending: new Map(),
        seen: new Set(), targets: new Set(), revision: 0, seq: 0, hosts: P.protectedHosts(), rate: { at: this.clock.now(), count: 0 } };
      this.context = context;
      try {
        const socket = new this.Socket(`ws://127.0.0.1:${code.port}/`);
        context.socket = socket;
        context.authTimer = this._timer(() => this.stop('Pairing timed out'), LIMITS.authMs);
        socket.onopen = () => {
          if (!this._current(context) || this.clock.now() >= code.expiresAt) return this.stop('Pairing expired');
          this._send(context, { type: 'pair', secret: code.secret, epoch: context.epoch, browserInstance: context.browserInstance,
            windowId, observeConsent: true, closeConsent });
          code.secret = null;
        };
        socket.onmessage = event => { if (this._current(context)) this._receive(context, event.data); };
        socket.onerror = socket.onclose = () => { if (this._current(context)) this.stop('Disconnected. Pair again to share.'); };
        this.status = 'Connecting';
        this._notify();
      } catch { this.stop('Connection unavailable'); throw new Error('Connection unavailable'); }
      return this.getState();
    }

    stop(status = 'Not sharing') {
      ++this.generation;
      const context = this.context;
      this.context = null;
      this.status = status;
      if (context) {
        this.clock.clearTimeout(context.authTimer);
        this.clock.clearTimeout(context.heartbeatTimer);
        for (const pending of context.pending.values()) { pending.cancelled = true; this.clock.clearTimeout(pending.timer); }
        context.pending.clear();
        context.tabs.clear();
        context.seen.clear();
        context.targets.clear();
        try {
          if (context.socket?.readyState === 1) context.socket.send(JSON.stringify({ type: 'stop' }));
          context.socket?.close();
        } catch { /* Local consent is already gone. */ }
      }
      this._notify();
      return this.getState();
    }

    _timer(fn, ms) { const id = this.clock.setTimeout(fn, ms); id?.unref?.(); return id; }
    _current(context) { return this.context === context && context.generation === this.generation; }
    _notify() { try { this.onState(this.getState()); } catch { /* UI cannot prevent cleanup. */ } }
    _send(context, message) {
      if (!this._current(context) || context.socket?.readyState !== 1 || context.socket.bufferedAmount > LIMITS.maxPayload) return false;
      const raw = JSON.stringify(message);
      if (raw.length > LIMITS.maxPayload) return false;
      try { context.socket.send(raw); return true; } catch { return false; }
    }
    _receive(context, raw) {
      try {
        if (typeof raw !== 'string' || raw.length > LIMITS.maxPayload) throw new Error('Invalid message');
        if (this.clock.now() - context.rate.at >= 1000) context.rate = { at: this.clock.now(), count: 0 };
        if (++context.rate.count > LIMITS.messagesPerSecond) throw new Error('Rate exceeded');
        const message = JSON.parse(raw);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
        if (!context.paired) {
          if (!P.keys(message, ['type', 'epoch', 'observeConsent', 'closeConsent', 'protectedHosts']) || message.type !== 'paired' ||
            message.epoch !== context.epoch || message.observeConsent !== true || typeof message.closeConsent !== 'boolean') throw new Error('Pairing rejected');
          context.hosts = P.protectedHosts(message.protectedHosts);
          context.paired = true;
          context.remoteClose = message.closeConsent;
          context.lastMessage = this.clock.now();
          this.clock.clearTimeout(context.authTimer);
          this._heartbeat(context);
          this._initial(context).catch(() => { if (this._current(context)) this.stop('Window unavailable. Pair again.'); });
          return;
        }
        context.lastMessage = this.clock.now();
        if (message.type === 'pong' && P.keys(message, ['type'])) return;
        if (message.type === 'stop' && P.keys(message, ['type'])) return this.stop();
        if (message.type === 'consent' && P.keys(message, ['type', 'observeConsent', 'closeConsent'])) {
          if (message.observeConsent !== true) return this.stop();
          context.remoteClose = message.closeConsent === true;
          if (!context.remoteClose) for (const pending of [...context.pending.values()]) this._finish(context, pending, 'denied');
          this._notify();
          return;
        }
        if (message.type === 'cancel' && P.keys(message, ['type', 'commandId']) && P.token(message.commandId)) {
          const pending = context.pending.get(message.commandId);
          if (pending) this._finish(context, pending, 'stale');
          return;
        }
        if (message.type === 'close') { this._close(context, message).catch(() => this.stop('Tab operation unavailable')); return; }
        throw new Error('Invalid message');
      } catch { this.stop('Connection rejected. Pair again.'); }
    }
    _heartbeat(context) {
      context.heartbeatTimer = this._timer(() => {
        if (!this._current(context)) return;
        if (this.clock.now() - context.lastMessage >= LIMITS.idleMs || !this._send(context, { type: 'ping' })) return this.stop('Connection timed out');
        this._heartbeat(context);
      }, LIMITS.heartbeatMs);
    }
    async _initial(context) {
      context.initializing = true;
      const tabs = await this.chrome.tabs.query({ windowId: context.windowId });
      if (!this._current(context)) return;
      if (tabs.length > LIMITS.maxTabs) return this.stop('Too many tabs in this interview window');
      for (const tab of tabs) {
        if (!this._inWindow(context, tab)) return this.stop('Window scope changed. Pair again.');
        context.tabs.set(tab.id, this._entry(context, tab));
      }
      context.initializing = false;
      this.status = 'Sharing this interview window';
      this._report(context);
    }
    _inWindow(context, tab) { return tab && P.integer(tab.id) && tab.windowId === context.windowId && tab.incognito === false; }
    _entry(context, tab) {
      return { tabId: tab.id, revision: ++context.revision, hostname: P.fromUrl(tab.url), active: tab.active === true,
        url: typeof tab.url === 'string' ? tab.url : '', status: tab.status, pendingUrl: tab.pendingUrl };
    }
    _report(context, events = []) {
      if (!this._current(context) || !context.paired) return;
      if (context.tabs.size > LIMITS.maxTabs) return this.stop('Too many tabs in this interview window');
      const tabs = [...context.tabs.values()].map(({ tabId, revision, hostname, active }) => ({ tabId, revision, hostname, active }));
      if (!this._send(context, { type: 'inventory', epoch: context.epoch, browserInstance: context.browserInstance,
        windowId: context.windowId, seq: ++context.seq, tabs, events })) return this.stop('Connection unavailable');
      this._notify();
    }
    _event(kind, tab) { return { kind, tabId: tab.tabId, revision: tab.revision, hostname: tab.hostname }; }
    _ready(context) {
      if (!context?.paired) return false;
      if (context.initializing) { this.stop('Window changed while pairing. Pair again.'); return false; }
      return this._current(context);
    }
    _listen() {
      const tabs = this.chrome.tabs;
      tabs.onCreated.addListener(tab => {
        const context = this.context;
        if (!context || !this._inWindow(context, tab) || !this._ready(context)) return;
        if (context.tabs.has(tab.id)) return this.stop('Tab identity changed');
        const entry = this._entry(context, tab);
        if (entry.active) for (const other of context.tabs.values()) other.active = false;
        context.tabs.set(tab.id, entry);
        this._report(context, [this._event('created', entry)]);
      });
      tabs.onUpdated.addListener((id, changes, tab) => {
        const context = this.context;
        if (!context || !this._inWindow(context, tab) || !this._ready(context)) return;
        const old = context.tabs.get(id);
        if (!old) return;
        if (changes.url !== undefined || changes.status === 'loading' || changes.pendingUrl !== undefined) {
          const entry = this._entry(context, { ...tab, active: old.active });
          context.tabs.set(id, entry);
          this._report(context, [this._event('navigated', entry)]);
          for (const pending of [...context.pending.values()]) if (pending.command.tabId === id) this._finish(context, pending, 'stale');
        } else { old.status = tab.status; old.pendingUrl = tab.pendingUrl; }
      });
      tabs.onActivated.addListener(({ tabId, windowId }) => {
        const context = this.context;
        if (!context || windowId !== context.windowId || !this._ready(context)) return;
        const entry = context.tabs.get(tabId);
        if (!entry) return;
        for (const tab of context.tabs.values()) tab.active = tab.tabId === tabId;
        this._report(context, [this._event('activated', entry)]);
      });
      tabs.onRemoved.addListener((id, info) => {
        const context = this.context;
        if (!context || info.windowId !== context.windowId || !this._ready(context)) return;
        if (info.isWindowClosing) return this.stop('Shared window closed');
        const entry = context.tabs.get(id);
        if (!entry) return;
        context.tabs.delete(id);
        this._report(context, [this._event('removed', entry)]);
        for (const pending of [...context.pending.values()]) {
          if (pending.command.tabId === id && pending.command.revision === entry.revision && pending.invoked) {
            pending.removed = true;
            if (pending.apiDone) this._finish(context, pending, 'closed');
          }
        }
      });
      tabs.onDetached.addListener((id, info) => {
        const context = this.context;
        if (!context || info.oldWindowId !== context.windowId || !this._ready(context)) return;
        const entry = context.tabs.get(id);
        if (!entry) return;
        context.tabs.delete(id);
        this._report(context, [this._event('detached', entry)]);
        for (const pending of [...context.pending.values()]) if (pending.command.tabId === id) this._finish(context, pending, 'stale');
      });
      tabs.onAttached.addListener((id, info) => {
        const context = this.context;
        if (!context || info.newWindowId !== context.windowId || !this._ready(context)) return;
        this.chrome.tabs.get(id).then(tab => {
          if (!this._current(context) || !this._inWindow(context, tab)) return;
          if (context.tabs.has(id)) return this.stop('Tab identity changed');
          const entry = this._entry(context, tab);
          if (entry.active) for (const other of context.tabs.values()) other.active = false;
          context.tabs.set(id, entry);
          this._report(context, [this._event('attached', entry)]);
        }).catch(() => { if (this._current(context)) this.stop('Tab unavailable'); });
      });
      tabs.onReplaced.addListener((added, removed) => {
        if (this.context?.tabs.has(removed)) this.stop('Browser replaced a shared tab. Pair again.');
      });
    }
    _validPending(context, pending) {
      return this._current(context) && !pending.cancelled && context.pending.get(pending.command.commandId) === pending &&
        context.localClose && context.remoteClose && this.clock.now() < pending.command.expiresAt &&
        context.tabs.get(pending.command.tabId)?.revision === pending.command.revision;
    }
    async _close(context, command) {
      if (!P.keys(command, ['type', 'commandId', 'epoch', 'browserInstance', 'windowId', 'tabId', 'revision', 'expiresAt']) ||
        !P.token(command.commandId) || !P.integer(command.tabId) || !P.integer(command.revision) || !P.integer(command.expiresAt)) return this.stop('Invalid tab command');
      const respond = status => this._send(context, { ...command, type: 'result', status, removed: false });
      if (context.seen.has(command.commandId)) return respond('stale');
      if (context.seen.size >= LIMITS.maxCommands || context.pending.size >= LIMITS.maxPending) return respond('unavailable');
      context.seen.add(command.commandId);
      if (command.epoch !== context.epoch || command.browserInstance !== context.browserInstance || command.windowId !== context.windowId ||
        command.expiresAt <= this.clock.now() || command.expiresAt > this.clock.now() + LIMITS.commandMs) return respond('stale');
      if (!context.localClose || !context.remoteClose) return respond('denied');
      const entry = context.tabs.get(command.tabId);
      if (!entry || entry.revision !== command.revision) return respond('stale');
      if (P.protectedHost(entry.hostname, context.hosts)) return respond('denied');
      const target = `${command.tabId}:${command.revision}`;
      if (context.targets.has(target)) return respond('stale');
      context.targets.add(target);
      const pending = { command, cancelled: false, removed: false, invoked: false, apiDone: false };
      context.pending.set(command.commandId, pending);
      pending.timer = this._timer(() => this._finish(context, pending, 'failed'), command.expiresAt - this.clock.now());
      try {
        const window = await this.chrome.windows.get(context.windowId);
        if (!this._validPending(context, pending)) return this._finish(context, pending, 'stale');
        if (window.id !== context.windowId || window.type !== 'normal' || window.incognito !== false) return this._finish(context, pending, 'denied');
        const current = await this.chrome.tabs.get(command.tabId);
        if (!this._validPending(context, pending)) return this._finish(context, pending, 'stale');
        if (!this._inWindow(context, current) || current.id !== command.tabId) return this._finish(context, pending, 'stale');
        if (P.protectedHost(P.fromUrl(current.url), context.hosts) || (current.pendingUrl && P.protectedHost(P.fromUrl(current.pendingUrl), context.hosts))) return this._finish(context, pending, 'denied');
        if (current.url !== entry.url || current.pendingUrl || current.status === 'loading') return this._finish(context, pending, 'stale');
        // Chromium cannot atomically lock a document here. This closes the tab object,
        // never a hostname match, and success additionally requires its removal event.
        pending.invoked = true;
        await this.chrome.tabs.remove(command.tabId);
        if (!this._current(context) || pending.cancelled) return;
        pending.apiDone = true;
        if (pending.removed) this._finish(context, pending, 'closed');
      } catch { this._finish(context, pending, 'failed'); }
    }
    _finish(context, pending, status) {
      if (context.pending.get(pending.command.commandId) !== pending) return;
      context.pending.delete(pending.command.commandId);
      pending.cancelled = true;
      this.clock.clearTimeout(pending.timer);
      if (status === 'closed' && (!pending.removed || !pending.apiDone || !this._current(context) ||
        !context.localClose || !context.remoteClose || this.clock.now() >= pending.command.expiresAt)) status = 'failed';
      this._send(context, { ...pending.command, type: 'result', status, removed: pending.removed });
    }
  }

  const api = { WindowSharing, decodePairingCode: P.decodePairingCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TruveilWindowSharing = api;
})(globalThis);
