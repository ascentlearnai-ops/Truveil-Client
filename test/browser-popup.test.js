'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../browser-extension/popup.js'), 'utf8');
const idle = { connected: false, observeConsent: false, closeConsent: false, tabCount: 0, status: 'Not sharing' };
const active = { connected: true, observeConsent: true, closeConsent: true, tabCount: 2, status: 'Sharing this demo window' };

async function popupHarness(initial = idle) {
  let state = { ...initial }, poll;
  const messages = [], elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, { value: '', checked: false, disabled: false, textContent: '',
        addEventListener: (type, handler) => listeners.set(type, handler),
        dispatch: (type, event) => listeners.get(type)?.(event) });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get },
    window: { addEventListener() {} },
    setInterval(fn, ms) { assert.equal(ms, 1000); poll = fn; return 1; },
    clearInterval() {},
    chrome: {
      windows: { getCurrent: async () => ({ id: 7 }) },
      runtime: { async sendMessage(message) {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (message.type === 'state') return { ...state };
        if (message.type === 'stop') { state = { ...idle }; return { ...state }; }
        if (message.type === 'share') {
          state = { ...active, observeConsent: message.observeConsent, closeConsent: message.closeConsent };
          return { ok: true, ...state };
        }
        throw new Error('Unexpected message');
      } }
    }
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, messages, poll: () => poll(), setState: next => { state = { ...next }; } };
}

function assertChecks(h, observe, close) {
  assert.equal(h.get('observe').checked, observe, 'observe checkbox');
  assert.equal(h.get('close').checked, close, 'close checkbox');
}

test('reopened popup mirrors active authoritative consent without sending an opt-in', async () => {
  const h = await popupHarness(active);
  assertChecks(h, true, true);
  assert.equal(h.get('observe').disabled, true);
  assert.equal(h.get('close').disabled, true);
  assert.equal(h.get('share').disabled, true);
  assert.equal(h.get('stop').disabled, false);
  assert.match(h.get('status').textContent, /Closing permitted/);
  assert.deepEqual(h.messages, [{ type: 'state' }]);
});

test('reopened observe-only popup checks observation but never grants closing', async () => {
  const h = await popupHarness({ ...active, closeConsent: false });
  assertChecks(h, true, false);
  assert.equal(h.get('close').disabled, true);
  assert.match(h.get('status').textContent, /Observe only/);
  await h.poll();
  assertChecks(h, true, false);
  assert.ok(h.messages.every(message => message.type === 'state'));
});

test('remote close-consent revocation updates checkmarks while observation stays active', async () => {
  const h = await popupHarness();
  h.get('observe').checked = true;
  h.get('close').checked = true;
  h.setState(active);
  await h.poll();
  h.setState({ ...active, closeConsent: false });
  await h.poll();
  assertChecks(h, true, false);
  assert.equal(h.get('share').disabled, true);
  assert.equal(h.get('stop').disabled, false);
  assert.ok(h.messages.every(message => message.type === 'state'));
});

test('remote full revocation clears active checks once and preserves the next idle draft', async () => {
  const h = await popupHarness();
  h.get('observe').checked = true;
  h.get('close').checked = true;
  h.setState(active);
  await h.poll();
  h.setState(idle);
  await h.poll();
  assertChecks(h, false, false);
  assert.equal(h.get('share').disabled, false);
  assert.equal(h.get('stop').disabled, true);
  h.get('pairing-code').value = 'new synthetic pairing draft';
  h.get('observe').checked = true;
  for (let i = 0; i < 3; i++) await h.poll();
  assertChecks(h, true, false);
  assert.equal(h.get('pairing-code').value, 'new synthetic pairing draft');
  assert.ok(h.messages.every(message => message.type === 'state'));
});

test('idle polling preserves checked and unchecked draft choices and pairing text', async () => {
  const h = await popupHarness();
  for (const [observe, close] of [[true, true], [true, false], [false, true], [false, false]]) {
    h.get('pairing-code').value = 'synthetic idle draft';
    h.get('observe').checked = observe;
    h.get('close').checked = close;
    for (let i = 0; i < 3; i++) await h.poll();
    assertChecks(h, observe, close);
    assert.equal(h.get('pairing-code').value, 'synthetic idle draft');
    assert.equal(h.get('share').disabled, false);
  }
  assert.ok(h.messages.every(message => message.type === 'state'));
});

test('polling cannot opt in; explicit submit sends exactly the selected idle consents', async () => {
  const h = await popupHarness();
  h.get('pairing-code').value = ' synthetic pairing code ';
  h.get('close').checked = true;
  await h.get('share-form').dispatch('submit', { preventDefault() {} });
  assert.ok(h.messages.every(message => message.type === 'state'), 'unchecked observation prevents sharing');
  h.get('observe').checked = true;
  h.get('close').checked = false;
  await h.poll();
  await h.get('share-form').dispatch('submit', { preventDefault() {} });
  assert.deepEqual(h.messages.filter(message => message.type === 'share'), [
    { type: 'share', pairingCode: 'synthetic pairing code', windowId: 7, observeConsent: true, closeConsent: false }
  ]);
  assertChecks(h, true, false);
  assert.equal(h.get('pairing-code').value, '');
  await h.get('stop').dispatch('click');
  assertChecks(h, false, false);
  assert.equal(h.messages.filter(message => message.type === 'stop').length, 1);
});
