# Native UHD experiment: evidence and validation

## Evidence boundary

Source snapshots: Lights Out `400b982`; Android patch `2b5f93c`.
No authenticated F1 TV request or LG G6 playback was performed for this change.
Repository observations, upstream claims and hypotheses are different below.
No account, DRM, entitlement or geographical checks are bypassed.

### Confirmed in source

- Lights Out's service requests `/3.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY`
  with `player=player_tm`, browser device metadata, subscription and entitlement
  headers. `service/lib/f1tv.js` records previous real HD observations and
  stream-rule failures with other platforms; these are historical observations,
  not fresh API verification in this change.
- The page uses bundled **Shaka v5.2.9**, `video`, and Widevine EME where the
  response supplies `laURL`. The existing licence filter sends both
  `ascendontoken` and `entitlementtoken`. These remain unchanged.
- The Android [patch script](https://github.com/Alexvbp/f1tv-4k-patch/blob/2b5f93c/scripts/patch.sh)
  modifies ClearVR/EGL HLG capability gates, display size and tile limits and
  supplies decoder maximum-size hints. These are Android-native mechanisms;
  they cannot be translated to Shaka configuration.
- Android [PR #22](https://github.com/Alexvbp/f1tv-4k-patch/pull/22)
  explains that the old model spoof did not affect request headers. This change
  does not copy that spoof or force a TV to claim unsupported HDR capabilities.
- The target's open [legacy PR #2](https://github.com/The-DarkMatter/lightsout-webos/pull/2)
  concerns webOS 4. This experiment leaves default HD, UI size, overlays and
  existing playback controls in place; older-TV UHD remains unverified.

### Reported by the reference, not independently verified here

The Android [README](https://github.com/Alexvbp/f1tv-4k-patch/blob/2b5f93c/README.md#how-it-works)
attributes `HDR-UHD-CMAF-WV` selection to `X-F1-Device-Info` with
`device=android_tv`. It reports 2160p HLG tiles, with SDR capped at 1620p, and
ClearVR requiring both renderer and display HDR support before fetching 2160p.
The compatibility table and issues concern Android devices, not LG webOS.
Profile spelling varies in reports (`HDR_UDH_CMAFWV` in issue #13); the app does
not use any spelling as proof of resolution.

### Experiment, not a recovered Android request

The opt-in `uhd` profile sends exactly the documented header fragment
`device=android_tv`; the `web` profile retains the full working browser header.
Both retain **WEB_HLS** and **player_tm**. The reference does not establish a
complete Android header or a platform/player pair, so no made-up version,
model, capability, BIG_SCREEN or DASH combination is sent. The fragment may be
insufficient and the experiment may always fall back. Catalog and entitlement
requests continue to use the original browser identity. No claim is made that
a header alone unlocks UHD or that this is a production Android profile.

A signed-in Premium test must establish:

1. Whether this fragment is accepted, and whether a complete captured legitimate
   Android request has additional necessary fields (record names, not secrets).
2. Whether server negotiation exposes UHD to this app and subscription.
3. Whether its feeds are standard HLS/CMAF or DASH/HEVC with usable audio and
   subtitles, or ClearVR presentation/tile metadata requiring its native core.
4. Whether the original Widevine exchange satisfies UHD security/output policy.

CMAF describes packaging, not the manifest protocol or a guarantee of ordinary
single-picture HEVC. If ClearVR is required, Shaka cannot reconstruct its tiled
presentation; native engine integration would be a separate project. No
ClearVR dependency, DRM workaround or alternate engine is included here.

## webOS compatibility

LG's [webOS 26 media table](https://webostv.developer.lge.com/develop/specifications/video-audio-260)
lists HEVC Main/Main10 up to 3840×2160@60P, Level 5.1, 60 Mbps on UHD models.
Its [streaming/DRM table](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)
lists MSE/EME, Widevine Modular 17, and L1/HW_SECURE_ALL on webOS 3.5+.
These ceilings support investigating 2160p50; they do not establish F1 licence
approval, this specific model's protected decoder path or correct HLG output.

Shaka's [v5.2.9 preferences](https://github.com/shaka-project/shaka-player/blob/v5.2.9/lib/media/preference_based_criteria.js)
apply HEVC preferences only to available variants. `hdrLevel: AUTO` uses its
[webOS HDR detection](https://github.com/shaka-project/shaka-player/blob/v5.2.9/lib/device/webos.js),
which prefers HLG when present and HDR is reported. This is not the Android
patch's forced HDR advertise. No HDR-to-SDR/PQ conversion is attempted.
Normally adaptive playback uses MSE and protected playback uses EME; Shaka may
choose a native path depending on support. Diagnostics report the observable
path without exposing `currentSrc`. No engine replacement is justified without
a real manifest. The UI stays 1920×1080, independently of decoder resolution.

`getVariantTracks()` reflects Shaka's playable/filtered manifest tracks, not
necessarily every rendition offered by the server. A missing UHD track can
therefore mean either no UHD was served or it was filtered as unsupported.
`videoWidth/videoHeight` distinguish intrinsic decoded video from manifest
advertising and CSS size, but do not prove panel output or original source
quality. Frame rate/HDR are manifest tags; frame counters are browser/Shaka
observations. HDR output remains explicitly unobservable in this panel.

## Automated checks

Run `node scripts/playback-test.js`, then `bash scripts/package.sh`.
The dependency-free assertions execute production playback functions with
mocked HTTPS/service/player boundaries. They cover unchanged default headers and
route, opt-in and opt-out, per-request isolation, invalid profile rejection,
HEVC preference restoration, real 2160p options (no fake UHD), malformed feed
metadata, decoded-vs-manifest diagnostics, replay/control carry-over, one-shot
fallback on stream-rule/manifest/codec/DRM failures, explicit access denials and
stale PLAY replies. Mocks cannot validate Shaka's decoder, actual manifests,
Widevine licences or a TV's HDR output. CI runs the checks and IPK packaging.
The pre-existing archive replay test needs signed-in session data and is not an
offline playback regression suite.

## LG G6/webOS 26 manual checklist — all pending

- First test with UHD **Off**: live Widevine, replay/resume, all cameras, audio,
  captions, remote play/pause/seek, quality/Auto and speed, timing and track map.
- With Premium and a known UHD-eligible main feed, enable UHD. Record profile,
  stream type, manifest max, decoded dimensions, codec, frame rate/HDR tags and
  frame counters. Do not share tokens, signed manifest URLs or licence data.
- Require decoded 3840×2160 with progressing frames for a native UHD observation;
  verify 50 fps separately and confirm HLG through the TV's own signal display.
  A stream name or 2160p menu entry is insufficient.
- Confirm sustained playback and ABR on the real connection; check dark/bright
  HDR details, dropped frames and audio sync. Test live and replay separately.
- Switch to an HD-only onboard and back, test all controls and overlays, then
  disable UHD and verify the browser profile and HD playback return.
- Exercise unsupported UHD/DRM and confirm one unload/retry, preserved replay
  position and HD toast. Explicit expired-login/plan/region denials must remain
  visible without an HD retry. Unknown DRM-policy failures may be retried once;
  this does not imply entitlement is granted.

Keep the PR draft until manifest/DRM and hardware evidence resolve these gaps.
