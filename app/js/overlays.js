// Telemetry overlays: timing tower and track map. On demand only - the
// service holds no live-timing connection until one of these is toggled
// on (liveTimingStart/Stop), and this file polls for state only while at
// least one overlay is visible.
//
// The track map draws the circuit from a known outline and puts the cars on
// it. F1 publishes no circuit shape, so the outlines are cut from one lap of
// F1's own Position feed (scripts/build-circuits.js -> service/data/
// circuits.json): in the cars' own coordinates, which is the point.
// Reuses callService() from watch.js (same page, loaded first).
//
// Two things were tried before, and the reason each failed is why this
// works. The map first drew only the trails the cars had left so far, which
// is right but empty until a whole lap has been driven: joining a session
// late, or watching one start, is exactly when it gets looked at. Then a
// pre-drawn outline went behind the trails (25 SVGs from a public
// circuit-outline collection, with a per-circuit rotation and
// measured-bounds table). The placement maths was eventually right, but the
// trails were fitted to whatever they covered SO FAR, so until a full lap
// their bounding box was not the circuit's and the two layers couldn't
// agree however well each was placed. Now there are no two layers to agree:
// the map is fitted to the outline, which is complete from the first frame,
// and the cars are positioned in the same coordinates. A circuit with no
// outline in the table (a new one) falls back to drawing the trails.

var towerBtn = document.getElementById("timing-tower-btn");
var mapBtn = document.getElementById("track-map-btn");
var towerOverlay = document.getElementById("timing-tower-overlay");
var mapOverlay = document.getElementById("track-map-overlay");
var towerRows = document.getElementById("timing-tower-rows");
var towerPlaceholder = document.getElementById("timing-tower-placeholder");
var mapPlaceholder = document.getElementById("track-map-placeholder");
var mapSvg = document.getElementById("track-map-svg");

var pollTimer = null;
// Set here, not with the rest of the map's state further down: the
// ?debugOverlays=1 path below opens both overlays while this file is still
// loading, before anything further down has run.
var MAP_FRAME_MS = 100;
// More map state that has to exist before the debug path below runs, for the same reason:
// which kind of session it is showing, an answer-in-flight guard (a late answer to a
// map that has since been reset must be dropped), and what to say while a replay
// has nothing to draw yet.
var mapMode = null; // "live" or "replay"
var mapEpoch = 0;
var mapRequestInFlight = false;
var mapReplayText = "Loading positions…";
var towerOrder = {}; // racingNumber -> position in the timing tower, for who keeps a tag on the map
var mapDotOrder = ""; // the stacking order of the dots last drawn
var consecutiveFailures = 0;
// Distinguishes "still connecting", "connected but nothing live", and a
// real failure - without this, all three looked identical (a placeholder
// that never changes), which read as broken rather than as "there's
// genuinely nothing to show right now".
var statusText = "Connecting…";

function anyOverlayVisible() {
  return towerOverlay.classList.contains("visible") || mapOverlay.classList.contains("visible");
}

function setPlaceholders(text) {
  towerPlaceholder.textContent = text;
  mapPlaceholder.textContent = text;
}

function ensurePolling() {
  if (pollTimer || !anyOverlayVisible()) return;
  statusText = isReplay() ? "Loading timing…" : "Connecting…";
  setPlaceholders(statusText);
  consecutiveFailures = 0;
  // A replay is served from F1's session archive, not the live feed, so
  // there's no connection to open (watch.js isReplay/playheadUtc).
  if (!isReplay()) callService("liveTimingStart").catch(function () { /* best effort */ });
  pollTimer = setInterval(poll, 1000);
  // The cars move between polls, so the map is redrawn more often than it is fed.
  mapFrameTimer = setInterval(drawMap, MAP_FRAME_MS);
  poll();
}

function stopPollingIfIdle() {
  if (anyOverlayVisible()) return;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (mapFrameTimer) { clearInterval(mapFrameTimer); mapFrameTimer = null; }
  // The service drops its connection too, so these would have a gap in them.
  towerHistory = [];
  resetMap();
  callService("liveTimingStop").catch(function () { /* best effort */ });
}

towerBtn.addEventListener("click", function () {
  towerOverlay.classList.toggle("visible");
  towerBtn.classList.toggle("toggled", towerOverlay.classList.contains("visible"));
  fitTowerAboveControls();
  ensurePolling();
  stopPollingIfIdle();
});

mapBtn.addEventListener("click", function () {
  mapOverlay.classList.toggle("visible");
  mapBtn.classList.toggle("toggled", mapOverlay.classList.contains("visible"));
  // Closed, the map stops being fed, so what it holds would have a gap in it.
  if (!mapOverlay.classList.contains("visible")) resetMap();
  ensurePolling();
  stopPollingIfIdle();
});

// Local testing only: ?debugOverlays=1 auto-opens both overlays on load,
// so a plain screenshot/browser preview shows them without needing to
// click through first. Never set in real usage, harmless if it were. With no
// picture there is no clock to line up with, so it also shows the feed as close
// to live as the delay setting allows (see timingInstant), which is what
// watching a live session on a PC wants. scripts/live-view.js opens it this way.
var DEBUG_OVERLAYS = !!new URLSearchParams(window.location.search).get("debugOverlays");
if (DEBUG_OVERLAYS) {
  towerBtn.click();
  mapBtn.click();
}

// Standard F1 broadcast tyre-compound colours - well-established
// convention, not a guess.
var TYRE_COLOURS = { SOFT: "e10600", MEDIUM: "ffd12e", HARD: "eeeeee", INTERMEDIATE: "43b02a", WET: "0067ad" };
var TYRE_LETTERS = { SOFT: "S", MEDIUM: "M", HARD: "H", INTERMEDIATE: "I", WET: "W" };

function tyreBadge(tyre) {
  if (!tyre || !tyre.compound) return '<span class="tt-tyre"></span>';
  var colour = TYRE_COLOURS[tyre.compound] || "888";
  var letter = TYRE_LETTERS[tyre.compound] || "?";
  var textColour = tyre.compound === "HARD" || tyre.compound === "MEDIUM" ? "#111" : "#fff";
  return (
    '<span class="tt-tyre" style="background:#' + colour + ";color:" + textColour + '" title="' +
    tyre.compound + (tyre.isNew ? " (new)" : "") + '">' + letter +
    '<sub>' + (tyre.age != null ? tyre.age : "") + "</sub></span>"
  );
}

// LastLapTime carries explicit PersonalFastest/OverallFastest booleans
// (confirmed real fields) - purple beats green when both are somehow set,
// matching the real broadcast convention that a purple time is by
// definition also a personal best.
function lapTimeClass(lastLap) {
  if (!lastLap) return "";
  if (lastLap.OverallFastest) return "tt-purple";
  if (lastLap.PersonalFastest) return "tt-green";
  return "";
}

// Mini-sector colour bar. The Status codes below (2048/2049/2051/2064) are
// the only values seen in a real recorded session (scripts/replay-test.js)
// - this decode is a best-effort bitmask reading (2048 = has data/base,
// +1 = personal best that sector, +2 additional = also overall best i.e.
// purple, +16 = pit lane), consistent with what actually occurred (a real
// pit-lane sector showed exactly this "+16" pattern on its trailing
// segments) but NOT verified colour-for-colour against a broadcast - if a
// real session shows the wrong colour, this mapping is the place to fix.
function segmentClass(status) {
  if (status == null) return "tt-seg-none";
  if (status & 16) return "tt-seg-pit";
  if ((status & 3) === 3) return "tt-seg-purple";
  if (status & 1) return "tt-seg-green";
  if (status & 2048) return "tt-seg-yellow";
  return "tt-seg-none";
}

// One mini-column per sector: the mini-sector tick bar above that
// sector's actual time value, coloured to match (green/purple for
// personal/overall fastest - real fields, not guessed), so both the
// segment detail and the readable time are visible together instead of
// just a bare tick bar with no numbers.
function sectorBar(sectors) {
  if (!sectors || !sectors.length) return "";
  var cols = sectors
    .map(function (s) {
      if (!s) return "";
      var ticks = (s.segments || [])
        .map(function (status) { return '<i class="' + segmentClass(status) + '"></i>'; })
        .join("");
      var valClass = s.overallFastest ? "tt-purple" : s.personalFastest ? "tt-green" : "";
      return (
        '<span class="tt-sector">' +
        '<span class="tt-sector-ticks">' + ticks + "</span>" +
        '<span class="tt-sector-val ' + valClass + '">' + (s.value || "–") + "</span>" +
        "</span>"
      );
    })
    .join("");
  return '<span class="tt-sectors">' + cols + "</span>";
}

function telemetryReadout(telemetry) {
  if (!telemetry) return "";
  return (
    '<span class="tt-telem">' +
    (telemetry.gear != null ? "G" + telemetry.gear + " " : "") +
    (telemetry.speed != null ? telemetry.speed + "km/h" : "") +
    "</span>"
  );
}

// --- lining timing up with the picture ---------------------------------------
// Timing runs ahead of the video: live by the whole broadcast and streaming
// delay (other timing tools hold theirs back a fixed ~35s for this), and on a
// replay by the few seconds the broadcast trails F1's timing system. Rather
// than guess the bigger number, both cases read the picture's own clock -
// F1 TV's manifests carry EXT-X-PROGRAM-DATE-TIME, live as well as replay
// (watch.js playheadUtc) - and show timing as it stood at that instant. The
// viewer's delay setting covers what's left: the gap between the stamped
// time and F1's timing clock. 3 to 5 seconds, measured on replays.

var DELAY_KEY = "lightsout.timing.delayMs";
var DEFAULT_DELAY_MS = 4000;
var DELAY_CHOICES_MS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 10000];
// A live stream without timestamps has no clock to read, so assume F1 TV's
// usual live latency instead; with the default delay on top, this comes to
// about 35 seconds.
var NO_CLOCK_LATENCY_MS = 30000;
// Live snapshots kept for lining up: back to where watch.js stops treating
// the picture as live and asks the archive instead (LIVE_EDGE_MS).
var LIVE_HISTORY_MS = 5 * 60 * 1000;

var delayMs = (function () {
  try {
    var saved = parseInt(window.localStorage.getItem(DELAY_KEY), 10);
    if (saved >= 0 && saved <= 60000) return saved;
  } catch (e) { /* default */ }
  return DEFAULT_DELAY_MS;
})();

function setTimingDelayMs(ms) {
  delayMs = ms;
  try {
    window.localStorage.setItem(DELAY_KEY, String(ms));
  } catch (e) { /* applies until the page closes */ }
}

function currentDelayMs() {
  return delayMs;
}

function delayLabel(ms) {
  return ms === 0 ? "None" : ms / 1000 + " s";
}

// How far behind live the picture is, from its own clock, in seconds; or null
// (a replay, or a stream with no clock): now, less the program date-time the
// manifest stamps on the frame at the playhead. Another timing tool's live-delay
// figure on the same stream is this plus its own offset, so the two can be
// compared. If this reads lower than that figure less its offset, the picture
// clock here runs ahead of what is on screen, which would show up as timing
// arriving early.
function liveLatencySeconds() {
  if (isReplay()) return null;
  var at = playheadUtc();
  if (at === null) return null;
  var s = (Date.now() - at) / 1000;
  return s > 0 && s < 600 ? s : null;
}

// How far the picture is behind live, plus the viewer's delay: how long the
// timing is held back right now.
function liveLatencyLabel() {
  var s = liveLatencySeconds();
  if (s === null) return "";
  var held = s + currentDelayMs() / 1000;
  return "picture " + s.toFixed(1) + " s behind live, timing held " + held.toFixed(1) + " s";
}

// For watch.js's Settings menu (CHOICES.timing).
function timingDelayChoices() {
  var now = currentDelayMs();
  var latency = liveLatencyLabel();
  return DELAY_CHOICES_MS.map(function (ms) {
    var hint = [];
    if (ms === DEFAULT_DELAY_MS) hint.push("Default");
    if (ms === now && latency) hint.push(latency);
    return {
      label: delayLabel(ms),
      hint: hint.join(" · "),
      selected: ms === now,
      pick: function () { setTimingDelayMs(ms); },
    };
  });
}

function timingDelayLabel() {
  return delayLabel(currentDelayMs());
}

// The timing instant that matches the picture.
function timingInstant() {
  var at = playheadUtc();
  if (at === null) at = Date.now() - (DEBUG_OVERLAYS ? 0 : NO_CLOCK_LATENCY_MS);
  return at - currentDelayMs();
}

// Live snapshots, oldest first: {t: when received, data}.
var towerHistory = [];

function remember(history, data) {
  var now = Date.now();
  history.push({ t: now, data: data });
  while (history.length && history[0].t < now - LIVE_HISTORY_MS) history.shift();
}

// The newest snapshot from no later than t, or null if none goes back that far.
function asOf(history, t) {
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= t) return history[i].data;
  }
  return null;
}

// Placeholder while the snapshots don't yet reach back to the picture.
function liningUpText(history, t) {
  if (!history.length) return statusText;
  var wait = Math.ceil((history[0].t - t) / 1000);
  return "Lining up with the picture… " + Math.max(1, wait) + " s";
}

function renderTower(drivers, text) {
  towerOrder = {};
  (drivers || []).forEach(function (d) {
    var p = Number(d.position);
    if (p) towerOrder[d.racingNumber] = p;
  });
  if (!drivers || !drivers.length) {
    towerPlaceholder.style.display = "block";
    towerPlaceholder.textContent = text || statusText;
    towerRows.innerHTML = "";
    fitTowerAboveControls();
    return;
  }
  towerPlaceholder.style.display = "none";
  towerRows.innerHTML = "";
  drivers.forEach(function (d) {
    var row = document.createElement("div");
    row.className = "tt-row";
    row.innerHTML =
      '<div class="tt-line1">' +
      '<span class="tt-pos">' + (d.position || "-") + "</span>" +
      '<span class="tt-swatch" style="background:#' + (d.teamColour || "555") + '"></span>' +
      '<span class="tt-tla">' + (d.tla || d.racingNumber) + "</span>" +
      tyreBadge(d.tyre) +
      '<span class="tt-lastlap ' + lapTimeClass(d.lastLap) + '">' + (d.lastLap ? d.lastLap.Value : "") + "</span>" +
      '<span class="tt-gap">' + (d.inPit ? "PIT" : d.gapToLeader || d.interval || "") + "</span>" +
      "</div>" +
      '<div class="tt-line2">' +
      sectorBar(d.sectors) +
      telemetryReadout(d.telemetry) +
      "</div>";
    towerRows.appendChild(row);
  });
  fitTowerAboveControls(); // watch.js: keeps the tower clear of the control bar
}

// --- the track map -----------------------------------------------------------
// The circuit comes from the service as an outline (see the header), and each
// car as timestamped samples. Nothing is drawn "as of now": the picture is
// roughly half a minute behind live, so each car is placed where it was at the
// instant the picture shows (timingInstant) - between the two samples either
// side of it, so it glides instead of hopping once a poll. The stamps are
// F1's own, like the replay archive's, which is what the viewer's delay
// setting was tuned against. Arrival time would not do: positions reach the
// app about three seconds after the moment they describe.

var MAP_PAD = 4; // of the 100-unit square the map is drawn in
var MAP_KEEP_MS = 6 * 60 * 1000; // samples held: the picture is never further behind than this
var MAP_GAP_MS = 2000; // further apart than this, a car is held, not slid across the gap
var SVG_NS = "http://www.w3.org/2000/svg";

var mapFrameTimer = null;
var mapSamples = {}; // racingNumber -> [[stamp ms, x, y], ...], oldest first
var mapCars = {}; // racingNumber -> {tla, teamColour}
var mapSince = 0; // newest stamp held; asked back to the service so it only sends what's new
var mapCircuit = null; // key of the outline held
var mapOutline = null; // {x: [], y: [], bounds} or null
var mapSeen = null; // bounds of every position seen: the fit when there is no outline
var mapTrails = {}; // racingNumber -> [[x, y], ...] thinned: what's drawn when there is no outline
var mapStatic = null; // <g> for the outline or trails
var mapDotLayer = null; // <g> for the cars
var mapDots = {}; // racingNumber -> <g>
var mapStaticDirty = true;

function resetMap() {
  mapEpoch++;
  mapRequestInFlight = false;
  mapReplayText = "Loading positions…";
  mapSamples = {};
  mapCars = {};
  mapSince = 0;
  mapCircuit = null;
  mapOutline = null;
  mapSeen = null;
  mapTrails = {};
  mapStatic = null;
  mapDotLayer = null;
  mapDots = {};
  mapDotOrder = "";
  mapStaticDirty = true;
  mapSvg.innerHTML = "";
}

function ensureMapLayers() {
  // The replay branch of poll() clears the svg, which orphans these.
  if (mapStatic && mapStatic.parentNode === mapSvg) return;
  mapSvg.innerHTML = "";
  mapStatic = document.createElementNS(SVG_NS, "g");
  mapDotLayer = document.createElementNS(SVG_NS, "g");
  mapSvg.appendChild(mapStatic);
  mapSvg.appendChild(mapDotLayer);
  mapDots = {};
  mapDotOrder = "";
  mapStaticDirty = true;
}

function boundsOf(xs, ys) {
  var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (var i = 0; i < xs.length; i++) {
    if (xs[i] < b.minX) b.minX = xs[i];
    if (xs[i] > b.maxX) b.maxX = xs[i];
    if (ys[i] < b.minY) b.minY = ys[i];
    if (ys[i] > b.maxY) b.maxY = ys[i];
  }
  return b;
}

// Takes the service's reply: remembers the outline if it came with one, and
// appends the new samples.
function ingestTrackMap(res) {
  if (res.circuitKey && mapCircuit && res.circuitKey !== mapCircuit) resetMap(); // a different circuit
  if (res.outline) {
    mapOutline = { x: res.outline.x, y: res.outline.y, markers: res.outline.markers, bounds: boundsOf(res.outline.x, res.outline.y) };
    mapCircuit = res.circuitKey;
    mapStaticDirty = true;
  }
  (res.drivers || []).forEach(function (d) {
    var list = mapSamples[d.racingNumber];
    if (!list) list = mapSamples[d.racingNumber] = [];
    mapCars[d.racingNumber] = { tla: d.tla, teamColour: d.teamColour };
    (d.samples || []).forEach(function (s) {
      if (list.length && s[0] <= list[list.length - 1][0]) return; // already held
      list.push(s);
      if (s[0] > mapSince) mapSince = s[0];
      if (!mapSeen) mapSeen = { minX: s[1], maxX: s[1], minY: s[2], maxY: s[2] };
      if (s[1] < mapSeen.minX) mapSeen.minX = s[1];
      if (s[1] > mapSeen.maxX) mapSeen.maxX = s[1];
      if (s[2] < mapSeen.minY) mapSeen.minY = s[2];
      if (s[2] > mapSeen.maxY) mapSeen.maxY = s[2];
      if (!mapOutline && list.length % 4 === 0) {
        var trail = mapTrails[d.racingNumber] || (mapTrails[d.racingNumber] = []);
        trail.push([s[1], s[2]]);
        if (trail.length > 600) trail.shift();
        mapStaticDirty = true;
      }
    });
  });
  var cutoff = mapSince - MAP_KEEP_MS;
  Object.keys(mapSamples).forEach(function (num) {
    var list = mapSamples[num];
    var drop = 0;
    while (drop < list.length && list[drop][0] < cutoff) drop++;
    if (drop) list.splice(0, drop);
  });
}

// One scale for both axes, so the circuit keeps its real proportions. Y is
// flipped: the position feed counts it upward, SVG downward.
function mapFit() {
  var b = mapOutline ? mapOutline.bounds : mapSeen;
  if (!b) return null;
  var w = Math.max(b.maxX - b.minX, 1);
  var h = Math.max(b.maxY - b.minY, 1);
  var avail = 100 - 2 * MAP_PAD;
  var scale = Math.min(avail / w, avail / h);
  var ox = MAP_PAD + (avail - w * scale) / 2;
  var oy = MAP_PAD + (avail - h * scale) / 2;
  return function (x, y) {
    return [ox + (x - b.minX) * scale, oy + (b.maxY - y) * scale];
  };
}

function svgEl(name, attrs) {
  var el = document.createElementNS(SVG_NS, name);
  Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  return el;
}

function pointsAttr(pairs, fit) {
  return pairs
    .map(function (p) { var n = fit(p[0], p[1]); return n[0].toFixed(2) + "," + n[1].toFixed(2); })
    .join(" ");
}

// A line straight across the track at outline point i, `half` map units
// either side. Sized in map units like the car dots, not in metres: a real track
// is a pixel or two wide at this scale, and a marker that size can't be seen.
// The way across is worked out on the map itself (after the fit), perpendicular
// to the outline's direction a couple of points either side, so one jittery
// point doesn't tilt it.
function crossLine(fit, i, half, attrs) {
  var o = mapOutline;
  var n = o.x.length;
  var a = fit(o.x[(i - 2 + n) % n], o.y[(i - 2 + n) % n]);
  var b = fit(o.x[(i + 2) % n], o.y[(i + 2) % n]);
  var p = fit(o.x[i], o.y[i]);
  var tx = b[0] - a[0], ty = b[1] - a[1];
  var len = Math.sqrt(tx * tx + ty * ty) || 1;
  var nx = -ty / len, ny = tx / len;
  attrs.x1 = (p[0] + nx * half).toFixed(2);
  attrs.y1 = (p[1] + ny * half).toFixed(2);
  attrs.x2 = (p[0] - nx * half).toFixed(2);
  attrs.y2 = (p[1] - ny * half).toFixed(2);
  return svgEl("line", attrs);
}

// The finish line, chequered, and a tick where each of the first two sectors
// ends. Where they are comes from the service (scripts/build-markers.js).
function drawMapMarkers(fit) {
  var m = mapOutline && mapOutline.markers;
  if (!m) return;
  (m.sectors || []).forEach(function (s) {
    if (!s) return;
    mapStatic.appendChild(crossLine(fit, s.i, 2.2, { stroke: "#ffd12e", "stroke-width": "1", "stroke-opacity": "0.95" }));
  });
  if (m.finish) {
    // White, with black dashes laid over it: reads as a chequered line at this size.
    mapStatic.appendChild(crossLine(fit, m.finish.i, 3, { stroke: "#fff", "stroke-width": "1.7" }));
    mapStatic.appendChild(crossLine(fit, m.finish.i, 3, { stroke: "#000", "stroke-width": "1.7", "stroke-dasharray": "0.85 0.85" }));
  }
}

function rebuildMapStatic(fit) {
  while (mapStatic.firstChild) mapStatic.removeChild(mapStatic.firstChild);
  if (mapOutline) {
    var pairs = mapOutline.x.map(function (x, i) { return [x, mapOutline.y[i]]; });
    var pts = pointsAttr(pairs, fit);
    // A dark edge under a light line, so the circuit reads on any picture.
    mapStatic.appendChild(svgEl("polygon", { points: pts, fill: "none", stroke: "#000", "stroke-opacity": "0.55", "stroke-width": "2.6", "stroke-linejoin": "round" }));
    mapStatic.appendChild(svgEl("polygon", { points: pts, fill: "none", stroke: "#fff", "stroke-opacity": "0.85", "stroke-width": "1.1", "stroke-linejoin": "round" }));
    drawMapMarkers(fit);
  } else {
    // No outline for this circuit (a new one): what the cars have driven so
    // far, one line per car. One line per car, because a single line through
    // every car's points runs spurious diagonals from one car's last point to
    // the next car's first.
    Object.keys(mapTrails).forEach(function (num) {
      var trail = mapTrails[num];
      if (trail.length < 2) return;
      var car = mapCars[num] || {};
      mapStatic.appendChild(svgEl("polyline", { points: pointsAttr(trail, fit), fill: "none", stroke: "#" + (car.teamColour || "888"), "stroke-width": "0.5", opacity: "0.6" }));
    });
  }
  mapStaticDirty = false;
}

// [x, y] of a car at stamp t, or null if t is before everything held for it.
function positionAt(samples, t) {
  var n = samples.length;
  if (!n || t < samples[0][0]) return null;
  var lo = 0, hi = n - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (samples[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  var a = samples[lo], b = samples[lo + 1];
  if (!b || b[0] - a[0] > MAP_GAP_MS) return [a[1], a[2]];
  var f = (t - a[0]) / (b[0] - a[0]);
  return [a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

// Each car is a dot with its three-letter tag inside it (HAM, VER: F1 gives
// official codes, not initials). The dot is big enough to hold three letters,
// so the tag is part of the dot and not a label floating beside it. Where dots
// overlap, only one keeps its tag (see tagMapDots).
var MAP_DOT_R = 3.6;
var MAP_TAG_CLEAR = 7.6; // two dots closer than this (map units) share one tag

// Black on a light team colour, white on a dark one.
function tagColour(hex) {
  var h = String(hex || "fff");
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "#fff";
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#000" : "#fff";
}

function mapDot(num) {
  var dot = mapDots[num];
  var car = mapCars[num] || {};
  if (dot) {
    // The driver list can arrive after the first positions.
    var tag = car.tla || "";
    if (dot.tagText !== tag) {
      dot.tagText = tag;
      dot.tagEl.textContent = tag;
    }
    return dot;
  }
  dot = svgEl("g", {});
  dot.appendChild(svgEl("circle", { r: String(MAP_DOT_R), fill: "#" + (car.teamColour || "fff"), stroke: "#000", "stroke-width": "0.35" }));
  var label = svgEl("text", {
    "font-size": "2.7",
    "font-weight": "700",
    fill: tagColour(car.teamColour),
    "text-anchor": "middle",
    dy: ".35em",
    "pointer-events": "none",
  });
  label.textContent = car.tla || "";
  dot.appendChild(label);
  dot.tagEl = label;
  dot.tagText = car.tla || "";
  dot.tagShown = true;
  mapDotLayer.appendChild(dot);
  mapDots[num] = dot;
  return dot;
}

// Who gets the tag when dots overlap: the car running higher in the order,
// by the timing tower, else by racing number. The rest are plain dots. The
// ones with tags are also drawn in front, so a tagged dot is never half
// buried under a plain one.
function tagMapDots(cars) {
  cars.sort(function (a, b) { return mapPriority(a.num) - mapPriority(b.num); });
  var tagged = [];
  cars.forEach(function (c) {
    var clash = false;
    for (var i = 0; i < tagged.length; i++) {
      var dx = tagged[i].x - c.x, dy = tagged[i].y - c.y;
      if (dx * dx + dy * dy < MAP_TAG_CLEAR * MAP_TAG_CLEAR) { clash = true; break; }
    }
    var dot = mapDots[c.num];
    if (dot.tagShown === clash) {
      dot.tagShown = !clash;
      if (clash) dot.tagEl.setAttribute("display", "none");
      else dot.tagEl.removeAttribute("display");
    }
    if (!clash) tagged.push(c);
  });
  // Lowest priority first, so the best end up on top. Only re-stacked when the order changes.
  var order = cars.map(function (c) { return c.num; }).join(",");
  if (order !== mapDotOrder) {
    mapDotOrder = order;
    for (var k = cars.length - 1; k >= 0; k--) mapDotLayer.appendChild(mapDots[cars[k].num]);
  }
}

// Lower is better. Position in the timing tower when it has one, else after
// everyone who does, by racing number.
function mapPriority(num) {
  var p = towerOrder[num];
  return p ? p : 100 + (Number(num) || 0);
}

function showMapText(text, belowOutline) {
  mapPlaceholder.style.display = "flex";
  mapPlaceholder.style.alignItems = belowOutline ? "flex-end" : "center";
  mapPlaceholder.textContent = text;
}

// Runs about ten times a second while the map is open, and after every poll.
function drawMap() {
  if (!mapOverlay.classList.contains("visible")) return;
  var fit = mapFit();
  if (!fit) {
    showMapText(mapStatus(), false);
    return;
  }
  ensureMapLayers();
  if (mapStaticDirty) rebuildMapStatic(fit);

  var t = timingInstant();
  var placed = 0;
  var oldest = Infinity;
  var onMap = [];
  Object.keys(mapSamples).forEach(function (num) {
    var list = mapSamples[num];
    if (list.length && list[0][0] < oldest) oldest = list[0][0];
    var at = positionAt(list, t);
    var dot = mapDot(num);
    if (!at) {
      dot.setAttribute("display", "none");
      return;
    }
    var n = fit(at[0], at[1]);
    dot.setAttribute("transform", "translate(" + n[0].toFixed(2) + "," + n[1].toFixed(2) + ")");
    dot.removeAttribute("display");
    onMap.push({ num: num, x: n[0], y: n[1] });
    placed++;
  });
  if (placed) tagMapDots(onMap);
  if (placed) {
    mapPlaceholder.style.display = "none";
  } else if (oldest === Infinity) {
    showMapText(mapStatus(), !!mapOutline); // the circuit is known; no car has reported yet
  } else {
    // The samples don't reach back to the picture yet: it is behind the
    // service's first call. The outline is already worth showing.
    var wait = Math.max(1, Math.ceil((oldest - t) / 1000));
    showMapText("Lining up with the picture… " + wait + " s", !!mapOutline);
  }
}

// What the map says when it has nothing to draw: for a replay, what its own
// request last learned; for a live session, the connection status.
function mapStatus() {
  return isReplay() ? mapReplayText : statusText;
}

// The span of picture-clock time the samples held cover, or null if none are held.
function mapRange() {
  var oldest = Infinity, newest = -Infinity;
  Object.keys(mapSamples).forEach(function (num) {
    var list = mapSamples[num];
    if (!list.length) return;
    if (list[0][0] < oldest) oldest = list[0][0];
    if (list[list.length - 1][0] > newest) newest = list[list.length - 1][0];
  });
  return oldest === Infinity ? null : { oldest: oldest, newest: newest };
}

// A replay's map, asked for in windows around the picture's instant. The service
// answers for a stretch of the picture's clock (the same one the live samples are
// on), so what is held is simply a run of samples: more is asked for before it
// runs out, and after a seek outside it, what is held is thrown away and asked
// for afresh around the new instant. The first answer for a session comes at
// once with the circuit, so there is an outline to look at while the position
// stream downloads (about 8MB, once; the service keeps it for next time).
var MAP_AHEAD_MS = 40000; // how far past the picture one request reaches
var MAP_REFILL_MS = 15000; // ask for more when this little is left ahead of it

function pollHistoricMap() {
  if (playheadUtc() === null) {
    mapReplayText = "This replay doesn't carry timestamps, so the map can't be lined up with it.";
    return drawMap();
  }
  if (mapRequestInFlight) return;
  var t = timingInstant();
  var have = mapRange();
  var replace = !have || t < have.oldest - 1000 || t > have.newest + 1000;
  if (!replace && have.newest - t >= MAP_REFILL_MS) return; // plenty ahead already
  var epoch = mapEpoch;
  mapRequestInFlight = true;
  callService("historicTrackMap", {
    atUtc: new Date(t).toISOString(),
    from: replace ? t - 5000 : have.newest,
    to: t + MAP_AHEAD_MS,
    circuit: mapCircuit,
  })
    .then(function (res) {
      if (epoch !== mapEpoch) return; // the map was reset while this was on its way
      mapRequestInFlight = false;
      if (!res.returnValue) return;
      if (!res.available) {
        mapReplayText = "F1 published no position data for this session.";
      } else if (res.phase === "loading") {
        mapReplayText = "Loading positions…";
      } else if (res.phase === "missing") {
        mapReplayText = "F1 recorded no positions for this session.";
      } else if (res.phase === "failed") {
        mapReplayText = "Couldn't load positions. Trying again…";
      } else {
        mapReplayText = "No positions at this point of the video.";
      }
      if (replace) {
        mapSamples = {};
        mapSince = 0;
      }
      if (res.available) ingestTrackMap(res);
      drawMap();
    })
    .catch(function () {
      if (epoch !== mapEpoch) return;
      mapRequestInFlight = false;
      mapReplayText = "Couldn't reach F1's timing archive.";
      drawMap();
    });
}

// A replay asks a different question than a live session: not "what is
// happening" but "what was happening at this moment of the video". The
// answer comes from F1's archive of the session, lined up with the picture
// by the timestamp in the manifest - so scrubbing the video scrubs the
// timing with it.
var historicInFlight = false;

function pollHistoric() {
  if (playheadUtc() === null) {
    statusText = "This replay doesn't carry timestamps, so timing can't be lined up with it.";
    setPlaceholders(statusText);
    return;
  }
  var at = timingInstant();
  // The first call downloads the session; at one poll a second the rest
  // would pile up behind it.
  if (historicInFlight) return;
  historicInFlight = true;
  callService("historicTiming", { atUtc: new Date(at).toISOString() })
    .then(function (res) {
      historicInFlight = false;
      consecutiveFailures = 0;
      if (!res.returnValue) return;
      if (!res.available) {
        // F1 only lists a session's archive once the session has finished -
        // an in-progress one has no path in the index at all - so a session
        // from the last few hours isn't missing, just not published yet.
        // This is what someone rewinding well behind a live session sees.
        statusText =
          Date.now() - at < 6 * 3600 * 1000
            ? "Timing for this session is published once it finishes."
            : "F1 published no timing for this session.";
        setPlaceholders(statusText);
        return renderTower([]);
      }
      if (!res.started || !res.drivers.length) {
        // The video opens before the session does; there is genuinely
        // nothing yet rather than something missing.
        statusText = "Timing starts when the session does.";
        setPlaceholders(statusText);
        return renderTower([]);
      }
      renderTower(res.drivers);
    })
    .catch(function () {
      historicInFlight = false;
      consecutiveFailures++;
      if (consecutiveFailures >= 3) statusText = "Couldn't reach F1's timing archive.";
      setPlaceholders(statusText);
    });
}

function poll() {
  // A replay and a live session feed the map differently, so a switch between
  // them (rewinding a live session far enough, or catching up to it) starts it afresh.
  var mode = isReplay() ? "replay" : "live";
  if (mode !== mapMode) {
    resetMap();
    mapMode = mode;
  }
  if (isReplay()) {
    pollHistoric();
    if (mapOverlay.classList.contains("visible")) pollHistoricMap();
    return;
  }
  callService("liveTimingSummary")
    .then(function (res) {
      consecutiveFailures = 0;
      if (!res.returnValue) return;
      if (!res.connected) {
        statusText = "Connecting…";
      } else if (!res.rawMessageCount) {
        // Nothing at all arriving - genuinely no session live (F2/F3
        // sessions don't publish through this feed at all, confirmed
        // against another timing app also showing nothing for F2 - only F1
        // sessions do), not a parsing problem on our end.
        statusText = "Connected — no data arriving (no F1 session live?)";
      } else if (!res.driverCount) {
        // Messages ARE arriving but our topic parsing isn't producing
        // driver data - a real parsing bug, not "nothing to show". Surface
        // exactly what's coming in instead of an ambiguous placeholder.
        statusText =
          "Connected, " + res.rawMessageCount + " msgs received but no driver data - " +
          "topics seen: " + JSON.stringify(res.topicCounts);
      } else {
        statusText = "Connected — waiting for data";
      }
    })
    .catch(function () {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) statusText = "Connection error — the on-TV service is not answering";
    });
  // Each poll is remembered, and what's drawn is the one matching the
  // picture (see timingInstant).
  callService("liveTimingTower")
    .then(function (res) {
      if (!res.returnValue) return;
      remember(towerHistory, res.drivers);
      var t = timingInstant();
      var drivers = asOf(towerHistory, t);
      if (drivers === null) renderTower([], liningUpText(towerHistory, t));
      else renderTower(drivers);
    })
    .catch(function () { /* summary poll above already tracks failures */ });
  // Only while the map is open: it is the heavier of the two answers.
  if (mapOverlay.classList.contains("visible")) {
    var epoch = mapEpoch;
    callService("liveTimingTrackMap", { since: mapSince, circuit: mapCircuit })
      .then(function (res) {
        if (!res.returnValue || epoch !== mapEpoch) return; // or the map was reset on its way
        ingestTrackMap(res);
        drawMap();
      })
      .catch(function () { /* summary poll above already tracks failures */ });
  }
}

// Navigating away (e.g. Back to Browse) without explicitly toggling
// overlays off first shouldn't leave the live-timing connection running
// needlessly - that defeats the point of "on demand".
window.addEventListener("unload", function () {
  if (anyOverlayVisible()) callService("liveTimingStop").catch(function () {});
});
