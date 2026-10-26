const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { TabBridge, EXTENSION_ID, LIMITS } = require('../src/browser/tab-bridge');
const { WindowSharing, decodePairingCode } = require('../browser-extension/window-sharing');
const manifest = require('../browser-extension/manifest.json');

test('default browser timers retain their native global receiver', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  let calls=0;
  function nativeTimer() {
    if (this && Object.hasOwn(this,'now')) throw new TypeError('Illegal invocation');
    calls++; return 1;
  }
  const context=vm.createContext({module:{exports:{}},require:()=>require('../browser-extension/protocol'),
    setTimeout:nativeTimer,clearTimeout:nativeTimer});
  vm.runInContext(fs.readFileSync(require.resolve('../browser-extension/window-sharing'),'utf8'),context);
  const h=workerHarness();
  const worker=new context.module.exports.WindowSharing({chrome:h.chrome,WebSocket:class{}});
  worker._timer(()=>{},100);
  worker.context={pending:new Map(),tabs:new Map(),seen:new Set(),targets:new Set()};
  worker.stop();
  assert.equal(calls,3);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let time = 100000, id = 0;
  const tasks = new Map();
  return { now: () => time, setTimeout(fn, ms) { tasks.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    tick(ms) { time += ms; for (const [id, task] of [...tasks]) if (task.at <= time) { tasks.delete(id); task.fn(); } }, tasks };
}
class Peer extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  close() { this.terminate(); }
  receive(value) { this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), false); }
}
class Server extends EventEmitter {
  constructor(options) { super(); this.options = options; Server.last = this; options.server.on('listening', () => this.emit('listening')); }
  address() { return this.options.server.address(); }
  close(callback) { this.emit('close'); callback?.(); }
  connect(origin = `chrome-extension://${EXTENSION_ID}`) {
    const req = { url: '/', headers: { origin, host: `127.0.0.1:${this.address()?.port}` }, socket: { remoteAddress: '127.0.0.1' } };
    let accepted = false;
    this.options.verifyClient({ origin, req }, ok => { accepted = ok; });
    if (!accepted) return null;
    const peer = new Peer(); this.emit('connection', peer, req); return peer;
  }
}
async function bridgeHarness(t, options = {}) {
  const time = clock(), updates = [], results = [];
  const bridge = new TabBridge({ onUpdate: value => updates.push(value), onResult: value => results.push(value), WebSocketServer: Server, clock: time });
  const pairing = await bridge.start({ sessionId: 'synthetic-session', observeConsent: true, closeConsent: true, ...options });
  t.after(() => bridge.stop());
  const code = JSON.parse(Buffer.from(pairing.pairingCode.slice(5), 'base64url'));
  const server = Server.last;
  function pair(extra = {}) {
    const peer = server.connect();
    peer?.receive({ type: 'pair', secret: code.secret, epoch: code.epoch, browserInstance: 'test-browser-instance', windowId: 10, observeConsent: true, closeConsent: true, ...extra });
    return peer;
  }
  let seq = 0;
  const inventory = (peer, tabs, events = [], extra = {}) => peer.receive({ type: 'inventory', epoch: code.epoch, browserInstance: 'test-browser-instance', windowId: 10, seq: ++seq, tabs, events, ...extra });
  return { bridge, code, server, pair, inventory, time, updates, results };
}
const tab = (tabId = 1, overrides = {}) => ({ tabId, hostname: 'example.test', revision: 1, active: tabId === 1, ...overrides });
function closeResult(peer, command, extra = {}) {
  peer.receive({ ...command, type: 'result', status: 'closed', removed: true, ...extra });
}

test('manifest uses stable identity, no host/content/native/debugger permissions and no incognito', () => {
  const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, x => String.fromCharCode(97 + parseInt(x, 16)));
  assert.equal(id, EXTENSION_ID);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.permissions, ['tabs']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test('bridge is opt-in, binds IPv4 loopback on an ephemeral port, and never leaks pairing credentials', async t => {
  const h = await bridgeHarness(t);
  assert.equal(h.server.address().address, '127.0.0.1');
  assert.ok(h.server.address().port > 0);
  assert.equal(h.server.options.maxPayload, LIMITS.maxPayload);
  assert.equal(h.bridge.getState().connected, false);
  assert.equal(JSON.stringify(h.updates).includes(h.code.secret), false);
  h.pair();
  assert.equal(h.bridge.getState().connected, true);
  assert.equal(JSON.stringify(h.bridge.getState()).includes(h.code.epoch), false);
});

test('webpage, missing, malformed and foreign extension origins cannot connect', async t => {
  const h = await bridgeHarness(t);
  for (const origin of [null, '', 'null', 'https://example.test', `chrome-extension://${EXTENSION_ID}/`, `chrome-extension://${EXTENSION_ID}.evil`, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.equal(h.server.connect(origin), null);
  }
  assert.equal(h.bridge.getState().connected, false);
});

test('wrong authentication and unauthenticated timeout cannot consume a valid pairing', async t => {
  const h = await bridgeHarness(t);
  assert.equal(h.pair({ secret: 'wrong' }).readyState, 3);
  const idle = h.server.connect(); h.time.tick(LIMITS.authMs + 1);
  assert.equal(idle.readyState, 3);
  assert.equal(h.pair().readyState, 1);
  assert.equal(h.server.connect(), null, 'only one authenticated peer');
});

test('pairing expires, and disconnect requires a fresh one-use pairing', async t => {
  const h = await bridgeHarness(t);
  const peer = h.pair(); peer.terminate();
  assert.deepEqual(h.bridge.getState(), { tabs: [], events: [], connected: false, observeConsent: false, closeConsent: false });
  assert.equal(h.server.connect(), null);
  const second = await h.bridge.start({ sessionId: 'new-session', observeConsent: true, closeConsent: false });
  assert.notEqual(JSON.parse(Buffer.from(second.pairingCode.slice(5), 'base64url')).secret, h.code.secret);
  h.time.tick(LIMITS.pairingMs + 1);
  assert.equal(Server.last.connect(), null);
});

test('inventory is hostname-only, opaque, copy-safe and protects meeting hosts and subdomains', async t => {
  const h = await bridgeHarness(t, { protectedHosts: ['interview.test'] }); const peer = h.pair();
  h.inventory(peer, [tab(1), tab(2, { hostname: 'meet.google.com' }), tab(3, { hostname: 'eu.interview.test' }), tab(4, { hostname: '' })]);
  const state = h.bridge.getState();
  assert.match(state.tabs[0].id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(state.tabs[0]).sort(), ['active', 'hostname', 'id', 'protected', 'revision']);
  assert.deepEqual(state.tabs.map(item => item.protected), [false, true, true, true]);
  state.tabs[0].hostname = 'changed'; assert.equal(h.bridge.getState().tabs[0].hostname, 'example.test');
  assert.equal((await h.bridge.closeTab(state.tabs[1])).status, 'denied');
});

test('malformed, oversized, cross-window, replayed and rate-limited inventory fails closed', async t => {
  for (const attack of ['json', 'host', 'window', 'duplicate', 'extra', 'large', 'rate']) {
    const h = await bridgeHarness(t); const peer = h.pair();
    if (attack === 'json') peer.receive('{');
    if (attack === 'host') h.inventory(peer, [tab(1, { hostname: 'example.test/private?q=secret' })]);
    if (attack === 'window') h.inventory(peer, [tab()], [], { windowId: 20 });
    if (attack === 'duplicate') h.inventory(peer, [tab(), tab()]);
    if (attack === 'extra') h.inventory(peer, [tab(1, { title: 'private' })]);
    if (attack === 'large') peer.receive(' '.repeat(LIMITS.maxPayload + 1));
    if (attack === 'rate') for (let i = 0; i <= LIMITS.messagesPerSecond; i++) peer.receive({ type: 'ping' });
    assert.equal(h.bridge.getState().connected, false, attack);
    assert.deepEqual(h.bridge.getState().tabs, []);
  }
});

test('same-host tabs stay distinct and stale revisions, target reuse and wrong-tab results never close', async t => {
  const h = await bridgeHarness(t); const peer = h.pair(); h.inventory(peer, [tab(1), tab(2)]);
  const [first, second] = h.bridge.getState().tabs; assert.notEqual(first.id, second.id);
  h.inventory(peer, [tab(1, { revision: 2 }), tab(2)], [{ kind: 'navigated', tabId: 1, revision: 2, hostname: 'example.test' }]);
  assert.equal((await h.bridge.closeTab(first)).status, 'stale');
  const closing = h.bridge.closeTab(second); const command = peer.sent.at(-1);
  assert.equal(command.tabId, 2);
  assert.equal((await h.bridge.closeTab(second)).status, 'stale');
  closeResult(peer, command, { tabId: 1 });
  assert.equal((await closing).status, 'failed');
});

test('close success requires exact removal event plus successful acknowledgement', async t => {
  const h = await bridgeHarness(t); const peer = h.pair(); h.inventory(peer, [tab()]);
  const closing = h.bridge.closeTab(h.bridge.getState().tabs[0]); const command = peer.sent.at(-1);
  h.inventory(peer, [], [{ kind: 'removed', tabId: 1, revision: 1, hostname: 'example.test' }]);
  closeResult(peer, command);
  assert.equal((await closing).status, 'closed');
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].tabId, undefined);
});

test('unverified close, timeout, navigation, revocation and end cancel pending commands', async t => {
  for (const scenario of ['unverified', 'timeout', 'navigation', 'revoke', 'end', 'disconnect']) {
    const h = await bridgeHarness(t); const peer = h.pair(); h.inventory(peer, [tab()]);
    const closing = h.bridge.closeTab(h.bridge.getState().tabs[0]); const command = peer.sent.at(-1);
    if (scenario === 'unverified') closeResult(peer, command);
    if (scenario === 'timeout') h.time.tick(LIMITS.commandMs + 1);
    if (scenario === 'navigation') h.inventory(peer, [tab(1, { revision: 2 })], [{ kind: 'navigated', tabId: 1, revision: 2, hostname: 'example.test' }]);
    if (scenario === 'revoke') h.bridge.setConsent({ observeConsent: false, closeConsent: false });
    if (scenario === 'end') h.bridge.stop();
    if (scenario === 'disconnect') peer.terminate();
    assert.notEqual((await closing).status, 'closed', scenario);
    closeResult(peer, command);
    assert.equal(h.results.some(result => result.status === 'closed'), false);
    if (['revoke', 'end', 'disconnect'].includes(scenario)) assert.equal(h.bridge.getState().observeConsent, false);
  }
});

test('observe-only is enforced by both sides and close revocation cancels in-flight work', async t => {
  const h = await bridgeHarness(t, { closeConsent: false }); const peer = h.pair(); h.inventory(peer, [tab()]);
  assert.equal((await h.bridge.closeTab(h.bridge.getState().tabs[0])).status, 'denied');
  h.bridge.setConsent({ observeConsent: true, closeConsent: true });
  const pending = h.bridge.closeTab(h.bridge.getState().tabs[0]);
  h.bridge.setConsent({ observeConsent: true, closeConsent: false });
  assert.equal((await pending).status, 'denied');
  assert.equal(h.bridge.getState().connected, true);
});

function chromeEvent() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit(...args) { for (const fn of listeners) fn(...args); }, listeners };
}
function workerHarness(options = {}) {
  const time = clock(), messages = [], queries = [], removed = [], sockets = [];
  const tabs = new Map([[1, { id: 1, windowId: 10, incognito: false, active: true, url: 'https://example.test/private?q=hidden', status: 'complete' }], [2, { id: 2, windowId: 20, incognito: false, active: true, url: 'https://personal.test/secret' }]]);
  const chrome = { runtime: { id: EXTENSION_ID }, windows: { get: async id => ({ id, type: 'normal', incognito: false, focused: true, ...options.window }) }, tabs: {
    query: async query => { queries.push(query); return [...tabs.values()].filter(tab => tab.windowId === query.windowId); },
    get: async id => { if (options.get) return options.get(id, tabs); if (!tabs.has(id)) throw Error('missing'); return { ...tabs.get(id) }; },
    remove: async id => { removed.push(id); if (options.removeError) throw Error('blocked'); if (options.removeEvent !== false) { tabs.delete(id); chrome.tabs.onRemoved.emit(id, { windowId: 10, isWindowClosing: false }); } },
    onCreated: chromeEvent(), onUpdated: chromeEvent(), onActivated: chromeEvent(), onRemoved: chromeEvent(), onDetached: chromeEvent(), onAttached: chromeEvent(), onReplaced: chromeEvent()
  } };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; sockets.push(this); }
    send(raw) { messages.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const worker = new WindowSharing({ chrome, WebSocket: Socket, clock: time, randomId: () => 'test-browser-instance' });
  const code = { v: 1, port: 41821, secret: 's'.repeat(43), epoch: crypto.randomUUID(), expiresAt: time.now() + 120000, extensionId: EXTENSION_ID };
  const pairingCode = `trv1.${Buffer.from(JSON.stringify(code)).toString('base64url')}`;
  async function share(closeConsent = true) {
    await worker.share({ pairingCode, windowId: 10, observeConsent: true, closeConsent });
    sockets[0].open(); sockets[0].receive({ type: 'paired', epoch: code.epoch, observeConsent: true, closeConsent, protectedHosts: ['meet.google.com'] });
    await settle();
  }
  function command(extra = {}) { return { type: 'close', commandId: crypto.randomUUID(), epoch: code.epoch, browserInstance: 'test-browser-instance', windowId: 10, tabId: 1, revision: messages.findLast(item => item.type === 'inventory')?.tabs.find(item => item.tabId === 1)?.revision || 1, expiresAt: time.now() + 5000, ...extra }; }
  return { worker, chrome, messages, queries, removed, sockets, tabs, time, code, pairingCode, share, command };
}

test('worker never auto-connects and explicitly enrolls only one focused normal non-incognito window', async () => {
  const h = workerHarness(); assert.equal(h.sockets.length, 0); assert.equal(h.queries.length, 0);
  await h.share(); assert.deepEqual(h.queries, [{ windowId: 10 }]);
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:41821/');
  const data = JSON.stringify(h.messages.filter(item => item.type === 'inventory'));
  assert.equal(data.includes('personal'), false); assert.equal(data.includes('hidden'), false); assert.equal(data.includes('/private'), false);
  for (const window of [{ incognito: true }, { type: 'popup' }, { focused: false }]) {
    const other = workerHarness({ window }); await assert.rejects(other.share()); assert.equal(other.sockets.length, 0);
  }
  h.worker.stop();
});

test('pairing decoder rejects arbitrary endpoints, extension mismatches, malformed and expired codes', () => {
  const h = workerHarness();
  assert.equal(decodePairingCode(h.pairingCode, h.time.now()).port, 41821);
  for (const code of ['', 'ws://evil.test', 'trv1.!!!', ...[{ port: 0 }, { port: 65536 }, { endpoint: 'ws://evil.test' }, { extensionId: 'x' }, { expiresAt: 1 }, { secret: 'short' }].map(extra => `trv1.${Buffer.from(JSON.stringify({ ...h.code, ...extra })).toString('base64url')}`)]) {
    assert.throws(() => decodePairingCode(code, h.time.now()));
  }
});

test('worker reports truthful events, same-host navigation revisions and excludes all other windows', async () => {
  const h = workerHarness(); await h.share(); const before = h.command().revision;
  h.chrome.tabs.onUpdated.emit(2, { url: 'https://personal.test/more' }, h.tabs.get(2));
  h.tabs.get(1).url = 'https://example.test/another?hidden=2';
  h.chrome.tabs.onUpdated.emit(1, { url: h.tabs.get(1).url }, h.tabs.get(1));
  assert.ok(h.command().revision > before);
  assert.equal(h.messages.at(-1).events[0].kind, 'navigated');
  h.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 10 });
  assert.equal(h.messages.at(-1).events[0].kind, 'activated');
  assert.equal(JSON.stringify(h.messages).includes('personal'), false);
  h.worker.stop();
});

test('worker rejects expired, replayed, stale, protected, cross-window, observe-only and navigated targets', async () => {
  for (const scenario of ['expired', 'crosswindow', 'revision', 'protected', 'observe', 'race', 'pendingUrl']) {
    const h = workerHarness(); await h.share(scenario !== 'observe'); const command = h.command();
    if (scenario === 'expired') command.expiresAt = 1;
    if (scenario === 'crosswindow') command.windowId = 20;
    if (scenario === 'revision') command.revision++;
    if (scenario === 'protected') h.tabs.get(1).url = 'https://meet.google.com/private';
    if (scenario === 'race') h.tabs.get(1).url = 'https://example.test/changed';
    if (scenario === 'pendingUrl') h.tabs.get(1).pendingUrl = 'https://meet.google.com/new';
    h.sockets[0].receive(command); await settle();
    assert.deepEqual(h.removed, [], scenario);
    assert.notEqual(h.messages.at(-1).status, 'closed'); h.worker.stop();
  }
  const h = workerHarness(); await h.share(); const command = h.command();
  h.sockets[0].receive(command); await settle(); h.sockets[0].receive(command); await settle();
  assert.deepEqual(h.removed, [1]); h.worker.stop();
});

test('worker requires an exact removal event, fails on rejected removal and cancels on stop while awaiting tab lookup', async () => {
  for (const options of [{ removeEvent: false }, { removeError: true }]) {
    const h = workerHarness(options); await h.share(); h.sockets[0].receive(h.command()); await settle(); h.time.tick(6000); await settle();
    assert.notEqual(h.messages.at(-1).status, 'closed'); h.worker.stop();
  }
  let resolve; const h = workerHarness({ get: () => new Promise(res => { resolve = res; }) });
  await h.share(); h.sockets[0].receive(h.command()); await settle(); h.worker.stop();
  resolve({ ...h.tabs.get(1) }); await settle();
  assert.deepEqual(h.removed, []); assert.equal(h.worker.getState().observeConsent, false);
});

test('real WebSocket loopback rejects page origins and accepts only a one-use extension pairing', async t => {
  const WebSocket = require('ws'); const bridge = new TabBridge({ onUpdate() {} }); t.after(() => bridge.stop());
  const pair = await bridge.start({ sessionId: 'loopback-only', observeConsent: true, closeConsent: false });
  const code = JSON.parse(Buffer.from(pair.pairingCode.slice(5), 'base64url')); const url = `ws://127.0.0.1:${code.port}/`;
  const rejected = new WebSocket(url, { origin: 'https://example.test' });
  const [error] = await once(rejected, 'error'); assert.match(error.message, /403/);
  const accepted = new WebSocket(url, { origin: `chrome-extension://${EXTENSION_ID}` }); t.after(() => accepted.terminate());
  await once(accepted, 'open'); const response = once(accepted, 'message');
  accepted.send(JSON.stringify({ type: 'pair', secret: code.secret, epoch: code.epoch, browserInstance: 'loopback-test-instance', windowId: 10, observeConsent: true, closeConsent: false }));
  assert.equal(JSON.parse((await response)[0]).type, 'paired');
  assert.equal(bridge.getState().closeConsent, false);
});

test('HTTP connections are bounded and have a short pre-upgrade timeout', async t => {
  const h = await bridgeHarness(t);
  assert.ok(h.server.options.server, 'Own the HTTP server so non-WebSocket connections are bounded too');
  assert.equal(h.server.options.server.maxConnections, LIMITS.maxPeers + 2);
  assert.equal(h.server.options.server.timeout, LIMITS.authMs);
});

test('overlapping starts cannot leave an old listener or pairing alive', async () => {
  const bridge = new TabBridge({ WebSocketServer: Server });
  try {
    const results = await Promise.allSettled([
      bridge.start({ sessionId: 'first', observeConsent: true, closeConsent: false }),
      bridge.start({ sessionId: 'second', observeConsent: true, closeConsent: false })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(bridge.sessionId, 'second');
  } finally { await bridge.stop(); }
});

test('no observe consent opens no listener; revocation cannot be undone without pairing again', async () => {
  const bridge = new TabBridge({ WebSocketServer: Server }); const previous = Server.last;
  assert.deepEqual(await bridge.start({ sessionId: 'observe-denied', observeConsent: false, closeConsent: true }), { pairingCode: null, extensionId: EXTENSION_ID });
  assert.equal(Server.last, previous);
  bridge.setConsent({ observeConsent: true, closeConsent: true });
  assert.equal(bridge.getState().observeConsent, false);
  await bridge.stop();
});

test('worker consumes each target revision once, even with distinct command IDs', async () => {
  let resolve;
  const h = workerHarness({ get: () => new Promise(res => { resolve = res; }) }); await h.share();
  const command = h.command(); h.sockets[0].receive(command); await settle();
  h.sockets[0].receive({ ...command, commandId: crypto.randomUUID() }); await settle();
  assert.equal(h.messages.at(-1).status, 'stale');
  resolve({ ...h.tabs.get(1) }); await settle(); h.worker.stop();
});

test('worker cannot close on the wrong removal event or close after an awaited lookup expires', async () => {
  const wrong = workerHarness({ removeEvent: false }); await wrong.share(); wrong.sockets[0].receive(wrong.command()); await settle();
  wrong.chrome.tabs.onRemoved.emit(2, { windowId: 20, isWindowClosing: false });
  wrong.time.tick(6000); await settle();
  assert.equal(wrong.messages.some(message => message.status === 'closed'), false); wrong.worker.stop();
  let resolve; const late = workerHarness({ get: () => new Promise(res => { resolve = res; }) });
  await late.share(); late.sockets[0].receive(late.command()); await settle(); late.time.tick(6000);
  resolve({ ...late.tabs.get(1) }); await settle(); assert.deepEqual(late.removed, []); late.worker.stop();
});

test('bridge rejects repeated snapshot sequence and mismatched session identity', async t => {
  const h = await bridgeHarness(t); const peer = h.pair(); h.inventory(peer, [tab()]);
  assert.equal((await h.bridge.closeTab({ ...h.bridge.getState().tabs[0], sessionId: 'another-session' })).status, 'stale');
  h.inventory(peer, [tab()], [], { seq: 1 });
  assert.equal(h.bridge.getState().connected, false);
});

test('worker stops on disconnect, drops both permissions, and never reconnects', async () => {
  const h = workerHarness(); await h.share(); h.sockets[0].close(); h.time.tick(120000);
  assert.equal(h.worker.getState().observeConsent, false); assert.equal(h.worker.getState().closeConsent, false);
  assert.equal(h.sockets.length, 1); assert.equal(h.worker.getState().tabCount, 0);
  const count = h.messages.length;
  h.chrome.tabs.onUpdated.emit(1, { url: 'https://another.test/' }, h.tabs.get(1));
  assert.equal(h.messages.length, count);
});

test('real loopback bridge and mock-browser worker complete an exact-tab close end to end', async t => {
  const WebSocket = require('ws');
  const updates = [];
  let waiting;
  const bridge = new TabBridge({ onUpdate(state) { updates.push(state); waiting?.(state); } });
  t.after(() => bridge.stop());
  const pairing = await bridge.start({ sessionId: 'synthetic-e2e', observeConsent: true, closeConsent: true });
  const h = workerHarness();
  class ExtensionSocket extends WebSocket { constructor(url) { super(url, { origin: `chrome-extension://${EXTENSION_ID}` }); } }
  const worker = new WindowSharing({ chrome: h.chrome, WebSocket: ExtensionSocket }); t.after(() => worker.stop());
  const inventory = new Promise(resolve => { waiting = state => { if (state.tabs.length) resolve(state); }; });
  await worker.share({ pairingCode: pairing.pairingCode, windowId: 10, observeConsent: true, closeConsent: true });
  const state = await inventory;
  assert.equal(state.tabs.length, 1); assert.equal(state.tabs[0].hostname, 'example.test');
  const result = await bridge.closeTab(state.tabs[0]);
  assert.equal(result.status, 'closed'); assert.deepEqual(h.removed, [1]);
  assert.equal(h.tabs.has(2), true, 'the personal-window tab is untouched');
  assert.equal(JSON.stringify(updates).includes('personal.test'), false);
  assert.equal(JSON.stringify(updates).includes('private'), false);
});

test('worker handles created, removed and moved tabs without treating a move as a close', async () => {
  const h = workerHarness(); await h.share();
  const added = { id: 3, windowId: 10, incognito: false, active: false, url: 'https://other.test/secret', status: 'complete' };
  h.tabs.set(3, added); h.chrome.tabs.onCreated.emit(added);
  assert.equal(h.messages.at(-1).events[0].kind, 'created');
  h.chrome.tabs.onDetached.emit(3, { oldWindowId: 10 });
  assert.equal(h.messages.at(-1).events[0].kind, 'detached');
  h.chrome.tabs.onAttached.emit(3, { newWindowId: 10 }); await settle();
  assert.equal(h.messages.at(-1).events[0].kind, 'attached');
  h.chrome.tabs.onRemoved.emit(3, { windowId: 10, isWindowClosing: false });
  assert.equal(h.messages.at(-1).events[0].kind, 'removed');
  h.worker.stop();
});

test('worker revocation while lookup is pending cannot invoke remove; protected subdomains remain denied', async () => {
  let resolve;
  const h = workerHarness({ get: () => new Promise(res => { resolve = res; }) }); await h.share();
  h.sockets[0].receive(h.command()); await settle();
  h.sockets[0].receive({ type: 'consent', observeConsent: true, closeConsent: false });
  resolve({ ...h.tabs.get(1) }); await settle(); assert.deepEqual(h.removed, []);
  assert.equal(h.worker.getState().closeConsent, false); assert.equal(h.worker.getState().observeConsent, true); h.worker.stop();
  const guarded = workerHarness(); guarded.tabs.get(1).url = 'https://eu.zoom.us/meeting'; await guarded.share();
  guarded.sockets[0].receive(guarded.command()); await settle();
  assert.equal(guarded.messages.at(-1).status, 'denied'); assert.deepEqual(guarded.removed, []); guarded.worker.stop();
});

test('worker rejects wrong-tab lookup and tabs moved to another window before closing', async () => {
  for (const change of [{ id: 9 }, { windowId: 20 }, { incognito: true }]) {
    const h = workerHarness({ get: async (id, tabs) => ({ ...tabs.get(id), ...change }) }); await h.share();
    h.sockets[0].receive(h.command()); await settle(); assert.deepEqual(h.removed, []); h.worker.stop();
  }
});

test('peer, authentication attempt, inventory and pending-command bounds fail closed', async t => {
  const h = await bridgeHarness(t);
  const first = h.server.connect(), second = h.server.connect(); assert.equal(h.server.connect(), null);
  first.terminate(); second.terminate();
  for (let i = 2; i < LIMITS.maxAttempts; i++) h.pair({ secret: 'bad' });
  assert.equal(h.server.connect(), null);
  const large = await bridgeHarness(t); const peer = large.pair();
  large.inventory(peer, Array.from({ length: LIMITS.maxTabs + 1 }, (_, index) => tab(index + 1)));
  assert.equal(large.bridge.getState().connected, false);
  const bounded = await bridgeHarness(t); const active = bounded.pair();
  bounded.inventory(active, Array.from({ length: LIMITS.maxPending + 1 }, (_, index) => tab(index + 1)));
  const targets = bounded.bridge.getState().tabs;
  const pending = targets.slice(0, LIMITS.maxPending).map(target => bounded.bridge.closeTab(target));
  assert.equal((await bounded.bridge.closeTab(targets.at(-1))).status, 'unavailable');
  bounded.bridge.stop(); assert.ok((await Promise.all(pending)).every(result => result.status === 'unavailable'));
});

test('worker rejects excess tabs, malformed messages and sharing without explicit consent', async () => {
  const h = workerHarness();
  await assert.rejects(h.worker.share({ pairingCode: h.pairingCode, windowId: 10, closeConsent: false, observeConsent: false }));
  assert.equal(h.sockets.length, 0);
  await h.share(); h.sockets[0].onmessage({ data: '{' }); assert.equal(h.worker.getState().observeConsent, false);
  const large = workerHarness();
  for (let id = 3; id < LIMITS.maxTabs + 4; id++) large.tabs.set(id, { ...large.tabs.get(1), id, active: false });
  await large.share(); assert.equal(large.worker.getState().observeConsent, false);
});

test('parent callback distinguishes waiting-for-pairing from synchronous disconnected revocation', async t => {
  const h = await bridgeHarness(t);
  assert.deepEqual(h.updates.at(-1), { tabs: [], events: [], connected: false, observeConsent: true, closeConsent: false });
  const peer = h.pair(); h.inventory(peer, [tab()]);
  h.bridge.setConsent({ observeConsent: false, closeConsent: false });
  assert.deepEqual(h.updates.at(-1), { tabs: [], events: [], connected: false, observeConsent: false, closeConsent: false });
  assert.equal(peer.readyState, 3);
});

test('service-worker startup clears stale badge without connecting and accepts messages only from its popup', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const h = workerHarness(); const badges = []; let handler;
  h.chrome.runtime.getURL = file => `chrome-extension://${EXTENSION_ID}/${file}`;
  h.chrome.runtime.onMessage = { addListener(fn) { handler = fn; } };
  h.chrome.action = { setBadgeText: async value => badges.push(value.text), setTitle: async () => {} };
  const context = vm.createContext({ chrome: h.chrome, WebSocket: class { constructor() { throw Error('Unexpected connection'); } },
    URL, atob, crypto, setTimeout, clearTimeout });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../browser-extension', file), 'utf8'), context);
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../browser-extension/service-worker.js'), 'utf8'), context);
  assert.deepEqual(badges, ['']);
  let response;
  for (const sender of [{}, { id: 'foreign', url: h.chrome.runtime.getURL('popup.html') },
    { id: EXTENSION_ID, url: 'https://example.test/' }, { id: EXTENSION_ID, url: h.chrome.runtime.getURL('popup.html'), tab: {} }]) {
    assert.equal(handler({ type: 'share' }, sender, value => { response = value; }), false);
    assert.equal(response, undefined);
  }
  const sender = { id: EXTENSION_ID, url: h.chrome.runtime.getURL('popup.html') };
  handler({ type: 'state' }, sender, value => { response = value; });
  assert.equal(response.observeConsent, false); assert.equal(response.connected, false);
  assert.equal(h.queries.length, 0);
});
