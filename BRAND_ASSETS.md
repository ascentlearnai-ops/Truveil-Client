# Shared Brand Assets

The existing recruiter website is the canonical brand source:

- `TrueVeils/landing/assets/brand`: logo mark, favicon, Tavi poses, website media.
- `TrueVeils/landing/assets/fonts`: shared typefaces and font licenses.

Both websites retain the exact existing logo and design. Both desktop headers,
favicons, Windows app icons, Mac app icons, and the recruiter tray now use that
same lock mark. The old color filters are removed; the blue smile is preserved.
The recruiter tray uses the standard native template treatment on macOS.

## Synchronize

With both repositories beside each other and dependencies installed, run from
either app directory:

```sh
npm run brand:sync
npm run brand:check
```

The sync command copies only brand/font files to their declared destinations and
generates platform icons from the existing mark. No AI/media API is called.
Shared website media is mirrored to the candidate website; unused marketing
videos are not added to the recruiter installer. Existing unrelated/retired
assets are not deleted.

Each surface has an `assets/brand-manifest.json` recording expected local hashes,
canonical source hashes, and the source inventory. A changed, missing, or added
source asset makes the check fail until synchronization. Start and both platform
build paths check rather than silently overwrite assets. The candidate repository
can verify its saved local hashes when built without its sibling website checkout;
canonical drift can only be checked when that source is available.

## Verification and Release

Brand regression tests validate both websites and apps, icon consistency,
unfiltered header logos, startup/build gates, changed/missing/new files and path
boundaries. Offline browser QA renders the real header markup/styles/assets from
all four surfaces with app actions and network services disabled. It is a branding
check, not an installed-app or real-microphone test.

These changes are local. They do not update a running/installed app, rebuild an
installer, deploy a website, change the relay, or publish anything. Existing release
manifests must not be represented as matching this newer source. Rebuild and
publication need their own reviewed release step.
