(function (root) {
  'use strict';
  const EXTENSION_ID = 'dmemhcgadchjgfpleneioeenkcjepbhk';
  const LIMITS = Object.freeze({ maxPayload: 65536, maxTabs: 128, maxEvents: 64, maxPeers: 2,
    maxAttempts: 8, messagesPerSecond: 80, maxCommands: 256, maxPending: 8,
    pairingMs: 120000, authMs: 3000, commandMs: 5000, idleMs: 45000, heartbeatMs: 20000 });
  const DEFAULT_PROTECTED = Object.freeze(['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'webex.com']);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
  const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
  function hostname(value) {
    return typeof value === 'string' && value.length <= 253 && (value === '' ||
      value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  }
  function fromUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      return ['http:', 'https:'].includes(url.protocol) && hostname(host) ? host : '';
    } catch { return ''; }
  }
  function protectedHost(host, list = DEFAULT_PROTECTED) {
    return !host || list.some(item => host === item || host.endsWith(`.${item}`));
  }
  function protectedHosts(value = []) {
    if (!Array.isArray(value) || value.length > 64 || value.some(host => !host || !hostname(host))) throw new Error('Invalid protected host list');
    const result = [...new Set([...DEFAULT_PROTECTED, ...value])];
    if (result.length > 64) throw new Error('Too many protected hosts');
    return result;
  }
  function decodePairingCode(value, now = Date.now()) {
    if (typeof value !== 'string' || value.length > 2048 || !/^trv1\.[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid pairing code');
    let code;
    try {
      const encoded = value.slice(5).replace(/-/g, '+').replace(/_/g, '/');
      code = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    } catch { throw new Error('Invalid pairing code'); }
    if (!keys(code, ['v', 'port', 'secret', 'epoch', 'expiresAt', 'extensionId']) || code.v !== 1 ||
      !integer(code.port) || code.port < 1 || code.port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(code.secret) ||
      !token(code.epoch) || code.extensionId !== EXTENSION_ID || !integer(code.expiresAt) ||
      code.expiresAt <= now || code.expiresAt > now + LIMITS.pairingMs + 5000) throw new Error('Invalid or expired pairing code');
    return code;
  }
  const api = { EXTENSION_ID, LIMITS, DEFAULT_PROTECTED, integer, token, keys, hostname, fromUrl, protectedHost, protectedHosts, decodePairingCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TruveilTabProtocol = api;
})(globalThis);
