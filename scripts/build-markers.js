#!/usr/bin/env node
// Adds the timing lines to service/data/circuits.json: where the finish line
// is, and where sectors 1 and 2 end, as indices into each circuit's outline.
//
// F1 publishes no map of these, but the timing feed says when each car
// finished a sector (TimingData, Sectors.{0,1,2}.Value appearing), and the
// Position feed says where that car was a moment before. Do that for every
// car on every lap of a race and the points pile up on the lines. The
// finish line is sector 3's end, which is also when NumberOfLaps ticks.
//
// The two feeds are lined up in UTC. Position samples carry their own UTC
// stamp. A TimingData line only carries the recording clock (HH:MM:SS.mmm),
// so that clock is pinned to UTC through the Position stream: its stamps
// against the clock of the lines that carry them. Heartbeat would be the
// obvious pin and was tried first. It disagrees by a steady 2.05 s (22 of the
// 26 races), and that 2 s, at 75 m/s, put Silverstone's finish line 160 m from
// where an independent set of lap-start points has it; pinned through Position
// it is within 8 m.
// It also fails outright where a recording's heartbeat has the wrong date
// (Mexico City 2026). So timing events are taken to reach the recording as
// late as position samples do, which fits both arriving through the same
// feed. A residual of a few tens of metres along the track is possible.
//
// Needs the same race that build-circuits.js took the outline from (its
// download is cached in .dev/position-cache/) and the signed-in viewer's
// token, for TimingData (about 7MB per circuit).
//
//   node scripts/build-markers.js            every circuit
//   node scripts/build-markers.js 2 39       only circuit keys 2 and 39

var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
var archive = require("./lib/archive");

var FILE = path.join(archive.ROOT, "service", "data", "circuits.json");

function clockMs(prefix) {
  var m = /^(\d+):(\d\d):(\d\d)\.(\d{3})/.exec(prefix);
  return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] : NaN;
}

function median(values) {
  var s = values.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)];
}

// UTC of the recording clock's zero, from the Position stream: each line's
// newest sample stamp against the clock of the line that carried it.
function streamStart(positionText) {
  var offsets = [];
  var lines = positionText.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i += 10) {
    var line = lines[i];
    if (line.length < 14) continue;
    try {
      var data = JSON.parse(zlib.inflateRawSync(Buffer.from(JSON.parse(line.slice(12)), "base64")).toString("utf8"));
      var items = data.Position;
      var ts = Date.parse(items[items.length - 1].Timestamp);
      var c = clockMs(line);
      if (!isNaN(ts) && !isNaN(c)) offsets.push(ts - c);
    } catch (e) { /* not a position line */ }
  }
  return offsets.length ? median(offsets) : null;
}

// [{car, sector (0-2), t}] for every sector a car finished.
function sectorEvents(timingText, start) {
  var events = [];
  timingText.split(/\r?\n/).forEach(function (line) {
    if (line.length < 14 || line.indexOf("Sectors") === -1) return;
    var data;
    try { data = JSON.parse(line.slice(12)); } catch (e) { return; }
    var lines = data && data.Lines;
    if (!lines) return;
    var t = start + clockMs(line);
    Object.keys(lines).forEach(function (car) {
      var sectors = lines[car] && lines[car].Sectors;
      if (!sectors) return;
      Object.keys(sectors).forEach(function (k) {
        var v = sectors[k] && sectors[k].Value;
        // A value is a sector finished. PreviousValue alone is the old time
        // being kept for a moment, and an empty Value is the reset.
        if (typeof v === "string" && v !== "") events.push({ car: car, sector: Number(k), t: t });
      });
    });
  });
  return events;
}

// Where a car was at time t, between the two samples either side; null if it
// wasn't on track then, or the samples around t are too far apart to trust.
function positionAt(samples, t) {
  var lo = 0, hi = samples.length - 1;
  if (!samples.length || t < samples[0].t || t > samples[hi].t) return null;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  var a = samples[lo], b = samples[lo + 1];
  if (!b || b.t - a.t > 1500) return null;
  var f = (t - a.t) / (b.t - a.t);
  return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
}

// The middle of a pile of points: the median, then the mean of those within
// 30m of it (positions are tenths of a metre), which drops the pit-lane
// crossings and the odd bad sample.
function centre(points) {
  var mx = median(points.map(function (p) { return p.x; }));
  var my = median(points.map(function (p) { return p.y; }));
  var near = points.filter(function (p) { return Math.hypot(p.x - mx, p.y - my) < 300; });
  if (near.length < 5) return null;
  var cx = 0, cy = 0;
  near.forEach(function (p) { cx += p.x; cy += p.y; });
  cx /= near.length;
  cy /= near.length;
  var spread = median(near.map(function (p) { return Math.hypot(p.x - cx, p.y - cy); }));
  return { x: cx, y: cy, n: near.length, of: points.length, spreadM: spread / 10 };
}

function nearestIndex(outline, p) {
  var best = 0, bestD = Infinity;
  for (var i = 0; i < outline.x.length; i++) {
    var d = Math.hypot(outline.x[i] - p.x, outline.y[i] - p.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { i: best, offM: bestD / 10 };
}

function markersFor(c) {
  var base = "/static/" + c.session + "/";
  return Promise.all([
    archive.cached(c.key + "-" + c.year + ".jsonStream", base + "Position.z.jsonStream"),
    archive.cached(c.key + "-" + c.year + "-timing.jsonStream", base + "TimingData.jsonStream"),
  ]).then(function (texts) {
    if (!texts[0] || !texts[1]) throw new Error("a stream is missing from the archive");
    var start = streamStart(texts[0]);
    if (start === null) throw new Error("no position samples to pin the clock");
    var cars = archive.readPositions(texts[0]);
    var piles = [[], [], []];
    sectorEvents(texts[1], start).forEach(function (e) {
      if (e.sector > 2 || !cars[e.car]) return;
      var p = positionAt(cars[e.car], e.t);
      if (p) piles[e.sector].push(p);
    });
    var out = piles.map(function (pile) {
      var mid = pile.length ? centre(pile) : null;
      if (!mid) return null;
      var at = nearestIndex(c, mid);
      return { i: at.i, n: mid.n, of: mid.of, spreadM: Math.round(mid.spreadM), offOutlineM: Math.round(at.offM) };
    });
    if (!out[2]) throw new Error("no finish line found");
    return { finish: out[2], sectors: [out[0], out[1]] };
  });
}

function main() {
  var data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  var only = process.argv.slice(2);
  var keys = Object.keys(data).filter(function (k) { return !only.length || only.indexOf(k) !== -1; });
  return archive
    .signIn()
    .then(function () {
      return keys.reduce(function (chain, key) {
        return chain.then(function () {
          var c = data[key];
          return markersFor(c).then(
            function (m) {
              c.markers = m;
              console.log(
                "  " + key + " " + c.short + ": finish #" + m.finish.i + " (" + m.finish.n + "/" + m.finish.of + " crossings, spread " + m.finish.spreadM + " m)" +
                "  S1 #" + (m.sectors[0] ? m.sectors[0].i + " (" + m.sectors[0].spreadM + " m)" : "-") +
                "  S2 #" + (m.sectors[1] ? m.sectors[1].i + " (" + m.sectors[1].spreadM + " m)" : "-")
              );
            },
            function (err) { console.log("  " + key + " " + c.short + ": " + err.message); }
          );
        });
      }, Promise.resolve());
    })
    .then(function () {
      fs.writeFileSync(FILE, JSON.stringify(data));
      console.log("wrote " + path.relative(archive.ROOT, FILE));
    });
}

main().catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
