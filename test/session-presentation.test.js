const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mainHarness } = require('./helpers/main-harness');
const presentation = require('../src/session/presentation');

test('unrestricted legacy sessions do not start app restriction scans', async () => {
  let scans = 0;
  const h = mainHarness({ session: { allowed_apps: [], allowed_sites: [], blocked_sites: [], blocking_mode: 'none' },
    modules: { './src/lockdown/scanner': { start() { scans++; }, stop() {} } } });
  await h.join();
  await h.run('activateMonitoring()');
  assert.equal(scans, 0);
  assert.equal(h.run('policyScanInterval'), null);
  await h.run('cleanupSession({failedJoin:true})');
});

test('legacy browser restriction rules match only the exact hostname or its real subdomains', () => {
  const h = mainHarness();
  for (const [host, allowed] of [['chatgpt.com', false], ['sub.chatgpt.com', false], ['notchatgpt.com', true], ['chatgpt.com.attacker.example', true], ['example.org', true]]) {
    const decision = h.run(`evaluateForegroundPolicy({processName:'chrome',detectedHost:${JSON.stringify(host)}},normalizePolicy({blocked_sites:['chatgpt.com'],allowed_apps:[],allowed_sites:[],blocking_mode:'observe'}))`);
    assert.equal(decision.allowed, allowed, host);
  }
});

test('legacy permitted activity carries an allowed decision all the way to the host event', async () => {
  const h = mainHarness({ session: { allowed_apps: [], allowed_sites: [], blocked_sites: ['example.org'], blocking_mode: 'observe' } });
  await h.join();
  await h.run('activateMonitoring()');
  const scan = [...h.clock.pending.values()].find(timer => timer.ms === 1000);
  assert.ok(scan);
  const pending = scan.fn();
  h.foreground.resolve({ processName: 'chrome', detectedHost: 'chatgpt.com', detectedUrl: 'https://chatgpt.com/' });
  await pending;
  const event = h.sent.find(item => item.payload?.type === 'foreground_changed');
  assert.equal(event?.payload.policyDecision, 'allowed');
  await h.run('cleanupSession({failedJoin:true})');
});

test('new long session codes and old short cloud codes cannot be confused', () => {
  const h = mainHarness();
  for (const code of ['TRV-ABCDEFGHIJ234567', 'TRV-ABC123', 'DEMO-ABCDEFGHIJ234567']) {
    assert.equal(h.run(`extractInviteCode(${JSON.stringify(code)})`), code);
  }
  for (const code of ['TRV-ABCDEFGHIJ234568', 'TRV-ABCDEFGHIJ234569', 'TRV-ABCDEFGHIJ23456', 'TRV-ABCDEFGHIJ234567A']) assert.equal(h.run(`extractInviteCode(${JSON.stringify(code)})`), null);
});

test('neutral session invitations prefill the same room and server without extra authority', () => {
  const h = mainHarness({ modules: { './src/demo/relay-client': require('../src/demo/relay-client') } });
  const url = presentation.invitation('DEMO-ABCDEFGHIJ234567', 'wss://relay.example/demo');
  h.run(`captureDemoInvite(${JSON.stringify(url)})`);
  assert.equal(h.run('pendingDemoInvite.code'), 'TRV-ABCDEFGHIJ234567');
  assert.equal(h.run('pendingDemoInvite.relayUrl'), 'wss://relay.example/demo');
});

test('new visible session code joins the unchanged relay room without cloud sign-in', async () => {
  let joined;
  class Relay extends EventEmitter {
    async join(data) { joined = data; return { details: { policy: { blocked_sites: [], blocking_mode: 'none' } } }; }
    async send() { return 'ok'; }
    close() {}
    async end() {}
  }
  const h = mainHarness({ modules: { './src/demo/relay-client': { DemoRelayClient: Relay, normalizeRelayUrl: url => url } } });
  const result = await h.handlers.get('session:start')({}, { sessionCode: 'TRV-ABCDEFGHIJ234567', candidateName: 'Synthetic Candidate',
    relayUrl: 'wss://relay.example', consentConfirmed: true, microphoneReady: true });
  assert.equal(result.ok, true);
  assert.equal(joined.code, 'DEMO-ABCDEFGHIJ234567');
  assert.equal(h.run('monitoring'), false);
  assert.equal(h.channels.length, 0);
  assert.deepEqual([...result.policy.blocked_sites], []);
  await h.run('cleanupSession({failedJoin:true})');
});
