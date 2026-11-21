// A recorded session's Position.z stream (about 8MB for a race) kept on disk,
// so reopening the map on the replay being watched doesn't download it again.
//
// Only the latest one is ever kept. Writing a new session's file removes the
// rest, and the service sweeps on start, keeping the one most recently used
// (a read counts as use). It lives in the store's folder (service/state/ on the
// TV, which an uninstall removes - see store.js), in its own subfolder.
// Anything that goes wrong here just means a download next time.

var fs = require("fs");
var path = require("path");
var store = require("./store");

function dir() {
  return store.dir ? path.join(store.dir, "positions") : null;
}

// One file per session; the session's archive path made safe to use as a name.
function nameFor(sessionPath) {
  return String(sessionPath).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") + ".jsonStream";
}

function files(d) {
  try {
    return fs.readdirSync(d).filter(function (n) { return /\.jsonStream(\.tmp)?$/.test(n); });
  } catch (e) {
    return [];
  }
}

// The text, or null if this session isn't cached.
function read(sessionPath) {
  var d = dir();
  if (!d) return null;
  var file = path.join(d, nameFor(sessionPath));
  try {
    var text = fs.readFileSync(file, "utf8");
    var now = new Date();
    try { fs.utimesSync(file, now, now); } catch (e) { /* the use isn't recorded; harmless */ }
    return text;
  } catch (e) {
    return null;
  }
}

// Keep this session's file and nothing else.
function write(sessionPath, text) {
  var d = dir();
  if (!d) return;
  try {
    fs.mkdirSync(d, { recursive: true });
    var keep = nameFor(sessionPath);
    files(d).forEach(function (n) {
      if (n !== keep) { try { fs.unlinkSync(path.join(d, n)); } catch (e) { /* in use or gone */ } }
    });
    // Written aside and renamed, so a service killed part-way never leaves a
    // half file that reads as a whole session.
    var tmp = path.join(d, keep + ".tmp");
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(d, keep));
  } catch (e) {
    console.error("[poscache] not cached:", e && e.message);
  }
}

// On service start: drop everything but the most recently used file, and any
// leftover half-written one.
function prune() {
  var d = dir();
  if (!d) return;
  var newest = null;
  var all = files(d);
  all.forEach(function (n) {
    if (/\.tmp$/.test(n)) return;
    try {
      var m = fs.statSync(path.join(d, n)).mtime.getTime();
      if (!newest || m > newest.m) newest = { n: n, m: m };
    } catch (e) { /* gone already */ }
  });
  all.forEach(function (n) {
    if (newest && n === newest.n) return;
    try { fs.unlinkSync(path.join(d, n)); } catch (e) { /* in use or gone */ }
  });
}

module.exports = { read: read, write: write, prune: prune, nameFor: nameFor };
