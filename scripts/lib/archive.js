// What the circuit scripts share: signing in as the dev server's viewer,
// fetching files from F1's timing archive, and reading a Position.z stream.
// The archive wants the viewer's token as a Bearer header (see service/lib/
// archive.js); here it comes from .dev/state.json through the app's own auth
// module, so it is never printed or copied anywhere.

var fs = require("fs");
var https = require("https");
var path = require("path");
var zlib = require("zlib");

var ROOT = path.resolve(__dirname, "..", "..");
process.env.LIGHTSOUT_STATE_DIR = path.join(ROOT, ".dev");
var auth = require("../../service/lib/auth.js");

var HOST = "livetiming.formula1.com";
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/133.0.0.0 Safari/537.36";

var token = null;

function signIn() {
  return auth.freshToken().then(function (t) {
    if (!t) throw new Error("not signed in: run scripts/dev-server.js and sign in first");
    token = t;
  });
}

function get(p) {
  return new Promise(function (resolve, reject) {
    https
      .get(
        { host: HOST, path: encodeURI(p), headers: { "User-Agent": USER_AGENT, Authorization: "Bearer " + token }, timeout: 120000 },
        function (res) {
          var chunks = [];
          res.on("data", function (c) { chunks.push(c); });
          res.on("end", function () {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "") });
          });
        }
      )
      .on("error", reject);
  });
}

// null for a file that isn't there (403 or 404: the archive can't list, so a
// file never recorded comes back forbidden); throws for anything else.
function getWithRetry(p, tries) {
  tries = tries || 3;
  return get(p).then(
    function (res) {
      if (res.status === 200) return res;
      if (res.status === 404 || res.status === 403) return null;
      if (res.status === 401) throw new Error("the archive refused the sign-in (401)");
      throw new Error("archive returned " + res.status + " for " + p);
    },
    function (err) {
      if (tries <= 1) throw err;
      return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return getWithRetry(p, tries - 1); });
    }
  );
}

// A file from the archive, kept in .dev/position-cache/ so a re-run is free.
function cached(name, archivePath) {
  var dir = path.join(ROOT, ".dev", "position-cache");
  var file = path.join(dir, name);
  if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file, "utf8"));
  return getWithRetry(archivePath).then(function (res) {
    if (!res) return null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, res.body);
    return res.body;
  });
}

// Every line is a clock followed by a JSON string of base64 deflate. Returns
// {racingNumber: [{t, x, y}]} in time order, on-track samples only: a car
// in the garage or being recovered says nothing about the racing line.
function readPositions(text) {
  var cars = {};
  text.split(/\r?\n/).forEach(function (line) {
    if (line.length < 14) return;
    var data;
    try {
      data = JSON.parse(zlib.inflateRawSync(Buffer.from(JSON.parse(line.slice(12)), "base64")).toString("utf8"));
    } catch (e) {
      return;
    }
    (data.Position || []).forEach(function (item) {
      var t = Date.parse(item.Timestamp);
      if (isNaN(t)) return;
      Object.keys(item.Entries || {}).forEach(function (num) {
        var e = item.Entries[num];
        if (!e || e.Status !== "OnTrack" || typeof e.X !== "number" || typeof e.Y !== "number") return;
        if (e.X === 0 && e.Y === 0) return; // no fix yet
        (cars[num] = cars[num] || []).push({ t: t, x: e.X, y: e.Y });
      });
    });
  });
  Object.keys(cars).forEach(function (n) {
    cars[n].sort(function (a, b) { return a.t - b.t; });
  });
  return cars;
}

module.exports = {
  ROOT: ROOT,
  signIn: signIn,
  getWithRetry: getWithRetry,
  cached: cached,
  readPositions: readPositions,
};
