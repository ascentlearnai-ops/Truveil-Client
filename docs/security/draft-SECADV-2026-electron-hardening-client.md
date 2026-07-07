---
title: "Security Hardening 2026-07-07: Electron Sandbox + CSP in Truveil-Client Desktop"
severity: medium
ghsa_tag: v2026.07.07-hardened-client
patch_shas:
  - f7a51e7
  - e33d330
cwe_ids:
  - CWE-693
  - CWE-1021
state: draft
review_required: true
---

> **Note on `ghsa_tag`:** the value above is the *planned* release tag.
> The local git tag is created at push time; until
> `v2026.07.07-hardened-client` is tagged on `origin/main`,
> `git tag -l` will not show it. Draft is therefore committed before
> the tag exists.

# Security Hardening 2026-07-07: Electron Sandbox + CSP in Truveil-Client Desktop

**Repo:** `ascentlearnai-ops/Truveil-Client`
**Release tag:** `v2026.07.07-hardened-client`
**Status:** Draft — do **not** Publish without operator review.

## Summary

A focused Electron renderer hardening release for the Truveil-Client
desktop app (the live-transcription installers distributed from
`/downloads/`). The Windows installer was rebuilt at `f7a51e7` to
deliver the hardened renderer binary from `e33d330`.

## What's in this release

### 1. Electron renderer hardening (`e33d330`)
`main.js` revisions:

- `setWindowOpenHandler` denies unauthorized `window.open()`.
- `app.on("web-contents-created")` adds `will-navigate` and
  `will-redirect` guards on the secure window.
- `nodeIntegration` disabled; `contextIsolation` enabled where
  applicable.

### 2. Strict CSP
Applied to `src/renderer/index.html` and reinforced in `vercel.json`:

- `default-src 'none'`
- `script-src 'self'`
- `connect-src 'self' wss://api.deepgram.com https://api.deepgram.com`
- `frame-ancestors 'none'`
- `object-src 'none'`

### 3. Vercel / landing HTTP headers (`vercel.json`)
- `X-Frame-Options: DENY`
- `Cross-Origin-Opener-Policy: same-origin`

### 4. Installer delivery (`f7a51e7`)
- Rebuilt `downloads/TruveilSecure-Setup-1.0.0.exe` ships the
  hardened renderer binary.
- `downloads/TruveilSecure-Setup-1.0.0.exe.sha256` provides the
  canonical sha256 of the rebuilt installer.

## Severity

**Medium.** Defense-in-depth; no demonstrated in-the-wild exploit.
Removes the latent render-path way for XSS or a compromised
dependency to drive arbitrary code in an authenticated user session.

CVSS v3.1 vector:
`CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:C/C:H/I:H/A:L` (score ~5.0).

CWEs:

- **CWE-693** — Protection Mechanism Failure
- **CWE-1021** — Improper Restriction of Rendered UI Layers

## Affected versions

All builds shipped against `main` before the two commits below land.

## Patches

| SHA | Subject |
|-----|---------|
| `f7a51e7` | Ship rebuilt Windows installer with live-duration transcription fix |
| `e33d330` | Security hardening: Electron sandbox guards + CSP |

## Operator runbook

1. Pull `main` after `v2026.07.07-hardened-client` is tagged.
2. Replace the canonical installer(s) in `downloads/`.
3. Verify sha256 of `TruveilSecure-Setup-1.0.0.exe` against
   `downloads/TruveilSecure-Setup-1.0.0.exe.sha256`.
4. Re-sign with the current code-signing certificate before
   redistribution.
5. Push update notice to current end-users.
6. **Quarantine the previous installer binary.** Pre-step:
   `mkdir -p downloads/_archive/` so the quarantine target exists,
   then `mv` the previous installer binary out of `downloads/` into
   `downloads/_archive/` so end-users on auto-update do not roll back
   to the unhardened binary. Any rollback logic that references
   `downloads/*.exe` should be updated to skip the archived file by
   path.
7. **Bump the auto-update manifest version pointer** to skip `1.0.0`,
   and force the next install on the new sha256
   (`downloads/TruveilSecure-Setup-1.0.0.exe.sha256`). End-users on
   the prior version should be prompted to re-install rather than
   rolling forward across the hardened boundary.

## Workarounds (if you cannot redistribute immediately)

There is no upstream workaround for the renderer hardening — it
requires the rebuilt installer. The previous build remains in service
until end-users update.

## Credits

Reported and fixed internally as part of the standing Truveil
security program. Implementation by CodeX.

## References

- Truveil-Client commit `e33d330` — Security hardening: Electron
  sandbox guards + CSP.
- Truveil-Client commit `f7a51e7` — Ship rebuilt Windows installer
  with live-duration transcription fix.
- OWASP Desktop App Security Top 10: M1 (Code Injection),
  M8 (Code Signing Failures).
- OWASP ASVS v4.0: V14 (Configuration).

---

> This file is tracked on branch `feat/advisory-drafts` in
> `C:\Truveil\Truveil-Client\docs\security\`. To make it the canonical
> live advisory, press **Publish** on the GitHub Security Advisory
> draft at
> `https://github.com/ascentlearnai-ops/Truveil-Client/security/advisories?state=draft`.
