(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TruveilSession = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function displayCode(value) {
    return String(value || '').replace(/^DEMO-([A-Z2-7]{16})$/, 'TRV-$1');
  }
  function wireCode(value) {
    return String(value || '').toUpperCase().replace(/^TRV-([A-Z2-7]{16})$/, 'DEMO-$1');
  }
  function serverAddress(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'wss:' || (url.protocol === 'ws:' && url.hostname === '127.0.0.1'))) throw new Error('Invalid session server address.');
    url.pathname = url.pathname.replace(/\/demo\/?$/, '').replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
  }
  function invitation(code, relayUrl) {
    if (!/^DEMO-[A-Z2-7]{16}$/.test(code)) throw new Error('Invalid session code.');
    return `truveil://session?code=${displayCode(code)}&relay=${encodeURIComponent(serverAddress(relayUrl))}`;
  }
  function message(value) {
    return String(value || '').replace(/\b(demo) (connection|room|relay|session|join|policy|metadata|lifetime|action)\b/gi,
      (_, label, noun) => `${label[0] === 'D' ? 'Session' : 'session'} ${noun}`);
  }
  return Object.freeze({ displayCode, wireCode, serverAddress, invitation, message });
});
