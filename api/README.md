# Website APIs

These dependency-free CommonJS handlers target the Vercel Node.js runtime (Node 22+).
Each linked website carries its own identical copy; neither imports the desktop app.
Do not place server credentials in browser runtime config or a `NEXT_PUBLIC_` variable.

## Server Environment

Both `truveil-recruiter` and `truveil-secure` need:

- `SUPABASE_URL`: project origin, without a trailing slash.
- `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`): public `sb_publishable_...`
  key or legacy JWT with role `anon`, used server-side for OTP auth.
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`): server-only `sb_secret_...`
  key or legacy JWT with role `service_role`, used only for the waitlist RPC.
- `WAITLIST_RATE_LIMIT_SALT`: a random secret of at least 32 characters, identical on both projects.
- `WAITLIST_ALLOWED_ORIGINS`: optional comma-separated exact HTTPS origins for custom domains.
- `AUTH_RATE_LIMIT_SALT`: optional auth-only HMAC salt; defaults to the waitlist salt or a random per-process key.

Auth also accepts the existing `TRUVEIL_SUPABASE_URL` and `TRUVEIL_SUPABASE_ANON_KEY`
names. Key precedence is `SUPABASE_ANON_KEY`, `TRUVEIL_SUPABASE_ANON_KEY`, then
`SUPABASE_PUBLISHABLE_KEY`; waitlist prefers `SUPABASE_SERVICE_ROLE_KEY` over
`SUPABASE_SECRET_KEY`. Set one key variable per endpoint. An incorrect selected
key fails with 503, without falling back to another variable or contacting Supabase.
Auth rejects secret/service-role keys; waitlist rejects publishable/anon keys.
Unrecognized keys are rejected even in local tests. JWT role inspection is a
configuration guard, not signature verification; Supabase validates credentials.

Modern keys are sent only in `apikey`, never as Bearer tokens. Legacy JWT API keys
also use `Authorization: Bearer <key>` for compatibility. Auth session validation
and logout use the user's access JWT in Authorization with the public key in apikey.
The two canonical Vercel domains and Vercel's current deployment/production URL
environment variables are recognized automatically. No wildcard domains or CORS.
Requests must originate from the same host as the API. Plain HTTP loopback is
supported only outside production for local tests; production cookies are Secure.

## Waitlist

`POST /api/waitlist` accepts JSON:

```json
{"email":"person@example.com","name":"Person","audience":"recruiter","company":"Team","consent":true,"website":""}
```

`audience` can be `recruiter` or `candidate`; `name` and `company` are optional.
Unknown fields, nonempty/missing honeypots, and non-boolean consent are rejected.
Email is normalized; bodies are limited to 4096 bytes. Success is HTTP 200 with
`{ "ok": true, "message": "You are on the waitlist." }`, only after a successful RPC.
Repeated email/audience pairs return the same success without overwriting original
details. They count toward the shared five-attempt, 15-minute IP limit. Only keyed
IP hashes are stored, not raw IPs. 429 includes `Retry-After`; configuration/storage
failures return 503. There is no in-memory success fallback.

Apply `TrueVeils/supabase/migrations/20260906000100_website_waitlist.sql` once to the
existing project before enabling the waitlist. It creates two RLS-protected tables
and a service-role-only RPC. The transaction covers rate limiting and signup insertion.
It does not modify interview tables or grant public signup-table access. Stale rate
rows are removed in bounded batches during accepted submissions, not on a timer.

Run the reviewed SQL in the intended project's Supabase SQL editor using an account
with database-management access, or through an authorized PostgreSQL connection with
DDL privileges and its database credentials. API keys (including secret/service-role)
are not database passwords or Management API access tokens and cannot apply this SQL.
For a CLI migration workflow, verify the project link, CLI login/access token, database
connection credentials, and pending migration history first; `db push` can apply other
pending migrations too. Do not assume a CLI login alone is sufficient.
The file assumes Supabase's `anon`, `authenticated`, and `service_role` roles and a
database owner able to create the tables/function and change grants in `public`.
It is a one-time migration, not an idempotent bootstrap script. Vercel deployment
does not apply it; a missing RPC or missing grants returns 503. Live migration and
deployment are separate integration steps, not performed by the website test suite.

## Existing-User Login

- `POST /api/auth` with `{ "action": "send", "email": "person@example.com" }`.
- `POST /api/auth` with `{ "action": "verify", "email": "person@example.com", "code": "123456" }`.
- `GET /api/auth` returns `{ "ok": true, "user": { "email": "person@example.com" } }` or `user: null`.
- `POST /api/auth` with `{ "action": "logout" }` clears the cookie and requests local-session sign-out.

Successful verification uses the same user response as GET. Valid and unknown/non-OTP
email sends return the identical generic message: `If this email can sign in, you will
receive a sign-in code.` This is an acknowledgement, not confirmation that an account
exists or that email was delivered. Only known account-state errors are acknowledged;
`otp_disabled` is acknowledged only with GoTrue's exact unknown-user message
`Signups not allowed for otp` (also recognized in legacy code-less responses).
Other 400/422 responses, SMTP restrictions such as `email_address_not_authorized`,
disabled email-provider configuration, service failures, malformed responses,
redirect failures, and transport timeouts return 503. Provider 429 remains 429.
Errors use `{ "ok": false, "error": "..." }`. GoTrue `create_user: false` is the
REST equivalent of `shouldCreateUser: false`; this endpoint does not create accounts.
Supabase must have email OTP enabled, a working mail provider authorized to send to
the intended recipients, and a Magic Link email template containing `{{ .Token }}`.
The default SMTP service restricts recipients to organization members; configure
custom SMTP for other users. Local tests do not verify live email delivery/templates.

The versioned email body is `TrueVeils/supabase/email-templates/magic-link.html`.
Set it under Auth > Emails > Magic link or OTP with subject `Your Truveil sign-in code`.
It puts the website OTP first while retaining the link for magic-link-compatible clients.
Saving a template does not configure or verify the SMTP sender.

Auth also applies bounded per-process defense-in-depth counters over ten-minute windows:
send allows 3 attempts per normalized email and 10 per IP; verify allows 10 per email
and 50 per IP. The map holds at most 10,000 hashed counters, expires stale entries, and
rejects new identities when full rather than evicting active counters. Only HMAC digests
are retained, with no raw IP/email persistence. These counters reset on cold starts and
are NOT distributed replacements for Supabase provider limits. Only Vercel's trusted IP
header is accepted on Vercel; local requests use the socket peer. Session/logout are not
blocked by send/verify throttles.

The only browser credential is a host-only HttpOnly SameSite=Strict cookie, named
`__Host-truveil_session` on HTTPS (Secure). Access/refresh tokens and provider keys
never appear in JSON responses or localStorage. Sessions are checked with Supabase
on each GET. No refresh token is retained; the cookie expires at the earlier of the
access-token lifetime or one hour, then the user signs in again. Logout clears the
cookie even if upstream sign-out fails. Supabase access JWTs cannot be revoked before
their expiry, so sign-out is not a claim of immediate JWT revocation.

The UI should show the verified email and desktop download/guide, not a web dashboard.

## Verification

From this website root run `node --test website-api.test.cjs`. The tests run real Node
HTTP servers for the API and the fake Supabase provider; no module or fetch mocks.
They verify modern/legacy headers, key-role guards, env aliases, account nondisclosure,
mail-provider failures, and the remaining wire contract. From `TrueVeils`, run
`node --test supabase/tests/website-api.test.cjs` for actual migration execution against
in-memory PostgreSQL via PGlite. That separate suite requires `@electric-sql/pglite`
to be resolvable, or `PGLITE_MODULE` set to its installed module path.
SQL tests cover role permissions/RLS, deduplication, validation, limiter expiry, bounded
cleanup, rollback atomicity, and simultaneously submitted calls. PGlite serializes its
single backend connection, so multi-backend lock contention remains unverified.

References: [Vercel Node runtime](https://vercel.com/docs/functions/runtimes/node-js),
[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[Supabase auth errors](https://supabase.com/docs/guides/auth/debugging/error-codes),
[GoTrue OTP handling](https://github.com/supabase/auth/blob/master/internal/api/otp.go),
[Supabase CLI migrations](https://supabase.com/docs/reference/cli/supabase-db-push),
[Supabase OTP](https://supabase.com/docs/reference/javascript/auth-signinwithotp),
[Supabase function permissions](https://supabase.com/docs/guides/database/functions),
[Supabase sign-out](https://supabase.com/docs/reference/javascript/auth-signout).
