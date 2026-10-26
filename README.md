# Truveil Secure

This repository contains the code for the **Truveil candidate website and desktop app**. Truveil Secure is the candidate's side of a remote interview and connects to the recruiter's Truveil app.

## What's in this repo

- **Website pages** — the candidate website, download page, guides, and interactive product preview.
- **`main.js`, `preload.js`, and `src/`** — the Electron desktop app, interview interface, and live transcription.
- **`browser-extension/`** — support for optional, consented browser-tab sharing and controls.
- **`api/`** — supporting website endpoints.

## How the app works

1. The candidate receives an invitation code from the recruiter and opens Truveil Secure.
2. They review what will be shared, give consent, and check their microphone before joining.
3. During the interview, speech appears as live captions. Browser sharing is optional and requires the candidate's permission.
4. The recruiter reviews interview evidence in their own app. Recruiter-only scores are kept out of the candidate interface.

**Recruiter website and app:** [TrueVeils](https://github.com/ascentlearnai-ops/TrueVeils)
