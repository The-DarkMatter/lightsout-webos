#!/usr/bin/env node
// Checks every outline in service/data/circuits.json against the real-world
// shape of its circuit, and reports how far each has to be turned to match
// and how closely it then does.
//
// The reference is a public collection of F1 circuit outlines as GeoJSON, one
// file per circuit, whose geometry comes from OpenStreetMap ((c) OpenStreetMap
// contributors, ODbL). Point the script at its raw files folder with the
// CIRCUIT_REFERENCE_URL environment variable (it must end in a slash; the files
// are named as in REFERENCE below, plus ".geojson"). Nothing from it is stored
// or drawn: longitude and latitude are not the feed's coordinates, and drawing
// from them was the mismatch that sank the earlier SVG backdrop.
//
// What it found (2026-11-20, all 26 circuits): every rotation is within 2.3
// degrees of none, and every outline is within 4-21 m RMS of OpenStreetMap.
// The Position feed is already north-up (x east, y north) in metres, so the
// app applies no rotation, and the outlines are independently confirmed.
// Re-run it after rebuilding the outlines: a rotation that is not close to 0,
// or a fit of more than a few tens of metres, means a bad lap or a changed layout.
//
// The two shapes are matched as closed loops: both resampled evenly, then for
// every starting point and both directions the best rotation is solved
// directly (2D Procrustes), and the best of those kept.
//
//   node scripts/check-circuits.js            all circuits
//   node scripts/check-circuits.js 2 39       only circuit keys 2 and 39

var fs = require("fs");
var https = require("https");
var path = require("path");

var FILE = path.join(__dirname, "..", "service", "data", "circuits.json");
var N = 240;

// F1's circuit key -> file name in the reference collection (country code and
// the year the circuit opened)
var REFERENCE = {
  "2": "gb-1948", "4": "hu-1986", "6": "it-1953", "7": "be-1925", "9": "us-2012",
  "10": "au-1953", "12": "my-1999", "14": "br-1940", "15": "es-1991", "19": "at-1969",
  "22": "mc-1929", "23": "ca-1978", "39": "it-1922", "46": "jp-1962", "49": "cn-2004",
  "55": "nl-1948", "61": "sg-2008", "63": "bh-2002", "65": "mx-1962", "70": "ae-2009",
  "144": "az-2016", "149": "sa-2021", "150": "qa-2004", "151": "us-2022", "152": "us-2023",
  "153": "es-2026",
};

function fetchJson(name) {
  var base = process.env.CIRCUIT_REFERENCE_URL;
  if (!base) {
    return Promise.reject(new Error("set CIRCUIT_REFERENCE_URL to the folder of reference GeoJSON files (see the top of this file)"));
  }
  return new Promise(function (resolve, reject) {
    https
      .get(
        base + name + ".geojson",
        { headers: { "User-Agent": "lightsout-check" } },
        function (res) {
          var chunks = [];
          res.on("data", function (c) { chunks.push(c); });
          res.on("end", function () {
            if (res.statusCode !== 200) return reject(new Error(name + ": HTTP " + res.statusCode));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
          });
        }
      )
      .on("error", reject);
  });
}

// The longest line in the file, as local metres: x east, y north.
function geoLoop(geojson) {
  var lines = [];
  (geojson.features || [geojson]).forEach(function (f) {
    var g = f.geometry || f;
    if (g.type === "LineString") lines.push(g.coordinates);
    if (g.type === "MultiLineString") g.coordinates.forEach(function (c) { lines.push(c); });
  });
  lines.sort(function (a, b) { return b.length - a.length; });
  var pts = lines[0];
  var lat0 = (pts[0][1] * Math.PI) / 180;
  return pts.map(function (p) {
    return { x: (p[0] - pts[0][0]) * Math.cos(lat0) * 111320, y: (p[1] - pts[0][1]) * 110540 };
  });
}

function resample(pts, n) {
  var cum = [0];
  for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  var total = cum[cum.length - 1];
  var out = [];
  var j = 1;
  for (var k = 0; k < n; k++) {
    var target = (total * k) / n;
    while (j < pts.length - 1 && cum[j] < target) j++;
    var span = cum[j] - cum[j - 1] || 1;
    var f = (target - cum[j - 1]) / span;
    out.push({ x: pts[j - 1].x + f * (pts[j].x - pts[j - 1].x), y: pts[j - 1].y + f * (pts[j].y - pts[j - 1].y) });
  }
  return out;
}

// Centred on its centroid and scaled so its RMS radius is 1; returns the radius
// so a residual can be turned back into metres.
function normalise(pts) {
  var cx = 0, cy = 0;
  pts.forEach(function (p) { cx += p.x; cy += p.y; });
  cx /= pts.length;
  cy /= pts.length;
  var r2 = 0;
  pts.forEach(function (p) { r2 += (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy); });
  var r = Math.sqrt(r2 / pts.length) || 1;
  return { pts: pts.map(function (p) { return { x: (p.x - cx) / r, y: (p.y - cy) / r }; }), radius: r };
}

// The best rotation of `a` onto `b` (same length, matched point to point).
function bestRotation(a, b) {
  var dot = 0, cross = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i].x * b[i].x + a[i].y * b[i].y;
    cross += a[i].x * b[i].y - a[i].y * b[i].x;
  }
  var theta = Math.atan2(cross, dot);
  var c = Math.cos(theta), s = Math.sin(theta);
  var err = 0;
  for (var k = 0; k < a.length; k++) {
    var rx = a[k].x * c - a[k].y * s, ry = a[k].x * s + a[k].y * c;
    err += (rx - b[k].x) * (rx - b[k].x) + (ry - b[k].y) * (ry - b[k].y);
  }
  return { theta: theta, err: err / a.length };
}

function align(feed, geo) {
  var a = normalise(resample(feed, N));
  var g = normalise(resample(geo, N));
  var best = null;
  [false, true].forEach(function (reflect) {
    // The feed's y might count the other way; try it mirrored too and see which fits.
    var fa = reflect ? a.pts.map(function (p) { return { x: p.x, y: -p.y }; }) : a.pts;
    [false, true].forEach(function (reversed) {
      var ga = reversed ? g.pts.slice().reverse() : g.pts;
      for (var shift = 0; shift < N; shift += 2) {
        var shifted = ga.slice(shift).concat(ga.slice(0, shift));
        var r = bestRotation(fa, shifted);
        if (!best || r.err < best.err) best = { err: r.err, theta: r.theta, reflect: reflect };
      }
    });
  });
  return {
    rotation: (best.theta * 180) / Math.PI,
    reflected: best.reflect,
    // RMS gap in metres, using the real-world scale of the reference
    rmsM: Math.sqrt(best.err) * g.radius,
  };
}

function main() {
  var data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  var only = process.argv.slice(2);
  var keys = Object.keys(data).filter(function (k) { return !only.length || only.indexOf(k) !== -1; });
  return keys
    .reduce(function (chain, key) {
      return chain.then(function () {
        var c = data[key];
        var ref = REFERENCE[key];
        if (!ref) { console.log("  " + key + " " + c.short + ": no reference"); return; }
        return fetchJson(ref).then(
          function (geojson) {
            var feed = c.x.map(function (x, i) { return { x: x, y: c.y[i] }; });
            var r = align(feed, geoLoop(geojson));
            // Mirrored would mean the feed's axes are not a turn of the real map, and a
            // rotation alone cannot fix that. Keep it out of the file and say so.
            if (r.reflected) { console.log("  " + key + " " + c.short + ": best match was MIRRORED (" + r.rmsM.toFixed(0) + " m): the feed's axes would not be a turn of the real map"); return; }
            console.log("  " + key + " " + c.short + " (" + ref + "): rotate " + r.rotation.toFixed(1) + " deg, fit " + r.rmsM.toFixed(0) + " m");
          },
          function (err) { console.log("  " + key + " " + c.short + ": " + err.message); }
        );
      });
    }, Promise.resolve())
    ;
}

main().catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
