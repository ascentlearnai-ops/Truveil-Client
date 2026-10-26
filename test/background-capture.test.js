const test = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./helpers/main-harness');

test('candidate captions are not timer-throttled behind a calling app', () => {
  const h = mainHarness();
  h.run('createWindow()');
  assert.equal(h.windowOptions[0].webPreferences.backgroundThrottling, false);
  assert.equal(h.windowOptions[0].webPreferences.sandbox, true);
  assert.equal(h.windowOptions[0].webPreferences.contextIsolation, true);
});

for (const demo of [true, false]) {
  test(`${demo ? 'account-free' : 'unrestricted cloud'} sessions keep speech active only after Start and release on cleanup`, async () => {
    const h = mainHarness();
    h.run(`activeSession = { demo: ${demo}, policy: { blocking_mode: 'none' } };`);
    assert.equal(h.powerStarts.length, 0, 'Joining must not acquire ongoing capture authority');
    await h.run('activateMonitoring()');
    await h.run('activateMonitoring()');
    assert.deepEqual(h.powerStarts, ['prevent-app-suspension']);
    assert.equal(h.run('policyScanInterval'), null);
    assert.equal(h.events.filter(([name]) => name === 'session-started').length, 1);
    await h.run('cleanupSession({failedJoin:true, disconnected:true})');
    assert.deepEqual(h.powerStops, [0], 'Release valid blocker ID zero before network cleanup');
    assert.equal(h.run('monitoring'), false);
    await h.run('activateMonitoring()');
    assert.equal(h.powerStarts.length, 1, 'An ended session must not restart capture');
  });
}

test('an unavailable Windows power API does not break consented session startup', async () => {
  const h = mainHarness({ powerError: true });
  h.run("activeSession = { demo: true, policy: { blocking_mode: 'none' } };");
  await h.run('activateMonitoring()');
  assert.equal(h.events.filter(([name]) => name === 'session-started').length, 1);
  await h.run('cleanupSession({failedJoin:true})');
  assert.deepEqual(h.powerStops, []);
});

test('switching to a call does not end an account-free session or publish foreground activity', async () => {
  const h = mainHarness();
  h.run('createWindow(); activeSession = {demo:true};');
  await h.run('activateMonitoring()');
  const count = h.events.length;
  h.windowHandlers.get('blur')();
  h.windowHandlers.get('focus')();
  assert.equal(h.run('monitoring'), true);
  assert.equal(h.events.length, count);
  assert.equal(h.sent.length, 0);
  await h.run('cleanupSession({failedJoin:true})');
});
