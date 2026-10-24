'use strict';

const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');

const MAX_BODY_BYTES = 4096;
const UNAVAILABLE = 'Waitlist is temporarily unavailable. Please try again later.';
const FIELDS = new Set(['email', 'name', 'audience', 'company', 'consent', 'website']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function parseOrigin(value) {
  try {
    const url = new URL(value);
    if (url.origin !== value || !['https:', 'http:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function isLocal(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function validateOrigin(req, env) {
  const origin = parseOrigin(req.headers.origin);
  const production = env.VERCEL === '1' || env.NODE_ENV === 'production';
  if (!origin || origin.host !== req.headers.host
    || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
    || (production && origin.protocol !== 'https:')) {
    throw new RequestError(403, 'Request origin is not allowed.');
  }
  const allowed = new Set([
    'https://truveil-recruiter.vercel.app',
    'https://truveil-secure.vercel.app',
    ...String(env.WAITLIST_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()),
    ...[env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
      .filter(Boolean).map(host => `https://${host}`),
  ]);
  if (!allowed.has(origin.origin) && (production || !isLocal(origin))) {
    throw new RequestError(403, 'Request origin is not allowed.');
  }
  return origin.origin;
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
    || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    throw new RequestError(415, 'Use application/json.');
  }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new RequestError(413, 'Request body is too large.');
  }
  // Vercel can preparse JSON; raw Node HTTP requests arrive as a stream.
  let body = req.body;
  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        throw new RequestError(413, 'Request body is too large.');
      }
      chunks.push(bytes);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  if (Buffer.byteLength(serialized || '', 'utf8') > MAX_BODY_BYTES) {
    throw new RequestError(413, 'Request body is too large.');
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      throw new RequestError(400, 'Invalid JSON.');
    }
  }
  return body;
}

function validateSignup(body) {
  const invalid = () => { throw new RequestError(400, 'Check your details and consent, then try again.'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !FIELDS.has(key))) invalid();
  if (body.consent !== true || body.website !== ''
    || !['recruiter', 'candidate'].includes(body.audience)
    || typeof body.email !== 'string') invalid();
  const email = body.email.trim().toLowerCase();
  const parts = email.split('@');
  if (email.length > 254 || parts.length !== 2 || parts[0].length > 64
    || !/^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/i.test(parts[0])
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(parts[1])) invalid();
  const optionalText = (value, max) => {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > max || CONTROL_CHARACTERS.test(value)) invalid();
    return value.trim() || null;
  };
  return {
    p_email: email,
    p_name: optionalText(body.name, 100),
    p_company: optionalText(body.company, 160),
    p_audience: body.audience,
    p_consent: true,
  };
}

function configuration(env) {
  const url = parseOrigin(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  let serviceKey = typeof key === 'string' && /^sb_secret_[A-Za-z0-9_-]+$/.test(key);
  if (typeof key === 'string' && TOKEN.test(key)) {
    // Inspect the configured key's role; Supabase still validates its signature.
    try { serviceKey = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))?.role === 'service_role'; }
    catch { serviceKey = false; }
  }
  const salt = env.WAITLIST_RATE_LIMIT_SALT;
  const production = env.VERCEL === '1' || env.NODE_ENV === 'production';
  if (!url || (!url.hostname.endsWith('.supabase.co') && !(!production && isLocal(url)))
    || (url.protocol !== 'https:' && !(!production && isLocal(url)))
    || !serviceKey
    || typeof salt !== 'string' || salt.length < 32) {
    throw new RequestError(503, UNAVAILABLE);
  }
  return { url: url.origin, key, salt };
}

function rateKey(req, env, salt) {
  // Only trust Vercel's client-IP header in the Vercel runtime, never arbitrary proxies.
  let ip = env.VERCEL === '1' ? req.headers['x-vercel-forwarded-for'] : req.socket?.remoteAddress;
  if (typeof ip !== 'string' || !isIP(ip)) throw new RequestError(503, UNAVAILABLE);
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (isIP(ip) === 6) {
    ip = new URL(`http://[${ip}]/`).hostname;
  }
  return createHmac('sha256', salt).update(`waitlist-ip:${ip}`).digest('hex');
}

async function waitlist(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'Method not allowed.' });
  }
  try {
    const origin = validateOrigin(req, process.env);
    const signup = validateSignup(await readBody(req));
    const config = configuration(process.env);
    const key = rateKey(req, process.env, config.salt);
    const response = await fetch(`${config.url}/rest/v1/rpc/register_waitlist_signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        ...(TOKEN.test(config.key) ? { Authorization: `Bearer ${config.key}` } : {}),
      },
      body: JSON.stringify({ ...signup, p_source_origin: origin, p_rate_key: key }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new RequestError(503, UNAVAILABLE);
    const result = await response.json();
    if (result?.accepted === false && Number.isInteger(result.retry_after)
      && result.retry_after > 0 && result.retry_after <= 900) {
      res.setHeader('Retry-After', String(result.retry_after));
      return send(res, 429, { ok: false, error: 'Too many attempts. Please try again later.' });
    }
    if (result?.accepted !== true || result.retry_after !== 0) throw new RequestError(503, UNAVAILABLE);
    return send(res, 200, { ok: true, message: 'You are on the waitlist.' });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 503;
    if (status === 503) res.setHeader('Retry-After', '60');
    return send(res, status, { ok: false, error: error instanceof RequestError ? error.message : UNAVAILABLE });
  }
}

module.exports = waitlist;
