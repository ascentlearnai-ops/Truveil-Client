'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const waitlist = require('./api/waitlist.js');
const auth = require('./api/auth.js');
const { createAuthRateLimiter } = require('./api/_lib/auth-rate-limit.cjs');

const VALID = { email: ' Person@Example.com ', name: ' Person ', audience: 'recruiter', company: ' Team ', consent: true, website: '' };
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.test_signature';
const legacyKey = role => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test_signature`;
const ANON_KEY = legacyKey('anon');
const SERVICE_KEY = legacyKey('service_role');
const PUBLISHABLE_KEY = 'sb_publishable_test_only';
const SECRET_KEY = 'sb_secret_test_only';
const AUTH_KEY_NAMES = ['SUPABASE_ANON_KEY', 'TRUVEIL_SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'];
const WAITLIST_KEY_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'];

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function request(base, route, data, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (data === undefined ? undefined : JSON.stringify(data));
    const headers = { Origin: base, 'Content-Type': 'application/json', ...options.headers };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const req = http.request(`${base}${route}`, { method: options.method || 'POST', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (options.fragmented) {
      req.write(payload.slice(0, 4500));
      setTimeout(() => req.end(payload.slice(4500)), 50);
    } else if (options.chunked) {
      req.write(payload.slice(0, 3000));
      req.end(payload.slice(3000));
    } else req.end(payload);
  });
}

test('website APIs over real HTTP with a local Supabase fake', async t => {
  const names = ['SUPABASE_URL', ...WAITLIST_KEY_NAMES, ...AUTH_KEY_NAMES, 'TRUVEIL_SUPABASE_URL',
    'WAITLIST_RATE_LIMIT_SALT', 'WAITLIST_ALLOWED_ORIGINS', 'VERCEL',
    'NODE_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'AUTH_RATE_LIMIT_SALT'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  names.forEach(name => { delete process.env[name]; });
  let fault;
  let preparedBody = 'raw';
  let authHandler = auth.createHandler();
  t.beforeEach(() => {
    authHandler = auth.createHandler();
    [...AUTH_KEY_NAMES, ...WAITLIST_KEY_NAMES].forEach(name => { delete process.env[name]; });
    process.env.SUPABASE_ANON_KEY = ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  });
  const calls = [];
  const rows = new Map();
  const rates = new Map();
  const fake = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ route: req.url, method: req.method, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (fault && (!fault.route || fault.route === req.url)) {
      const current = fault;
      fault = undefined;
      if (current.delay) await new Promise(resolve => setTimeout(resolve, current.delay));
      res.writeHead(current.status || 200, current.headers || {});
      res.end(current.raw ?? JSON.stringify(current.body));
      return;
    }
    if (req.url === '/rest/v1/rpc/register_waitlist_signup') {
      const count = (rates.get(body.p_rate_key) || 0) + 1;
      rates.set(body.p_rate_key, count);
      if (count > 5) return res.end(JSON.stringify({ accepted: false, retry_after: 900 }));
      const key = `${body.p_email}:${body.p_audience}`;
      if (!rows.has(key)) rows.set(key, body);
      return res.end(JSON.stringify({ accepted: true, retry_after: 0 }));
    }
    if (req.url === '/auth/v1/otp') return res.end('{}');
    if (req.url === '/auth/v1/verify') {
      return res.end(JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: 'never-return-this',
        token_type: 'bearer', expires_in: 3600, user: { id: 'user-1', email: body.email } }));
    }
    if (req.url === '/auth/v1/user') return res.end(JSON.stringify({ id: 'user-1', email: 'person@example.com' }));
    if (req.url === '/auth/v1/logout?scope=local') { res.writeHead(204); return res.end(); }
    res.writeHead(404);
    res.end('{}');
  });
  const provider = await listen(fake);
  process.env.SUPABASE_URL = provider;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  process.env.WAITLIST_RATE_LIMIT_SALT = 'test-only-shared-secret-at-least-32-characters';
  const appHandler = async (req, res) => {
    if (preparedBody !== 'raw' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = preparedBody === 'object' ? JSON.parse(raw) : preparedBody === 'buffer' ? Buffer.from(raw) : raw;
    }
    await (req.url === '/api/auth' ? authHandler : waitlist)(req, res);
  };
  const app = http.createServer(appHandler);
  const otherApp = http.createServer(appHandler);
  const base = await listen(app);
  const otherBase = await listen(otherApp);
  t.after(async () => {
    await close(app);
    await close(otherApp);
    await close(fake);
    names.forEach(name => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  });

  await t.test('waitlist normalizes and persists only validated fields', async () => {
    const result = await request(base, '/api/waitlist', VALID);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.headers['cache-control'], 'no-store');
    const call = calls.at(-1);
    assert.equal(call.headers.apikey, SERVICE_KEY);
    assert.equal(call.headers.authorization, `Bearer ${SERVICE_KEY}`);
    assert.deepEqual({ ...call.body, p_rate_key: 'redacted' }, {
      p_email: 'person@example.com', p_name: 'Person', p_company: 'Team', p_audience: 'recruiter',
      p_consent: true, p_source_origin: base, p_rate_key: 'redacted',
    });
    assert.match(call.body.p_rate_key, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(call.body), /127\.0\.0\.1(?!:)/);
    assert.equal(rows.size, 1);
  });

  await t.test('duplicates do not overwrite and rate limits span separate HTTP instances', async () => {
    assert.equal((await request(otherBase, '/api/waitlist', { ...VALID, name: 'Do not overwrite' })).status, 200);
    assert.equal(rows.size, 1);
    assert.equal(rows.values().next().value.p_name, 'Person');
    for (let i = 0; i < 3; i++) assert.equal((await request(base, '/api/waitlist', VALID)).status, 200);
    const limited = await request(otherBase, '/api/waitlist', VALID);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.ok, false);
    assert.equal(limited.headers['retry-after'], '900');
    rates.clear();
  });

  await t.test('candidate and recruiter signups are distinct', async () => {
    assert.equal((await request(base, '/api/waitlist', { ...VALID, audience: 'candidate' })).status, 200);
    assert.equal(rows.size, 2);
  });

  await t.test('invalid fields, consent, honeypot and JSON never call storage', async () => {
    const before = calls.length;
    for (const body of [null, [], {}, { ...VALID, email: 'bad' }, { ...VALID, email: '.bad@example.com' },
      { ...VALID, email: 'a..b@example.com' }, { ...VALID, email: 'a'.repeat(65) + '@example.com' },
      { ...VALID, name: 3 }, { ...VALID, name: 'x'.repeat(101) }, { ...VALID, name: 'bad\nname' },
      { ...VALID, company: 'x'.repeat(161) }, { ...VALID, audience: 'admin' },
      { ...VALID, consent: false }, { ...VALID, consent: 'true' }, { ...VALID, website: 'bot' },
      { ...VALID, website: undefined }, { ...VALID, extra: true }]) {
      assert.equal((await request(base, '/api/waitlist', body)).status, 400);
    }
    assert.equal((await request(base, '/api/waitlist', undefined, { raw: '{broken' })).status, 400);
    assert.equal(calls.length, before);
  });

  await t.test('both endpoints enforce origin, method, media type and byte limits', async () => {
    const before = calls.length;
    for (const route of ['/api/waitlist', '/api/auth']) {
      const data = route.endsWith('auth') ? { action: 'send', email: 'person@example.com' } : VALID;
      for (const Origin of ['https://evil.example', 'null', `${base}/path`, undefined]) {
        assert.equal((await request(base, route, data, { headers: { Origin } })).status, 403);
      }
      assert.equal((await request(base, route, data, { headers: { Origin: 'https://evil.example', Host: 'evil.example' } })).status, 403);
      assert.equal((await request(base, route, data, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await request(base, route, data, { method: 'PUT' })).status, 405);
      assert.equal((await request(base, route, data, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal((await request(base, route, data, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
      assert.equal((await request(base, route, undefined, { raw: 'x'.repeat(5000) })).status, 413);
      assert.equal((await request(base, route, undefined, { raw: 'x'.repeat(5000), chunked: true })).status, 413);
      assert.equal((await request(base, route, undefined, { raw: 'x'.repeat(5000), fragmented: true })).status, 413);
    }
    assert.equal(calls.length, before);
  });

  await t.test('Vercel-preparsed object, string and buffer bodies remain supported', async () => {
    for (const mode of ['object', 'string', 'buffer']) {
      preparedBody = mode;
      rates.clear();
      assert.equal((await request(base, '/api/waitlist', VALID)).status, 200);
      assert.equal((await request(base, '/api/auth', { action: 'send', email: 'person@example.com' })).status, 200);
    }
    preparedBody = 'raw';
  });

  await t.test('waitlist missing configuration, bad upstream data and redirects fail closed', async () => {
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WAITLIST_RATE_LIMIT_SALT']) {
      const value = process.env[name];
      delete process.env[name];
      const result = await request(base, '/api/waitlist', VALID);
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      process.env[name] = value;
    }
    for (const failure of [{ status: 500, body: { error: 'SECRET DATABASE ERROR' } },
      { status: 404, body: {} }, { status: 200, body: {} }, { status: 200, body: { accepted: true } },
      { status: 200, raw: 'not-json' }, { status: 302, headers: { location: `${provider}/leak` }, body: {} }]) {
      fault = failure;
      const result = await request(base, '/api/waitlist', VALID);
      assert.equal(result.status, 503);
      assert.doesNotMatch(result.text, /SECRET|test_signature|sb_secret_/);
    }
    assert.ok(calls.every(call => call.route !== '/leak'));
  });

  await t.test('untrusted forwarded IP headers cannot bypass waitlist rate limiting locally', async () => {
    rates.clear();
    const keys = [];
    for (let i = 0; i < 6; i++) {
      const result = await request(base, '/api/waitlist', VALID, {
        headers: { 'X-Forwarded-For': `203.0.113.${i}`, 'X-Vercel-Forwarded-For': `203.0.113.${i}` },
      });
      keys.push(calls.at(-1).body.p_rate_key);
      assert.equal(result.status, i < 5 ? 200 : 429);
    }
    assert.equal(new Set(keys).size, 1);
    rates.clear();
  });

  await t.test('send requests existing-user OTP without exposing keys or creating accounts', async () => {
    const result = await request(base, '/api/auth', { action: 'send', email: ' Person@Example.com ' });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1).body, { email: 'person@example.com', create_user: false });
    assert.equal(calls.at(-1).headers.apikey, ANON_KEY);
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${ANON_KEY}`);
    assert.doesNotMatch(result.text, /test_signature|sb_secret_|access_token|refresh_token/);
    assert.equal(result.headers['set-cookie'], undefined);
  });

  await t.test('verify returns only the email and a secure HttpOnly host-only cookie', async () => {
    const secureOrigin = base.replace('http:', 'https:');
    const result = await request(base, '/api/auth', { action: 'verify', email: 'person@example.com', code: '123456' },
      { headers: { Origin: secureOrigin } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, user: { email: 'person@example.com' } });
    assert.deepEqual(calls.at(-1).body, { email: 'person@example.com', token: '123456', type: 'email' });
    const cookie = result.headers['set-cookie'][0];
    assert.ok(cookie.startsWith(`__Host-truveil_session=${ACCESS_TOKEN};`));
    assert.match(cookie, /Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
    assert.doesNotMatch(cookie, /Domain=/);
    assert.doesNotMatch(result.text, /access_token|refresh_token|never-return-this|test_signature/);
    assert.match(result.headers['cache-control'], /no-store/);
  });

  await t.test('session validates the cookie against Supabase and works without GET Origin', async () => {
    assert.deepEqual((await request(base, '/api/auth', undefined, { method: 'GET', headers: { Origin: undefined } })).body,
      { ok: true, user: null });
    const result = await request(base, '/api/auth', undefined, { method: 'GET', headers: { Cookie: `truveil_session=${ACCESS_TOKEN}` } });
    assert.equal(result.status, 200);
    assert.equal(result.body.user.email, 'person@example.com');
    assert.equal(calls.at(-1).route, '/auth/v1/user');
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    fault = { status: 401, body: { error: 'expired' } };
    const expired = await request(base, '/api/auth', undefined, { method: 'GET', headers: { Cookie: `truveil_session=${ACCESS_TOKEN}` } });
    assert.deepEqual(expired.body, { ok: true, user: null });
    assert.match(expired.headers['set-cookie'][0], /Max-Age=0/);
  });

  await t.test('logout clears the cookie and signs out only this session', async () => {
    const result = await request(base, '/api/auth', { action: 'logout' }, { headers: { Cookie: `truveil_session=${ACCESS_TOKEN}` } });
    assert.equal(result.status, 200);
    assert.equal(calls.at(-1).route, '/auth/v1/logout?scope=local');
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.match(result.headers['set-cookie'][0], /Max-Age=0/);
    fault = { status: 500, body: { error: 'private provider detail' } };
    const failed = await request(base, '/api/auth', { action: 'logout' }, { headers: { Cookie: `truveil_session=${ACCESS_TOKEN}` } });
    assert.equal(failed.status, 503);
    assert.match(failed.headers['set-cookie'][0], /Max-Age=0/);
    assert.doesNotMatch(failed.text, /private provider detail/);
  });

  await t.test('auth schema and provider failures never create cookies or fake success', async () => {
    for (const body of [null, [], {}, { action: 'signup', email: 'person@example.com' },
      { action: 'send', email: 'bad' }, { action: 'send', email: 'person@example.com', shouldCreateUser: true },
      { action: 'verify', email: 'person@example.com', code: 123456 },
      { action: 'verify', email: 'person@example.com', code: '12' }]) {
      assert.equal((await request(base, '/api/auth', body)).status, 400);
    }
    const verify = { action: 'verify', email: 'person@example.com', code: '123456' };
    for (const failure of [{ status: 400, expected: 401, body: { error: 'SECRET' } },
      { status: 429, expected: 429, headers: { 'Retry-After': '123' }, body: {} },
      { status: 500, expected: 503, body: {} }, { status: 200, expected: 503, body: {} }]) {
      fault = failure;
      const result = await request(base, '/api/auth', verify);
      assert.equal(result.status, failure.expected);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.doesNotMatch(result.text, /SECRET/);
      if (failure.status === 429) assert.equal(result.headers['retry-after'], '123');
    }
    delete process.env.SUPABASE_ANON_KEY;
    assert.equal((await request(base, '/api/auth', { action: 'send', email: 'person@example.com' })).status, 503);
    process.env.SUPABASE_ANON_KEY = ANON_KEY;
  });

  await t.test('auth rejects failed sends, malformed sessions, mismatched users and redirect responses', async () => {
    const verify = { action: 'verify', email: 'person@example.com', code: '123456' };
    const validSession = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 3600,
      user: { id: 'user-1', email: 'person@example.com' } };
    for (const body of [{ ...validSession, user: { id: 'user-2', email: 'other@example.com' } },
      { ...validSession, access_token: 'not-a-token' }, { ...validSession, expires_in: -1 }]) {
      fault = { status: 200, body };
      const result = await request(base, '/api/auth', verify);
      assert.equal(result.status, 503);
      assert.equal(result.headers['set-cookie'], undefined);
    }
    for (const failure of [{ status: 422, expected: 503, body: { error: 'private user details' } },
      { status: 200, expected: 503, raw: 'not-json' },
      { status: 302, expected: 503, headers: { location: `${provider}/leak` }, body: {} }]) {
      fault = failure;
      const result = await request(base, '/api/auth', { action: 'send', email: 'person@example.com' });
      assert.equal(result.status, failure.expected);
      assert.doesNotMatch(result.text, /private user details/);
    }
    const before = calls.length;
    assert.equal((await request(base, '/api/auth', undefined, { method: 'GET', headers: {
      Cookie: `truveil_session=${ACCESS_TOKEN}; truveil_session=${ACCESS_TOKEN}`,
    } })).body.user, null);
    assert.equal(calls.length, before);
    assert.ok(calls.every(call => call.route !== '/leak'));
  });

  await t.test('production rejects insecure origins and insecure provider URLs', async () => {
    process.env.VERCEL = '1';
    for (const route of ['/api/waitlist', '/api/auth']) {
      const body = route.endsWith('auth') ? { action: 'send', email: 'person@example.com' } : VALID;
      assert.equal((await request(base, route, body)).status, 403);
      assert.equal((await request(base, route, body, { headers: {
        Origin: 'https://truveil-recruiter.vercel.app', Host: 'truveil-recruiter.vercel.app',
        'X-Vercel-Forwarded-For': '203.0.113.1',
      } })).status, 503);
    }
    delete process.env.VERCEL;
  });

  await t.test('unknown and non-OTP accounts have the identical generic send response', async () => {
    const sendCode = email => request(base, '/api/auth', { action: 'send', email });
    const valid = await sendCode('valid@example.com');
    for (const [status, code] of [[422, 'otp_disabled'], [400, 'signup_disabled'],
      [404, 'user_not_found'], [403, 'user_sso_managed'], [400, 'email_not_confirmed'],
      [403, 'user_banned'], [404, 'identity_not_found']]) {
      for (const body of [
        { code, message: code === 'otp_disabled' ? 'Signups not allowed for otp' : 'private account information' },
        { code: status, error_code: code, msg: code === 'otp_disabled' ? 'Signups not allowed for otp' : 'private account information' },
      ]) {
        authHandler = auth.createHandler();
        fault = { status, body };
        const result = await sendCode(`${code}@example.com`);
        assert.equal(result.status, valid.status);
        assert.deepEqual(result.body, valid.body);
        assert.equal(result.headers['set-cookie'], undefined);
        assert.doesNotMatch(result.text, /private account|Signups not allowed/);
      }
    }
    fault = { status: 400, body: { code: 400, msg: 'Signups not allowed for otp' } };
    assert.deepEqual((await sendCode('legacy-unknown@example.com')).body, valid.body);
    for (const status of [429, 500, 503, 401]) {
      fault = { status, body: { code: 'upstream_failure' } };
      const result = await sendCode(`failure${status}@example.com`);
      assert.equal(result.status, status === 429 ? 429 : 503);
      assert.equal(result.body.ok, false);
    }
  });

  await t.test('modern and legacy keys use the correct wire headers through every supported env name', async () => {
    for (const name of AUTH_KEY_NAMES) {
      for (const key of [PUBLISHABLE_KEY, ANON_KEY]) {
        AUTH_KEY_NAMES.forEach(variable => { delete process.env[variable]; });
        process.env[name] = key;
        authHandler = auth.createHandler();
        for (const action of ['send', 'verify', 'session', 'logout']) {
          const withSession = ['session', 'logout'].includes(action);
          const result = await request(base, '/api/auth', action === 'session' ? undefined : {
            action, ...(action === 'logout' ? {} : { email: 'person@example.com' }),
            ...(action === 'verify' ? { code: '123456' } : {}),
          }, { method: action === 'session' ? 'GET' : 'POST', headers: {
            Cookie: `truveil_session=${ACCESS_TOKEN}`, Authorization: 'Bearer untrusted-client-header',
          } });
          assert.equal(result.status, 200, `${name}: ${action}`);
          assert.equal(calls.at(-1).headers.apikey, key);
          assert.equal(calls.at(-1).headers.authorization,
            withSession ? `Bearer ${ACCESS_TOKEN}` : key === ANON_KEY ? `Bearer ${ANON_KEY}` : undefined);
          assert.doesNotMatch(result.text, /test_signature|sb_publishable_|sb_secret_|untrusted-client-header/);
        }
      }
    }
    for (const name of WAITLIST_KEY_NAMES) {
      for (const key of [SECRET_KEY, SERVICE_KEY]) {
        WAITLIST_KEY_NAMES.forEach(variable => { delete process.env[variable]; });
        process.env[name] = key;
        rates.clear();
        const result = await request(base, '/api/waitlist', VALID, { headers: {
          Cookie: `truveil_session=${ACCESS_TOKEN}`, Authorization: `Bearer ${ACCESS_TOKEN}`,
        } });
        assert.equal(result.status, 200, name);
        assert.equal(calls.at(-1).headers.apikey, key);
        assert.equal(calls.at(-1).headers.authorization, key === SERVICE_KEY ? `Bearer ${SERVICE_KEY}` : undefined);
        assert.doesNotMatch(result.text, /test_signature|sb_secret_/);
      }
    }
    rates.clear();
  });

  await t.test('key configuration rejects incorrect roles and malformed keys before contacting Supabase', async () => {
    const malformed = ['', ' ', 'opaque-key', 'sb_publishable_', 'sb_secret_',
      'sb_publishable_bad.key', 'sb_secret_bad.key', ACCESS_TOKEN,
      legacyKey('authenticated'), legacyKey('admin'), 'e30.bm90LWpzb24.signature', 'e30.bnVsbA.signature'];
    for (const [route, names, invalidKeys, body] of [
      ['/api/auth', AUTH_KEY_NAMES, [SECRET_KEY, SERVICE_KEY, ...malformed], { action: 'send', email: 'person@example.com' }],
      ['/api/waitlist', WAITLIST_KEY_NAMES, [PUBLISHABLE_KEY, ANON_KEY, ...malformed], VALID],
    ]) {
      for (const name of names) {
        for (const key of invalidKeys) {
          names.forEach(variable => { delete process.env[variable]; });
          process.env[name] = key;
          const before = calls.length;
          const result = await request(base, route, body);
          assert.equal(result.status, 503, `${route}: ${name}, invalid key index ${invalidKeys.indexOf(key)}`);
          assert.equal(result.body.ok, false);
          assert.equal(result.headers['retry-after'], '60');
          assert.equal(result.headers['set-cookie'], undefined);
          assert.equal(calls.length, before);
          assert.doesNotMatch(result.text, /test_signature|sb_secret_|sb_publishable_|opaque-key/);
        }
      }
    }
  });

  await t.test('existing env names retain precedence and never fall back around an incorrect key role', async () => {
    process.env.SUPABASE_PUBLISHABLE_KEY = SECRET_KEY;
    process.env.TRUVEIL_SUPABASE_ANON_KEY = SECRET_KEY;
    process.env.SUPABASE_SECRET_KEY = PUBLISHABLE_KEY;
    assert.equal((await request(base, '/api/auth', { action: 'send', email: 'person@example.com' })).status, 200);
    assert.equal(calls.at(-1).headers.apikey, ANON_KEY);
    rates.clear();
    assert.equal((await request(base, '/api/waitlist', VALID)).status, 200);
    assert.equal(calls.at(-1).headers.apikey, SERVICE_KEY);
    process.env.SUPABASE_ANON_KEY = SERVICE_KEY;
    process.env.TRUVEIL_SUPABASE_ANON_KEY = ANON_KEY;
    process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = ANON_KEY;
    process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
    const before = calls.length;
    assert.equal((await request(base, '/api/auth', { action: 'send', email: 'person@example.com' })).status, 503);
    assert.equal((await request(base, '/api/waitlist', VALID)).status, 503);
    assert.equal(calls.length, before);
    delete process.env.SUPABASE_ANON_KEY;
    assert.equal((await request(base, '/api/auth', { action: 'send', email: 'person@example.com' })).status, 200);
    assert.equal(calls.at(-1).headers.apikey, ANON_KEY);
    rates.clear();
  });

  await t.test('send acknowledges only known account errors, never SMTP or configuration failures', async () => {
    const sendCode = { action: 'send', email: 'person@example.com' };
    for (const status of [400, 403, 404, 422]) {
      for (const body of [
        { code: 'email_address_not_authorized', message: 'private SMTP restriction' },
        { code: status, error_code: 'email_address_not_authorized', msg: 'private SMTP restriction' },
        { code: 'email_provider_disabled' }, { code: 'otp_disabled', message: 'OTP is disabled' },
        { code: 'email_address_invalid' }, { code: 'validation_failed' }, { code: 'bad_jwt' },
        { code: 'unexpected_failure' }, { error: 'private SMTP failure' }, {},
        { code: 'email_provider_disabled', message: 'Signups not allowed for otp' },
      ]) {
        authHandler = auth.createHandler();
        fault = { status, body };
        const result = await request(base, '/api/auth', sendCode);
        assert.equal(result.status, 503, `${status}: ${JSON.stringify(body)}`);
        assert.equal(result.body.ok, false);
        assert.equal(result.headers['retry-after'], '60');
        assert.equal(result.headers['set-cookie'], undefined);
        assert.doesNotMatch(result.text, /private|SMTP|email_address|Signups not allowed/);
      }
    }
    for (const failure of [
      { status: 500, body: { code: 'user_not_found' } },
      { status: 429, body: { code: 'user_not_found' } },
      { status: 200, body: { error: 'private SMTP failure' } },
      { status: 200, body: { error_code: 'email_address_not_authorized' } },
      { status: 200, body: { code: 'email_provider_disabled' } },
      { status: 422, body: [] }, { status: 422, body: null }, { status: 400, raw: 'not-json' },
    ]) {
      authHandler = auth.createHandler();
      fault = failure;
      const result = await request(base, '/api/auth', sendCode);
      assert.equal(result.status, failure.status === 429 ? 429 : 503);
      assert.equal(result.body.ok, false);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.doesNotMatch(result.text, /private|SMTP|email_address/);
    }
  });

  await t.test('send limiter blocks by normalized email and IP without hitting the provider', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await request(base, '/api/auth', { action: 'send', email: ' Limit@Example.com ' })).status, 200);
    }
    const before = calls.length;
    const result = await request(otherBase, '/api/auth', { action: 'send', email: 'limit@example.com' }, {
      headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Vercel-Forwarded-For': '203.0.113.9' },
    });
    assert.equal(result.status, 429);
    assert.ok(Number(result.headers['retry-after']) > 0);
    assert.equal(calls.length, before);
    authHandler = auth.createHandler();
    for (let i = 0; i < 10; i++) {
      assert.equal((await request(base, '/api/auth', { action: 'send', email: `ip-limit${i}@example.com` })).status, 200);
    }
    const sent = calls.length;
    assert.equal((await request(base, '/api/auth', { action: 'send', email: 'ip-limit-new@example.com' })).status, 429);
    assert.equal(calls.length, sent);
  });

  await t.test('failed verify attempts are limited and logout/session stay available', async () => {
    const body = { action: 'verify', email: 'verify-limit@example.com', code: '123456' };
    for (let i = 0; i < 10; i++) {
      fault = { status: 400, body: { code: 'otp_expired' } };
      assert.equal((await request(base, '/api/auth', body)).status, 401);
    }
    const before = calls.length;
    assert.equal((await request(base, '/api/auth', body)).status, 429);
    assert.equal(calls.length, before);
    assert.equal((await request(base, '/api/auth', undefined, { method: 'GET' })).status, 200);
    assert.equal((await request(base, '/api/auth', { action: 'logout' })).status, 200);
    assert.equal((await request(base, '/api/auth', { action: 'send', email: body.email })).status, 200);
  });

  await t.test('local limiter bounds storage, expires counters and normalizes client identities', () => {
    let timestamp = 0;
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const consume = createAuthRateLimiter({ now: () => timestamp, maxEntries: 3, salt: 'test-salt' });
    assert.equal(consume(req, 'send', 'one@example.com').allowed, true);
    assert.equal(consume(req, 'send', 'two@example.com').allowed, true);
    assert.equal(consume(req, 'send', 'three@example.com').allowed, false);
    timestamp = 600001;
    assert.equal(consume(req, 'send', 'three@example.com').allowed, true);
    const emails = createAuthRateLimiter({ salt: 'test-salt' });
    for (let i = 0; i < 3; i++) {
      assert.equal(emails({ headers: {}, socket: { remoteAddress: `203.0.113.${i}` } }, 'send', 'same@example.com').allowed, true);
    }
    assert.equal(emails(req, 'send', ' SAME@EXAMPLE.COM ').allowed, false);
    const verifyIp = createAuthRateLimiter({ salt: 'test-salt' });
    for (let i = 0; i < 50; i++) assert.equal(verifyIp(req, 'verify', `test${i}@example.com`).allowed, true);
    assert.equal(verifyIp(req, 'verify', 'new@example.com').allowed, false);
    const savedSalt = process.env.WAITLIST_RATE_LIMIT_SALT;
    delete process.env.WAITLIST_RATE_LIMIT_SALT;
    const withoutSalt = createAuthRateLimiter();
    process.env.WAITLIST_RATE_LIMIT_SALT = savedSalt;
    for (let i = 0; i < 3; i++) assert.equal(withoutSalt(req, 'send', 'fallback@example.com').allowed, true);
    assert.equal(withoutSalt(req, 'send', 'fallback@example.com').allowed, false);
  });

  await t.test('auth transport timeout is not converted to enumeration-safe success', async () => {
    fault = { route: '/auth/v1/otp', delay: 5200, status: 200, body: {} };
    assert.equal((await request(base, '/api/auth', { action: 'send', email: 'timeout@example.com' })).status, 503);
  });

  await t.test('provider timeout returns honest 503', async () => {
    fault = { delay: 5200, status: 200, body: { accepted: true, retry_after: 0 } };
    const started = Date.now();
    assert.equal((await request(base, '/api/waitlist', VALID)).status, 503);
    assert.ok(Date.now() - started < 6500);
  });
});
