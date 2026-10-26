# macOS and Windows Support

Status: local source preparation, October 25, 2026. No Mac installer has been
built, signed, notarized, published, or tested on real Mac hardware in this work.

## Targets

- Windows: retain the existing Windows 10/11 x64 NSIS installer and filename.
- macOS: separate native Apple Silicon (arm64) and Intel (x64) DMG builds,
  with macOS 12.0 as the configured minimum. This is a build target, not a
  claim that every macOS release/device has been validated.
- Both apps retain their shared white/baby-blue interface and existing room,
  caption, advisory checker/report, and consented extension workflows.
- Mac windows use a native title bar to avoid traffic-light/control overlap.
  Dock activation restores the existing app window.
- Browser sharing on Mac still requires Chrome/Edge and the included extension.
  Safari tab control is not implemented. No new Accessibility, Apple Events,
  screen recording, camera, personal-window access, or automatic closing is added.
- The legacy Windows OS foreground/overlay monitoring path is not a validated
  Mac capability. Cross-platform scope is the current account-free interview
  and explicitly shared-browser workflow, not whole-computer monitoring.

## Build on a Matching Mac

Use a clean, dedicated checkout containing the final reviewed source. Do not copy
Windows node_modules or private Windows environment files to a Mac. Use native
Node on the target processor, then install the locked dependencies with npm ci.

Configure the existing public runtime settings through the normal local build
environment. Never bundle provider keys or the relay's private host access code.
The public relay address must be current and reachable from both test networks.

From either app's directory:

```sh
npm ci
npm test
npm run build:mac:arm64  # Apple Silicon Mac with native arm64 Node
# Or, on an Intel Mac:
npm run build:mac:x64
```

Alternatively, npm run build:mac uses the host processor. Cross-architecture
builds are rejected: recruiter ffmpeg-static downloads a host-specific binary.
The release verifier inspects the actual Mach-O architecture of the app executable
and the recruiter's unpacked ffmpeg. A Windows executable cannot pass that check.
Mac and Windows artifacts/manifests use distinct filenames.

## Microphone and Background Behavior

Truveil Secure supplies NSMicrophoneUsageDescription and the audio-input signing
entitlement. The recruiter app does not request microphone permission.

The existing explicit join/consent flow is still required. Merely launching the
app, building it, or viewing the download page never starts capture. macOS must
also grant its own microphone permission. If denied, use System Settings >
Privacy & Security > Microphone and relaunch the candidate app.

The existing unthrottled caption windows and authorized-session power blocker
remain enabled. End/disconnect/quit cleanup must stop capture and release the
blocker. Actual behavior with Teams, Meet, Zoom, device switching and background
windows still requires attended Mac testing. No one-second speech-delay or
accuracy guarantee is established by Windows mocks.

## Release Validation and Download Options

Both local download pages now have Windows/macOS choices and Apple Silicon/Intel
selection. Windows keeps its existing real installer link. Mac links stay absent
until a correctly named, same-app/version/architecture validated manifest exists.
A missing/invalid manifest or network failure cannot create a fake download link.

After obtaining the proper Apple Developer ID signing/notarization configuration
through the operator's secure environment and building on the matching Mac:

```sh
npm run release:mac:check
npm run release:mac:stage
```

These commands verify the DMG, mount it read-only at an isolated temporary path,
compare the app's packaged sources/configuration and extension resources, check
native executable architecture, and require codesign verification, Gatekeeper
acceptance and a valid stapled notarization ticket. They stage only that Mac DMG,
its checksum, and release-manifest-mac-arm64.json or release-manifest-mac-x64.json.
They never overwrite the Windows installer or Windows manifest and never upload,
deploy, commit, or publish anything. Unsigned local builds cannot pass this
public-download gate. Do not disable Gatekeeper to simulate a passing release.

Before publication, complete an attended Mac-to-Windows and Mac-to-Mac rehearsal:
room create/join/approval/start, explicit mic consent, captions on both screens,
background call use, advisory checker thresholds, final report, extension pairing,
protected meeting tabs, exact-tab removal acknowledgment, revocation, end cleanup,
deep links, Dock restoration, and installer launch from Finder. Exercise both
Mac processors before claiming support for both.

Local verification for this change includes 28 focused Mac/download regressions,
the existing Windows source tests, and six offline browser viewport cases
(18 Windows/pending-Mac/synthetic-release states). Browser manifests in that QA
are synthetic, not evidence of a built or published Mac installer. Final observed
Windows-host source suites passed 328 recruiter tests and 205 Secure tests.
These counts include concurrent main-thread work, not just the Mac feature.
No shared readiness report, public relay, installed app, installer, website
deployment, or database was changed by this side-conversation work.

[Electron macOS permission documentation](https://www.electronjs.org/docs/latest/api/system-preferences)
describes the system microphone permission and purpose notice.
[Electron signing guidance](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
distinguishes Developer ID distribution outside the App Store.
