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
- `dev/`: mocks and helpers injected by the dev server. Outside `app/`, so
  they never ship.
- `scripts/`: `package.sh`, `deploy.sh`, `dev-server.js`, `replay-test.js`.

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
- **The track map is drawn from telemetry**, with no pre-drawn outline. A
  bundled circuit backdrop was tried and dropped; `app/js/overlays.js`'s
  header explains why.
- **Replays are unencrypted HLS. Live is Widevine** through the TV's own
  CDM, with the licence request carrying the viewer's own tokens.
- **The release workflow's toolbox:** the webosbrew packages are named
  `webosbrew-toolbox-*`, but the commands are `webosbrew-gen-manifest` and
  `webosbrew-ipk-verify`. ipk-verify depends on the fw-symbols package.

## Open issues (from the last on-TV testing)

- **Back presses may accumulate** after opening the timing tower several
  times. This wasn't reproducible from a resting state; retry with the tower
  left open.
- **The tower runs 3 to 5 seconds ahead of the picture on replays.** That's
  expected: archive timestamps come from F1's timing system, and the
  broadcast trails it. The fix is a constant subtracted from the playhead in
  `app/js/overlays.js`, to be tuned against a real session.
- **The track map is live-only.** Replays would need the archive's
  `Position.z`, about 9MB per session. `service/lib/archive.js` has the
  plumbing; the download cost is what stopped it.
- **Subscription vs region errors** are told apart by the wording of F1's
  message, which is a guess (`service/lib/failure.js`). Correct it if a real
  refusal is ever captured.

## Style

- Match the surrounding code: ES5 (`var`, no arrow functions), since older
  webOS runtimes are in scope. Comments explain *why*, at the density
  already there.
- Commit messages are a short subject line, then prose saying what changed
  and why.
