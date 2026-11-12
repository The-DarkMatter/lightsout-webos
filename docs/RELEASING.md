# Releasing Lights Out on the Homebrew Channel

The steps from here to a listing in [webosbrew/apps-repo](https://github.com/webosbrew/apps-repo),
in order. Everything that could be done away from a TV is done (October
2026). What's left needs the TV, then the release itself.

webosbrew's rules: <https://www.webosbrew.org/develop/guides/publishing/rules/>
and <https://www.webosbrew.org/develop/guides/publishing/how-to/>.

## 1. On the TV, before anything is public

Install the current build first. Either run `bash scripts/deploy.sh <device>`, or
get a build from the workflow's dry run (Actions > Release > Run workflow,
then download the `dry-run` artifact).

- [ ] **Storage that leaves nothing behind (rule 3).** `service/lib/store.js`
  saves the sign-in to `/media/internal/lightsout/state.json`. That survives
  an uninstall, so a token would stay on the TV after the app is gone.
  1. After signing in, find where it really wrote. The service logs
     `store persisting to <path>` (in `/var/log/messages` over SSH).
  2. Find a location that the service can write to and that an uninstall
     removes. Try a folder inside the service's own install directory: its
     `__dirname`, under `/media/developer/apps/usr/palm/services/` for a
     Homebrew install. Check whether it's writable when Luna starts the
     service, then uninstall and check it's gone.
  3. Check what an *update* does to that folder too. If an update wipes it,
     every update signs the viewer out. That may still be the right trade,
     but say so in the README.
  4. Make that the only persistent location. Keep `/tmp` as the fallback.
     Move a `state.json` found in the old location once and delete the old
     folder. Then rewrite the header comment in `store.js` with what you
     found.
- [ ] **Uninstall is clean.** Install, sign in, uninstall. Then over SSH,
  confirm nothing named `lightsout` is left in `/media/internal`, the
  service's home folder or `/tmp`.
- [ ] **Phone sign-in with the pairing code**, end to end from a real phone
  (Firefox for Android). Also test a browser that never scanned the QR code,
  so it has to ask for the code.
- [ ] **TV-browser import** on the rooted TV. It should be offered, stay off
  until allowed, then pick up a formula1.com login.
- [ ] **Regression pass:** Browse and switching weekends, a replay with
  resume, camera switching, audio and captions, the timing tower and track
  map. Then a **live session with Widevine**. Error cards were added since
  the last on-TV test, so watch that a working stream never shows one.
- [ ] **Remote navigation** on the sign-in screen (Up/Down between buttons)
  and on the player's error card.
- [ ] **New icon on the home row.** The launcher caches icons for a few
  minutes after a reinstall.
- [ ] **Screenshots for the README and the listing.** Take them from the
  TV, save them under `docs/screenshots/`, and add a Screenshots section
  to the README.
- [ ] **Code walkthrough.** The README and the PR say the code was written
  with AI coding agents and reviewed and tested by the author. Read through
  the service (`service/index.js`, `service/lib/`) and the player
  (`app/js/watch.js`, `feeds.js`, `overlays.js`) until that's true and you
  can answer a reviewer's "why is this written this way".

## 2. Make the repository public

```sh
gh repo edit The-DarkMatter/lightsout-webos --visibility public --accept-visibility-change-consequences
```

The manifest's icon URL and the listing's icon and screenshots are
`raw.githubusercontent.com` links. They only load once the repo is public.

## 3. Cut the release

The version is already `0.1.0` in `app/appinfo.json` and
`service/package.json`. Bump both together for later releases.

```sh
git tag v0.1.0
git push origin v0.1.0
```

The Release workflow builds the IPK and writes
`com.thedarkmatter.lightsout.manifest.json` (with `rootRequired: "optional"`
and the IPK's sha256). It puts ipk-verify's compatibility report in the run
summary and publishes both files on the GitHub release. A tag with a hyphen
(`v0.2.0-beta.1`) becomes a pre-release, which `releases/latest` skips.

Install the published IPK on the TV once, through Homebrew Channel's own
installer, to prove the release works as users will get it:

```sh
luna-send -n 1 luna://org.webosbrew.hbchannel.service/install \
  '{"ipkUrl":"https://github.com/The-DarkMatter/lightsout-webos/releases/download/v0.1.0/com.thedarkmatter.lightsout_0.1.0_all.ipk","ipkHash":"<sha256 from the manifest>"}'
```

## 4. Submit to apps-repo

Fork `webosbrew/apps-repo` and add
`packages/com.thedarkmatter.lightsout.yml`:

```yaml
title: Lights Out for F1 TV
iconUri: https://raw.githubusercontent.com/The-DarkMatter/lightsout-webos/main/assets/app-icon.png
manifestUrl: https://github.com/The-DarkMatter/lightsout-webos/releases/latest/download/com.thedarkmatter.lightsout.manifest.json
category: multimedia
pool: main
requirements:
  webosRelease: '>=7.0'
screenshots:
  - url: https://raw.githubusercontent.com/The-DarkMatter/lightsout-webos/main/docs/screenshots/<file>.png
    caption: <what it shows>
shortDescription: Unofficial F1 TV player with live timing tower and track map.
description: |
  Watch live sessions and replays from your own F1 TV subscription on an LG
  webOS TV. Switch between the world feed and every onboard camera, and bring
  up a live timing tower and a track map over the video.


  Sign in once from your phone: the app shows a QR code and a pairing code,
  and the sign-in renews itself for at least a month. On a rooted TV it can
  also read your login from the TV's own browser, if you allow it.


  Unofficial: not affiliated with or endorsed by Formula 1, F1 TV or LG. It
  needs your own F1 TV subscription (live sessions and onboards need F1 TV
  Pro or Premium) and plays only what that subscription includes. F1 and
  F1 TV are trademarks of Formula One Licensing B.V.


  Free and open source under the Apache License 2.0.
  Source code: https://github.com/The-DarkMatter/lightsout-webos
```

- `title` must be 30 characters or fewer, and `shortDescription` 80 or fewer.
- `webosRelease: '>=7.0'` (webOS 22) comes from ipk-verify's report: the
  web app's runtime APIs are all present from 7.x, and the bundled `ws`
  needs Node 10 or newer. The apps-repo checks compatibility against the
  releases you name, so lower it only once someone has tested an older TV.
- Screenshots are optional. Drop the block if there are none yet.

Open the PR and fill in its template:

- **Application description:** two or three sentences from the description
  above.
- **Tested on a real webOS TV:** say which, with the exact firmware and
  webOS version (for example LG OLED55C5, webOS 25, firmware 33.xx.xx).
- **Complies with the repository rules.**
- **AI-use declaration:** "AI coding agents were used; an experienced
  developer has reviewed and tested all generated code", ticked only once
  the walkthrough in step 1 is done.

## After the listing

Fixing forward needs no apps-repo change: fix, bump the version, tag, push.
The workflow publishes, and `releases/latest` carries the new manifest to
users. Issues come in through the issue form, which asks for the TV model,
webOS version and app version.
