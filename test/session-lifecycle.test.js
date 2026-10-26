const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function timers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimeout: id => pending.delete(id),
    setInterval: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearInterval: id => pending.delete(id)
  };
}

const { mainHarness } = require('./helpers/main-harness');

test('explicit open policy stays unrestricted and never reconstructs default blocked tools', () => {
  const h = mainHarness();
  const policy = h.run('normalizePolicy({allowed_apps:[],allowed_sites:[],blocked_sites:[],blocking_mode:"none"})');
  assert.deepEqual([...policy.blocked_sites], []);
  const decision = h.run('evaluateForegroundPolicy({processName:"chrome",detectedHost:"chatgpt.com"}, normalizePolicy({blocked_sites:[],blocking_mode:"none"}))');
  assert.equal(decision.allowed, true);
  assert.equal(decision.unlisted, undefined);
});

test('candidate consent privacy links open only in the system browser', async () => {
  const h = mainHarness();
  h.run('createWindow()');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const urls = [...html.matchAll(/href="([^"]+)" target="_blank"/g)].map(match => match[1]);
  assert.deepEqual(urls, ['https://www.pangram.com/data-privacy', 'https://openrouter.ai/privacy']);
  for (const url of urls) assert.equal(h.openWindow({ url }).action, 'deny');
  await settle();
  assert.deepEqual(h.externalUrls, urls);
  assert.equal(h.channels.length, 0);
  assert.equal(h.run('monitoring'), false);
});

function candidateDemoHarness() {
  const { EventEmitter } = require('node:events');
  const clients = [];
  class Relay extends EventEmitter {
    constructor() { super(); this.sent = []; clients.push(this); }
    async join(data) { this.joined = data; return { code: data.code, details: { policy: {}, technicalVocabulary: ['Truveil'] } }; }
    async send(data) { this.sent.push(data); return 'ok'; }
    async token() { return { ok: true, accessToken: 'synthetic-short-lived' }; }
    async end() { this.ended = true; }
    close() { this.closed = true; }
  }
  class Bridge {
    constructor(options) { this.options = options; }
    async start() { return { pairingCode: 'test-only', extensionId: 'synthetic' }; }
    stop() { this.stopped = true; }
    setConsent() { this.stopped = true; }
    getState() { return { connected: false, tabs: [] }; }
    async closeTab() { return { status: 'closed' }; }
  }
  return { ...mainHarness({ modules: {
    './src/demo/relay-client': { DemoRelayClient: Relay, normalizeRelayUrl: url => url },
    './src/browser/tab-bridge': { TabBridge: Bridge }
  } }), clients };
}

test('demo candidate joins without Supabase and does not start monitoring until host start', async () => {
  const h = candidateDemoHarness();
  const result = await h.handlers.get('session:start')({}, { sessionCode: 'DEMO-ABCDEFGH23456789',
    candidateName: 'Demo candidate', relayUrl: 'ws://127.0.0.1:43180/demo', consentConfirmed: true, microphoneReady: true });
  assert.equal(result.ok, true);
  assert.equal(result.demo, true);
  assert.equal(h.run('monitoring'), false);
  assert.equal(h.channels.length, 0);
  assert.deepEqual(h.updates, []);
  h.clients[0].emit('event', { event: 'session_started', payload: { sessionId: result.sessionCode } });
  await settle();
  assert.equal(h.run('monitoring'), true);
  assert.equal(h.clock.pending.size, 0, 'Demo must not start foreground scans or cloud polling');
  await h.run('endSession()');
  assert.equal(h.clients[0].closed, true);
  assert.equal(h.run('monitoring'), false);
});

test('demo candidate token and exact tab commands require an active consented session', async () => {
  const h = candidateDemoHarness();
  await h.handlers.get('session:start')({}, { sessionCode: 'DEMO-ABCDEFGH23456789',
    candidateName: 'Demo', relayUrl: 'ws://127.0.0.1:43180/demo', consentConfirmed: true, microphoneReady: true,
    tabObserveConsent: false, tabCloseConsent: false });
  assert.equal((await h.handlers.get('transcription:token')({})).ok, false);
  h.clients[0].emit('event', { event: 'session_started', payload: { sessionId: 'DEMO-ABCDEFGH23456789' } });
  await settle();
  assert.equal((await h.handlers.get('transcription:token')({})).accessToken, 'synthetic-short-lived');
  h.clients[0].emit('event', { event: 'recruiter_action', payload: { sessionId: 'DEMO-ABCDEFGH23456789', action: 'close_tab', commandId: 'command', target: { id: 'tab', revision: 1 } } });
  await settle();
  assert.equal(h.clients[0].sent.find(m => m.payload.type === 'browser_tab_close_result').payload.result.status, 'denied');
  h.clients[0].emit('closed', { reason: 'offline' });
  await settle();
  assert.equal(h.run('activeSession'), null);
  assert.ok(h.events.some(([name]) => name === 'session-disconnected'));
});

test('legacy restricted-target helper never sends a global close shortcut', async () => {
  const h = mainHarness();
  assert.equal(await h.run("closeForegroundRestrictedTarget({processName:'chrome',detectedHost:'example.com'}, {matchedRule:'example.com'})"), false);
});

test('demo mode never reports legacy foreground focus changes', () => {
  const h = mainHarness();
  h.run('createWindow(); monitoring=true; activeSession={demo:true};');
  h.windowHandlers.get('blur')();
  h.windowHandlers.get('focus')();
  assert.equal(h.events.some(([name]) => name === 'focus-lost' || name === 'focus-gained'), false);
});

test('actual desktop main processes relay consent, captions, checker input and exact-tab closing locally', { timeout: 15000 }, async t => {
  const { loadMain } = require('../../TrueVeils/recruiter-app/test/helpers/main-harness');
  const { createDemoRelay } = require('../../TrueVeils/backend/demo/relay-server');
  const { TabBridge, EXTENSION_ID } = require('../src/browser/tab-bridge');
  const WebSocket = require('ws');
  const hostAccessCode = require('node:crypto').randomBytes(32).toString('base64url');
  const relay = createDemoRelay({ hostKey: hostAccessCode, tokenProvider: async () => ({ accessToken: 'synthetic-token', expiresIn: 30 }) });
  const { port } = await relay.listen(0);
  t.after(() => relay.close());
  const host = loadMain({ env: { TRUVEIL_APP_MODE: 'demo' }, user: null });
  const hostEvents = [];
  host.attachRenderer((name, payload) => hostEvents.push({ name, payload }));
  const candidate = mainHarness({ modules: {
    './src/demo/relay-client': require('../src/demo/relay-client'), './src/browser/tab-bridge': { TabBridge }
  } });
  t.after(async () => { await candidate.run('cleanupSession({failedJoin:true})'); await host.run('closeRealtimeSession()'); });
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for desktop relay state'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  await host.invoke('demo:config');
  const room = await host.invoke('demo:create', { relayUrl: `ws://127.0.0.1:${port}/demo`, hostAccessCode });
  const joining = candidate.handlers.get('session:start')({}, { sessionCode: room.sessionId, candidateName: 'Synthetic Candidate',
    relayUrl: `ws://127.0.0.1:${port}/demo`, consentConfirmed: true, microphoneReady: true,
    externalReviewConsent: false, tabObserveConsent: true, tabCloseConsent: true });
  await waitFor(() => hostEvents.some(e => e.name === 'demo:join-request'));
  assert.equal(candidate.run('monitoring'), false);
  await host.invoke('demo:approve', { requestId: hostEvents.find(e => e.name === 'demo:join-request').payload.requestId, allow: true });
  assert.equal((await joining).ok, true);
  await waitFor(() => host.inspect().sessionData.candidateReady);
  assert.equal((await host.invoke('session:start')).started, true);
  await waitFor(() => candidate.run('monitoring'));
  assert.equal((await candidate.handlers.get('transcription:token')({})).accessToken, 'synthetic-token');
  const text = 'During my last project I traced a queue failure to a missing timeout in the worker. I added a bounded retry, checked the metrics with my teammate, and verified the fix with a small test before releasing it to production.';
  const transcript = { text, interim: false, confidence: .97, confidenceKnown: true, wordCount: text.split(' ').length,
    rms: .12, peak: .3, durationMs: 14000, startedAt: Date.now() - 14000, endedAt: Date.now(),
    source: 'deepgram-nova-3-direct', revision: 1, streamEpoch: 0, segmentId: 'synthetic-span', sequence: 0 };
  assert.equal((await candidate.handlers.get('session:transcript')({}, transcript)).ok, true);
  await waitFor(() => hostEvents.some(e => e.name === 'realtime:caption' && e.payload.text === text));
  assert.ok(candidate.events.some(([name, data]) => name === 'transcript-caption' && data.text === text));
  await waitFor(() => host.inspect().sessionData.transcripts?.some(entry => entry.text === text || entry.transcript === text));

  const info = await candidate.handlers.get('browser:pair')({});
  const pairing = JSON.parse(Buffer.from(info.pairingCode.slice(5), 'base64url'));
  const socket = new WebSocket(`ws://127.0.0.1:${pairing.port}/`, { origin: `chrome-extension://${EXTENSION_ID}` });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const common = { epoch: pairing.epoch, browserInstance: 'synthetic-instance', windowId: 10 };
  socket.send(JSON.stringify({ type: 'pair', secret: pairing.secret, ...common, observeConsent: true, closeConsent: true }));
  await waitFor(() => candidate.run('tabBridge.getState().connected'));
  let sequence = 1;
  const event = { kind: 'created', tabId: 7, hostname: 'example.test', revision: 1 };
  const inventory = events => socket.send(JSON.stringify({ type: 'inventory', ...common, seq: sequence++, tabs: [{ tabId: 7, hostname: 'example.test', revision: 1, active: true }], events }));
  inventory([event]);
  await waitFor(() => hostEvents.some(e => e.name === 'browser:tabs' && e.payload.tabs.length));
  const selected = hostEvents.findLast(e => e.name === 'browser:tabs' && e.payload.tabs.length).payload.tabs[0];
  inventory([]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(host.inspect().sessionData.flags.filter(flag => flag.eventType === 'browser_tab_created').length, 1, 'event history must not repeat notifications');
  socket.on('message', bytes => {
    const command = JSON.parse(bytes);
    if (command.type !== 'close') return;
    socket.send(JSON.stringify({ type: 'inventory', ...common, seq: sequence++, tabs: [], events: [{ kind: 'removed', tabId: 7, hostname: 'example.test', revision: 1 }] }));
    socket.send(JSON.stringify({ ...command, type: 'result', status: 'closed', removed: true }));
  });
  assert.equal((await host.invoke('browser:close-tab', selected)).status, 'closed');
  await candidate.handlers.get('browser:stop')({});
  await waitFor(() => !host.run('browserTabs.connected'));
  await assert.rejects(host.invoke('browser:close-tab', selected), /shared|available/i);
  assert.equal(host.calls.some(call => call.function || call.table || call.channel), false);
  assert.equal(candidate.channels.length, 0);
});

test('candidate privacy navigation denies arbitrary URLs and retains frame protection', () => {
  const h = mainHarness();
  h.run('createWindow()');
  for (const url of [undefined, '', 'https://example.com', 'http://openrouter.ai/privacy',
    'https://openrouter.ai.evil.test/privacy', 'https://openrouter.ai@evil.test/privacy',
    'https://openrouter.ai/privacy?redirect=https://evil.test', 'https://www.pangram.com/',
    'file:///C:/secret.txt', 'javascript:alert(1)']) {
    assert.equal(h.openWindow({ url }).action, 'deny');
  }
  assert.deepEqual(h.externalUrls, []);
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false;
    h.navigationHandlers.get(name)({ preventDefault() { prevented = true; } }, 'https://openrouter.ai/privacy');
    assert.equal(prevented, true);
  }
});

test('unavailable system browser does not cause an unhandled privacy-link failure', async () => {
  const h = mainHarness({ openExternalError: true });
  h.run('createWindow()');
  assert.equal(h.openWindow({ url: 'https://openrouter.ai/privacy' }).action, 'deny');
  await settle();
  assert.equal(h.externalUrls.length, 1);
});

test('failed realtime join rolls back locally without ending the shared interview', async () => {
  const h = mainHarness({ subscribeStatus: 'CHANNEL_ERROR' });
  assert.equal((await h.join()).ok, false);
  assert.deepEqual(h.updates, []);
  assert.equal(h.removed.length, 1);
  assert.equal(h.run('activeSession'), null);
});

test('external provider consent is opt-in, versioned and withdrawn through the candidate main process', async () => {
  const h = mainHarness();
  const result = await h.handlers.get('session:start')({}, {
    sessionCode: 'TRV-ABC123', candidateName: 'Synthetic', consentConfirmed: true,
    microphoneReady: true, externalReviewConsent: true
  });
  assert.equal(result.ok, true);
  const ready = h.sent.find(message => message.payload.type === 'candidate_ready');
  assert.equal(ready.payload.externalReviewConsent.version, 'external-review-v1');
  assert.equal(ready.payload.externalReviewConsent.enabled, true);
  assert.equal((await h.handlers.get('provider-review:withdraw')({})).ok, true);
  assert.equal(h.run('activeSession.externalReviewConsent'), false);
  assert.equal(h.sent.find(message => message.payload.type === 'candidate_review_consent').payload.externalReviewConsent.enabled, false);
  await h.run('endSession()');
});

test('candidate main process never defaults external review consent to true', async () => {
  const h = mainHarness();
  await h.join();
  assert.equal(h.sent.find(message => message.payload.type === 'candidate_ready').payload.externalReviewConsent.enabled, false);
  await h.run('endSession()');
});

test('joining an already-active interview never downgrades it to candidate_ready', async () => {
  const h = mainHarness({ sessionStatus: 'active' });
  const result = await h.join();
  assert.equal(result.ok, true);
  assert.equal(result.waitingForInterviewer, false);
  assert.equal(h.updates.some(update => update.status === 'candidate_ready'), false);
});

test('persisted active status starts monitoring even when the start broadcast was missed', async () => {
  const h = mainHarness();
  await h.join();
  await h.channels[0].callbacks.get('UPDATE')({ new: { status: 'active' } });
  assert.equal(h.run('monitoring'), true);
  assert.equal(h.events.filter(([event]) => event === 'session-started').length, 1);
});

test('realtime disconnect after subscription stops the local session and informs the renderer', async () => {
  const h = mainHarness({ sessionStatus: 'active' });
  await h.join();
  h.channels[0].status('CHANNEL_ERROR');
  await settle();
  assert.equal(h.run('monitoring'), false);
  assert.equal(h.run('activeSession'), null);
  assert.ok(h.events.some(([event]) => event === 'session-disconnected'));
});

test('remote end clears local state and notifies renderer before waiting on realtime', async () => {
  const sending = deferred();
  const h = mainHarness({ send: data => data.payload.type === 'session_ended_remote' ? sending.promise : 'ok' });
  await h.join();
  const ending = h.run('endSession({ remote: true })');
  assert.equal(h.run('activeSession'), null);
  assert.ok(h.events.some(([event]) => event === 'remote-session-ended'));
  sending.resolve('ok');
  await ending;
});

test('an in-flight foreground scan cannot act on a session after it ends', async () => {
  const h = mainHarness({ sessionStatus: 'active' });
  await h.join();
  const scan = [...h.clock.pending.values()].find(timer => timer.ms === 1000).fn();
  await h.run('endSession({ remote: true })');
  h.foreground.resolve({ processName: 'chrome', title: 'Restricted', detectedHost: 'chatgpt.com' });
  await scan;
  assert.equal(h.events.some(([event]) => event === 'blocking-warning'), false);
});

test('failed transcript delivery is reported and does not poison duplicate detection', async () => {
  let sendResult = 'timed out';
  const h = mainHarness({ send: data => data.event === 'candidate_transcript' ? sendResult : 'ok' });
  await h.join();
  const data = { text: 'I rolled the deployment back and replayed the failed jobs.', transcriptConfidence: 0.9, rms: 0.03, peak: 0.2 };
  const send = () => h.handlers.get('session:transcript')({}, data);
  assert.equal((await send()).ok, false);
  sendResult = 'ok';
  const retry = await send();
  assert.equal(retry.ok, true);
  assert.equal(retry.skipped, undefined);
});

test('duplicate end requests perform one status update and one channel removal', async () => {
  const sending = deferred();
  const h = mainHarness({ send: data => data.payload.type === 'candidate_interrupted' ? sending.promise : 'ok' });
  await h.join();
  const first = h.run('endSession()');
  const second = h.run('endSession()');
  sending.resolve('ok');
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(h.updates.filter(update => update.status === 'interrupted').length, 1);
  assert.equal(h.removed.length, 1);
});

test('failed end persistence still removes the channel and reports failure', async () => {
  const h = mainHarness({ update: data => data.status === 'interrupted' ? { error: { message: 'offline' } } : {} });
  await h.join();
  const result = await h.run('endSession()');
  assert.equal(result.ok, false);
  assert.equal(h.run('activeSession'), null);
  assert.equal(h.removed.length, 1);
});

test('a second join cannot replace an active session', async () => {
  const h = mainHarness();
  await h.join();
  assert.equal((await h.join()).ok, false);
  assert.equal(h.channels.length, 1);
  assert.equal(h.removed.length, 0);
});

test('an old channel cannot start or end a later session', async () => {
  const h = mainHarness();
  await h.join();
  const old = h.channels[0];
  await h.run('endSession({ remote: true })');
  await h.join();
  await old.callbacks.get('session_started')();
  await old.callbacks.get('session_ended')();
  assert.equal(h.run('monitoring'), false);
  assert.notEqual(h.run('activeSession'), null);
});

test('late secure audio transcription cannot be published into a later session', async () => {
  const response = deferred();
  const h = mainHarness({
    session: { sessionToken: 'test-token' },
    fetch: url => url.endsWith('/transcribe-chunk') ? response.promise : Promise.resolve({ ok: true })
  });
  await h.join();
  const upload = h.handlers.get('audio:chunk')({}, { arrayBuffer: Buffer.alloc(256), rms: 0.03, peak: 0.2 });
  await h.run('endSession({ remote: true })');
  await h.join();
  response.resolve({ ok: true, json: async () => ({ text: 'This answer belongs only to the previous interview.', confidence: 0.9 }) });
  assert.equal((await upload).ok, false);
  assert.equal(h.sent.some(data => data.event === 'candidate_transcript'), false);
});

test('duplicate transcript cache is scoped to one session', async () => {
  const h = mainHarness();
  await h.join();
  const data = { text: 'I rolled the deployment back and replayed the failed jobs.', transcriptConfidence: 0.9, rms: 0.03, peak: 0.2 };
  assert.equal((await h.handlers.get('session:transcript')({}, data)).ok, true);
  await h.run('endSession({ remote: true })');
  await h.join();
  assert.equal((await h.handlers.get('session:transcript')({}, data)).skipped, undefined);
});

test('main rejects joins without explicit consent and microphone preflight', async () => {
  const h = mainHarness();
  const result = await h.handlers.get('session:start')({}, { sessionCode: 'TRV-ABC123', candidateName: 'Test Candidate' });
  assert.equal(result.ok, false);
  assert.equal(h.channels.length, 0);
  assert.equal(h.sent.length, 0);
});

test('failed readiness delivery rolls back locally without claiming a ready session', async () => {
  const h = mainHarness({ send: data => data.payload.type === 'candidate_ready' ? 'timed out' : 'ok' });
  assert.equal((await h.join()).ok, false);
  assert.equal(h.run('activeSession'), null);
  assert.equal(h.updates.some(data => data.status === 'interrupted'), false);
  assert.equal(h.removed.length, 1);
});

test('main secure join, subscription, readiness and departure use real functions with synthetic IO', async () => {
  const requests = [];
  const h = mainHarness({
    realValidation: true, deferSubscribe: true,
    fetch: async (url, request) => {
      requests.push({ url, request });
      if (url.endsWith('/candidate-join')) {
        assert.equal(request.headers.authorization, 'Bearer test-auth-token');
        return { ok: true, json: async () => ({ session: { status: 'candidate_ready', internal_id: 'internal-test' }, sessionToken: 'test-session-token' }) };
      }
      assert.ok(url.endsWith('/candidate-state'));
      assert.equal(request.headers['x-session-token'], 'test-session-token');
      return { ok: true };
    }
  });
  const joining = h.join();
  await settle();
  assert.equal(h.sent.length, 0, 'no readiness before subscription');
  h.channels[0].status('SUBSCRIBED');
  assert.equal((await joining).ok, true);
  assert.equal(h.sent.filter(data => data.payload.type === 'candidate_ready').length, 1);
  await h.handlers.get('session:end')();
  assert.deepEqual(requests.filter(({ url }) => url.endsWith('/candidate-state')).map(({ request }) => JSON.parse(request.body).status), ['candidate_ready', 'interrupted']);
  assert.equal(h.removed.length, 1);
});

for (const status of ['completed', 'cancelled', 'interrupted']) {
  test(`persisted ${status} prevents join and terminates an existing session on polling`, async () => {
    const rejected = mainHarness({ sessionStatus: status });
    assert.equal((await rejected.join()).ok, false);
    assert.equal(rejected.channels.length, 0);

    let persisted = 'waiting';
    const h = mainHarness({ statusRead: async () => ({ data: { status: persisted } }) });
    await h.join();
    persisted = status;
    await h.run('refreshSessionStatus(activeSession)');
    assert.equal(h.run('activeSession'), null);
    assert.ok(h.events.some(([event]) => event === 'remote-session-ended'));
    assert.equal([...h.clock.pending.values()].some(timer => timer.ms === 3000), false);
  });
}

test('cancelled realtime status ends immediately even without an end broadcast', async () => {
  const h = mainHarness();
  await h.join();
  await h.channels[0].callbacks.get('UPDATE')({ new: { status: 'cancelled' } });
  assert.equal(h.run('activeSession'), null);
});

test('readiness is reannounced on resubscribe or recruiter rejoin only while locally ready', async () => {
  const h = mainHarness();
  await h.join();
  const channel = h.channels[0];
  const count = () => h.sent.filter(data => data.payload.type === 'candidate_ready').length;
  channel.status('SUBSCRIBED');
  await channel.callbacks.get('join')({ key: 'recruiter', newPresences: [{ role: 'recruiter' }] });
  assert.equal(count(), 3);
  await h.run('endSession({ remote: true })');
  channel.status('SUBSCRIBED');
  await channel.callbacks.get('join')({ key: 'recruiter', newPresences: [{ role: 'recruiter' }] });
  assert.equal(count(), 3);
});

test('persisted candidate_ready cannot reannounce readiness before local join completes', async () => {
  const status = deferred();
  const h = mainHarness({ sessionStatus: 'candidate_ready', statusRead: () => status.promise });
  const joining = h.join();
  await settle();
  const channel = h.channels[0];
  channel.status('SUBSCRIBED');
  await channel.callbacks.get('join')({ key: 'recruiter', newPresences: [{ role: 'recruiter' }] });
  assert.equal(h.sent.length, 0);
  status.resolve({ data: { status: 'candidate_ready' } });
  assert.equal((await joining).ok, true);
  assert.equal(h.sent.filter(data => data.payload.type === 'candidate_ready').length, 1);
});

function element() {
  const classes = new Set();
  return {
    value: '', checked: true, disabled: false, textContent: '', children: [], style: { setProperty() {} },
    listeners: {},
    classList: { add: x => classes.add(x), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    setAttribute() {}, toggleAttribute() {}, focus() {}, querySelector: () => null,
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }, prepend() {}
  };
}

function rendererHarness(options = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('sessionCodeInput').value = 'TRV-ABC123';
  get('candidateNameInput').value = 'Test Candidate';
  const events = {};
  const clock = timers();
  let now = options.now;
  clock.advance = ms => { now += ms; };
  const RendererDate = now === undefined ? Date : class extends Date { static now() { return now; } };
  const sockets = [];
  let stopped = 0;
  let micRequests = 0;
  let joinRequests = 0;
  const track = { readyState: 'live', stop: () => stopped++, addEventListener: (name, fn) => events[`track:${name}`] = fn };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const bridge = {
    startSession: async data => {
      assert.equal(data.consentConfirmed, true);
      assert.equal(data.microphoneReady, true);
      joinRequests++;
      return options.join ? options.join(data) : { ok: true, waitingForInterviewer: true };
    },
    endSession: () => options.end ? options.end() : Promise.resolve({ ok: true }),
    getTranscriptionToken: () => options.token ? options.token() : Promise.resolve({ ok: false }),
    sendTranscript: async () => ({ ok: true }), sendAudioLevel: async () => ({ ok: true }), quit() {}
  };
  for (const name of ['FocusLost', 'FocusGained', 'ShortcutBlocked', 'BlockingWarning', 'SessionPolicyUpdated', 'RemoteSessionEnded', 'SessionStarted', 'SessionDisconnected', 'InviteCode']) {
    bridge[`on${name}`] = fn => { events[name] = fn; };
  }
  class Socket {
    static OPEN = 1;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    console, URL, URLSearchParams, TextEncoder, Uint8Array, Date: RendererDate, ...clock, WebSocket: Socket,
    window: { truveil: bridge },
    navigator: { mediaDevices: {
      getUserMedia: async constraints => { micRequests++; return options.mic ? options.mic(constraints) : stream; },
      enumerateDevices: options.devices || (async () => [])
    } },
    document: { getElementById: get, createElement: element },
    confirm: () => true
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(root, 'src/session/presentation.js'), 'utf8'));
  run(fs.readFileSync(path.join(root, 'src/renderer/session.js'), 'utf8'));
  // This counter replaces capture startup, never a real microphone or AudioContext.
  run('var streamingStarts = 0; startTranscriptStreaming = () => streamingStarts++;');
  return { run, get, events, clock, sockets, stopped: () => stopped, micRequests: () => micRequests, joinRequests: () => joinRequests };
}

test('neutral long codes retain optional browser consent and use the account-free join path', async () => {
  let sent;
  const h = rendererHarness({ join: async data => { sent = data; return { ok: true, demo: true, directSpeechOnly: true, waitingForInterviewer: true }; } });
  const input = h.get('sessionCodeInput');
  input.value = 'TRV-ABCDEFGHIJ234567';
  input.listeners.input({ target: input });
  assert.equal(h.get('browserConsentOptions').hidden, false);
  assert.equal(h.get('activityNoticeTitle').textContent, 'Optional browser sharing');
  h.get('demoRelayInput').value = 'ws://127.0.0.1:43180';
  h.get('tabObserveConsentInput').checked = true;
  await h.run('startSession()');
  assert.equal(sent.sessionCode, 'TRV-ABCDEFGHIJ234567');
  assert.equal(sent.tabObserveConsent, true);
  assert.equal(h.run('streamingStarts'), 0);
  assert.equal(h.get('pairBrowserBtn').disabled, true);
});

test('old room codes display neutral aliases without changing any room-code bits', () => {
  const h = rendererHarness();
  const input = h.get('sessionCodeInput');
  input.value = 'DEMO-ABCDEFGHIJ234567';
  input.listeners.input({ target: input });
  assert.equal(input.value, 'TRV-ABCDEFGHIJ234567');
  assert.equal(h.get('browserConsentOptions').hidden, false);
});

test('consent and microphone preflight must pass before joining', async () => {
  const h = rendererHarness({ mic: () => Promise.reject(new Error('permission denied')) });
  h.get('sessionConsentInput').checked = false;
  await h.run('startSession()');
  assert.equal(h.micRequests(), 0);
  h.get('sessionConsentInput').checked = true;
  await h.run('startSession()');
  assert.equal(h.joinRequests(), 0);
  assert.equal(h.get('startBtn').disabled, false);
});

test('candidate capture requests microphone audio only with echo cancellation and no system audio', async () => {
  let constraints;
  const h = rendererHarness({ mic: value => { constraints = value; throw new Error('synthetic permission denial'); } });
  h.get('microphoneInput').value = 'candidate-headset';
  await h.run('startSession()');
  assert.deepEqual(JSON.parse(JSON.stringify(constraints)), { video: false, audio: {
    deviceId: { exact: 'candidate-headset' }, echoCancellation: true, noiseSuppression: true,
    autoGainControl: true, channelCount: { ideal: 1 }
  } });
  assert.equal(h.joinRequests(), 0);
  assert.equal(h.get('microphoneInput').disabled, false);
});

test('default microphone requests processed audio without silently selecting a different device', async () => {
  let constraints;
  const h = rendererHarness({ mic: value => { constraints = value; throw new Error('synthetic permission denial'); } });
  await h.run('startSession()');
  assert.equal(constraints.video, false);
  assert.equal(constraints.audio.deviceId, undefined);
  assert.equal(constraints.audio.echoCancellation, true);
});

test('microphone list refresh never captures audio and preserves the selected source', async () => {
  const h = rendererHarness({ devices: async () => [
    { kind: 'audioinput', deviceId: 'headset', label: 'Candidate headset' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera' }
  ] });
  h.get('microphoneInput').value = 'headset';
  await h.run('refreshMicrophones()');
  assert.equal(h.micRequests(), 0);
  assert.equal(h.get('microphoneInput').value, 'headset');
  assert.deepEqual(h.get('microphoneInput').children.map(item => item.textContent), ['System default microphone', 'Candidate headset']);
});

test('late microphone enumeration cannot change an active joining source', async () => {
  const devices = deferred();
  const h = rendererHarness({ devices: () => devices.promise });
  h.get('microphoneInput').value = 'headset';
  const pending = h.run('refreshMicrophones()');
  h.run('joiningSession = true');
  devices.resolve([{ kind: 'audioinput', deviceId: 'other', label: 'Other input' }]);
  await pending;
  assert.equal(h.get('microphoneInput').value, 'headset');
  assert.equal(h.micRequests(), 0);
});

test('unplugged selected microphones never silently fall back to a different source', async () => {
  const h = rendererHarness({ devices: async () => [] });
  h.get('microphoneInput').value = 'unplugged-headset';
  await h.run('refreshMicrophones()');
  assert.equal(h.get('microphoneInput').value, 'unplugged-headset');
  assert.match(h.get('microphoneInput').children.at(-1).textContent, /unavailable/i);
  assert.equal(h.micRequests(), 0);
});

test('late enumeration failure cannot overwrite active interview guidance', async () => {
  const devices = deferred();
  const h = rendererHarness({ devices: () => devices.promise });
  const pending = h.run('refreshMicrophones()');
  h.run('activeConnection = {demo:true}');
  h.get('toast').textContent = 'Active session';
  devices.reject(new Error('synthetic list failure'));
  await pending;
  assert.equal(h.get('toast').textContent, 'Active session');
  assert.equal(h.micRequests(), 0);
});

test('demo renderer rejects insecure remote relays before microphone preflight', async () => {
  const h = rendererHarness();
  h.get('sessionCodeInput').value = 'DEMO-ABCDEFGH23456789';
  h.get('demoRelayInput').value = 'ws://untrusted.example/demo';
  await h.run('startSession()');
  assert.equal(h.micRequests(), 0);
  assert.match(h.get('toast').textContent, /secure.*server/i);
});

test('demo renderer passes explicit tab consent and waits for approval without starting speech', async () => {
  let sent;
  const h = rendererHarness({ join: async data => { sent = data; return { ok: true, demo: true, directSpeechOnly: true, waitingForInterviewer: true }; } });
  h.get('sessionCodeInput').value = 'DEMO-ABCDEFGH23456789';
  h.get('demoRelayInput').value = 'ws://127.0.0.1:43180/demo';
  h.get('tabObserveConsentInput').checked = false;
  h.get('tabCloseConsentInput').checked = true;
  await h.run('startSession()');
  assert.equal(sent.relayUrl, 'ws://127.0.0.1:43180/demo');
  assert.equal(sent.tabObserveConsent, false);
  assert.equal(sent.tabCloseConsent, false);
  assert.equal(h.run('streamingStarts'), 0);
  assert.equal(h.get('pairBrowserBtn').disabled, true);
});

test('demo speech failure never starts backup uploads and provides an explicit retry', () => {
  const h = rendererHarness();
  h.run('activeConnection = {demo:true,directSpeechOnly:true}; startAudioFallback("unavailable");');
  assert.equal(h.run('audioFallbackActive'), false);
  assert.match(h.get('audioState').textContent, /unavailable/i);
  assert.equal(h.get('retrySpeechBtn').hidden, false);
});

for (const id of ['sessionConsentInput','externalReviewConsentInput','tabObserveConsentInput','tabCloseConsentInput']) {
  test(`withdrawing ${id} during approval cancels capture and prevents a late join`, async () => {
    const approval = deferred();
    const h = rendererHarness({join:()=>approval.promise});
    h.get('sessionCodeInput').value='DEMO-ABCDEFGH23456789';
    h.get('demoRelayInput').value='ws://127.0.0.1:43180/demo';
    const joining=h.run('startSession()');
    await settle();
    h.get(id).checked=false;
    await h.get(id).listeners.change?.();
    assert.equal(h.stopped(),1);
    approval.resolve({ok:true,demo:true,waitingForInterviewer:false});
    await joining;
    assert.equal(h.run('streamingStarts'),0);
    assert.equal(h.run('activeConnection'),null);
  });
}

test('rejected join IPC releases preflight microphone and restores retry controls', async () => {
  const h = rendererHarness({ join: () => Promise.reject(new Error('IPC unavailable')) });
  await h.run('startSession()');
  assert.equal(h.stopped(), 1);
  assert.equal(h.get('startBtn').disabled, false);
  assert.equal(h.get('statusText').textContent, 'Not started');
});

test('remote end during join wins over the late successful join response', async () => {
  const joining = deferred();
  const h = rendererHarness({ join: () => joining.promise });
  const start = h.run('startSession()');
  await settle();
  h.events.RemoteSessionEnded();
  joining.resolve({ ok: true, waitingForInterviewer: false });
  await start;
  assert.equal(h.run('sessionEnding'), true);
  assert.equal(h.get('ended-screen').classList.contains('active'), true);
  assert.equal(h.run('streamingStarts'), 0);
});

test('start event received during join is delivered once after the response', async () => {
  const joining = deferred();
  const h = rendererHarness({ join: () => joining.promise });
  const start = h.run('startSession()');
  await settle();
  h.events.SessionStarted();
  joining.resolve({ ok: true, waitingForInterviewer: true });
  await start;
  h.events.SessionStarted();
  assert.equal(h.run('streamingStarts'), 1);
});

test('local end releases microphone immediately even while the end IPC is pending', async () => {
  const ending = deferred();
  const h = rendererHarness({ end: () => ending.promise });
  await h.run('startSession()');
  const end = h.get('endBtn').listeners.click();
  assert.equal(h.stopped(), 1);
  ending.resolve({ ok: true });
  await end;
});

test('local end IPC rejection keeps capture stopped and exposes the notification failure', async () => {
  const h = rendererHarness({ end: () => Promise.reject(new Error('offline')) });
  await h.run('startSession()');
  await h.get('endBtn').listeners.click();
  assert.equal(h.stopped(), 1);
  assert.equal(h.get('statusText').textContent, 'Stopped locally');
});

test('microphone permission resolving after session end releases the late stream without joining', async () => {
  const permission = deferred();
  let stopped = 0;
  const h = rendererHarness({ mic: () => permission.promise });
  const start = h.run('startSession()');
  await h.run('finishSession()');
  const track = { readyState: 'live', addEventListener() {}, stop: () => stopped++ };
  permission.resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
  await start;
  assert.equal(stopped, 1);
  assert.equal(h.joinRequests(), 0);
});

test('token response arriving after end cannot open a transcription socket', async () => {
  const token = deferred();
  const h = rendererHarness({ token: () => token.promise });
  await h.run('startSession()');
  const starting = h.run('startLiveTranscription()');
  await h.run('finishSession()');
  token.resolve({ ok: true, accessToken: 'test-token' });
  await starting;
  assert.equal(h.sockets.length, 0);
});

test('disconnect event releases microphone and does not report successful completion', async () => {
  const h = rendererHarness();
  await h.run('startSession()');
  assert.equal(typeof h.events.SessionDisconnected, 'function');
  await h.events.SessionDisconnected();
  assert.equal(h.stopped(), 1);
  assert.equal(h.get('statusText').textContent, 'Disconnected');
});

test('temporary transcription credentials use the bearer WebSocket protocol', async () => {
  const h = rendererHarness({ token: async () => ({ ok: true, accessToken: 'temporary-test-jwt' }) });
  await h.run('startSession()');
  await h.run('startLiveTranscription()');
  assert.deepEqual(Array.from(h.sockets[0].protocols), ['bearer', 'temporary-test-jwt']);
  assert.equal(new URL(h.sockets[0].url).searchParams.get('mip_opt_out'), 'true');
  assert.deepEqual(new URL(h.sockets[0].url).searchParams.getAll('keyterm'), ['Truveil']);
  await h.run('finishSession()');
});

test('live recognition hints retain names without duplicating or coercing malformed vocabulary', async () => {
  const h = rendererHarness({
    token: async () => ({ ok: true, accessToken: 'temporary-test-jwt' }),
    join: async () => ({ ok: true, waitingForInterviewer: true,
      technicalVocabulary: [' TRUVEIL ', 'Asha Mehta', 'PostgreSQL', 'postgresql', null, {}, 42, '', 'x'.repeat(81)] })
  });
  await h.run('startSession()');
  await h.run('startLiveTranscription()');
  assert.deepEqual(new URL(h.sockets[0].url).searchParams.getAll('keyterm'), ['Truveil', 'Asha Mehta', 'PostgreSQL']);
  assert.equal(h.micRequests(), 1, 'only the existing mocked preflight, no additional capture');
  await h.run('finishSession()');
});

test('live recognition vocabulary stays bounded even for large multilingual input', async () => {
  const h = rendererHarness({ token: async () => ({ ok: true, accessToken: 'temporary-test-jwt' }) });
  await h.run('startSession()');
  h.run("activeConnection.technicalVocabulary = Array.from({ length: 100 }, (_, i) => '\\u65e5'.repeat(60) + i)");
  await h.run('startLiveTranscription()');
  const terms = new URL(h.sockets[0].url).searchParams.getAll('keyterm');
  assert.equal(terms[0], 'Truveil');
  assert.ok(terms.length <= 30);
  assert.ok(terms.reduce((n, term) => n + Buffer.byteLength(term, 'utf8') + 1, 0) <= 320);
  await h.run('finishSession()');
});

test('malformed live vocabulary cannot break startup or change provider options', async () => {
  for (const vocabulary of [null, 'Truveil', {}, ['C++', 'A&B?model=other', '\u0000bad']]) {
    const h = rendererHarness({
      token: async () => ({ ok: true, accessToken: 'temporary-test-jwt' }),
      join: async () => ({ ok: true, waitingForInterviewer: true, technicalVocabulary: vocabulary })
    });
    await h.run('startSession()');
    await h.run('startLiveTranscription()');
    const params = new URL(h.sockets[0].url).searchParams;
    assert.deepEqual(params.getAll('model'), ['nova-3']);
    assert.deepEqual(params.getAll('keyterm'), Array.isArray(vocabulary) ? ['Truveil', 'C++', 'A&B?model=other'] : ['Truveil']);
    await h.run('finishSession()');
  }
});

test('ending clears transcription reconnect timers and detaches old socket callbacks', async () => {
  const h = rendererHarness({ now: 100000, token: async () => ({ ok: true, accessToken: 'test-token' }) });
  await h.run('startSession()');
  await h.run('startLiveTranscription()');
  const socket = h.sockets[0];
  socket.onclose();
  const reconnect = h.run('liveReconnectTimer');
  assert.ok(h.clock.pending.get(reconnect).ms >= 10250);
  await h.run('finishSession()');
  assert.equal(h.clock.pending.has(reconnect), false);
  assert.equal(socket.onopen, null);
  assert.equal(socket.onmessage, null);
});

function speechRecoveryHarness(options = {}) {
  const requests = [];
  let h;
  h = rendererHarness({ now: 100000, ...options, token: () => {
    const at = h.run('Date.now()');
    if (options.enforceBudget !== false) {
      if (requests.length) assert.ok(at - requests.at(-1) >= 10250, 'fresh grants respect relay cooldown');
      assert.ok(requests.filter(time => at - time < 60000).length < 3, 'no fourth grant inside a relay window');
    }
    requests.push(at);
    return options.token ? options.token() : Promise.resolve({ ok: true, accessToken: `synthetic-${requests.length}` });
  } });
  h.run('activeConnection={demo:true,directSpeechOnly:true,technicalVocabulary:[]}; interviewStarted=true;');
  h.requests = requests;
  h.open = () => { const socket = h.sockets.at(-1); socket.readyState = 1; socket.onopen(); return socket; };
  h.retry = async () => {
    const id = h.run('liveReconnectTimer');
    const timer = h.clock.pending.get(id);
    assert.ok(timer, 'a bounded recovery is scheduled');
    h.clock.pending.delete(id);
    h.clock.advance(timer.ms);
    await timer.fn();
    await settle();
  };
  return h;
}

test('speech recovery R1 waits for fresh-grant cooldown and rolling budget without reusing credentials', async () => {
  const h = speechRecoveryHarness();
  await h.run('startLiveTranscription()');
  for (let i = 0; i < 3; i++) {
    h.sockets.at(-1).onclose({ code: 1006 });
    await h.run('startLiveTranscription()');
    assert.equal(h.requests.length, i + 1, 'manual calls cannot bypass a scheduled cooldown');
    assert.match(h.get('audioState').textContent, /unavailable.*retry/i);
    assert.doesNotMatch(h.get('uploadStatus').textContent, /relay active|demo/i);
    await h.retry();
  }
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests[3] - h.requests[0] >= 60250);
  assert.equal(new Set(h.sockets.map(socket => socket.protocols[1])).size, 4);
  assert.equal(h.micRequests(), 0);
});

test('speech recovery R2 pending manual retry is single-flight and has fresh watchdog grace', async () => {
  const token = deferred();
  const h = speechRecoveryHarness({ token: () => token.promise });
  h.run('sessionStart=Date.now()-20000; lastSpeechLevelAt=Date.now(); startTranscriptWatchdog(); startAudioFallback("initial failure");');
  h.get('retrySpeechBtn').listeners.click();
  h.get('retrySpeechBtn').listeners.click();
  await h.run('startLiveTranscription()');
  assert.equal(h.requests.length, 1);
  h.clock.advance(1000);
  [...h.clock.pending.values()].find(timer => timer.ms === 5000).fn();
  token.resolve({ ok: true, accessToken: 'synthetic-late' });
  await settle();
  assert.equal(h.sockets.length, 1, 'watchdog cannot invalidate the new grant');
  h.open();
  h.clock.advance(8000);
  h.run('lastSpeechLevelAt=Date.now()');
  [...h.clock.pending.values()].find(timer => timer.ms === 5000).fn();
  assert.equal(h.run('demoSpeechUnavailable'), false, 'new socket has recognition grace');
  h.clock.advance(2000);
  [...h.clock.pending.values()].find(timer => timer.ms === 5000).fn();
  assert.equal(h.run('demoSpeechUnavailable'), true, 'genuinely stalled speech remains visible');
});

test('speech recovery R3 provider errors and close codes are safe, visible, and schedule only one retry', async () => {
  const h = speechRecoveryHarness();
  await h.run('startLiveTranscription()');
  const socket = h.open();
  const closed = socket.onclose;
  socket.onmessage({ data: JSON.stringify({ type: 'Error', code: 'private-token', description: 'private-token' }) });
  assert.equal(h.run('demoSpeechUnavailable'), true);
  assert.match(h.get('audioState').textContent, /unavailable.*speech service/i);
  assert.doesNotMatch(h.get('audioState').textContent + h.get('uploadStatus').textContent, /private-token|demo/i);
  const retry = h.run('liveReconnectTimer');
  closed({ code: 1006, reason: 'private-token' });
  assert.equal(h.run('liveReconnectTimer'), retry);
  await h.retry();
  h.sockets.at(-1).onclose({ code: 1006, reason: 'private-token' });
  assert.match(h.get('audioState').textContent, /1006/);
  assert.doesNotMatch(h.get('audioState').textContent, /private-token/);
  await h.retry();
  h.sockets.at(-1).onclose({ code: 'private-token', reason: 'private-token' });
  assert.doesNotMatch(h.get('audioState').textContent, /private-token/);
});

test('speech recovery R4 open-close cycles exhaust retries until useful recognition resets the bound', async () => {
  const h = speechRecoveryHarness({ enforceBudget: false });
  await h.run('startLiveTranscription()');
  for (let i = 0; i < 6; i++) {
    const socket = h.open();
    socket.onmessage({ data: JSON.stringify({ type: 'SpeechStarted' }) });
    socket.onmessage({ data: JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: '' }] } }) });
    socket.onclose({ code: 1006 });
    if (i < 5) await h.retry();
  }
  assert.equal(h.requests.length, 6);
  assert.equal(h.run('liveReconnectTimer'), null);
  assert.equal(h.run('demoSpeechUnavailable'), true);
  assert.equal(h.get('retrySpeechBtn').disabled, false);
  assert.match(h.get('audioState').textContent, /unavailable/);
  assert.doesNotMatch(h.get('audioState').textContent, /retrying in/i);
  h.get('retrySpeechBtn').listeners.click();
  await h.retry();
  const socket = h.open();
  h.run('liveReconnectAttempts=4');
  socket.onmessage({ data: JSON.stringify({ type: 'Results', is_final: false, start: 0, duration: 1,
    channel: { alternatives: [{ transcript: 'A useful recognized phrase' }] } }) });
  assert.equal(h.run('liveReconnectAttempts'), 0);
});

test('speech recovery pending grants and scheduled callbacks cannot restart after capture stops', async () => {
  const token = deferred();
  const h = speechRecoveryHarness({ token: () => token.promise });
  const starting = h.run('startLiveTranscription()');
  await h.run('finishSession()');
  token.resolve({ ok: true, accessToken: 'synthetic-late' });
  await starting;
  assert.equal(h.sockets.length, 0);
  assert.equal(h.run('liveReconnectTimer'), null);

  const scheduled = speechRecoveryHarness();
  await scheduled.run('startLiveTranscription()');
  scheduled.sockets[0].onclose({ code: 1006 });
  const id = scheduled.run('liveReconnectTimer');
  const callback = scheduled.clock.pending.get(id).fn;
  await scheduled.run('finishSession()');
  assert.equal(scheduled.clock.pending.has(id), false);
  await callback();
  assert.equal(scheduled.requests.length, 1);
});

test('speech recovery only new recognition resets retries, not duplicate finals or obsolete drafts', async () => {
  const h = speechRecoveryHarness();
  await h.run('startLiveTranscription()');
  const socket = h.open();
  const result = providerFinal('A confirmed phrase.', 0, 1);
  socket.onmessage({ data: JSON.stringify(result) });
  h.run('liveReconnectAttempts=4');
  socket.onmessage({ data: JSON.stringify(result) });
  assert.equal(h.run('liveReconnectAttempts'), 4);
  socket.onmessage({ data: JSON.stringify({ ...result, is_final: false }) });
  assert.equal(h.run('liveReconnectAttempts'), 4);
  socket.onmessage({ data: JSON.stringify({ ...result, start: 1 }) });
  assert.equal(h.run('liveReconnectAttempts'), 0);
});

test('speech recovery stalled authorization becomes visible without overlapping the unresolved request', async () => {
  const token = deferred();
  const h = speechRecoveryHarness({ token: () => token.promise });
  const starting = h.run('startLiveTranscription()');
  const timeout = [...h.clock.pending.values()].find(timer => timer.ms === 12000);
  assert.ok(timeout, 'authorization must not remain connecting indefinitely');
  h.clock.advance(12000);
  timeout.fn();
  assert.match(h.get('audioState').textContent, /unavailable.*authorization.*timed out/i);
  h.get('retrySpeechBtn').listeners.click();
  assert.equal(h.requests.length, 1);
  token.resolve({ ok: true, accessToken: 'synthetic-late' });
  await starting;
  assert.equal(h.sockets.length, 0);
  assert.equal(h.get('retrySpeechBtn').disabled, false);
});

test('speech recovery reconnects an unopened socket and stops safely on PCM startup failure', async () => {
  const h = speechRecoveryHarness();
  await h.run('startLiveTranscription()');
  const first = h.sockets[0];
  const timeout = [...h.clock.pending.values()].find(timer => timer.ms === 12000);
  h.clock.advance(12000);
  timeout.fn();
  assert.equal(first.closed, true);
  assert.match(h.get('audioState').textContent, /unavailable.*connection timed out/i);
  await h.retry();
  h.run('var backupUploads=0; window.MediaRecorder=class {}; window.truveil.uploadAudioChunk=async()=>backupUploads++; startPcmStream=async()=>{throw new Error("private failure");};');
  h.open();
  await settle();
  assert.equal(h.run('liveReconnectTimer'), null);
  assert.equal(h.run('audioFallbackActive'), false);
  assert.equal(h.run('backupUploads'), 0);
  assert.match(h.get('audioState').textContent, /unavailable.*microphone streaming/i);
  assert.doesNotMatch(h.get('audioState').textContent, /private failure|demo/i);
});

test('speech recovery retries transient grant failure conservatively and leaves exhausted budget terminal', async () => {
  let attempts = 0;
  const h = speechRecoveryHarness({ token: async () => ++attempts === 1
    ? { ok: false, error: 'Temporary token request throttled.' }
    : { ok: false, error: 'Relay lifetime token budget exhausted.' } });
  await h.run('startLiveTranscription()');
  assert.equal(h.sockets.length, 0);
  assert.ok(h.clock.pending.get(h.run('liveReconnectTimer')).ms >= 60250);
  await h.retry();
  assert.equal(h.run('liveReconnectTimer'), null);
  assert.match(h.get('audioState').textContent, /unavailable.*limit reached/i);
  assert.equal(h.get('retrySpeechBtn').disabled, false);
});

test('speech recovery anchors cooldown after a delayed grant response and ignores retired keepalives', async () => {
  const token = deferred();
  let calls = 0;
  const h = speechRecoveryHarness({ token: () => ++calls === 1 ? token.promise
    : Promise.resolve({ ok: true, accessToken: 'synthetic-next' }) });
  const starting = h.run('startLiveTranscription()');
  h.clock.advance(8000);
  token.resolve({ ok: true, accessToken: 'synthetic-first' });
  await starting;
  const first = h.open();
  let retiredSends = 0, currentSends = 0;
  first.send = () => retiredSends++;
  const retiredKeepalive = [...h.clock.pending.values()].find(timer => timer.ms === 4000).fn;
  first.onclose({ code: 1006 });
  assert.ok(h.clock.pending.get(h.run('liveReconnectTimer')).ms >= 10250);
  await h.retry();
  const current = h.open();
  current.send = () => currentSends++;
  retiredKeepalive();
  assert.equal(retiredSends, 0);
  [...h.clock.pending.values()].find(timer => timer.ms === 4000).fn();
  assert.equal(currentSends, 1);
});

test('speech recovery an old pending grant cannot replace the next interview connection', async () => {
  const token = deferred();
  let calls = 0;
  const h = speechRecoveryHarness({ token: () => ++calls === 1 ? token.promise
    : Promise.resolve({ ok: true, accessToken: 'synthetic-new-owner' }) });
  const previous = h.run('startLiveTranscription()');
  h.run('stopTranscriptStreaming(); activeConnection={demo:true,directSpeechOnly:true}; interviewStarted=true;');
  await h.run('startLiveTranscription()');
  assert.equal(h.requests.length, 1);
  token.resolve({ ok: true, accessToken: 'synthetic-retired-owner' });
  await previous;
  assert.equal(h.sockets.length, 0);
  await h.retry();
  assert.equal(h.sockets[0].protocols[1], 'synthetic-new-owner');
});

test('speech recovery caption health remains truthful through cooldown, connecting and quiet recovery', async () => {
  const h = speechRecoveryHarness();
  await h.run('startLiveTranscription()');
  h.sockets[0].onclose({ code: 1006 });
  h.run('updateAudioUi({rms:0.005,peak:0.01})');
  assert.match(h.get('audioState').textContent, /unavailable.*1006.*retrying/i);
  assert.match(h.get('captionState').textContent, /unavailable/i);
  await h.retry();
  assert.match(h.get('captionState').textContent, /connecting/i);
  assert.match(h.get('uploadStatus').textContent, /No audio is being sent/);
  h.open();
  await settle();
  assert.equal(h.get('captionState').textContent, 'Listening');
  h.run('updateAudioUi({rms:0.005,peak:0.01})');
  assert.match(h.get('audioState').textContent, /connected/i);
  assert.doesNotMatch(h.get('uploadStatus').textContent, /relay active|audio sent|demo/i);
});

test('speech recovery does not claim backup uploads are unavailable on a fallback-capable connection', async () => {
  const h = speechRecoveryHarness();
  h.run('activeConnection.directSpeechOnly=false');
  await h.run('startLiveTranscription()');
  h.sockets[0].onclose({ code: 1006 });
  assert.doesNotMatch(h.get('uploadStatus').textContent, /backup.*unavailable/i);
  assert.match(h.get('uploadStatus').textContent, /No audio is being sent/);
});

test('a worklet module loading after end cannot create new audio nodes', async () => {
  const h = rendererHarness({ token: async () => ({ ok: true, accessToken: 'test-token' }) });
  await h.run('startSession()');
  await h.run('startLiveTranscription()');
  h.sockets[0].readyState = 1;
  h.run(`
    var resolveModule;
    audioContext = {
      audioWorklet: { addModule: () => new Promise(resolve => resolveModule = resolve) },
      close: async () => {},
      createMediaStreamSource: () => { throw new Error('Must not create nodes after stop'); }
    };
  `);
  const pcm = h.run('startPcmStream()');
  await h.run('finishSession()');
  h.run('resolveModule()');
  await pcm;
});

test('preload forwards disconnect without exposing the Electron event', () => {
  const handlers = new Map();
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => bridge = api },
      ipcRenderer: { on: (name, fn) => handlers.set(name, fn) }
    })
  });
  let args;
  bridge.onSessionDisconnected((...values) => args = values);
  handlers.get('session-disconnected')({ sender: 'must stay in preload' });
  assert.deepEqual(args, []);
});

test('microphone disconnect stops renderer capture instead of retaining readiness', async () => {
  const h = rendererHarness();
  await h.run('startSession()');
  h.events['track:ended']();
  assert.equal(h.run('sessionEnding'), true);
  assert.equal(h.stopped(), 1);
  assert.equal(h.get('statusText').textContent, 'Disconnected');
});

async function transcriptHarness() {
  const h = rendererHarness({ token: async () => ({ ok: true, accessToken: 'synthetic' }) });
  await h.run('startSession()');
  await h.run('startLiveTranscription()');
  h.run(`var transcripts = []; window.truveil.sendTranscript = async data => { transcripts.push(data); return { ok: true }; }; liveAudioStartedAt = 100000; lastRms = 0.05; lastPeak = 0.2; liveEnergySamples = Array.from({ length: 100 }, (_, i) => ({ at: 100000 + i * 120, rms: 0.05, peak: 0.2 }));`);
  h.message = message => h.sockets.at(-1).onmessage({ data: JSON.stringify(message) });
  h.finals = () => JSON.parse(h.run('JSON.stringify(transcripts.filter(item => !item.interim))'));
  return h;
}

function providerFinal(text, start, duration = 1, extra = {}) {
  return { type: 'Results', is_final: true, start, duration, channel: { alternatives: [{ transcript: text, confidence: 0.9 }] }, ...extra };
}

test('provider ranges preserve repeated phrases as immediate spans and ignore replay', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('Retry the job.', 0));
  h.message(providerFinal('Retry the job.', 0));
  h.message(providerFinal('Retry the job.', 1));
  h.message(providerFinal('', 2, 0.3, { speech_final: true }));
  assert.equal(h.finals().length, 2);
  assert.equal(h.finals().map(item => item.text).join(' '), 'Retry the job. Retry the job.');
  assert.equal(h.finals()[0].durationMs, 1000);
  assert.equal(h.finals()[0].startedAt, 100000);
  assert.equal(h.finals()[0].endedAt, 101000);
  assert.equal(h.finals()[1].startedAt, 101000);
  assert.equal(h.finals()[1].endedAt, 102000);
  h.message(providerFinal('Retry the job.', 1, 1, { speech_final: true }));
  assert.equal(h.finals().length, 2);
  h.message(providerFinal('Retry the job.', 3, 1, { speech_final: true }));
  assert.equal(h.finals().length, 3);
});

test('final word confidences include zero, weight words, and use absolute stream offsets', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('A', 5, 1, { channel: { alternatives: [{ transcript: 'A', confidence: 1, words: [{ word: 'a', start: 5.2, end: 5.4, confidence: 0 }] }] } }));
  h.message(providerFinal('better answer.', 6, 2, { speech_final: true, channel: { alternatives: [{ transcript: 'better answer.', confidence: 0.99, words: [{ word: 'better', start: 6.2, end: 6.5, confidence: 0.9 }, { word: 'answer', start: 6.6, end: 7, confidence: 0.9 }] }] } }));
  const final = h.finals()[0];
  assert.equal(final.transcriptConfidence, 0);
  assert.equal(final.lowConfidenceWordRatio, 1);
  assert.equal(final.wordCount, 1);
  assert.equal(final.confidenceKnown, true);
  assert.equal(final.startedAt, 105200);
  assert.equal(final.endedAt, 105400);
  assert.equal(final.durationMs, 200);
  const second = h.finals()[1];
  assert.equal(second.transcriptConfidence, 0.9);
  assert.equal(second.wordCount, 2);
  assert.equal(second.lowConfidenceWordRatio, 0);
  assert.equal(second.startedAt, 106200);
  assert.equal(second.endedAt, 107000);
  assert.equal(second.durationMs, 800);
  assert.ok(Math.abs((final.transcriptConfidence + second.transcriptConfidence * 2) / 3 - 0.6) < 1e-10);
});

test('partially missing confidence never produces a falsely known aggregate', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('Known and unknown.', 0, 1, { speech_final: true, channel: { alternatives: [{ transcript: 'Known and unknown.', confidence: 1, words: [{ word: 'Known', start: 0, end: 0.2, confidence: 0.9 }, { word: 'and', start: 0.3, end: 0.4 }, { word: 'unknown', start: 0.5, end: 0.8, confidence: null }] }] } }));
  const final = h.finals()[0];
  assert.equal(final.transcriptConfidence, undefined);
  assert.equal(final.confidenceKnown, false);
  assert.equal(final.lowConfidenceWordRatio, undefined);
  assert.equal(final.qualityReason, 'missing-confidence');
});

test('reconnect preserves finalized prefix without promoting the unfinalized tail', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('This part is final.', 0));
  h.message({ ...providerFinal('unfinished specu', 1), is_final: false });
  h.sockets[0].onclose();
  assert.equal(h.finals().length, 1);
  assert.equal(h.finals()[0].text, 'This part is final.');
  assert.equal(h.finals()[0].finalReason, 'segment_final');
  assert.equal(h.run('transcripts.at(-1).captionClear'), true);
  assert.equal(h.run('liveFinalSegments.length'), 0);
  assert.equal(h.run('liveStreamEpoch'), 1);
});

test('stale utterance boundary cannot discard a newer live draft', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('First answer.', 0, 1, { speech_final: true }));
  h.message(providerFinal('Second answer.', 2));
  h.message({ ...providerFinal('with an ongoing thought', 3), is_final: false });
  const before = h.run('transcripts.length');
  h.message({ type: 'UtteranceEnd', last_word_end: 1 });
  assert.equal(h.run('transcripts.length'), before);
  h.message({ type: 'UtteranceEnd', last_word_end: 4 });
  assert.equal(h.finals().length, 2);
  assert.equal(h.run('transcripts.at(-1).captionClear'), true);
});

test('utterance end uses recognized word time rather than the trailing audio silence', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('A complete answer.', 0, 1, { channel: { alternatives: [{ transcript: 'A complete answer.', confidence: 0.9,
    words: [{ word: 'A', start: 0, end: 0.1, confidence: 0.9 }, { word: 'complete', start: 0.2, end: 0.5, confidence: 0.9 }, { word: 'answer', start: 0.5, end: 0.8, confidence: 0.9 }]
  }] } }));
  h.message({ type: 'UtteranceEnd', last_word_end: 0.8 });
  assert.equal(h.run('transcripts.at(-1).captionClear'), true);
});

test('main forwards quality metadata and deduplicates explicit final identities, not speech', async () => {
  const h = mainHarness();
  await h.join();
  const data = { text: 'I would retry the job.', transcriptConfidence: 0.9, rms: 0.03, peak: 0.2, startedAt: 100000, endedAt: 101000, wordCount: 5, lowConfidenceWordRatio: 0.2, confidenceKnown: true, qualityReason: 'ok' };
  const send = payload => h.handlers.get('session:transcript')({}, payload);
  assert.equal((await send({ ...data, segmentId: 'live-0-0' })).skipped, undefined);
  assert.equal((await send({ ...data, segmentId: 'live-0-0' })).reason, 'duplicate-final');
  assert.equal((await send({ ...data, segmentId: 'live-0-1' })).skipped, undefined);
  const delivered = h.sent.filter(item => item.event === 'candidate_transcript');
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].payload.startedAt, 100000);
  assert.equal(delivered[0].payload.lowConfidenceWordRatio, 0.2);
  assert.equal(delivered[0].payload.confidenceKnown, true);
  assert.equal(delivered[0].payload.qualityReason, null);
  assert.equal(delivered[0].payload.streamEpoch, 0, 'all namespaced captions supply a valid epoch');
  await send({ ...data, segmentId: 'live-0-2', transcriptConfidence: undefined, confidenceKnown: false, qualityReason: 'missing-confidence' });
  assert.equal(h.sent.at(-1).payload.transcriptConfidence, undefined);
  assert.equal(h.sent.at(-1).payload.confidenceKnown, false);
});

test('rejoining creates distinct transcript identities while retries retain their identity', async () => {
  const h = mainHarness();
  await h.join();
  const data = { text: 'This is a new answer.', transcriptConfidence: 0.9, rms: 0.03, peak: 0.2, segmentId: 'live-0-0' };
  const send = () => h.handlers.get('session:transcript')({}, data);
  await send();
  const first = h.sent.at(-1).payload.segmentId;
  assert.equal((await send()).reason, 'duplicate-final');
  await h.run('cleanupSession({ failedJoin: true })');
  await h.join();
  await send();
  const second = h.sent.at(-1).payload.segmentId;
  assert.notEqual(first, second);
  assert.ok(first.endsWith(':live-0-0') && second.endsWith(':live-0-0'));
});

test('storage fallback broadcasts original capture bounds, not upload time', async () => {
  const h = mainHarness();
  await h.join();
  h.run(`getSupabase = () => ({
    storage: { from: () => ({ upload: async () => ({}), remove: async () => ({}) }) },
    from: () => ({ upsert: async () => ({}) })
  });`);
  const result = await h.handlers.get('audio:chunk')({}, {
    arrayBuffer: Buffer.alloc(256), sequence: 1, timestamp: 120000,
    startedAt: 100000, endedAt: 120000, durationMs: 20000, rms: 0.1, peak: 0.2
  });
  assert.equal(result.ok, true);
  const payload = h.sent.find(item => item.event === 'candidate_audio_chunk').payload;
  assert.equal(payload.startedAt, 100000);
  assert.equal(payload.endedAt, 120000);
  assert.equal(payload.timestamp, 120000);
});

test('fallback retry keeps capture timestamps and explicit zero audio metrics', async () => {
  const h = rendererHarness();
  h.run(`var uploads = []; window.truveil.uploadAudioChunk = async data => { uploads.push(data); return { ok: uploads.length > 1 }; }; var blob = { size: 256, type: 'audio/webm', arrayBuffer: async () => new Uint8Array(256).buffer }; lastRms = 0.9; lastPeak = 0.9;`);
  await h.run('uploadFallbackAudioBlob(blob, 0, 1000, { endedAt: 3500, rms: 0, peak: 0 })');
  const retry = [...h.clock.pending.values()].find(timer => timer.ms === 1200);
  await retry.fn();
  assert.equal(h.run('uploads.length'), 2);
  assert.equal(h.run('uploads[1].durationMs'), 2500);
  assert.equal(h.run('uploads[1].timestamp'), 3500);
  assert.equal(h.run('uploads[1].rms'), 0);
});

test('fallback recorder restarts immediately without a deliberate inter-segment gap', async () => {
  const h = rendererHarness();
  await h.run('startSession()');
  h.run(`
    var recorders = [];
    var MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; recorders.push(this); }
      start() { this.state = 'recording'; this.onstart(); }
      stop() { this.state = 'inactive'; this.onstop(); }
      requestData() {}
    };
    window.MediaRecorder = MediaRecorder;
    window.truveil.uploadAudioChunk = async () => ({ ok: true });
    startAudioFallback();
    recorders[0].stop();
  `);
  assert.equal(h.run('recorders.length'), 2);
  assert.equal(h.run('recorders[1].state'), 'recording');
  assert.equal([...h.clock.pending.values()].some(timer => timer.ms === 250), false);
  await h.run('finishSession()');
  assert.equal(h.run('recorders.length'), 2);
});

test('stable provider segments reach the checker relay before a turn-ending pause', async () => {
  const h = await transcriptHarness();
  h.message(providerFinal('Um, I used PostgreSQL and a dead-letter queue.', 0));
  assert.equal(h.finals().length, 1);
  assert.equal(h.finals()[0].text, 'Um, I used PostgreSQL and a dead-letter queue.');
  assert.equal(h.finals()[0].finalReason, 'segment_final');
  assert.ok(h.finals()[0].revision > 0);
  h.message({ ...providerFinal('then I retried', 1), is_final: false });
  assert.equal(h.finals().length, 1, 'draft speech must not reach analysis');
});

test('short interim revisions have a trailing relay and are cancelled by final speech', async () => {
  const h = await transcriptHarness();
  h.message({ ...providerFinal('I use Redis', 0), is_final: false });
  h.message({ ...providerFinal('I used Redis', 0), is_final: false });
  const trailing = [...h.clock.pending.values()].find(timer => timer.ms <= 100);
  assert.ok(trailing, 'a short correction cannot be silently dropped');
  trailing.fn();
  assert.equal(h.run('transcripts.at(-1).text'), 'I used Redis');
  h.message(providerFinal('I used Redis.', 0));
  assert.equal(h.finals().length, 1);
  assert.ok(h.finals()[0].revision > h.run('transcripts.filter(item => item.interim).at(-1).revision'));
  await h.run('finishSession()');
  const count = h.run('transcripts.length');
  trailing.fn();
  assert.equal(h.run('transcripts.length'), count);
});

test('healthy interim progress does not trigger the final-only watchdog', async () => {
  const h = await transcriptHarness();
  h.run('sessionStart = Date.now() - 20000; lastSpeechLevelAt = Date.now(); lastFinalTranscriptAt = 0; var fallbackStarts = 0; startAudioFallback = () => fallbackStarts++; startTranscriptWatchdog();');
  h.message({ ...providerFinal('A longer answer that is still being recognized', 0), is_final: false });
  [...h.clock.pending.values()].find(timer => timer.ms === 5000).fn();
  assert.equal(h.run('fallbackStarts'), 0);
});

test('candidate main forwards a namespaced caption locally before a slow remote acknowledgement', async () => {
  const ack = deferred();
  const h = mainHarness({ send: data => data.event === 'candidate_transcript' ? ack.promise : 'ok' });
  await h.join();
  const sending = h.handlers.get('session:transcript')({}, { text: 'PostgreSQL replication', interim: true, revision: 7, streamEpoch: 1, segmentId: 'live-1-2' });
  const caption = h.events.find(([event]) => event === 'transcript-caption')?.[1];
  assert.equal(caption?.text, 'PostgreSQL replication');
  assert.equal(caption?.revision, 7);
  assert.equal(caption?.captionStreamId, h.run('activeSession.transcriptInstanceId'));
  ack.resolve('ok');
  await sending;
});

test('explicit caption clear crosses the relay without becoming a final or entering duplicate cache', async () => {
  const h = mainHarness();
  await h.join();
  const result = await h.handlers.get('session:transcript')({}, { text: '', interim: true, captionClear: true, revision: 3, streamEpoch: 0 });
  assert.equal(result.skipped, undefined);
  assert.equal(h.sent.at(-1).payload.captionClear, true);
  assert.equal(h.sent.at(-1).payload.interim, true);
  assert.equal(h.run('recentFinalTranscripts.length'), 0);
});

test('direct provider URL preserves speech and opts out of model improvement', async () => {
  const h = await transcriptHarness();
  const url = new URL(h.sockets[0].url);
  assert.equal(url.searchParams.get('mip_opt_out'), 'true');
  assert.equal(url.searchParams.get('filler_words'), 'true');
  assert.equal(url.searchParams.get('endpointing'), '300');
});

test('failed stable relay retries the same identity and stops retrying after end', async () => {
  const h = await transcriptHarness();
  h.run('window.truveil.sendTranscript = async data => { transcripts.push(data); return { ok: false }; };');
  h.message(providerFinal('A stable answer must survive one failed relay.', 0));
  await settle();
  const retry = [...h.clock.pending.values()].find(timer => timer.ms === 500);
  assert.ok(retry);
  await retry.fn();
  await settle();
  assert.equal(h.finals().length, 2);
  assert.deepEqual(h.finals()[0], h.finals()[1]);
  await h.run('finishSession()');
  await retry.fn();
  assert.equal(h.finals().length, 2);
});

test('concurrent final retries share one acknowledgement without duplicate sends', async () => {
  const ack = deferred();
  const h = mainHarness({ send: data => data.event === 'candidate_transcript' ? ack.promise : 'ok' });
  await h.join();
  const payload = { text: 'I retried the queue.', segmentId: 'range-0-1', revision: 2, transcriptConfidence: 0.9 };
  const send = () => h.handlers.get('session:transcript')({}, payload);
  const first = send();
  const second = send();
  assert.equal(h.sent.filter(item => item.event === 'candidate_transcript').length, 1);
  ack.resolve('ok');
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test('storage fallback text returns to the candidate only for the current owned chunk', async () => {
  const h = mainHarness({ sessionStatus: 'active' });
  await h.join();
  const channel = h.channels[0];
  const receive = channel.callbacks.get('audio_chunk_status');
  assert.equal(typeof receive, 'function');
  const chunkId = `TRV-ABC123-${h.run('activeSession.transcriptInstanceId')}-00001-1000`;
  const payload = { sessionId: 'TRV-ABC123', chunkId, status: 'transcribed_deleted', transcript: 'The backup preserved PostgreSQL and um, my correction.', sequence: 1, timestamp: 1000 };
  receive({ payload: { ...payload, chunkId: 'unrelated' } });
  assert.equal(h.events.filter(([event]) => event === 'transcript-caption').length, 0);
  receive({ payload });
  receive({ payload });
  assert.equal(h.events.filter(([event]) => event === 'transcript-caption').length, 1);
  assert.equal(h.events.find(([event]) => event === 'transcript-caption')[1].text, payload.transcript);
  await h.run('cleanupSession({ failedJoin: true })');
  receive({ payload: { ...payload, chunkId: chunkId + '-late' } });
  assert.equal(h.events.filter(([event]) => event === 'transcript-caption').length, 1);
});

test('delayed final spans use their captured speech energy, not silence at result arrival', async () => {
  const h = await transcriptHarness();
  h.run(`lastRms = 0; lastPeak = 0; liveSegmentMaxRms = 0.05; liveSegmentMaxPeak = 0.2;
    liveEnergySamples = [{ at: 100300, rms: 0.05, peak: 0.2 }, { at: 101300, rms: 0.04, peak: 0.18 }];`);
  h.message(providerFinal('The first confirmed phrase.', 0));
  h.message(providerFinal('The second confirmed phrase.', 1));
  const main = mainHarness();
  await main.join();
  for (const payload of h.finals()) await main.handlers.get('session:transcript')({}, payload);
  const finals = main.sent.filter(item => item.event === 'candidate_transcript' && !item.payload.interim);
  assert.equal(finals.length, 2);
  assert.equal(finals[1].payload.rms, 0.04);
});

test('unknown capture energy stays reviewable, while measured silence remains rejected', async () => {
  const h = await transcriptHarness();
  h.run('liveEnergySamples = []; lastRms = 0; lastPeak = 0;');
  h.message(providerFinal('Delayed speech outside the energy history.', 0));
  const main = mainHarness();
  await main.join();
  await main.handlers.get('session:transcript')({}, h.finals()[0]);
  assert.equal(main.sent.at(-1).payload.interim, false);
  assert.equal(main.sent.at(-1).payload.qualityReason, 'missing-audio-energy');
  h.run('liveEnergySamples = [{ at: 101300, rms: 0, peak: 0 }];');
  h.message(providerFinal('An artifact recognized over measured silence.', 1));
  const result = await main.handlers.get('session:transcript')({}, h.finals()[1]);
  assert.equal(result.reason, 'no-speech-energy');
  assert.equal(main.sent.at(-1).payload.captionClear, true);
});
