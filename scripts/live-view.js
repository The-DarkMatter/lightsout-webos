#!/usr/bin/env node
// Watch a live session (or a replay) on this PC, without a TV: starts the dev
// server against the real F1 TV API, opens the app in the browser with the
// timing tower and track map already open, and prints what the live feed is
// doing every few seconds.
//
//   node scripts/live-view.js                       a live session, no picture
//   node scripts/live-view.js --replay 1000010398   a replay, with its picture
//   node scripts/live-view.js --no-open             just serve and report
//   node scripts/live-view.js --port 8800
//
// Ctrl+C stops it. It needs the sign-in the dev server already holds
// (.dev/state.json); if there isn't one, the dev server prints its sign-in
// address, and you sign in there once.
//
// With no picture the page has no clock to line up with, so it shows the feed
// about as live as it arrives, less the Timing delay (4 s by default). With a
// replay it uses the picture's own clock, exactly as on the TV. A replay plays
// its sound in the browser; mute the tab if that isn't wanted.
//
// The status line is for judging the feed without staring at the page:
//   track     what F1 says the track is (AllClear, Yellow, Red ...)
//   moving    cars that covered more than 30 m in the last few seconds
//   newest    how old the newest position is, as it reaches the service

var http = require("http");
var path = require("path");
var cp = require("child_process");

var ROOT = path.resolve(__dirname, "..");
var args = process.argv.slice(2);
var port = 8788;
var replayId = null;
var open = true;
for (var i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]) || port;
  else if (args[i] === "--replay") replayId = args[++i];
  else if (args[i] === "--no-open") open = false;
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("usage: node scripts/live-view.js [--replay <contentId>] [--no-open] [--port <n>]");
    process.exit(0);
  }
}

var BASE = "http://localhost:" + port;
var server = null;

function request(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body ? JSON.stringify(body) : null;
    var req = http.request(
      { host: "localhost", port: port, path: urlPath, method: method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}, timeout: 8000 },
      function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      }
    );
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function call(method, params) {
  return request("POST", "/api/" + method, params || {}).then(function (r) {
    try { return JSON.parse(r.body); } catch (e) { return null; }
  });
}

function isUp() {
  // Any answer at all means it is listening ("/" may redirect or 404).
  return request("GET", "/").then(function () { return true; }, function () { return false; });
}

function waitUntilUp(tries) {
  return isUp().then(function (up) {
    if (up) return;
    if (tries <= 0) throw new Error("the dev server didn't come up on port " + port);
    return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return waitUntilUp(tries - 1); });
  });
}

function startServer() {
  return isUp().then(function (up) {
    if (up) {
      console.log("Using the dev server already running on port " + port + ".");
      return;
    }
    console.log("Starting the dev server...");
    server = cp.spawn(process.execPath, [path.join(ROOT, "scripts", "dev-server.js")], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(port) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Its own lines are noise once it's up, but the sign-in address matters if there's no sign-in.
    var show = function (chunk) {
      String(chunk).split(/\r?\n/).forEach(function (line) {
        if (/Sign in:|not signed in|No sign-in|error/i.test(line)) console.log("  [dev-server] " + line.trim());
      });
    };
    server.stdout.on("data", show);
    server.stderr.on("data", show);
    server.on("exit", function (code) {
      if (code) console.log("The dev server stopped (exit " + code + ").");
      process.exit(code || 0);
    });
    return waitUntilUp(40);
  });
}

function openBrowser(url) {
  var cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    cp.spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
  } catch (e) {
    console.log("Couldn't open a browser. Open " + url + " yourself.");
  }
}

// ---- the status line -----------------------------------------------------

function describe(summary, map) {
  if (!summary) return "no answer from the service";
  var si = summary.sessionInfo || {};
  var where = [si.Name, si.Meeting && si.Meeting.Name].filter(Boolean).join(" · ") || "no session info yet";
  if (!summary.connected) return where + " - connecting to F1's live feed...";
  if (!summary.rawMessageCount) return where + " - connected, but nothing is arriving (is a session live?)";
  var parts = [where];
  parts.push("track " + ((summary.trackStatus && summary.trackStatus.Message) || "?"));
  if (map && map.drivers) {
    var moving = 0, samples = 0;
    map.drivers.forEach(function (d) {
      samples += d.samples.length;
      var recent = d.samples.filter(function (s) { return s[0] > map.newest - 5000; });
      if (recent.length >= 2) {
        var a = recent[0], b = recent[recent.length - 1];
        if (Math.sqrt((b[1] - a[1]) * (b[1] - a[1]) + (b[2] - a[2]) * (b[2] - a[2])) > 300) moving++;
      }
    });
    parts.push(map.drivers.length + " cars, " + moving + " moving");
    parts.push(map.hasOutline ? "outline " + map.circuitKey : "no outline for circuit " + map.circuitKey);
    if (map.newest) parts.push("newest " + ((Date.now() - map.newest) / 1000).toFixed(1) + " s ago");
  }
  return parts.join(" · ");
}

function report() {
  return Promise.all([call("liveTimingSummary"), call("liveTimingTrackMap", { since: 0 })]).then(
    function (r) {
      var line = describe(r[0], r[1]);
      console.log(new Date().toTimeString().slice(0, 8) + "  " + line);
    },
    function (err) { console.log("status check failed: " + err.message); }
  );
}

function main() {
  return startServer().then(function () {
    var url = BASE + "/watch.html?debugOverlays=1" + (replayId ? "&contentId=" + encodeURIComponent(replayId) : "");
    console.log("App: " + url);
    // The page starts the live feed itself when its overlays open; starting it
    // here too means the status line has something to report even with no page.
    if (!replayId) call("liveTimingStart");
    if (open) openBrowser(url);
    console.log("Ctrl+C to stop.\n");
    if (replayId) {
      console.log("(A replay's timing comes from F1's archive, not the live feed, so there is no live status to print.)");
      return new Promise(function () { /* run until Ctrl+C */ });
    }
    report();
    setInterval(report, 5000);
    return new Promise(function () { /* run until Ctrl+C */ });
  });
}

function stop() {
  if (server) {
    // The dev server is a plain child, but be sure nothing it started outlives it.
    if (process.platform === "win32") cp.spawnSync("taskkill", ["/T", "/F", "/PID", String(server.pid)]);
    else server.kill();
  }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch(function (err) {
  console.error(err.message);
  stop();
});
