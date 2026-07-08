# Truveil Client Codex Handoff

> **Read `C:\Truveil\TrueVeils\MASTERPLAN.md` first — it holds the end goal (YC + 100 companies), the roadmap, the marketing plan, and the model delegation playbook for both repos.**

Last updated: 2026-07-06

## Project Map

- Client repo: `ascentlearnai-ops/Truveil-Client`
- Client local path (current laptop): `C:\Truveil\Truveil-Client`
- Client Electron app: root Electron project in this repo
- Client website: static client download/check-in website in this repo
- Admin repo: `ascentlearnai-ops/TrueVeils` at `C:\Truveil\TrueVeils`

## 2026-07-06 Launch-Prep Changes (Claude Code)

- Live Deepgram path now reports real utterance `durationMs` in
  `src/renderer/session.js` (summed from Deepgram `is_final` result durations,
  reset per utterance/reconnect/session). This feeds the admin app's
  words-per-minute tempo detection, which previously received 0 on the live path.
- Deleted dead stub files `src/audio/recorder.js` and `src/websocket/client.js`
  (never loaded by any HTML/preload; contradicted the real Supabase-relay
  architecture). Real audio pipeline lives in `session.js` + `pcm-worklet.js`.
- Candidate app skin: acid-green `#e4f222` replaced with `#4ade80`.
- Client website: staggered reveals, scroll-aware nav, check-in steps light up
  in sequence (IntersectionObserver, reduced-motion safe).
- Tests: 15 passing.

## Current Product Direction

The client app, Truveil Secure, is the candidate-side desktop app. The candidate receives or pastes a TRV code, consents to session verification, then the app keeps a minimal active session screen while sending transcript/evidence signals to the admin app.

Important product rules:

- Candidate should not see AI-risk scores or behavioral analysis.
- Candidate UI should show only session, connection, microphone health, and simple restricted-destination warnings.
- No camera, screen recording, file access, or clipboard collection.
- Live transcription should be fast and stable; fallback audio chunks are temporary and should be deleted after processing.

## Recent Client Work

Latest relevant commit:

- `301ff4a Tune live transcript chunking`

Key changes:

- Deepgram live stream settings:
  - `endpointing=300`
  - `utterance_end_ms=1000`
  - `interim_results=true`
  - KeepAlive every `4000ms`
- Interim transcript updates are throttled to about `250ms`.
- Live transcript metadata now includes:
  - `streamEpoch`
  - `utteranceId`
  - `segmentId`
  - `revision`
  - `finalReason`
- Reconnect increments `streamEpoch` so delayed old events cannot overwrite new transcript text.
- Fallback audio chunks are `2500ms` and should only be used when live streaming fails.

Validation at time of handoff:

- `cd D:\Truveil-Client`
- `npm test`
- Result: 11 passing tests.

## Environment Needed

Client packaged app needs Supabase public client config:

```env
TRUVEIL_SUPABASE_URL=https://kcsrqobajprwpsyjiram.supabase.co
TRUVEIL_SUPABASE_ANON_KEY=<Supabase publishable/anon key>
```

Provider secrets should not be embedded in the client app.

## Common Commands

```powershell
cd D:\Truveil-Client
npm install
npm test
npm run build:win
```

```powershell
cd D:\Truveil-Client
git pull origin main
git status
```

## Next Codex Prompt

When opening this repo in a new Codex app, paste:

```text
Continue Truveil Client from CODEX_HANDOFF.md. Work on the client repo at D:\Truveil-Client and the admin repo at D:\TrueVeils. First read CODEX_HANDOFF.md in both repos, then inspect git status before making changes.
```
