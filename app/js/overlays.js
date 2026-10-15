// Telemetry overlays: timing tower and track map. On demand only - the
// service holds no live-timing connection until one of these is toggled
// on (liveTimingStart/Stop), and this file polls for state only while at
// least one overlay is visible.
//
// Honest limitation on the track map: F1 doesn't publish circuit shape
// data anywhere. Real tools (MultiViewer included) build the outline
// empirically, by accumulating car position points during a live session
// until the shape emerges from the trail - there's no way to draw a
// correct track shape before that data exists. This renders exactly that
// accumulation, live, rather than faking a shape - so it shows a "waiting
// for position data" placeholder until a session actually produces some.
// Reuses callService() from watch.js (same page, loaded first).
//
// A pre-drawn circuit outline WAS tried as a backdrop (25 SVGs bundled in
// the IPK, from github.com/julesr0y/f1-circuits-svg, plus a per-circuit
// rotation and measured-bounds table). Dropped deliberately. The placement math was eventually
// correct - measured offline against the real Madring archive, the drawn
// outline sat within ~2% of the real telemetry across its whole length -
// but correct placement can't rescue the underlying mismatch: the live
// layer is auto-fitted to whatever has been accumulated SO FAR, so until
// the cars have covered the full lap, that bounding box is not the
// circuit's bounding box and the two layers cannot agree no matter how
// well each is placed. Watching a session start, or joining one after the
// cars have parked in the pits, lands squarely in that window - which is
// exactly when the map got looked at. Accumulation alone is always
// internally consistent: whatever it draws is genuinely where the cars
// have been, at the right proportions, with nothing to disagree with.

var towerBtn = document.getElementById("timing-tower-btn");
var mapBtn = document.getElementById("track-map-btn");
var towerOverlay = document.getElementById("timing-tower-overlay");
var mapOverlay = document.getElementById("track-map-overlay");
var towerRows = document.getElementById("timing-tower-rows");
var towerPlaceholder = document.getElementById("timing-tower-placeholder");
var mapPlaceholder = document.getElementById("track-map-placeholder");
var mapSvg = document.getElementById("track-map-svg");

var pollTimer = null;
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
  poll();
}

function stopPollingIfIdle() {
  if (anyOverlayVisible()) return;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
  ensurePolling();
  stopPollingIfIdle();
});

// Local testing only: ?debugOverlays=1 auto-opens both overlays on load,
// so a plain screenshot/browser preview shows them without needing to
// click through first. Never set in real usage, harmless if it were.
if (new URLSearchParams(window.location.search).get("debugOverlays")) {
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

function renderTower(drivers) {
  if (!drivers || !drivers.length) {
    towerPlaceholder.style.display = "block";
    towerPlaceholder.textContent = statusText;
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

function renderMap(data) {
  var trail = (data && data.trail) || [];
  var drivers = (data && data.drivers) || [];

  if (!trail.length) {
    mapPlaceholder.style.display = "flex";
    mapPlaceholder.textContent = statusText;
    mapSvg.innerHTML = "";
    return;
  }
  mapPlaceholder.style.display = "none";

  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  trail.forEach(function (p) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  var w = Math.max(maxX - minX, 1);
  var h = Math.max(maxY - minY, 1);

  // ONE scale for both axes, so the circuit keeps its real proportions.
  // This used to divide x by w and y by h separately, which stretched the
  // accumulated shape to fill the square regardless of how wide or tall the
  // track actually is - a real distortion of the shape, independent of the
  // now-removed backdrop it was also failing to line up with.
  var pad = 4;
  var avail = 100 - 2 * pad;
  var scale = Math.min(avail / w, avail / h);
  var ox = pad + (avail - w * scale) / 2;
  var oy = pad + (avail - h * scale) / 2;

  function norm(p) {
    // Y is flipped: F1's position feed counts Y upward, SVG counts it
    // downward, so without this the accumulated trail renders mirrored
    // top-to-bottom.
    return [ox + (p.x - minX) * scale, oy + (maxY - p.y) * scale];
  }

  // One polyline PER DRIVER (each driver's own ordered trail), not one
  // polyline over every car's points concatenated together - a real live
  // session showed exactly why: a single connected line across
  // concatenated per-driver arrays draws a spurious diagonal from the last
  // point of one car's trail to the first point of the next car's, all
  // over the map - a "wireframe" of nonsense lines. Bounds above still use
  // the flat merged trail (order doesn't matter for min/max).
  var trailLines = drivers
    .map(function (d) {
      if (!d.trail || d.trail.length < 2) return "";
      var pts = d.trail
        .map(function (p) { var n = norm(p); return n[0].toFixed(2) + "," + n[1].toFixed(2); })
        .join(" ");
      return '<polyline points="' + pts + '" fill="none" stroke="#' + (d.teamColour || "444") + '" stroke-width="0.5" opacity="0.6" />';
    })
    .join("");

  var dots = drivers
    .filter(function (d) { return d.x !== null && d.y !== null; })
    .map(function (d) {
      var n = norm({ x: d.x, y: d.y });
      return (
        '<circle cx="' + n[0].toFixed(2) + '" cy="' + n[1].toFixed(2) + '" r="2.2" ' +
        'fill="#' + (d.teamColour || "fff") + '" stroke="#000" stroke-width="0.3" />' +
        '<text x="' + n[0].toFixed(2) + '" y="' + (n[1] - 3).toFixed(2) + '" ' +
        'font-size="3" fill="#fff" text-anchor="middle">' + (d.tla || "") + "</text>"
      );
    })
    .join("");

  mapSvg.innerHTML = trailLines + dots;
}

// A replay asks a different question than a live session: not "what is
// happening" but "what was happening at this moment of the video". The
// answer comes from F1's archive of the session, lined up with the picture
// by the timestamp in the manifest - so scrubbing the video scrubs the
// timing with it.
var historicInFlight = false;

function pollHistoric() {
  var at = playheadUtc();
  if (at === null) {
    statusText = "This replay doesn't carry timestamps, so timing can't be lined up with it.";
    setPlaceholders(statusText);
    return;
  }
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
  if (isReplay()) {
    pollHistoric();
    // The map needs position telemetry, which is ~9MB per session and only
    // worth fetching if the map is ever going to earn it. Saying so beats
    // leaving last week's cars sitting on the track.
    mapPlaceholder.textContent = "The track map follows live sessions only.";
    mapPlaceholder.style.display = "block";
    mapSvg.innerHTML = "";
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
        // against MultiViewer also showing nothing for F2 - only F1
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
  callService("liveTimingTower")
    .then(function (res) { if (res.returnValue) renderTower(res.drivers); })
    .catch(function () { /* summary poll above already tracks failures */ });
  callService("liveTimingTrackMap")
    .then(function (res) { if (res.returnValue) renderMap(res); })
    .catch(function () { /* summary poll above already tracks failures */ });
}

// Navigating away (e.g. Back to Browse) without explicitly toggling
// overlays off first shouldn't leave the live-timing connection running
// needlessly - that defeats the point of "on demand".
window.addEventListener("unload", function () {
  if (anyOverlayVisible()) callService("liveTimingStop").catch(function () {});
});
