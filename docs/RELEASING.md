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

Done on the LG C5 on 2026-11-12:

- [x] **Storage that leaves nothing behind (rule 3).** The sign-in now lives
  in `service/state/` inside the service's install folder: writable from
  the jail, kept by a Homebrew update to a newer version, removed by an
  uninstall (see `service/lib/store.js`). No migration from the old
  `/media/internal/lightsout` location: no released build ever wrote there.
- [x] **Uninstall is clean**, checked over SSH after a real sign-in.
- [x] **Phone sign-in with the pairing code** from Firefox for Android,
  starting from a typed address, so the page had to ask for the code.
  Requests without the code, or with a wrong one, get a 403.
- [x] **TV-browser import:** offered, off until allowed, then picked up the
  formula1.com login.
- [x] **Regression pass** on replays: Browse and switching weekends, resume,
  cameras, audio and captions, the timing tower (after fixing the archive's
  new sign-in requirement).
- [x] **Remote navigation** on the sign-in screen.
- [x] **New icon on the home row.**

Still owed, on the next race weekend:

- [ ] **A live session with Widevine.** Error cards were added since the
  last live test, so watch that a working stream never shows one.
- [ ] **The live timing tower lining up with the picture**, including
  across a pause, and the track map live.
- [ ] **Remote navigation on the player's error card** (`?fail=player` in
  the dev server's mock mode shows it, if no real failure comes up).
- [x] **Screenshots for the README and the listing**, in `docs/screenshots/`
  (2026-11-12).
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
  - url: https://raw.githubusercontent.com/The-DarkMatter/lightsout-webos/main/docs/screenshots/browse.jpg
    caption: Browse a race weekend
  - url: https://raw.githubusercontent.com/The-DarkMatter/lightsout-webos/main/docs/screenshots/timing-tower.jpg
    caption: Timing tower over a race replay
  - url: https://raw.githubusercontent.com/The-DarkMatter/lightsout-webos/main/docs/screenshots/cameras.jpg
    caption: Every onboard camera
  - url: https://raw.githubusercontent.com/The-DarkMatter/lightsout-webos/main/docs/screenshots/sign-in.png
    caption: Sign in from your phone
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
- The screenshots are rendered from the app's own pages at 1920x1080
  (headless Edge against `scripts/dev-server.js` with real data), since the
  TV has no screen capture. Replays are unencrypted, so the player pages
  render with real video.

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
