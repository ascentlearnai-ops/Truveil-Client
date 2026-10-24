'use strict';

const { createAuthRateLimiter } = require('./_lib/auth-rate-limit.cjs');
const MAX_BODY_BYTES = 4096;
const UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again later.';
const SEND_MESSAGE = 'If this email can sign in, you will receive a sign-in code.';
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
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Vary', 'Cookie, Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function production() {
  return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
}

function parseOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value && ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function local(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function validateOrigin(req) {
  const source = req.headers.origin;
  // GET fetches may omit Origin. Fetch Metadata and the host allowlist still apply.
  const origin = parseOrigin(source || (req.method === 'GET'
    ? `${production() || req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}` : ''));
  const allowed = new Set([
    'https://truveil-recruiter.vercel.app', 'https://truveil-secure.vercel.app',
    ...String(process.env.WAITLIST_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()),
    ...[process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
      .filter(Boolean).map(host => `https://${host}`),
  ]);
  if (!origin || origin.host !== req.headers.host
    || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
    || (production() && origin.protocol !== 'https:')
    || (!allowed.has(origin.origin) && (production() || !local(origin)))) {
    throw new RequestError(403, 'Request origin is not allowed.');
  }
  return origin;
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
  if (Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body) || '') > MAX_BODY_BYTES) {
    throw new RequestError(413, 'Request body is too large.');
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { throw new RequestError(400, 'Invalid JSON.'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'Invalid sign-in request.');
  }
  const fields = {
    send: ['action', 'email'], verify: ['action', 'email', 'code'], logout: ['action'],
  };
  if (!Object.hasOwn(fields, body.action) || Object.keys(body).some(key => !fields[body.action].includes(key))) {
    throw new RequestError(400, 'Invalid sign-in request.');
  }
  if (body.action !== 'logout') {
    if (typeof body.email !== 'string') throw new RequestError(400, 'Enter a valid email address.');
    body.email = body.email.trim().toLowerCase();
    if (body.email.length > 254 || !/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[a-z]{2,63}$/i.test(body.email)) {
      throw new RequestError(400, 'Enter a valid email address.');
    }
  }
  if (body.action === 'verify' && (typeof body.code !== 'string' || !/^\d{6,8}$/.test(body.code))) {
    throw new RequestError(400, 'Enter the sign-in code from your email.');
  }
  return body;
}

function configuration() {
  const url = parseOrigin(process.env.SUPABASE_URL || process.env.TRUVEIL_SUPABASE_URL);
  const key = process.env.SUPABASE_ANON_KEY || process.env.TRUVEIL_SUPABASE_ANON_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY;
  let publicKey = typeof key === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (typeof key === 'string' && TOKEN.test(key)) {
    // Inspect the configured key's role; Supabase still validates its signature.
    try { publicKey = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))?.role === 'anon'; }
    catch { publicKey = false; }
  }
  if (!url || (!url.hostname.endsWith('.supabase.co') && !(!production() && local(url)))
    || (url.protocol !== 'https:' && !(!production() && local(url)))
    || !publicKey) throw new RequestError(503, UNAVAILABLE);
  return { url: url.origin, key };
}

function cookieName(origin) {
  return origin.protocol === 'https:' ? '__Host-truveil_session' : 'truveil_session';
}

function setCookie(res, origin, token, lifetime) {
  res.setHeader('Set-Cookie', `${cookieName(origin)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${origin.protocol === 'https:' ? '; Secure' : ''}`);
}

function accessToken(req, origin) {
  const matches = String(req.headers.cookie || '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(`${cookieName(origin)}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(cookieName(origin).length + 1);
  return value.length <= 3500 && TOKEN.test(value) ? value : null;
}

async function upstream(config, route, options = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: config.key };
  // Modern API keys are not JWTs. User sessions override legacy anon Bearer auth.
  if (options.token || TOKEN.test(config.key)) {
    headers.Authorization = `Bearer ${options.token || config.key}`;
  }
  return fetch(`${config.url}/auth/v1/${route}`, {
    method: options.method || 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
}

function providerError(response, action, res) {
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    res.setHeader('Retry-After', String(Number.isInteger(retry) && retry > 0 && retry <= 3600 ? retry : 60));
    throw new RequestError(429, 'Too many attempts. Please wait before trying again.');
  }
  if (action === 'verify' && [400, 401, 403, 422].includes(response.status)) {
    throw new RequestError(401, 'That code is invalid or expired. Request a new code.');
  }
  throw new RequestError(503, UNAVAILABLE);
}

function createHandler() {
  const consume = createAuthRateLimiter();
  return async function auth(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'Method not allowed.' });
  }
  try {
    const origin = validateOrigin(req);
    const body = req.method === 'POST' ? await readBody(req) : null;
    const token = accessToken(req, origin);
    if (body?.action === 'logout') setCookie(res, origin, '', 0);
    if (body?.action === 'logout' && !token) return send(res, 200, { ok: true, user: null });
    const config = configuration();
    if (body && ['send', 'verify'].includes(body.action)) {
      const limit = consume(req, body.action, body.email);
      if (limit.unavailable) throw new RequestError(503, UNAVAILABLE);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfter));
        throw new RequestError(429, 'Too many attempts. Please wait before trying again.');
      }
    }
    if (req.method === 'GET') {
      if (!token) return send(res, 200, { ok: true, user: null });
      const response = await upstream(config, 'user', { method: 'GET', token });
      if ([401, 403].includes(response.status)) {
        setCookie(res, origin, '', 0);
        return send(res, 200, { ok: true, user: null });
      }
      if (!response.ok) providerError(response, 'session', res);
      const user = await response.json();
      if (!user?.id || typeof user.email !== 'string') throw new RequestError(503, UNAVAILABLE);
      return send(res, 200, { ok: true, user: { email: user.email } });
    }
    if (body.action === 'send') {
      // GoTrue's create_user is the REST equivalent of shouldCreateUser: false.
      const response = await upstream(config, 'otp', { body: { email: body.email, create_user: false } });
      if (!response.ok && ![400, 403, 404, 422].includes(response.status)) providerError(response, 'send', res);
      const result = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new RequestError(503, UNAVAILABLE);
      }
      const code = typeof result.error_code === 'string' ? result.error_code : result.code;
      // GoTrue uses this exact OTP error for unknown users with create_user: false.
      const unknownOtp = (code === 'otp_disabled' || typeof code !== 'string')
        && (result.msg || result.message || result.error_description) === 'Signups not allowed for otp';
      const accountError = unknownOtp || ['signup_disabled', 'user_not_found', 'user_sso_managed',
        'email_not_confirmed', 'user_banned', 'identity_not_found'].includes(code);
      if (!response.ok && !accountError) providerError(response, 'send', res);
      if (response.ok && (result.error || result.error_code || result.code)) throw new RequestError(503, UNAVAILABLE);
      return send(res, 200, { ok: true, message: SEND_MESSAGE });
    }
    if (body.action === 'verify') {
      const response = await upstream(config, 'verify', {
        body: { email: body.email, token: body.code, type: 'email' },
      });
      if (!response.ok) providerError(response, 'verify', res);
      const result = await response.json();
      if (typeof result?.access_token !== 'string' || result.access_token.length > 3500
        || !TOKEN.test(result.access_token) || result.token_type !== 'bearer'
        || !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 86400
        || !result.user?.id || result.user.email?.toLowerCase() !== body.email) {
        throw new RequestError(503, UNAVAILABLE);
      }
      // No refresh token is stored: expiry requires another email sign-in.
      setCookie(res, origin, result.access_token, Math.min(result.expires_in, 3600));
      return send(res, 200, { ok: true, user: { email: result.user.email } });
    }
    const response = await upstream(config, 'logout?scope=local', { token });
    if (!response.ok && ![401, 403, 404].includes(response.status)) providerError(response, 'logout', res);
    return send(res, 200, { ok: true, user: null });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 503;
    if (status === 503) res.setHeader('Retry-After', '60');
    return send(res, status, { ok: false, error: error instanceof RequestError ? error.message : UNAVAILABLE });
  }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
