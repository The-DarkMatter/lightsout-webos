#!/usr/bin/env node
// Offline validation of livetiming.js's per-topic reducers against F1's
// public static session archive - the same per-topic JSON files (a full
// "keyframe" snapshot plus a timestamp-prefixed incremental ".jsonStream")
// that exist for every past session, world championship or support race:
// https://livetiming.formula1.com/static/<year>/<event folder>/<session
// folder>/Index.json lists every available topic file. The archive now
// needs an F1 TV sign-in: this reads the token the dev server stored in
// .dev/state.json, or F1TV_TOKEN from the environment.
//
// This runs real recorded data through the exact same applyTopic() used
// for the live SignalR connection, so the topic data shapes (previously
// pure guesswork - see livetiming.js's file header) get checked against
// real F1 output instead of waiting on a live session and hoping the
// guesses were right. This is the M4 verification approach from the
// project plan ("Build this against a recorded session file first").
//
// It does NOT validate the live WebSocket envelope itself (the
// type:1/target:"feed"/arguments wrapper) - the static archive is already
// split one file per topic, so there's no envelope to unwrap. That one
// remaining piece can only be confirmed against a real live connection.
//
// Usage:
//   node scripts/replay-test.js "2026/2026-09-13_Spanish_Grand_Prix/2026-09-12_Practice_3"

var https = require("https");
var lt = require("../service/lib/livetiming.js");

var sessionPath = process.argv[2];
if (!sessionPath) {
  console.error("usage: node replay-test.js <year>/<event-folder>/<session-folder>");
  console.error('example: node replay-test.js "2026/2026-09-13_Spanish_Grand_Prix/2026-09-12_Practice_3"');
  process.exit(1);
}

var BASE = "https://livetiming.formula1.com/static/" + sessionPath;

var token = process.env.F1TV_TOKEN || null;
if (!token) {
  try {
    var devState = require("path").join(__dirname, "..", ".dev", "state.json");
    token = JSON.parse(require("fs").readFileSync(devState, "utf8")).f1tv_token || null;
  } catch (e) {}
}
if (!token) {
  console.error("F1's archive needs a sign-in: sign in once through scripts/dev-server.js, or set F1TV_TOKEN.");
  process.exit(1);
}

function get(path) {
  return new Promise(function (resolve) {
    https
      .get(encodeURI(BASE + "/" + path), { headers: { Authorization: "Bearer " + token } }, function (res) {
        if (res.statusCode === 401) {
          console.error("F1's archive refused the sign-in (401) for " + path + ". Sign in again.");
          process.exit(1);
        }
        if (res.statusCode !== 200) {
          resolve(null); // topic doesn't exist for this session type (e.g. LapCount on a practice session) - not an error
          res.resume();
          return;
        }
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "")); });
      })
      .on("error", function () { resolve(null); });
  });
}

// Each record is a fixed-width session-elapsed timestamp immediately
// followed by JSON - no delimiter between them, confirmed against real
// downloaded files (e.g. "00:00:07.381{"Lines":{...}}").
function parseStream(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(function (line) {
      var m = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})(.*)$/);
      if (!m) return null;
      try {
        return { t: m[1], data: JSON.parse(m[2]) };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

var TOPICS = ["DriverList", "TimingData", "TimingAppData", "CarData.z", "Position.z", "TrackStatus", "WeatherData", "RaceControlMessages"];

Promise.all(
  TOPICS.map(function (topic) {
    return Promise.all([get(topic + ".json"), get(topic + ".jsonStream")]).then(function (results) {
      var keyframe = results[0];
      var stream = parseStream(results[1]);
      return { topic: topic, keyframe: keyframe ? JSON.parse(keyframe) : null, stream: stream };
    });
  })
)
  .then(function (results) {
    var total = 0;
    results.forEach(function (r) {
      if (r.keyframe !== null) {
        lt.__applyTopic(r.topic, r.keyframe);
        total++;
      }
      r.stream.forEach(function (rec) {
        lt.__applyTopic(r.topic, rec.data);
      });
      total += r.stream.length;
      console.log(
        r.topic + ": " + (r.keyframe !== null ? "1 keyframe + " : "no keyframe, ") + r.stream.length + " stream records"
      );
    });
    console.log("\nApplied " + total + " real records through the production applyTopic() reducer.\n");

    var tower = lt.getTimingTower();
    console.log("Timing tower - " + tower.length + " drivers, top 5 by position:");
    tower.slice(0, 5).forEach(function (d) {
      console.log(
        "  P" + d.position + " " + (d.tla || "?") + "  gap=" + d.gapToLeader + "  lastLap=" + d.lastLapTime +
        "  inPit=" + d.inPit + "  tyre=" + JSON.stringify(d.tyre) +
        "  telemetry=" + JSON.stringify(d.telemetry) +
        "  sectors=" + JSON.stringify(d.sectors)
      );
    });

    var map = lt.getTrackMap();
    console.log(
      "\nTrack map - " + map.trail.length + " accumulated position points, " + map.drivers.length + " drivers with a last-known position"
    );
    // The accumulated positions' bounding box, optionally after applying a
    // candidate rotation (second argument, in degrees). The app itself no
    // longer rotates the map - it draws the raw accumulation - but this
    // stays useful for checking offline what a session's track actually
    // looks like, and at what proportions, without waiting for one to be
    // live.
    if (map.trail.length) {
      var deg = parseFloat(process.argv[3] || "0") || 0;
      var rad = (deg * Math.PI) / 180, ca = Math.cos(rad), sa = Math.sin(rad);
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      map.trail.forEach(function (p) {
        var x = p.x * ca - p.y * sa, y = p.x * sa + p.y * ca;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
      var bw = maxX - minX, bh = maxY - minY;
      console.log(
        "  bounds at " + deg + "deg: " + Math.round(bw) + " x " + Math.round(bh) +
        "  aspect " + (bw / bh).toFixed(3)
      );
    }
    var summary = lt.getSummary();
    console.log("\nRace control messages captured: " + summary.raceControlMessages.length);
    console.log("Track status: " + JSON.stringify(summary.trackStatus));
    console.log("Weather: " + JSON.stringify(summary.weatherData));
  })
  .catch(function (err) {
    console.error("replay test failed:", err);
    process.exit(1);
  });
