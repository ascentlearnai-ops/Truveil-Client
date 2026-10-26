# Interview Window Sharing

Opt-in Chrome/Edge MV3 extension for one normal, non-incognito interview window. Nothing connects or collects tabs at install, browser startup, service-worker restart, or popup open. The candidate must paste a new pairing code, select observation consent, and click **Share this window**. Closing is a separate, unchecked permission. **Stop sharing** withdraws both permissions.

## Parent integration

```js
const { TabBridge } = require('./src/browser/tab-bridge');
const bridge = new TabBridge({
  onUpdate(state) { /* Only this sanitized state may go to the room. */ },
  onResult(result) { /* Optional: dispatched close results, once each. */ }
});
const { pairingCode, extensionId } = await bridge.start({
  sessionId: localSessionId,
  observeConsent: true,
  closeConsent: false,
  protectedHosts: ['interview.example.test']
});
// pairingCode goes ONLY to the candidate UI. Never room events, logs, or storage.
const result = await bridge.closeTab({ id: selected.id, revision: selected.revision });
bridge.setConsent({ observeConsent: false, closeConsent: false });
await bridge.stop();
```

- `start()` returns `{ pairingCode, extensionId }`; without explicit observation consent the pairing code is `null` and no server is opened. A new start ends the old session. A failed or superseded start rejects with a non-sensitive error.
- `getState()` and `onUpdate` expose `{ tabs, events, connected, observeConsent, closeConsent }`. Each tab has `{ id, revision, hostname, active, protected }`. IDs are opaque, session-local target references, not browser tab IDs. Do not select targets by hostname.
- Events are a bounded history (64 records) of `{ kind, id, revision, hostname, sequence }`. Deduplicate by `sequence` within a pairing and reset on disconnected state. The initial snapshot invents no events. `created`, `navigated`, `activated`, `removed`, `attached`, and `detached` describe observed browser events. Navigation includes URL changes and loading/reload starts, not a guarantee of completed document loading.
- `setConsent({ observeConsent, closeConsent })` is synchronous for local revocation. Observation revocation clears inventory and capabilities and closes the bridge. Close-only revocation keeps observation but cancels pending closes. Re-enabling observation after stop needs a new `start()` and explicit popup pairing. Close permission is the intersection of candidate-app and extension-popup consent.
- `stop()` immediately revokes local state and settles pending commands as `unavailable`; its Promise waits for listener/socket cleanup. Await it when ending a session. There is no automatic reconnect.
- `closeTab({ id, revision, sessionId? })` resolves to `{ status, id?, revision? }`; statuses are `closed`, `stale`, `denied`, `unavailable`, or `failed`. Optional `sessionId` must match. `onResult` runs once for each dispatched command, not for immediate validation failures. Choose either that callback or the returned Promise for room notifications to avoid duplicate UI notices.
- `WebSocketServer` is optionally injectable. The real server uses the existing `ws` dependency. Optional `clock` injection is used only by synthetic tests.
- The bridge requires `browser-extension/protocol.js`. Keep that file alongside `src/browser` in any later packaging work. This change does not alter packaging or app wiring.

## Transport and privacy boundaries

- Listener: ephemeral port on exactly `127.0.0.1`. Only `chrome-extension://dmemhcgadchjgfpleneioeenkcjepbhk`, exact loopback Host, and `/` upgrades are accepted. Webpage and other-extension origins are rejected. The manifest public key fixes the ID; it is public, not an authentication secret.
- Pairing: 256-bit random secret, two-minute expiry, one use, tied to an opaque session epoch. The code contains only protocol version, port, secret, epoch, expiry, and extension ID. It has no remote URL or executable data. The extension constructs the loopback address itself.
- Bounds: four HTTP connections; two unauthenticated WebSocket peers; eight pairing attempts; three-second HTTP/authentication timeout; 64 KiB messages and output backlog; 80 messages/second/peer; 128 enrolled tabs; eight pending closes; 256 close attempts per pairing. Idle connections expire after 45 seconds, with 20-second consent-scoped heartbeats.
- Only the enrolled window is queried. Events for other windows are ignored before reading their URLs. Incognito is disabled in the manifest and rejected in code. The initial enrollment requires the explicitly selected window to be focused and normal. Once enrolled, changing focus never enrolls another window.
- Reports contain only HTTP(S) hostnames, never URL paths, query strings, fragments, credentials, titles, page content, clipboard data, or screenshots. Unknown/internal/file tabs have empty hostnames and cannot be closed. Full URL values are held only in the extension's volatile memory for last-moment target comparison, never transmitted or persisted.
- The `tabs` permission is needed to read URLs for hostname extraction; browser permission UI is broader than the implemented collection scope. There are no content scripts, host permissions, external messaging, native messaging, debugger, capture, clipboard, storage, or history permissions. The CSP's only network destination is loopback, with a variable port, not a wildcard hostname.
- Protected hosts include `meet.google.com`, `zoom.us`, `teams.microsoft.com`, `teams.live.com`, and `webex.com`, plus supplied meeting hosts; subdomains are protected too. Provide the actual interview host when it differs. These are checked independently in the bridge and extension, including a pending navigation before close.

## Exact-tab close semantics

A close binds the session epoch, extension worker/browser instance, enrolled window ID, exact browser tab ID, navigation revision, unique command ID, and five-second deadline. Both sides reject replay and stale targets. The extension re-reads the window and tab and rechecks consent, scope, hostname protection, full URL equality, pending navigation, revision, and expiry immediately before `chrome.tabs.remove(exactId)`.

`closed` requires both successful completion of that API call and an observed `tabs.onRemoved` for the exact enrolled tab. The bridge independently requires its corresponding removal event before accepting the result. A promise resolving, tab disappearing from a snapshot, hostname match, wrong-tab removal, or window-closing notification is not enough. There is no focus, keyboard, process, native-command, or Ctrl+W fallback.

Chromium has no atomic compare-and-close or document-navigation lock. This is explicitly **tab-object closing**, not a guarantee that the document cannot change between final validation and removal. Similarly, revocation cannot undo a browser API call already issued before the revocation reaches the extension. Known protected hosts and pending protected navigation are denied; an unobserved last-instant navigation cannot be atomically excluded. A timeout/failure does not prove a previously issued browser operation had no effect. Human review and a dedicated interview window remain important.

## Local verification

Run `node --test test/browser-tabs.test.js` from `Truveil-Client`. Tests use synthetic Chrome APIs and local loopback only. No browser profile, microphone, real tab, installation, deployment, or native command is used.

For an authorized manual check, load this directory unpacked in a dedicated Chrome/Edge test profile (Chromium 116+), verify the extension ID above, start candidate-app pairing, and use a normal interview window containing only synthetic pages. Paste the pairing code into the popup and explicitly share. Local automated results do not establish two-computer operation or physical toolbar behavior in an installed browser.

References: [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key), [service-worker WebSocket lifecycle](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets), [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs).
