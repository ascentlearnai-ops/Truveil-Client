'use strict';

const { createHmac, randomBytes } = require('node:crypto');
const { isIP } = require('node:net');

const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { send: { ip: 10, email: 3 }, verify: { ip: 50, email: 10 } };

function clientIp(req) {
  let ip = process.env.VERCEL === '1' ? req.headers['x-vercel-forwarded-for'] : req.socket?.remoteAddress;
  if (typeof ip !== 'string' || !isIP(ip)) return null;
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
}

// Per-process defense in depth only; provider limits remain necessary across instances.
function createAuthRateLimiter({ now = Date.now, maxEntries = 10000,
  salt = process.env.AUTH_RATE_LIMIT_SALT || process.env.WAITLIST_RATE_LIMIT_SALT || randomBytes(32) } = {}) {
  const buckets = new Map();
  let nextSweep = 0;
  const digest = value => createHmac('sha256', salt).update(value).digest('hex');
  return function consume(req, action, email) {
    const ip = clientIp(req);
    if (!ip) return { allowed: false, unavailable: true };
    const timestamp = now();
    if (timestamp >= nextSweep || buckets.size + 2 > maxEntries) {
      for (const [key, bucket] of buckets) if (bucket.expires <= timestamp) buckets.delete(key);
      nextSweep = timestamp + 60000;
    }
    const entries = ['ip', 'email'].map(kind => ({
      key: digest(`${action}:${kind}:${kind === 'ip' ? ip : email.trim().toLowerCase()}`),
      limit: LIMITS[action][kind],
    }));
    let retryAfter = 0;
    for (const entry of entries) {
      const bucket = buckets.get(entry.key);
      if (bucket && bucket.expires > timestamp && bucket.count >= entry.limit) {
        retryAfter = Math.max(retryAfter, Math.ceil((bucket.expires - timestamp) / 1000));
      }
    }
    if (retryAfter) return { allowed: false, retryAfter };
    const missing = entries.filter(entry => !buckets.has(entry.key)).length;
    // Do not evict active counters under pressure, which would permit limit bypasses.
    if (buckets.size + missing > maxEntries) return { allowed: false, retryAfter: 60 };
    for (const { key } of entries) {
      const bucket = buckets.get(key);
      if (bucket && bucket.expires > timestamp) bucket.count += 1;
      else buckets.set(key, { count: 1, expires: timestamp + WINDOW_MS });
    }
    return { allowed: true };
  };
}

module.exports = { createAuthRateLimiter };
