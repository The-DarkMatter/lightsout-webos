# Lights Out: notes for working on this repo

An unofficial F1 TV player for LG webOS TVs, distributed through the webOS
Homebrew Channel. The README covers what it does and how it works. This file
holds what a new session needs and the README doesn't. **This repo is (or
will be) public:** never commit IP addresses, account details, tokens or
anything from `.dev/`.

## Where things stand

- The release checklist is `docs/RELEASING.md`. It's the next thing to work
  through, and most of it needs the TV.
- The app was built in a private repo and copied here fresh, without its
  history, on 2026-10-15. Everything since is here.
- Decided on 2026-10-16:
  - **Name:** Lights Out, title "Lights Out for F1 TV", app id
    `com.thedarkmatter.lightsout`. The id is permanent once anyone installs
    it, and F1 stays out of it.
  - **Icon:** "Gantry over play", five lit start lights on a hanging gantry
    above a play button. The master is `assets/icon.svg`, rendered to
    `app/icon.png` (80px), `app/largeIcon.png` (130px) and
    `assets/app-icon.png` (512px), square and opaque.
  - **Licence:** Apache-2.0. Bundled components are listed in
    `THIRD_PARTY.md`.
  - **TV-browser sign-in import:** opt-in and hidden without Homebrew
    Channel's root `exec`, so the manifest says `rootRequired: optional`.

## Layout

- `app/`: the web app (pages plus `js/`). `js/luna.js` is the only route to
  the service, and `js/errors.js` turns failures into words for the viewer.
- `service/`: the on-TV Node service that makes every F1 call, since F1
  sends no CORS headers. `node_modules/` is committed on purpose because it
  ships inside the IPK.
  - `lib/auth.js`: sign-in and token renewal
  - `lib/setupServer.js`: the LAN sign-in page with its pairing code
  - `lib/failure.js`: sorts F1 failures into reasons
  - `lib/livetiming.js`, `lib/archive.js`: live and replay timing
  - `lib/circuits.js`, `data/circuits.json`: each circuit's outline and its
    finish line and sector ends, in the position feed's own coordinates
  - `lib/poscache.js`: keeps the replay being watched's position stream on
    disk (only the latest), so reopening the map doesn't download it again
- `dev/`: mocks and helpers injected by the dev server. Outside `app/`, so
  they never ship.
- `scripts/`: `package.sh`, `deploy.sh`, `dev-server.js`, `replay-test.js`, and
  the circuit tools (`live-view.js`, `build-circuits.js`, `build-markers.js`,
  `check-circuits.js`, with `lib/archive.js`; see "The track map" below).

## Working without the TV

```sh
node scripts/dev-server.js --mock   # canned data; open http://localhost:8788/browse.html
node scripts/dev-server.js          # the real service against the real F1 TV API
```

- **Mock preview switches** (query parameters): `?auth=expiring|expired|none`,
  `?root=0` (no Homebrew Channel), `?tvb=1` (TV-browser import allowed),
  `?fail=signin|subscription|region|unavailable|network|changed|player`.
- **Real mode** needs one formula1.com sign-in pasted on the sign-in screen.
  It's stored in `.dev/state.json`, which is gitignored, and renews itself.
  It prints the setup page's URL with its pairing code.
  `LIGHTSOUT_DEV_HOMEBREW=1` fakes a rooted TV.
- **To build the IPK** without installing ares-cli:
  `npx -y -p @webos-tools/cli@3.2.6 ares-package app service -o build`.
  ares-package warns about a missing `requiredACG`. That's for LG's store and
  doesn't apply to Homebrew installs.
- **Screenshots on Windows:** headless Edge works when started from
  PowerShell (`Start-Process msedge --headless=new --screenshot=...
  --window-size=1920,1080`). From Git Bash it produces no output.

## On the TV

Developer installs go over SSH to a rooted TV: `bash scripts/deploy.sh <ares device>`.
The script's header covers setup. Two traps:

- `ares-install` often fails on the first try just after the TV wakes or
  while it's playing. The script retries.
- The launcher caches app icons for several minutes after a reinstall.

## Things that are settled; don't re-derive them

- **No password login.** F1's login endpoint sits behind an Imperva bot
  check that only clears in a real browser. The app takes a token from a
  browser login instead. The token lasts 96h, but its embedded `SessionId`
  (30 days or more, often longer) renews it through RetrieveSubscriber with
  `orderSubmitted: true`. Trust the session JWT's own `exp` (see
  `service/lib/auth.js`).
- **One video at a time.** The LG C5 decodes only one protected stream
  cleanly, so multiview was built and removed.
- **The track map draws each circuit from one real lap** of F1's own position
  feed (`service/data/circuits.json`, all 26 circuits F1 lists), so it is
  complete from the first frame, and the cars sit on it in the same
  coordinates. A bundled SVG backdrop was tried and dropped because it was in
  other coordinates; `app/js/overlays.js`'s header explains why. The feed is
  already north-up in metres, so nothing is rotated. A circuit with no entry
  falls back to drawing the trails the cars leave.
  - **Rebuilding it** needs the signed-in dev server's token (the archive
    refuses requests without one). `node scripts/build-circuits.js` cuts the
    outlines, `node scripts/build-markers.js` adds the finish line and sector
    ends, and `CIRCUIT_REFERENCE_URL=<folder of reference GeoJSON files>
    node scripts/check-circuits.js` checks each outline against the real shape
    of its circuit (all 26 are within 4-21 m). Downloads are cached in
    `.dev/position-cache/`.
  - **Positions are on the tower's clock,** not F1's raw one: each sample's own
    stamp plus how late the feed arrives (about 3 s live, measured from the
    recording on a replay). So the map and the tower agree and one Timing
    delay setting suits both. At the instant the tower shows a lap completing,
    the car is within a few metres of the finish line.
  - **Replays** load the position stream on demand (about 8MB, with the
    circuit answered first so the outline shows while it comes down) and keep
    the latest one on disk.
  - **Watching a live session on a PC:** `node scripts/live-view.js` starts
    the dev server, opens the app with the tower and map open (no picture),
    and prints a status line every few seconds.
- **Replays are unencrypted HLS. Live is Widevine** through the TV's own
  CDM, with the licence request carrying the viewer's own tokens.
- **The release workflow's toolbox:** the webosbrew packages are named
  `webosbrew-toolbox-*`, but the commands are `webosbrew-gen-manifest` and
  `webosbrew-ipk-verify`. ipk-verify depends on the fw-symbols package.
- **State lives in the service's install folder** (`service/state/` on the
  TV). Measured on the C5 (2026-11-12): writable from the jail, kept by a
  Homebrew update to a newer version, deleted by an uninstall. webOS leaves
  `/var/palm/jail/<service id>` behind after an uninstall, but that holds
  only system files.
- **F1's timing archive needs the viewer's token** as
  `Authorization: Bearer` (401 without it since about November 2026). A
  query-string token, cookie or other header names are refused.
- **The tower lines up with the picture's own clock**, live and replay,
  minus the Timing delay setting (default 4 s, which looked right on a
  replay). See the "lining timing up" section of `app/js/overlays.js`.

## Open issues (from the last on-TV testing, 2026-11-12)

- **The live tower's lining-up is untested** against a real session, and
  so is live Widevine since the error cards went in. Check both on the next
  race weekend. Also check the live tower holds up across a pause.
- **Back presses may accumulate** after opening the timing tower several
  times. This wasn't reproducible from a resting state; retry with the tower
  left open.
- **The track map is untested on the TV.** It was checked on the PC against
  real live sessions (a practice, a qualifying), a recorded race played through
  the real service, and a real replay. Check the live map on the TV on the next
  race weekend, and that the "picture N s behind live" figure in the Timing
  delay menu reads sensibly (it is how far the picture clock trails live; if
  timing arrives early, compare it with another timing tool's figure for the
  same stream).
- **Subscription vs region errors** are told apart by the wording of F1's
  message, which is a guess (`service/lib/failure.js`). Correct it if a real
  refusal is ever captured.

## Style

- Match the surrounding code: ES5 (`var`, no arrow functions), since older
  webOS runtimes are in scope. Comments explain *why*, at the density
  already there.
- Commit messages are a short subject line, then prose saying what changed
  and why.
