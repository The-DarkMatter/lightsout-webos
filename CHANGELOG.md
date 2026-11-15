# Changelog

## 0.1.1

- Add default-off experimental Android TV device negotiation for native UHD.
- Prefer supported HEVC with Shaka's existing automatic webOS HDR detection.
- Retry the original HD profile once when UHD cannot be played, preserving
  playback state where possible; do not retry explicit access denials.
- Add playback diagnostics and offline regression checks with CI IPK builds.
- Native UHD, 50 fps and HLG on LG G6/webOS 26 remain unverified. ClearVR's
  tiled presentation may prevent this approach from producing UHD at all.
