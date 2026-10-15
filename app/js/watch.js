// Real-content playback test. Calls the actual F1TV PLAY chain (via the
// service, since F1's endpoints send no CORS headers and can't be called
// from the page directly) and plays whatever comes back with Shaka.
//
// DRM: earlier testing (off-air VOD/replay content) showed zero
// encryption - no #EXT-X-KEY anywhere - which held for replays but NOT
// for live content. A genuinely live session's PLAY response comes back
// with streamType SDR_HD_CMAFWV (the WV = Widevine), plus drmType:
// "widevine" and a laURL (license acquisition URL) pointing at F1TV's own
// domain. That confirmed the real split: VOD/replay is unencrypted, live
// is Widevine-protected - configure DRM only when the response actually
// says to. The license request needs an entitlementtoken header - the
// PLAY response already hands the page a fresh entitlementToken
// (resultObj.entitlementToken) for this exact purpose, so no new
// plumbing was needed to get it there.

// callService() (Luna on the TV, the dev server on a PC) comes
// from js/luna.js, loaded before this file.

function setStatus(text, cls) {
  var el = document.getElementById("status");
  el.textContent = text;
  el.className = cls || "";
}

var player = null;
var video = document.getElementById("video");
var currentFeeds = [];
// Rapid feed-switch clicks previously raced (an earlier load() could
// resolve/reject after a newer one started, clobbering state). Every
// playUrl() call gets a ticket; only the most recent one is allowed to
// update the UI.
var loadTicket = 0;
// Set from the PLAY response just before each playUrl() call. Read by the
// request filter registered once below, rather than re-registering a new
// filter per load - Shaka doesn't need that and it'd just accumulate.
// Both headers are needed - confirmed against a real captured license
// request during an actual live session, which sent ascendontoken AND
// entitlementtoken together; entitlementtoken alone was untested and
// risked another failed round-trip during a rare live-testing window.
var currentDrmHeaders = null;

function ensurePlayer() {
  if (player) return player;
  shaka.polyfill.installAll();
  player = new shaka.Player();
  player.attach(video);
  player.addEventListener("error", function (event) {
    setStatus("shaka error: " + JSON.stringify(event.detail), "fail");
  });
  // Caption tracks and the playing rendition can change after load - F1's
  // caption tracks can appear once the stream is running.
  ["trackschanged", "textchanged"].forEach(function (name) {
    player.addEventListener(name, function () { showCaptions(); });
  });
  ["trackschanged", "variantchanged", "adaptation", "abrstatuschanged"].forEach(function (name) {
    player.addEventListener(name, function () { showQuality(); });
  });
  player.getNetworkingEngine().registerRequestFilter(function (type, request) {
    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE && currentDrmHeaders) {
      request.headers["entitlementtoken"] = currentDrmHeaders.entitlementToken;
      request.headers["ascendontoken"] = currentDrmHeaders.ascendontoken;
    }
  });
  return player;
}

// labelForFeed(), groupFeeds() and defaultFeed() live in js/feeds.js, loaded
// before this file. currentStreams is the service's per-feed details (driver,
// team, colour) for the loaded content; currentChannelId the feed playing.
var currentStreams = [];
var currentChannelId = null;

function renderFeeds(feeds, activeChannelId, drm) {
  currentFeeds = feeds;
  currentChannelId = activeChannelId;

  // Debug sidebar list (channel id + name, for troubleshooting).
  var debugContainer = document.getElementById("feeds");
  debugContainer.innerHTML = "";
  feeds.forEach(function (feed) {
    var row = document.createElement("div");
    row.className = "feed-row" + (feed.metadata.channel_id === activeChannelId ? " active" : "");
    row.textContent = "channel " + feed.metadata.channel_id + "  (" + labelForFeed(feed, currentStreams) + ")";
    row.addEventListener("click", function () { selectFeed(feed, feeds, drm); });
    debugContainer.appendChild(row);
  });

  // Camera picker: main feeds, then a group per team with its colour, and a
  // check on the feed that's playing.
  var cameraContainer = document.getElementById("camera-rows");
  cameraContainer.innerHTML = "";
  groupFeeds(feeds, currentStreams).forEach(function (group) {
    var head = document.createElement("div");
    head.className = "camera-group";
    head.innerHTML = '<span class="team-mark"></span><span class="group-name"></span>';
    if (group.color) head.querySelector(".team-mark").style.background = group.color;
    head.querySelector(".group-name").textContent = group.name;
    cameraContainer.appendChild(head);

    group.items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "camera-row choice-row" + (item.channelId === activeChannelId ? " selected" : "");
      row.tabIndex = -1;
      row.innerHTML = '<span class="check">' + SVG_CHECK + '</span><span class="code"></span><span class="name"></span>';
      row.querySelector(".code").textContent = item.code;
      row.querySelector(".name").textContent = item.name;
      row.addEventListener("click", function (e) {
        e.stopPropagation();
        selectFeed(item.feed, feeds, drm);
        closeMenus(e.detail === 0);
      });
      cameraContainer.appendChild(row);
    });
  });
}

// Shared by both the debug list and the camera picker: switch playback and
// refresh both lists' active-row highlighting.
//
// A switch keeps the viewer's place. The feeds of one session share a
// timeline - on the 2026 Spanish GP race replay every feed reported the same
// presentation start and length - so a replay's new feed starts at the same
// media time. Live content follows the live edge instead. Speed and the
// caption language carry over too.
function selectFeed(feed, feeds, drm) {
  var carry = { rate: video.playbackRate };
  var caption = activeCaption();
  if (caption) carry.captionLanguage = caption.language;
  try {
    if (player && !player.isLive() && hasDuration()) carry.startTime = scrubTime !== null ? scrubTime : video.currentTime;
  } catch (e) { /* no position to keep */ }
  cancelScrub();
  playUrl(feed.url, drm, carry);
  renderFeeds(feeds, feed.metadata.channel_id, drm);
}

// drm, when present: {laURL, entitlementToken} - only live content has
// this; VOD/replay gets undefined and DRM is explicitly cleared so a
// previous live feed's Widevine config can't linger across a switch.
// opts: {startTime, rate, captionLanguage, toast} - where to start and what
// to restore once the feed has loaded.
function playUrl(url, drm, opts) {
  opts = opts || {};
  var ticket = ++loadTicket;
  feedLoading = true;
  setStatus("loading manifest…", "pending");
  var p = ensurePlayer();
  currentDrmHeaders = drm ? { entitlementToken: drm.entitlementToken, ascendontoken: drm.ascendontoken } : null;
  p.configure({ drm: { servers: drm ? { "com.widevine.alpha": drm.laURL } : {} } });
  p
    .load(url, opts.startTime != null ? opts.startTime : undefined)
    .then(function () {
      if (ticket !== loadTicket) return; // a newer feed switch has already started
      feedLoading = false;
      setStatus("loaded, playing", "ok");
      video.playbackRate = opts.rate || 1;
      if (opts.captionLanguage) {
        var same = textTracks().filter(function (t) { return t.language === opts.captionLanguage; })[0];
        if (same) player.selectTextTrack(same);
      }
      if (opts.toast) showToast(opts.toast);
      // video.play() first and deliberately not returned/awaited: an
      // exception in a later cosmetic setup call (populateCaptions hit
      // exactly this - a Shaka API rename it wasn't using) must never be
      // able to prevent playback from starting again. Each is individually
      // wrapped too, as defense in depth.
      video.play().catch(function (err) {
        if (ticket === loadTicket && err && err.name !== "AbortError") {
          setStatus("video.play() failed: " + err.name + " " + err.message, "fail");
        }
      });
      // Captions are off on load (no text track selected) - see activeCaption().
      showCaptions();
      showQuality();
    })
    .catch(function (err) {
      if (ticket !== loadTicket) return; // stale failure from an abandoned switch
      if (err && err.name === "AbortError") return; // benign - a newer switch interrupted this one
      // Previous guess (bare DOMException) didn't match reality - this
      // dumps everything available instead of guessing again: type,
      // constructor, every own property name (own + non-enumerable), and
      // a plain String() fallback, so the real shape is visible without
      // needing devtools attached.
      var diag =
        "typeof=" + typeof err +
        " ctor=" + (err && err.constructor && err.constructor.name) +
        " toString=" + Object.prototype.toString.call(err) +
        " keys=" + (err ? JSON.stringify(Object.getOwnPropertyNames(err)) : "n/a") +
        " String()=" + String(err) +
        " JSON=" + JSON.stringify(err);
      setStatus("load/play failed: " + diag, "fail");
    });
}

// --- playback controls -----------------------------------------------

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = Math.floor(sec % 60);
  var mm = (h > 0 && m < 10 ? "0" : "") + m;
  var ss = (s < 10 ? "0" : "") + s;
  return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
}

// Line-art icon paths (YouTube/Material style) swapped in as state changes -
// keeping these as raw SVG markup rather than emoji so they render as
// consistent, monochrome glyphs instead of platform-colourful emoji.
var ICON_PAUSE = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
var ICON_PLAY = '<svg class="icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
var ICON_VOLUME_UP =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
  '<path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z' +
  'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.06c1.48-.74 2.5-2.26 2.5-4.03z"/></svg>';
var ICON_VOLUME_MUTED =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
  '<path d="M19.48 12 22 9.48 20.94 8.42 18.42 10.94 15.9 8.42 14.84 9.48 17.36 12 14.84 14.52 15.9 15.58 18.42 13.06 20.94 15.58 22 14.52z"/></svg>';

var controlsEl = document.getElementById("controls");
var playPauseBtn = document.getElementById("playpause-btn");
var muteBtn = document.getElementById("mute-btn");
var volumeEl = document.getElementById("volume");
var cameraBtn = document.getElementById("camera-btn");
var cameraPanel = document.getElementById("camera-panel");
var settingsBtn = document.getElementById("settings-btn");
var settingsPanel = document.getElementById("settings-panel");

var REDUCE_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

// Swaps a button's icon and lets the new one pop in.
function setIcon(btn, html) {
  btn.innerHTML = html;
  var icon = btn.querySelector(".icon");
  if (icon && !REDUCE_MOTION) icon.classList.add("pop");
}

// Press feedback on every control button, whether clicked or pressed with
// the remote's OK (which also fires click).
Array.prototype.forEach.call(document.querySelectorAll("#controls button.ctrl"), function (btn) {
  btn.addEventListener("click", function () {
    btn.classList.remove("pressed");
    void btn.offsetWidth; // restart the animation on quick repeat presses
    btn.classList.add("pressed");
  });
  btn.addEventListener("animationend", function (e) {
    if (e.animationName === "press") btn.classList.remove("pressed");
  });
});

function togglePlay() {
  if (video.paused) video.play();
  else video.pause();
}
playPauseBtn.addEventListener("click", togglePlay);
video.addEventListener("play", function () { setIcon(playPauseBtn, ICON_PAUSE); showControls(); });
video.addEventListener("pause", function () { setIcon(playPauseBtn, ICON_PLAY); showControls(); });

// One place paints volume state, from the video's own volumechange: the
// slider's white fill (empty while muted) and the mute icon.
var mutedIconShown = false;
function paintVolume() {
  var level = video.muted ? 0 : video.volume;
  volumeEl.value = String(level);
  volumeEl.style.setProperty("--fill", level * 100 + "%");
  var muted = video.muted || video.volume === 0;
  if (muted !== mutedIconShown) {
    mutedIconShown = muted;
    setIcon(muteBtn, muted ? ICON_VOLUME_MUTED : ICON_VOLUME_UP);
  }
}
muteBtn.addEventListener("click", function () {
  video.muted = !video.muted;
});
volumeEl.addEventListener("input", function () {
  video.volume = Number(volumeEl.value);
  if (video.volume > 0 && video.muted) video.muted = false;
  paintVolume();
});
video.addEventListener("volumechange", paintVolume);

// The manual-load panel is a developer tool, off unless it was switched on
// from the sign-in screen's Developer tools (js/setup.js writes this key).
// When it's off there's no button for it, so the picture stays edge to edge.
var debugBtn = document.getElementById("debug-btn");
try {
  debugBtn.hidden = window.localStorage.getItem("f1hud.devtools.panel") !== "1";
} catch (e) {
  debugBtn.hidden = true;
}
debugBtn.addEventListener("click", function () {
  document.getElementById("left").classList.toggle("hidden-panel");
});

// --- seek bar ------------------------------------------------------------
// Remote: Left/Right step 10s (FF/Rewind keys too). Presses in quick
// succession add up and commit as one seek once they stop, so holding the
// key doesn't fire a stream of seeks. The bubble shows where it'll land.
// Pointer: click or drag.

var SEEK_STEP = 10;
var SEEK_COMMIT_DELAY = 700;

var seekEl = document.getElementById("seek");
var seekPlayed = document.getElementById("seek-played");
var seekBuffered = document.getElementById("seek-buffered");
var seekThumb = document.getElementById("seek-thumb");
var seekBubble = document.getElementById("seek-bubble");
var timeCurrent = document.getElementById("time-current");
var timeTotal = document.getElementById("time-total");
var scrubTime = null; // pending target while stepping or dragging
var scrubTimer = null;

function hasDuration() {
  return isFinite(video.duration) && video.duration > 0;
}

// The wall-clock instant showing on screen, or null if the stream doesn't
// say. F1 TV's manifests carry EXT-X-PROGRAM-DATE-TIME, so Shaka can map the
// playhead back to real time - which is what lets js/overlays.js ask the
// service for the timing as it stood at this point of a replay, instead of
// showing whatever the live feed happens to be saying now. Used by
// overlays.js, which loads after this file.
function playheadUtc() {
  if (!player) return null;
  try {
    var date = player.getPlayheadTimeAsDate();
    var ms = date && date.getTime ? date.getTime() : 0;
    // Shaka answers 1970 when the manifest carried no date at all.
    return ms > 864e5 ? ms : null;
  } catch (e) {
    return null;
  }
}

// Live content has its own feed; only replays need the archive.
//
// player.isLive() is NOT the test, though it looks like it should be: F1 TV
// serves a session that is happening right now as a growing VOD manifest, so
// Shaka correctly reports isLive() false while the picture is live. Trusting
// it sent a live session to the archive, which has nothing to say about a
// session still in progress, and both overlays went blank (seen during Baku
// FP2).
//
// What actually distinguishes them is the one thing already known: how far
// back the picture is. At the live edge the live feed describes what's on
// screen; further back than that, only the archive does - which is also the
// right answer for a live session someone has paused or rewound well behind.
var LIVE_EDGE_MS = 5 * 60 * 1000;

function isReplay() {
  try {
    if (player && player.isLive()) return false;
  } catch (e) { /* fall through to the timestamp */ }
  var at = playheadUtc();
  // No timestamps in the manifest: nothing to look up in the archive
  // anyway, so behave as this did before the archive existed.
  if (at === null) return false;
  return Date.now() - at > LIVE_EDGE_MS;
}

function paintSeek(t) {
  if (!hasDuration()) return;
  var pct = Math.max(0, Math.min(1, t / video.duration)) * 100;
  seekPlayed.style.width = pct + "%";
  seekThumb.style.left = pct + "%";
  seekBubble.style.left = pct + "%";
  seekBubble.textContent = formatTime(t);
  timeCurrent.textContent = formatTime(t);
  seekEl.setAttribute("aria-valuenow", String(Math.round(pct)));
}

function paintBuffered() {
  if (!hasDuration()) return;
  var end = 0;
  for (var i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i));
  }
  seekBuffered.style.width = Math.min(100, (end / video.duration) * 100) + "%";
}

video.addEventListener("timeupdate", function () {
  if (scrubTime === null) paintSeek(video.currentTime);
  paintBuffered();
});
video.addEventListener("progress", paintBuffered);
video.addEventListener("durationchange", function () {
  timeTotal.textContent = formatTime(video.duration);
  paintSeek(scrubTime === null ? video.currentTime : scrubTime);
});

function scrubTo(t) {
  scrubTime = Math.max(0, Math.min(video.duration - 0.5, t));
  seekEl.classList.add("scrubbing");
  paintSeek(scrubTime);
}

function scrubBy(seconds) {
  if (!hasDuration()) return;
  scrubTo((scrubTime === null ? video.currentTime : scrubTime) + seconds);
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(commitScrub, SEEK_COMMIT_DELAY);
}

function cancelScrub() {
  clearTimeout(scrubTimer);
  scrubTime = null;
  seekEl.classList.remove("scrubbing");
}

function commitScrub() {
  clearTimeout(scrubTimer);
  if (scrubTime === null) return;
  video.currentTime = scrubTime;
  scrubTime = null;
  seekEl.classList.remove("scrubbing");
}

function timeAtPointer(e) {
  var r = seekEl.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
}
seekEl.addEventListener("pointerdown", function (e) {
  if (!hasDuration()) return;
  seekEl.setPointerCapture(e.pointerId);
  scrubTo(timeAtPointer(e));
});
seekEl.addEventListener("pointermove", function (e) {
  if (scrubTime !== null && seekEl.hasPointerCapture(e.pointerId)) scrubTo(timeAtPointer(e));
});
seekEl.addEventListener("pointerup", function () {
  commitScrub();
});

// --- menus ---------------------------------------------------------------------
// Cameras and Settings are menus on their own buttons. Captions, resolution
// and speed each open a choice list: from their bar button, or from their
// row inside Settings (a drill-down whose header leads back to Settings).
// Opening from the remote moves focus into the menu (the current choice);
// closing returns it to the button it came from.

var buttonRow = document.getElementById("button-row");
var choicePanel = document.getElementById("choice-panel");
var captionsBtn = document.getElementById("captions-btn");
var qualityBtn = document.getElementById("quality-btn");
var speedBtn = document.getElementById("speed-btn");

var settingsMenu = { panel: settingsPanel, btn: settingsBtn, rows: ".settings-row:not([hidden])" };
// btn, kind and fromSettings are set each time it opens.
var choiceMenu = { panel: choicePanel, btn: null, rows: ".choice-head, .choice-row:not(.disabled)", kind: null, fromSettings: false };
var MENUS = [
  { panel: cameraPanel, btn: cameraBtn, rows: ".camera-head, .camera-row" },
  settingsMenu,
  choiceMenu,
];

function openMenu() {
  for (var i = 0; i < MENUS.length; i++) {
    if (MENUS[i].panel.classList.contains("open")) return MENUS[i];
  }
  return null;
}

function menuRows(menu) {
  return Array.prototype.slice.call(menu.panel.querySelectorAll(menu.rows));
}

function closeMenus(returnFocus) {
  var menu = openMenu();
  MENUS.forEach(function (m) {
    m.panel.classList.remove("open");
    if (m.btn) m.btn.classList.remove("open");
  });
  if (menu && menu.btn && returnFocus) menu.btn.focus({ preventScroll: true });
  showControls();
}

function focusRow(row) {
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

function toggleMenu(menu, fromRemote) {
  var wasOpen = menu.panel.classList.contains("open");
  closeMenus(false);
  if (wasOpen) {
    if (fromRemote) menu.btn.focus({ preventScroll: true });
    return;
  }
  if (menu === settingsMenu) showSettingsValues();
  menu.panel.classList.add("open");
  menu.btn.classList.add("open");
  if (fromRemote) {
    var start = menu.panel.querySelector(".camera-row.selected") || menuRows(menu)[0];
    if (start) focusRow(start);
  }
  showControls();
}

[MENUS[0], settingsMenu].forEach(function (menu) {
  menu.btn.addEventListener("click", function (e) {
    e.stopPropagation();
    // A click from the remote's OK has detail 0; a pointer click counts 1+.
    toggleMenu(menu, e.detail === 0);
  });
});
cameraPanel.querySelector(".camera-head").addEventListener("click", function (e) {
  e.stopPropagation();
  closeMenus(e.detail === 0);
});
document.addEventListener("click", function (e) {
  var menu = openMenu();
  if (menu && !menu.panel.contains(e.target) && !(menu.btn && menu.btn.contains(e.target))) closeMenus(false);
});

// --- choice lists --------------------------------------------------------------

var SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
var SVG_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
var SVG_BACK = '<svg viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
var ICON_CAPTIONS_ON =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>';
var ICON_CAPTIONS_OFF =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M6.83 4H19c1.1 0 2 .9 2 2v12c0 .05-.01.1-.02.16l-3.38-3.38c.24-.19.4-.46.4-.78v-1h-1.5v.5h-.18l-1.82-1.82V10.5h2v.5H18v-1c0-.55-.45-1-1-1h-3c-.55 0-1 .45-1 1v.17L6.83 4zm12.95 18.61L17.17 20H5c-1.11 0-2-.9-2-2V6c0-.05.02-.1.02-.15L1.39 4.22 2.8 2.81l18.38 18.38-1.4 1.42zM11 13.83L10.17 13H9.5v.5h-2v-3h.17L6.4 9.22c-.24.19-.4.46-.4.78v4c0 .55.45 1 1 1h3c.55 0 1-.45 1-1v-.17z"/></svg>';

// Each kind: a title, the button that opens it from the bar, its row in
// Settings, and its current options - [{label, hint?, selected, pick()}].
var CHOICES = {
  captions: { title: "Captions", btn: captionsBtn, row: "row-captions", options: captionChoices, empty: "No captions for this stream" },
  quality: { title: "Resolution", btn: qualityBtn, row: "row-resolution", options: qualityChoices },
  speed: { title: "Playback speed", btn: speedBtn, row: "row-speed", options: speedChoices },
  // Commentary language. Settings only - no bar button.
  language: { title: "Language", btn: null, row: "row-language", options: audioChoices },
};

// Positions the list above the button it belongs to. Measured in the page's
// own pixels: in a desktop preview the whole page is CSS-scaled.
function placeChoicePanel(anchor) {
  var rowRect = buttonRow.getBoundingClientRect();
  var scale = rowRect.width / buttonRow.offsetWidth || 1;
  var right = (rowRect.right - anchor.getBoundingClientRect().right) / scale;
  choicePanel.style.right = Math.max(0, right) + "px";
}

function openChoices(kind, fromSettings, fromRemote) {
  var choice = CHOICES[kind];
  var anchor = fromSettings ? settingsBtn : choice.btn;
  var options = choice.options();
  closeMenus(false);
  choiceMenu.btn = anchor;
  choiceMenu.kind = kind;
  choiceMenu.fromSettings = fromSettings;

  choicePanel.innerHTML = "";
  var head = document.createElement("div");
  head.className = "choice-head";
  head.tabIndex = -1;
  head.innerHTML = (fromSettings ? SVG_BACK : SVG_CLOSE) + "<span></span>";
  head.querySelector("span").textContent = choice.title;
  head.addEventListener("click", function (e) {
    e.stopPropagation();
    if (fromSettings) backToSettings(e.detail === 0);
    else closeMenus(e.detail === 0);
  });
  choicePanel.appendChild(head);
  var sep = document.createElement("div");
  sep.className = "choice-sep";
  choicePanel.appendChild(sep);

  var selectedRow = null;
  options.forEach(function (opt) {
    var row = document.createElement("div");
    row.className = "choice-row" + (opt.selected ? " selected" : "");
    row.tabIndex = -1;
    row.innerHTML = '<span class="check">' + SVG_CHECK + '</span><span class="name"></span><span class="hint"></span>';
    row.querySelector(".name").textContent = opt.label;
    row.querySelector(".hint").textContent = opt.hint || "";
    row.addEventListener("click", function (e) {
      e.stopPropagation();
      opt.pick();
      closeMenus(e.detail === 0);
    });
    if (opt.selected) selectedRow = row;
    choicePanel.appendChild(row);
  });
  if (options.length <= 1 && choice.empty) {
    var note = document.createElement("div");
    note.className = "choice-row disabled";
    note.innerHTML = '<span class="check"></span><span class="name"></span>';
    note.querySelector(".name").textContent = choice.empty;
    choicePanel.insertBefore(note, sep.nextSibling);
  }

  placeChoicePanel(anchor);
  choicePanel.classList.add("open");
  anchor.classList.add("open");
  if (fromRemote) focusRow(selectedRow || head);
  showControls();
}

function backToSettings(fromRemote) {
  var kind = choiceMenu.kind;
  toggleMenu(settingsMenu, fromRemote);
  if (fromRemote) focusRow(document.getElementById(CHOICES[kind].row));
}

Object.keys(CHOICES).forEach(function (kind) {
  var choice = CHOICES[kind];
  if (choice.btn) {
    choice.btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var fromRemote = e.detail === 0;
      if (openMenu() === choiceMenu && choiceMenu.btn === choice.btn) closeMenus(fromRemote);
      else openChoices(kind, false, fromRemote);
    });
  }
  var row = document.getElementById(choice.row);
  row.classList.add("drill");
  row.addEventListener("click", function (e) {
    e.stopPropagation();
    openChoices(kind, true, e.detail === 0);
  });
});

// Sets a text button's label, popping it in when it changes.
function setLabel(btn, text) {
  var label = btn.querySelector(".label");
  if (label.textContent === text) return;
  label.textContent = text;
  if (REDUCE_MOTION) return;
  label.classList.remove("pop");
  void label.offsetWidth;
  label.classList.add("pop");
}

// --- captions ----------------------------------------------------------------
// Tracks come from Shaka, and can appear after the stream has started, so the
// UI re-reads them on its track events (see ensurePlayer).

function languageName(code) {
  if (!code) return "";
  try {
    var name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch (e) {
    return String(code).toUpperCase();
  }
}

function textTracks() {
  try {
    return player ? player.getTextTracks() : [];
  } catch (e) {
    return [];
  }
}

// Shaka 5 has no separate caption visibility on the player (setTextVisibility
// and isTextVisible live on its internal text displayers now, and calling
// them on the player throws): captions are on exactly when a text track is
// selected, and selectTextTrack(null) turns them off. Checked against a real
// race replay - the browser's own track goes "showing" on select and
// "hidden" on null.
function activeCaption() {
  return textTracks().filter(function (t) { return t.active; })[0] || null;
}

function captionLabel(t) {
  return languageName(t.language) || t.label || "Unknown";
}

function captionChoices() {
  var active = activeCaption();
  var options = textTracks().map(function (t) {
    return {
      label: captionLabel(t),
      selected: !!active && active.id === t.id,
      pick: function () {
        player.selectTextTrack(t);
        showCaptions();
      },
    };
  });
  options.push({
    label: "Off",
    selected: !active,
    pick: function () {
      if (player) player.selectTextTrack(null);
      showCaptions();
    },
  });
  return options;
}

var captionsIconOn = null;
function showCaptions() {
  var active = activeCaption();
  var on = !!active;
  if (on !== captionsIconOn) {
    captionsIconOn = on;
    setIcon(captionsBtn, on ? ICON_CAPTIONS_ON : ICON_CAPTIONS_OFF);
  }
  captionsBtn.classList.toggle("toggled", on);
  captionsBtn.title = on ? "Captions: " + captionLabel(active) : "Captions: off";
}

// --- resolution ----------------------------------------------------------------

function variantTracks() {
  try {
    return player ? player.getVariantTracks() : [];
  } catch (e) {
    return [];
  }
}

function abrEnabled() {
  try {
    return !player || player.getConfiguration().abr.enabled;
  } catch (e) {
    return true;
  }
}

var CODEC_NAMES = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", vp09: "VP9", av01: "AV1" };

// One option per height (and codec, when a height comes in more than one).
function qualityChoices() {
  var tracks = variantTracks();
  var active = tracks.filter(function (t) { return t.active; })[0];
  var auto = abrEnabled();
  var byKey = {};
  var perHeight = {};
  tracks.forEach(function (t) {
    if (!t.height) return;
    var codec = (t.videoCodec || "").split(".")[0];
    var key = t.height + ":" + codec;
    if (!byKey[key]) {
      byKey[key] = { height: t.height, codec: codec, full: t.videoCodec || "" };
      perHeight[t.height] = (perHeight[t.height] || 0) + 1;
    }
  });
  var options = [{
    label: "Auto",
    hint: auto && active && active.height ? active.height + "p" : "",
    selected: auto,
    pick: function () {
      player.configure({ abr: { enabled: true } });
      showQuality();
    },
  }];
  Object.keys(byKey)
    .map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return b.height - a.height; })
    .forEach(function (q) {
      options.push({
        label: q.height + "p",
        hint: perHeight[q.height] > 1 ? CODEC_NAMES[q.codec] || q.codec : "",
        selected: !auto && !!active && active.height === q.height && (active.videoCodec || "").split(".")[0] === q.codec,
        pick: function () {
          var matching = variantTracks().filter(function (t) {
            return t.height === q.height && (t.videoCodec || "").split(".")[0] === q.codec;
          });
          if (!matching.length) return;
          var best = matching.reduce(function (a, b) { return b.bandwidth > a.bandwidth ? b : a; });
          player.configure({ abr: { enabled: false } });
          player.selectVariantTrack(best, true);
          showQuality();
        },
      });
    });
  return options;
}

function showQuality() {
  var active = variantTracks().filter(function (t) { return t.active; })[0];
  setLabel(qualityBtn, abrEnabled() || !active ? "Auto" : active.height + "p");
}

// --- playback speed --------------------------------------------------------------

var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function speedName(rate) {
  return rate === 1 ? "Normal" : rate + "x";
}

function speedChoices() {
  return SPEEDS.map(function (rate) {
    return {
      label: speedName(rate),
      selected: video.playbackRate === rate,
      pick: function () { video.playbackRate = rate; },
    };
  });
}

function showSpeed() {
  setLabel(speedBtn, video.playbackRate + "x");
}
video.addEventListener("ratechange", showSpeed);

// --- commentary language ---------------------------------------------------------
// One option per audio track Shaka reports (F1 TV streams can carry several
// commentary languages). Named by the stream's own label when it has one,
// otherwise by language.

function audioTracks() {
  try {
    return player ? player.getAudioTracks() : [];
  } catch (e) {
    return [];
  }
}

// The playing feed's details name its audio tracks ("English Int.",
// "Track FX"); onboards add "tea", the driver's team radio.
function audioLabel(t) {
  var names = (streamsByChannel(currentStreams)[currentChannelId] || {}).audioTrackNames || {};
  var named = names[t.language] || names[t.label];
  if (t.language === "tea" || t.label === "tea") return "Team radio" + (named ? " (" + named + ")" : "");
  return named || t.label || languageName(t.language) || "Default";
}

function audioChoices() {
  var tracks = audioTracks();
  if (!tracks.length) return [{ label: "Default", selected: true, pick: function () {} }];
  return tracks.map(function (t) {
    return {
      label: audioLabel(t),
      hint: t.channelsCount > 2 ? t.channelsCount + " ch" : "",
      selected: !!t.active,
      pick: function () { player.selectAudioTrack(t); },
    };
  });
}

// Values shown on the Settings rows, refreshed each time Settings opens.
function showSettingsValues() {
  var caption = activeCaption();
  document.getElementById("val-captions").textContent = caption ? captionLabel(caption) : textTracks().length ? "Off" : "None";
  document.getElementById("icon-captions").innerHTML = (caption ? ICON_CAPTIONS_ON : ICON_CAPTIONS_OFF).replace(' class="icon"', "");

  var active = variantTracks().filter(function (t) { return t.active; })[0];
  var auto = abrEnabled();
  document.getElementById("val-resolution").textContent = auto || !active ? "Auto" : active.height + "p";
  document.getElementById("hint-resolution").textContent = auto && active && active.height ? active.height + "p" : "";

  var audio = audioTracks().filter(function (t) { return t.active; })[0];
  document.getElementById("val-language").textContent = audio ? audioLabel(audio) : "Default";
  document.getElementById("val-speed").textContent = speedName(video.playbackRate);
}

showCaptions();
showQuality();
showSpeed();

// Bar buttons vs menu rows. In priority order, each setting gets a button in
// the bar while the button row has room for it; otherwise its row stays in
// the settings menu. Re-runs whenever the bar's width changes (the debug
// sidebar opening or closing narrows the player).
var BAR_SETTINGS = [
  { btn: captionsBtn, row: document.getElementById("row-captions") },
  { btn: qualityBtn, row: document.getElementById("row-resolution") },
  { btn: speedBtn, row: document.getElementById("row-speed") },
];
var BAR_BREATHING_ROOM = 96; // kept clear between the left and right groups

function fitBarButtons() {
  var groups = buttonRow.querySelectorAll(".group");
  var focused = document.activeElement;
  BAR_SETTINGS.forEach(function (s) {
    s.btn.hidden = true;
    s.row.hidden = false;
  });
  var free = buttonRow.clientWidth - groups[0].offsetWidth - groups[1].offsetWidth - BAR_BREATHING_ROOM;
  for (var i = 0; i < BAR_SETTINGS.length; i++) {
    var s = BAR_SETTINGS[i];
    s.btn.hidden = false;
    var needed = s.btn.offsetWidth + 12; // button + the group's gap
    if (needed > free) {
      s.btn.hidden = true;
      break;
    }
    free -= needed;
    s.row.hidden = true;
  }
  // Don't leave focus on something that just moved into the menu.
  if (focused && focused.hidden) focusButton(settingsBtn);
  var menu = openMenu();
  if (menu === choiceMenu && choiceMenu.btn) placeChoicePanel(choiceMenu.btn);
}

if (window.ResizeObserver) {
  new ResizeObserver(fitBarButtons).observe(buttonRow);
} else {
  window.addEventListener("resize", fitBarButtons);
}
fitBarButtons();

// Statistics: toggles the debug overlay (buffered/dropped-frames/active
// track) that's been there since M1.
document.getElementById("row-stats").addEventListener("click", function () {
  var statsEl = document.getElementById("stats");
  var on = statsEl.style.display === "none";
  statsEl.style.display = on ? "block" : "none";
  document.getElementById("val-stats").textContent = on ? "On" : "Off";
});

function startStatsLoop() {
  var statsEl = document.getElementById("stats");
  setInterval(function () {
    if (!player) return;
    var stats = player.getStats ? player.getStats() : {};
    var track = null;
    try {
      track = player.getVariantTracks().filter(function (t) { return t.active; })[0];
    } catch (e) { /* ignore */ }
    statsEl.textContent =
      "buffered=" + (video.buffered.length ? video.buffered.end(0).toFixed(1) : "0") +
      "  dropped=" + (stats.droppedFrames || 0) +
      (track ? "\n" + track.width + "x" + track.height + " " + (track.videoCodec || "") : "");
  }, 1000);
}

function loadContent(contentId, platform) {
  if (!contentId) {
    setStatus("enter a contentId first", "fail");
    return;
  }
  currentContentId = contentId;
  setStatus("calling PLAY…", "pending");
  callService("f1tvPlayTest", { contentId: contentId, platform: platform || undefined })
    .then(function (res) {
      if (!res.returnValue || !res.result || !res.result.play) {
        setStatus("f1tvPlayTest failed: " + JSON.stringify(res), "fail");
        return;
      }
      var play = res.result.play;
      if (play.statusCode !== 200 || !play.body || !play.body.resultObj || !play.body.resultObj.tme) {
        setStatus("PLAY returned " + play.statusCode + ": " + JSON.stringify(play.body), "fail");
        return;
      }
      var resultObj = play.body.resultObj;
      var feeds = resultObj.tme.feeds || [];
      // Live content only: drmType/laURL present -> Widevine-protected.
      // VOD/replay has neither -> drm stays undefined, DRM config cleared.
      var drm = resultObj.laURL
        ? { laURL: resultObj.laURL, entitlementToken: resultObj.entitlementToken, ascendontoken: res.result.ascendontoken }
        : undefined;
      // Names for the feeds (driver, team) - empty if the details call failed,
      // in which case feeds.js falls back to channel ids and car numbers.
      currentStreams = res.result.streams || [];
      // Start on the international broadcast, not F1's own default (the
      // "F1 Live" pre-show feed) - see defaultFeed().
      var main = defaultFeed(feeds, currentStreams, resultObj.channelId);
      setStatus(
        "PLAY OK - streamType=" + resultObj.streamType +
        (drm ? " (DRM: " + resultObj.drmType + ")" : "") +
        " playing=" + (main ? labelForFeed(main, currentStreams) + " (" + main.metadata.channel_id + ")" : "?") +
        " feeds=" + feeds.length +
        " named=" + currentStreams.length,
        "ok"
      );
      renderFeeds(feeds, main ? main.metadata.channel_id : null, drm);
      // Pick up a replay where it was left (js/resume.js).
      var resume = getResume(contentId);
      if (main) {
        playUrl(main.url, drm, resume ? { startTime: resume.t, toast: "Resuming from " + resumeClock(resume.t) } : null);
      }
    })
    .catch(function (err) {
      setStatus("service call failed: " + JSON.stringify(err), "fail");
    });
}

document.getElementById("load-btn").addEventListener("click", function () {
  loadContent(
    document.getElementById("content-id").value.trim(),
    document.getElementById("platform").value.trim()
  );
});

// Arriving from browse.html?contentId=X - prefill and auto-load.
(function () {
  var params = new URLSearchParams(window.location.search);
  var contentId = params.get("contentId");
  if (contentId) {
    document.getElementById("content-id").value = contentId;
    loadContent(contentId, params.get("platform"));
  }
})();

startStatsLoop();

// --- resume --------------------------------------------------------------------
// Records how far into a replay the viewer is (js/resume.js): every few
// seconds while playing, and on pause, seek and leaving the page. Nothing is
// recorded for live streams, mid-seek, or while a feed is loading (its
// position briefly reads 0).

// Declared without values on purpose: the auto-load above has already run
// by this point, and loadContent/playUrl may have set them.
var currentContentId;
var feedLoading;
var lastProgressSave = 0;
var PROGRESS_SAVE_INTERVAL = 5000;

function recordProgress(force) {
  if (!currentContentId || !player || feedLoading || scrubTime !== null || !hasDuration()) return;
  try {
    if (player.isLive()) return;
  } catch (e) {
    return;
  }
  var now = Date.now();
  if (!force && now - lastProgressSave < PROGRESS_SAVE_INTERVAL) return;
  lastProgressSave = now;
  saveResume(currentContentId, video.currentTime, video.duration);
}
video.addEventListener("timeupdate", function () { recordProgress(false); });
video.addEventListener("pause", function () { recordProgress(true); });
video.addEventListener("seeked", function () { recordProgress(true); });
video.addEventListener("ended", function () { recordProgress(true); });
window.addEventListener("pagehide", function () { recordProgress(true); });

// A short message at the top of the picture, e.g. "Resuming from 50:02".
var toastTimer = null;
function showToast(text) {
  var toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 3500);
}

// --- controls auto-hide ----------------------------------------------------
// Hides the control bar after a few seconds without input while the video
// plays. Stays up while paused, with a menu open, or mid-seek. Shown again by
// any remote key, the Magic Remote's scroll wheel, or pointer movement.

var controlsHideTimer = null;
var CONTROLS_HIDE_DELAY = 4000;
var TOWER_CLEARANCE = 20; // px between the tower's bottom edge and the seek bar

function controlsHidden() {
  return controlsEl.classList.contains("controls-hidden");
}

// A full timing tower runs almost the height of the screen, so with the bar
// up its last row sat under the seek bar. Shrink it (about 90% with 22 cars)
// to end just above the bar instead: every car stays on screen, which
// clipping wouldn't do, and it grows back when the bar hides. Also called
// from overlays.js whenever the tower opens or redraws, since its height
// changes as rows arrive.
function fitTowerAboveControls() {
  var tower = document.getElementById("timing-tower-overlay");
  var seekRow = document.getElementById("seek-row");
  var scale = 1;
  if (!controlsHidden() && tower.offsetHeight) {
    var room = controlsEl.offsetTop + seekRow.offsetTop - TOWER_CLEARANCE - tower.offsetTop;
    scale = Math.min(1, room / tower.offsetHeight);
  }
  tower.style.transform = scale < 1 ? "scale(" + scale.toFixed(3) + ")" : "";
}

function hideControls() {
  controlsEl.classList.add("controls-hidden");
  fitTowerAboveControls();
}

function showControls() {
  controlsEl.classList.remove("controls-hidden");
  fitTowerAboveControls();
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(function () {
    if (!video.paused && !openMenu() && scrubTime === null) hideControls();
  }, CONTROLS_HIDE_DELAY);
}

document.addEventListener("wheel", showControls);
document.addEventListener("mousemove", showControls);

// --- remote navigation -------------------------------------------------------
// Two rows: the seek bar, and the buttons below it.
//   Up/Down        between the rows (and through an open menu's rows)
//   Left/Right     seek on the bar; previous/next button on the button row
//   OK             press the button / pick the menu row
//   Back           close a menu, then hide the controls, then leave the player
//   Play/Pause/FF/Rewind keys work from anywhere.
// While the controls are hidden, the first key press only brings them back.
// Runs in the capture phase so Back is handled here before back-nav.js.

var KEY = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESCAPE: 27, SPACE: 32,
  PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, FAST_FORWARD: 417, REWIND: 412,
};
var lastButton = playPauseBtn;

function stop(e) {
  e.preventDefault();
  e.stopPropagation();
}

function rowButtons() {
  return Array.prototype.slice.call(document.querySelectorAll("#button-row button.ctrl")).filter(function (b) {
    return b.offsetParent !== null;
  });
}

function focusButton(btn) {
  btn.focus({ preventScroll: true });
  lastButton = btn;
}

// A short push in the pressed direction and back: "nothing further this way".
function nudge(el, dx, dy) {
  if (REDUCE_MOTION || !el.animate) return;
  var push = "translate(" + dx * 10 + "px, " + dy * 8 + "px)";
  el.animate([{ transform: "none" }, { transform: push, offset: 0.35 }, { transform: "none" }], { duration: 280, easing: "ease-out" });
}

function handleMenuKey(menu, k, e) {
  var rows = menuRows(menu);
  var i = rows.indexOf(document.activeElement);
  if (k === KEY.UP || k === KEY.DOWN) {
    stop(e);
    if (i === -1) {
      if (rows[0]) focusRow(rows[0]);
      return;
    }
    var j = i + (k === KEY.DOWN ? 1 : -1);
    if (j >= 0 && j < rows.length) focusRow(rows[j]);
    else nudge(rows[i], 0, k === KEY.DOWN ? 1 : -1);
  } else if (k === KEY.LEFT) {
    stop(e);
    if (menu === choiceMenu && choiceMenu.fromSettings) backToSettings(true);
    else closeMenus(true);
  } else if (k === KEY.RIGHT) {
    stop(e);
    // Right on a Settings row that opens a list opens it.
    if (i !== -1 && rows[i].classList.contains("drill")) rows[i].click();
  } else if (k === KEY.ENTER) {
    stop(e);
    if (i !== -1) rows[i].click();
  }
}

window.addEventListener(
  "keydown",
  function (e) {
    var k = e.keyCode;
    var active = document.activeElement;
    // Typing in the debug sidebar's text fields: leave keys alone.
    if (active && active.tagName === "INPUT" && active.type === "text") return;

    if (k === KEY.PLAY || k === KEY.PAUSE || k === KEY.PLAY_PAUSE) {
      stop(e);
      if (k === KEY.PLAY) video.play();
      else if (k === KEY.PAUSE) video.pause();
      else togglePlay();
      showControls();
      return;
    }
    if (k === KEY.FAST_FORWARD || k === KEY.REWIND) {
      stop(e);
      showControls();
      scrubBy(k === KEY.FAST_FORWARD ? SEEK_STEP : -SEEK_STEP);
      return;
    }

    var menu = openMenu();
    if (k === KEY.BACK || k === KEY.ESCAPE) {
      if (menu) {
        stop(e);
        if (menu === choiceMenu && choiceMenu.fromSettings) backToSettings(true);
        else closeMenus(true);
      } else if (!controlsHidden() && !video.paused) {
        stop(e);
        hideControls();
      }
      return; // otherwise back-nav.js leaves the player
    }

    var nav = [KEY.LEFT, KEY.UP, KEY.RIGHT, KEY.DOWN, KEY.ENTER].indexOf(k) !== -1;
    if (!nav && k !== KEY.SPACE) return;

    if (controlsHidden()) {
      stop(e);
      showControls();
      if (!controlsEl.contains(active)) focusButton(lastButton);
      return;
    }
    showControls();

    if (k === KEY.SPACE && active === seekEl) {
      stop(e);
      togglePlay();
      return;
    }
    if (menu) {
      handleMenuKey(menu, k, e);
      return;
    }

    if (active === seekEl) {
      if (k === KEY.LEFT || k === KEY.RIGHT) {
        stop(e);
        scrubBy(k === KEY.RIGHT ? SEEK_STEP : -SEEK_STEP);
      } else if (k === KEY.DOWN) {
        stop(e);
        commitScrub();
        focusButton(lastButton);
      } else if (k === KEY.ENTER) {
        stop(e);
        if (scrubTime !== null) commitScrub();
        else togglePlay();
      } else if (k === KEY.UP) {
        stop(e);
        nudge(seekEl, 0, -1);
      }
      return;
    }

    var buttons = rowButtons();
    var i = buttons.indexOf(active);
    if (i === -1) {
      if (k !== KEY.ENTER && k !== KEY.SPACE) {
        stop(e);
        focusButton(lastButton);
      }
      return;
    }
    if (k === KEY.LEFT || k === KEY.RIGHT) {
      stop(e);
      var j = i + (k === KEY.RIGHT ? 1 : -1);
      if (j >= 0 && j < buttons.length) focusButton(buttons[j]);
      else nudge(active, k === KEY.RIGHT ? 1 : -1, 0);
    } else if (k === KEY.UP) {
      stop(e);
      lastButton = active;
      seekEl.focus({ preventScroll: true });
    } else if (k === KEY.DOWN) {
      stop(e);
      nudge(active, 0, 1);
    }
    // OK on a button: its native click (which also plays the press animation).
  },
  true
);

playPauseBtn.innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE;
focusButton(playPauseBtn);
showControls();
