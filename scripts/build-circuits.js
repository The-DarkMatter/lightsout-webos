#!/usr/bin/env node
// Builds service/data/circuits.json: one clean lap of every circuit, in the
// coordinates of F1's own Position feed.
//
// Why this exists: the track map used to draw only what the cars had covered
// so far, so it was wrong until a full lap had happened. The outline is the
// same lap-shaped line every circuit has, so it can be known in advance, but
// only if it lives in the Position feed's coordinate space: a drawn SVG never
// lined up (see the header of app/js/overlays.js). This takes the outline
// from the feed itself.
//
// For each circuit it downloads the newest race's Position.z stream from the
// timing archive (about 8MB, needs the signed-in viewer's token, so run this
// where the dev server is signed in), finds every car's laps, drops the ones
// that went through the pit lane or under a safety car, and keeps the fastest
// clean lap, resampled at an even spacing.
//
//   node scripts/build-circuits.js              every circuit F1 lists
//   node scripts/build-circuits.js 2 39         only circuit keys 2 and 39
//   node scripts/build-circuits.js --years 2025,2026
//
// Downloads are cached in .dev/position-cache/, so a re-run costs nothing.

var fs = require("fs");
var path = require("path");

var archive = require("./lib/archive");
var ROOT = archive.ROOT;
var readPositions = archive.readPositions;

var OUT_FILE = path.join(ROOT, "service", "data", "circuits.json");
var OUTLINE_POINTS = 360;

// ---- finding laps -------------------------------------------------------

function dist(a, b) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

function pathLength(pts) {
  var len = 0;
  for (var i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

function median(values) {
  var s = values.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)];
}

// A gate across the track, a short way into the race: a point on the racing
// line and the direction of travel there. A lap is the time between two
// crossings of it. Taken from a car mid-race so it isn't the grid or a pit lane.
//
// It goes on the straightest, fastest stretch that car drove. In a bend,
// cars take different lines and cross the gate at different angles, and a
// gate narrow enough to keep out the pit lane then misses most of them (this
// found no laps at Spa, Suzuka and others before it looked for a straight).
function pickGate(cars) {
  var nums = Object.keys(cars).sort(function (a, b) { return cars[b].length - cars[a].length; });
  var ref = cars[nums[0]];
  var from = Math.floor(ref.length * 0.25);
  var to = Math.floor(ref.length * 0.6);
  var W = 6;
  var best = null;
  for (var i = from; i < to; i++) {
    var a = ref[i - W], b = ref[i], c = ref[i + W];
    if (c.t - a.t > 12 * W * 300) continue; // the stream dropped out here
    var reach = dist(a, c);
    if (reach < 1) continue;
    // 1 when the car drove dead straight, less in a bend; weighted by speed
    // so a slow, tight corner never beats a straight.
    var straight = reach / (dist(a, b) + dist(b, c) || 1);
    var score = straight * 1000 + reach / (c.t - a.t);
    if (!best || score > best.score) best = { score: score, i: i };
  }
  var p = ref[best ? best.i : from];
  var q = ref[(best ? best.i : from) + 3];
  var dx = q.x - p.x, dy = q.y - p.y;
  var d = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: p.x, y: p.y, dx: dx / d, dy: dy / d };
}

function side(g, p) {
  return (p.x - g.x) * g.dx + (p.y - g.y) * g.dy;
}

function lateral(g, p) {
  return Math.abs(-(p.x - g.x) * g.dy + (p.y - g.y) * g.dx);
}

// Every lap a car completed, as the samples between two gate crossings with
// the crossing points themselves interpolated in at both ends.
function lapsOf(g, pts, gateHalfWidth) {
  var crossings = [];
  for (var i = 1; i < pts.length; i++) {
    var a = side(g, pts[i - 1]);
    var b = side(g, pts[i]);
    if (a < 0 && b >= 0) {
      var f = a / (a - b);
      var at = {
        t: pts[i - 1].t + f * (pts[i].t - pts[i - 1].t),
        x: pts[i - 1].x + f * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + f * (pts[i].y - pts[i - 1].y),
      };
      // A different part of the circuit can cross the same infinite line.
      // Only a crossing at the gate itself counts.
      if (lateral(g, at) <= gateHalfWidth) crossings.push({ idx: i, p: at });
    }
  }
  var laps = [];
  for (var c = 1; c < crossings.length; c++) {
    var from = crossings[c - 1], to = crossings[c];
    // A gap in the samples (the stream dropped out) makes a lap that can't
    // be trusted to follow the track.
    var body = pts.slice(from.idx, to.idx);
    var ok = true;
    for (var k = 1; k < body.length; k++) {
      if (body[k].t - body[k - 1].t > 2500) { ok = false; break; }
    }
    if (!ok || body.length < 30) continue;
    laps.push({ pts: [from.p].concat(body, [to.p]), time: to.p.t - from.p.t });
  }
  return laps;
}

// The fastest lap among those that look like a normal lap of the circuit.
// Laps through the pit lane differ in length from the rest, and laps under a
// safety car or in the first lap's crush are slower, so: keep the laps whose
// length matches the typical one, then take the quickest of those.
function bestLap(cars, note) {
  var g = pickGate(cars);
  // The gate must be wide enough for the width of the road plus the line
  // different cars take, and narrow enough to exclude the pit lane beside it.
  var all = [];
  Object.keys(cars).forEach(function (n) {
    // Positions are in tenths of a metre: 120 is 12m either side of the line.
    lapsOf(g, cars[n], 120).forEach(function (lap) {
      lap.length = pathLength(lap.pts);
      lap.car = n;
      all.push(lap);
    });
  });
  note.cars = Object.keys(cars).length;
  note.laps = all.length;
  if (all.length < 5) { note.reason = "only " + all.length + " laps crossed the gate"; return null; }
  var typical = median(all.map(function (l) { return l.length; }));
  var normal = all.filter(function (l) { return Math.abs(l.length - typical) / typical < 0.012; });
  note.normal = normal.length;
  if (normal.length < 3) { note.reason = normal.length + " of " + all.length + " laps matched the typical length"; return null; }
  normal.sort(function (a, b) { return a.time - b.time; });
  var pick = normal[0];
  pick.lapCount = all.length;
  pick.normalCount = normal.length;
  return pick;
}

// ---- shaping the outline ------------------------------------------------

// An even spacing along the lap, so corners (where the cars were slow and the
// samples dense) don't carry more points than straights.
function resample(pts, n) {
  var cum = [0];
  for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  var total = cum[cum.length - 1];
  var out = [];
  var j = 1;
  for (var k = 0; k < n; k++) {
    var target = (total * k) / n;
    while (j < pts.length - 1 && cum[j] < target) j++;
    var span = cum[j] - cum[j - 1] || 1;
    var f = (target - cum[j - 1]) / span;
    out.push({
      x: Math.round(pts[j - 1].x + f * (pts[j].x - pts[j - 1].x)),
      y: Math.round(pts[j - 1].y + f * (pts[j].y - pts[j - 1].y)),
    });
  }
  return out;
}

// ---- driving it ---------------------------------------------------------

function loadIndex(year) {
  return archive.getWithRetry("/static/" + year + "/Index.json").then(function (res) {
    return res ? JSON.parse(res.body).Meetings || [] : [];
  });
}

function racePaths(years) {
  // circuit key -> {short, races: [{year, path}], newest first}
  var circuits = {};
  return years
    .reduce(function (chain, year) {
      return chain.then(function () {
        return loadIndex(year).then(function (meetings) {
          meetings.forEach(function (m) {
            var key = m.Circuit && m.Circuit.Key;
            var race = (m.Sessions || []).filter(function (s) { return s.Type === "Race" && s.Name === "Race" && s.Path; })[0];
            if (!key || !race) return;
            var c = (circuits[key] = circuits[key] || { key: String(key), short: m.Circuit.ShortName, races: [] });
            c.races.push({ year: year, path: race.Path });
          });
        });
      });
    }, Promise.resolve())
    .then(function () {
      Object.keys(circuits).forEach(function (k) {
        circuits[k].races.sort(function (a, b) { return b.year - a.year; });
      });
      return circuits;
    });
}

function positionText(circuit, race) {
  return archive.cached(circuit.key + "-" + race.year + ".jsonStream", "/static/" + race.path + "Position.z.jsonStream");
}

function buildOne(circuit) {
  // Newest race first; fall back to an older one if a season's feed is
  // missing or its laps don't come out clean.
  return circuit.races.reduce(function (chain, race) {
    return chain.then(function (done) {
      if (done) return done;
      return positionText(circuit, race).then(function (text) {
        if (!text) { console.log("    " + circuit.short + " " + race.year + ": no Position.z in the archive"); return null; }
        var note = {};
        var lap = bestLap(readPositions(text), note);
        if (!lap) { console.log("    " + circuit.short + " " + race.year + ": " + (note.reason || "no laps") + " (" + (note.cars || 0) + " cars)"); return null; }
        var pts = resample(lap.pts, OUTLINE_POINTS);
        return {
          key: circuit.key,
          short: circuit.short,
          year: race.year,
          session: race.path.replace(/\/$/, ""),
          lapTime: Math.round(lap.time) / 1000,
          lengthUnits: Math.round(lap.length),
          lapsSeen: lap.lapCount,
          lapsClean: lap.normalCount,
          x: pts.map(function (p) { return p.x; }),
          y: pts.map(function (p) { return p.y; }),
        };
      });
    });
  }, Promise.resolve(null));
}

function main() {
  var args = process.argv.slice(2);
  var years = [2026, 2025, 2024, 2023];
  var only = [];
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--years") years = args[++i].split(",").map(Number);
    else only.push(args[i]);
  }
  return archive.signIn().then(function () {
    return racePaths(years);
  }).then(function (circuits) {
    var keys = Object.keys(circuits).filter(function (k) { return !only.length || only.indexOf(k) !== -1; });
    var existing = {};
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, "utf8")); } catch (e) { /* first run */ }
    var result = existing;
    return keys
      .reduce(function (chain, key) {
        return chain.then(function () {
          return buildOne(circuits[key]).then(
            function (o) {
              if (!o) { console.log("  " + key + " " + circuits[key].short + ": no clean lap found"); return; }
              result[key] = o;
              console.log("  " + key + " " + o.short + ": " + o.year + ", lap " + o.lapTime + "s, " + o.lapsClean + "/" + o.lapsSeen + " clean laps");
            },
            function (err) { console.log("  " + key + " " + circuits[key].short + ": failed (" + err.message + ")"); }
          );
        });
      }, Promise.resolve())
      .then(function () {
        fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
        fs.writeFileSync(OUT_FILE, JSON.stringify(result));
        console.log("wrote " + Object.keys(result).length + " circuits to " + path.relative(ROOT, OUT_FILE));
      });
  });
}

main().catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
