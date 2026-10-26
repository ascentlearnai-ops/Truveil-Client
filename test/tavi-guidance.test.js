const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('src/renderer/index.html');
const source = read('src/renderer/session.js');
const css = read('src/renderer/styles.css');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const elements = new Map();
  let focused = null;
  function element(id = '') {
    let text = '';
    const classes = new Set();
    return {
      id, writes: 0, value: '', checked: false, hidden: false, disabled: false,
      children: [], attributes: {}, listeners: {}, style: { setProperty() {} },
      get textContent() { return text; },
      set textContent(value) { text = value; this.writes++; },
      classList: {
        add: x => classes.add(x), remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x)
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      dispatch(name, event = {}) { return this.listeners[name]?.(event); },
      focus() { focused = id; }, scrollIntoView() {},
      appendChild(child) { this.children.push(child); },
      insertBefore(child) { this.children.push(child); },
      querySelector() { return null; }
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  for (const id of ['setupGuide', 'sessionGuide', 'browserGuide', 'endedDescription']) {
    get(id).textContent = html.match(new RegExp(`<p id="${id}"[^>]*>([^<]+)</p>`))[1];
  }
  get('instructionTrack').children = ['Paste your code.', 'Review permissions.', 'Allow the microphone.', 'Keep Secure open.']
    .map(text => Object.assign(element(), { textContent: text }));
  get('sessionCodeInput').value = 'TRV-ABCDEFGHIJ234567';
  get('candidateNameInput').value = 'Test Candidate';
  get('demoRelayInput').value = 'ws://127.0.0.1:43180';
  get('browserPairing').hidden = true;
  get('setup-screen').classList.add('active');
  const events = {};
  const calls = [];
  let micRequests = 0;
  let stopped = 0;
  const track = { readyState: 'live', stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const bridge = {
    startSession: async data => {
      calls.push(['join', data]);
      return options.join ? options.join(data) : { ok: true, demo: true, directSpeechOnly: true, waitingForInterviewer: true };
    },
    endSession: async () => { calls.push(['end']); return { ok: true }; },
    openBrowserExtension: async () => { calls.push(['folder']); return options.folder?.(); },
    pairBrowser: async () => { calls.push(['pair']); return options.pair ? options.pair() : { pairingCode: 'FAKE-ONE-USE-CODE' }; },
    copyBrowserPairing: async () => { calls.push(['copy']); },
    stopBrowserSharing: async () => { calls.push(['stop']); return options.stop?.(); },
    getTranscriptionToken: async () => { calls.push(['token']); return { ok: false, error: 'not configured' }; },
    sendTranscript: async () => ({ ok: true }),
    quit: () => calls.push(['quit'])
  };
  for (const name of ['FocusLost', 'FocusGained', 'ShortcutBlocked', 'BlockingWarning', 'SessionPolicyUpdated',
    'RemoteSessionEnded', 'SessionStarted', 'SessionDisconnected', 'InviteCode', 'BrowserState', 'TranscriptCaption']) {
    bridge[`on${name}`] = fn => { events[name] = fn; };
  }
  let timerId = 0;
  const timers = new Map();
  const schedule = fn => { timers.set(++timerId, fn); return timerId; };
  // No real browser, microphone, provider, network, or repeating timers exist here.
  const context = vm.createContext({
    URL, URLSearchParams, console,
    document: { getElementById: get, createElement: () => element() },
    window: { truveil: bridge },
    navigator: { mediaDevices: { getUserMedia: async () => {
      micRequests++;
      return options.mic ? options.mic(stream) : stream;
    } } },
    setTimeout: schedule, setInterval: schedule,
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    confirm: () => true
  });
  const run = code => vm.runInContext(code, context);
  run(read('src/session/presentation.js'));
  run(source);
  run('var streamingStarts = 0; startTranscriptStreaming = () => streamingStarts++;');
  return { get, run, events, calls, timers, focused: () => focused, stopped: () => stopped,
    micRequests: () => micRequests, async join() { get('sessionConsentInput').checked = true; await run('startSession()'); } };
}

test('guidance uses existing assets, polite status, in-flow bubbles and unchanged carousel targets', () => {
  for (const id of ['setupGuide', 'sessionGuide', 'browserGuide', 'endedDescription', 'instructionAnnouncement']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"`));
  }
  assert.equal((html.match(/class="instruction-card"/g) || []).length, 4);
  for (const id of ['instructionViewport', 'instructionTrack', 'instructionDots', 'instructionPrev', 'instructionNext',
    'browserPairingCode', 'copyPairingBtn', 'openExtensionBtn']) assert.ok(html.includes(`id="${id}"`));
  assert.equal((html.match(/class="tavi-mascot"[^>]*width="72" height="72" alt=""/g) || []).length, 4);
  assert.doesNotMatch(html, /<details|AI-assistance risk|cheating score|demo workflow/i);
  assert.match(css, /\.tavi-bubble \{[^}]*border-radius: 8px/);
  assert.match(css, /\.tavi-guidance > \.tavi-bubble::before[^}]*border-left:[^}]*border-bottom:/);
  assert.doesNotMatch(css.match(/\.tavi[^}]+\}/g).join('\n'), /position:\s*fixed|animation:|transition:/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]), ['../session/presentation.js', 'session.js']);
});

test('text-only helper diffs announcements without actions, timers or focus changes', () => {
  const h = harness();
  const target = h.get('sessionGuide');
  const timers = h.timers.size;
  h.run("setTaviGuidance('sessionGuide', 'Keep Secure open.'); setTaviGuidance('sessionGuide', 'Keep Secure open.');");
  assert.equal(target.writes, 2, 'initial markup plus one changed text');
  assert.equal(target.textContent, 'Keep Secure open.');
  assert.equal(h.timers.size, timers);
  assert.deepEqual(h.calls, []);
  assert.equal(h.micRequests(), 0);
  assert.equal(h.focused(), null);
  assert.equal(h.get('sessionConsentInput').checked, false);
});

test('guidance adds no listeners, timers or hooks in high-frequency capture and caption paths', () => {
  const helper = source.slice(source.indexOf('function setTaviGuidance('), source.indexOf('function updateInstructionCarousel('));
  assert.doesNotMatch(helper, /window\.|navigator\.|\.focus\(|\.click\(|addEventListener|setTimeout|setInterval|MutationObserver/);
  for (const [start, end] of [
    ['function renderCaption(', 'function compareCaptionOrder('],
    ['function updateAudioUi(', 'function startAudioMeter('],
    ['async function startPcmStream(', 'function transcriptionKeyterms(']
  ]) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    assert.doesNotMatch(source.slice(from, to), /setTaviGuidance/);
  }
});

test('carousel speech announces changes once and retains keyboard, dots and swipes', () => {
  const h = harness();
  const announcement = h.get('instructionAnnouncement');
  const writes = announcement.writes;
  h.get('instructionViewport').dispatch('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(announcement.writes, writes);
  h.get('instructionViewport').dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(announcement.textContent, 'Review permissions.');
  assert.equal(h.get('instructionTrack').children[1].attributes['aria-hidden'], 'false');
  h.get('instructionDots').children[2].dispatch('click');
  assert.equal(announcement.textContent, 'Allow the microphone.');
  h.get('instructionViewport').dispatch('pointerdown', { clientX: 150, clientY: 20 });
  h.get('instructionViewport').dispatch('pointerup', { clientX: 50, clientY: 20 });
  assert.equal(announcement.textContent, 'Keep Secure open.');
  assert.equal(h.get('instructionNext').disabled, true);
  assert.deepEqual(h.calls, []);
});

test('required consent remains manual and validation errors stay readable', async () => {
  const h = harness();
  assert.match(h.get('setupGuide').textContent, /Add your name.*review the required permissions/);
  await h.run('startSession()');
  assert.match(h.get('setupGuide').textContent, /confirm the session verification notice/);
  assert.equal(h.micRequests(), 0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.get('externalReviewConsentInput').checked, false);
  assert.equal(h.get('tabObserveConsentInput').checked, false);
  for (const fn of [...h.timers.values()]) fn();
  assert.match(h.get('setupGuide').textContent, /confirm the session verification notice/);
});

test('preflight and approval remain gated with truthful waiting and active speech', async () => {
  const mic = deferred();
  const approval = deferred();
  const h = harness({ mic: () => mic.promise, join: () => approval.promise });
  h.get('sessionConsentInput').checked = true;
  const joining = h.run('startSession()');
  assert.match(h.get('setupGuide').textContent, /microphone prompt/);
  assert.deepEqual(h.calls, []);
  mic.resolve({ getAudioTracks: () => [{ readyState: 'live', addEventListener() {} }], getTracks: () => [] });
  await settle();
  assert.match(h.get('setupGuide').textContent, /microphone is open.*Check your name.*approval/);
  assert.equal(h.run('streamingStarts'), 0);
  assert.equal(h.calls[0][1].externalReviewConsent, false);
  approval.resolve({ ok: true, demo: true, directSpeechOnly: true, waitingForInterviewer: true });
  await joining;
  assert.match(h.get('sessionGuide').textContent, /microphone is open.*transcription hasn't started.*Wait/);
  assert.equal(h.run('streamingStarts'), 0);
  h.events.SessionStarted();
  assert.equal(h.get('sessionGuide').textContent, 'Keep Secure open and use your normal calling app.');
  assert.equal(h.run('streamingStarts'), 1);
  assert.deepEqual(h.calls.map(call => call[0]), ['join']);
});

test('denied microphone and rejected join retain errors without bypassing preflight', async () => {
  const denied = harness({ mic: () => Promise.reject(new Error('denied')) });
  await denied.join();
  assert.match(denied.get('setupGuide').textContent, /Microphone permission is required/);
  assert.deepEqual(denied.calls, []);
  const rejected = harness({ join: async () => ({ ok: false, error: 'Interviewer declined this request.' }) });
  await rejected.join();
  assert.equal(rejected.get('setupGuide').textContent, 'Interviewer declined this request.');
  assert.equal(rejected.stopped(), 1);
  assert.equal(rejected.get('startBtn').disabled, false);
});

test('extension install and pairing are explicit, show the actual code, and never share automatically', async () => {
  const h = harness();
  h.get('tabObserveConsentInput').checked = true;
  await h.join();
  assert.equal(h.get('pairBrowserBtn').disabled, true);
  assert.deepEqual(h.calls.map(call => call[0]), ['join']);
  h.events.SessionStarted();
  assert.match(h.get('browserGuide').textContent, /Open extension folder/);
  await h.get('openExtensionBtn').dispatch('click');
  await settle();
  assert.match(h.get('browserGuide').textContent, /Chrome or Edge Extensions.*Developer mode.*Load unpacked.*Connect browser/);
  h.events.BrowserState({ observeConsent: true, connected: false, revision: 1 });
  assert.match(h.get('browserGuide').textContent, /Load unpacked/);
  await h.get('pairBrowserBtn').dispatch('click');
  assert.equal(h.get('browserPairingCode').value, 'FAKE-ONE-USE-CODE');
  assert.equal(h.get('browserPairing').hidden, false);
  assert.match(h.get('browserGuide').textContent, /without personal tabs.*Paste the code.*review permissions.*Share this window/);
  h.events.BrowserState({ observeConsent: true, connected: false, revision: 2 });
  assert.match(h.get('browserGuide').textContent, /Share this window/);
  await h.get('copyPairingBtn').dispatch('click');
  assert.deepEqual(h.calls.map(call => call[0]), ['join', 'folder', 'pair', 'copy']);
  h.events.BrowserState({ observeConsent: true, connected: true, tabs: [{}], revision: 3 });
  assert.equal(h.get('browserPairingCode').value, '');
  const writes = h.get('browserGuide').writes;
  h.events.BrowserState({ observeConsent: true, connected: true, tabs: [{}, {}], revision: 4, closeConsent: true });
  assert.equal(h.get('browserGuide').writes, writes);
  assert.match(h.get('browserState').textContent, /2 shared tabs.*permitted/);
  await h.get('stopBrowserBtn').dispatch('click');
  assert.match(h.get('browserGuide').textContent, /no longer shared/);
  assert.equal(h.get('pairBrowserBtn').disabled, true);
});

test('revocation cannot be overwritten by a late folder or pairing response', async () => {
  for (const action of ['folder', 'pair']) {
    const pending = deferred();
    const h = harness({ [action]: () => pending.promise });
    h.get('tabObserveConsentInput').checked = true;
    await h.join();
    h.events.SessionStarted();
    const request = h.get(action === 'folder' ? 'openExtensionBtn' : 'pairBrowserBtn').dispatch('click');
    h.events.BrowserState({ observeConsent: false, connected: false });
    pending.resolve({ pairingCode: 'OBSOLETE-CODE' });
    await request;
    await settle();
    assert.match(h.get('browserGuide').textContent, /no longer shared/);
    assert.equal(h.get('browserPairingCode').value, '');
    assert.equal(h.get('browserPairing').hidden, true);
  }
});

for (const newerState of ['revocation', 'ended', 'disconnected']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`late stop ${outcome} preserves newer ${newerState} guidance`, async () => {
      const stop = deferred();
      const h = harness({ stop: () => stop.promise });
      h.get('tabObserveConsentInput').checked = true;
      await h.join();
      h.events.SessionStarted();
      h.events.BrowserState({ observeConsent: true, connected: true, tabs: [{}] });
      const stopping = h.get('stopBrowserBtn').dispatch('click');
      if (newerState === 'revocation') {
        h.events.BrowserState({ observeConsent: false, connected: false });
        assert.match(h.get('browserGuide').textContent, /no longer shared/);
      } else {
        h.events[newerState === 'ended' ? 'RemoteSessionEnded' : 'SessionDisconnected']();
        assert.equal(h.get('ended-screen').classList.contains('active'), true);
      }
      const snapshot = () => Object.fromEntries(
        ['browserGuide', 'browserState', 'sessionGuide', 'endedDescription'].map(id =>
          [id, { text: h.get(id).textContent, writes: h.get(id).writes }])
      );
      const confirmed = snapshot();
      if (outcome === 'resolve') stop.resolve();
      else stop.reject(new Error('Late stop failure'));
      await stopping;
      assert.deepEqual(snapshot(), confirmed, 'late stop results must not change newer guidance or reannounce it');
      assert.equal(h.get('stopBrowserBtn').disabled, true);
      assert.equal(h.get('pairBrowserBtn').disabled, true);
      assert.equal(h.get('browserPairing').hidden, true);
      assert.equal(h.calls.filter(call => call[0] === 'stop').length, 1);
    });
  }
}

test('unconfirmed sharing stop and failed pairing never claim success', async () => {
  const h = harness({ stop: () => Promise.reject(new Error('offline')), pair: () => Promise.reject(new Error('Pairing unavailable.')) });
  h.get('tabObserveConsentInput').checked = true;
  await h.join();
  h.events.SessionStarted();
  await h.get('pairBrowserBtn').dispatch('click');
  assert.equal(h.get('sessionGuide').textContent, 'Pairing unavailable.');
  assert.equal(h.get('browserPairing').hidden, true);
  await h.get('stopBrowserBtn').dispatch('click');
  assert.match(h.get('browserGuide').textContent, /could not confirm.*End the session/);
  assert.doesNotMatch(h.get('browserGuide').textContent, /no longer shared/);
});

test('no browser consent means no pairing action', async () => {
  const h = harness();
  await h.join();
  h.events.SessionStarted();
  await h.get('pairBrowserBtn').dispatch('click');
  assert.match(h.get('browserGuide').textContent, /not shared.*did not grant/);
  assert.deepEqual(h.calls.map(call => call[0]), ['join']);
});

test('caption failure stays truthful through old captions and frequent audio UI updates', async () => {
  const h = harness();
  await h.join();
  h.events.SessionStarted();
  h.run("failLiveTranscription('GRANT_NOT_CONFIGURED', { retryable: false })");
  assert.match(h.get('sessionGuide').textContent, /Live captions are unavailable/);
  const writes = h.get('sessionGuide').writes;
  for (let revision = 1; revision <= 10; revision++) {
    h.events.TranscriptCaption({ captionStreamId: 'fake', interim: true, revision, text: 'Old draft' });
    h.run('updateAudioUi({ rms: 0.2, peak: 0.3 })');
  }
  assert.equal(h.get('sessionGuide').writes, writes);
  assert.equal(h.get('captionState').textContent, 'Live captions unavailable');
  assert.deepEqual(h.calls.map(call => call[0]), ['join']);
});

test('connecting, retry and fallback guidance never promises live captions', async () => {
  const h = harness();
  await h.join();
  h.events.SessionStarted();
  h.run("scheduleLiveTranscriptionRetry(1000)");
  assert.match(h.get('sessionGuide').textContent, /unavailable.*retries/);
  h.run('stopLiveTranscription()');
  const connecting = h.run('startLiveTranscription()');
  assert.equal(h.get('sessionGuide').textContent, 'Captions are connecting. Keep Secure open.');
  await connecting;
  assert.match(h.get('sessionGuide').textContent, /unavailable/);
  h.run('activeConnection.directSpeechOnly = false; window.MediaRecorder = function() {}; window.truveil.uploadAudioChunk = () => {}; startFallbackRecorderSegment = () => {}; startAudioFallback();');
  assert.match(h.get('sessionGuide').textContent, /slower backup updates/);
});

test('cancellation and disconnect show stopped guidance and never restart on late approval', async () => {
  const approval = deferred();
  const h = harness({ join: () => approval.promise });
  h.get('sessionConsentInput').checked = true;
  const joining = h.run('startSession()');
  await settle();
  await h.get('cancelJoinBtn').dispatch('click');
  const ended = h.get('endedDescription').textContent;
  approval.resolve({ ok: true, demo: true, waitingForInterviewer: false });
  await joining;
  h.events.SessionStarted();
  assert.match(ended, /microphone and local monitoring have stopped.*close/);
  assert.equal(h.get('endedDescription').textContent, ended);
  assert.equal(h.run('streamingStarts'), 0);
  assert.equal(h.get('ended-screen').classList.contains('active'), true);
  assert.ok(h.stopped() >= 1);
  assert.ok(!h.calls.some(call => call[0] === 'quit'));
  const disconnected = harness();
  await disconnected.join();
  disconnected.events.SessionDisconnected();
  assert.match(disconnected.get('endedDescription').textContent, /have stopped.*Contact your interviewer/);
});
