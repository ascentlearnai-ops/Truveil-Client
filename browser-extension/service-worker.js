'use strict';
importScripts('protocol.js', 'window-sharing.js');

const sharing = new TruveilWindowSharing.WindowSharing({ chrome, WebSocket,
  onState(state) {
    chrome.action.setBadgeText({ text: state.connected ? 'ON' : '' }).catch(() => {});
    chrome.action.setTitle({ title: state.connected ? 'Truveil: interview window sharing on' : 'Truveil: not sharing' }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return false;
  if (message?.type === 'state') { respond(sharing.getState()); return false; }
  if (message?.type === 'stop') { respond(sharing.stop()); return false; }
  if (message?.type !== 'share') return false;
  sharing.share({ pairingCode: message.pairingCode, windowId: message.windowId,
    observeConsent: message.observeConsent, closeConsent: message.closeConsent })
    .then(state => respond({ ok: true, ...state }))
    .catch(() => respond({ ok: false, error: 'Unable to share. Check the pairing code and choose a normal interview window.' }));
  return true;
});
