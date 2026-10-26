'use strict';
const form = document.getElementById('share-form');
const code = document.getElementById('pairing-code');
const observe = document.getElementById('observe');
const close = document.getElementById('close');
const share = document.getElementById('share');
const stop = document.getElementById('stop');
const status = document.getElementById('status');
const error = document.getElementById('error');
let busy = false;
let wasActive = false;
function render(state) {
  const active = state.observeConsent === true;
  // Active consent is authoritative; idle checkboxes are a user-owned draft.
  if (active || wasActive) {
    observe.checked = active;
    close.checked = active && state.closeConsent === true;
  }
  wasActive = active;
  status.textContent = state.connected ? `${state.status}: ${state.tabCount} tabs. ${state.closeConsent ? 'Closing permitted.' : 'Observe only.'}` : state.status;
  for (const element of [code, observe, close, share]) element.disabled = busy || active;
  stop.disabled = !active && !busy;
}
async function refresh() {
  try { render(await chrome.runtime.sendMessage({ type: 'state' })); }
  catch { status.textContent = 'Extension unavailable'; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !observe.checked) return;
  busy = true;
  error.textContent = '';
  share.disabled = true;
  try {
    const window = await chrome.windows.getCurrent();
    const pairingCode = code.value.trim();
    code.value = '';
    const state = await chrome.runtime.sendMessage({ type: 'share', pairingCode, windowId: window.id,
      observeConsent: observe.checked, closeConsent: close.checked });
    if (!state?.ok) error.textContent = state?.error || 'Unable to share this window.';
  } catch { error.textContent = 'Unable to share this window.'; }
  finally { busy = false; await refresh(); }
});
stop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  code.value = ''; observe.checked = false; close.checked = false;
  await refresh();
});
refresh();
const refreshTimer = setInterval(refresh, 1000);
window.addEventListener('unload', () => clearInterval(refreshTimer));
