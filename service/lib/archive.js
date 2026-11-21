// Timing for sessions that already happened.
//
// The live SignalR feed (livetiming.js) only ever describes the session
// happening right now, so watching a replay used to show whatever the last
// session left behind - last week's finishing order over this week's race.
// This module answers the different question a replay asks: what did the
// timing look like at this exact moment?
//
// F1 archives every session's raw feed on the same host the live connection
// uses, one file per topic. It used to be open to anyone; by November 2026
// every request without a sign-in got a 401, and the viewer's F1 TV token as
// a Bearer header lets it through (a query-string token, cookie or other
// header names are still refused). So every request carries that token:
//
//   /static/2026/Index.json                         seasons -> meetings -> sessions
//   /static/<session path>/TimingData.jsonStream    the recorded stream
//
// Each .jsonStream line is a 12-character clock (HH:MM:SS.mmm) followed by
// the same JSON patch the live feed pushes - so the archive replays through
// livetiming.js's own reducer, which scripts/replay-test.js has been
// checking against these very files since it was written. Nothing here
// re-parses timing data; it only decides which patches have happened yet.
//
// Two clocks have to be reconciled:
//
//   - The stream clock starts when the feed started recording, roughly an
//     hour before the session and with no fixed relationship to it.
//   - The video has its own timeline, and an F1 TV replay also opens well
//     before the session starts (the 2026 Spanish GP race video begins at
//     12:06Z; lights out was 13:04Z).
//
// Absolute UTC is what joins them. Heartbeat.jsonStream pins the stream
// clock to real time - `00:00:15.049{"Utc":"2026-09-13T12:06:07.693Z"}` -
// and the video's own manifest carries EXT-X-PROGRAM-DATE-TIME, which Shaka
// exposes as getPlayheadTimeAsDate(). So the app says "it is this instant on
// screen" and this module says what was true then. Nobody has to line up a
// replay against a session by hand.
//
// Deltas, not snapshots: a line only carries what changed, so state at a
// given moment means applying every line up to it. Playback moves forward,
// so that is normally a handful of new lines per poll; only a backward seek
// pays for a rebuild from the start.

var https = require("https");
var lt = require("./livetiming");

var HOST = "livetiming.formula1.com";
var BASE = "/static/";
// Everything the timing tower reads. Deliberately not Position.z or
// CarData.z: those are ~9MB per race and only the track map wants them, so
// they'd cost every viewer a long download for an overlay that may never be
// opened. The map loads Position.z itself, on demand (trackMapAt below).
var TOPICS = [
  "SessionInfo",
  "DriverList",
  "TimingData",
  "TimingAppData",
  "TrackStatus",
  "SessionStatus",
  "LapCount",
  "WeatherData",
  "RaceControlMessages",
];

var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/133.0.0.0 Safari/537.36";
var REQUEST_TIMEOUT_MS = 20000;
var REQUEST_TRIES = 3;
// A session's feed starts before the session and runs past its end; these
// bound the search for "which session was happening at this instant".
var FEED_LEAD_MS = 3 * 3600 * 1000;
var FEED_TAIL_MS = 2 * 3600 * 1000;

var yearIndexes = {}; // year -> parsed Index.json
var sessions = {}; // session path -> loaded session
var loading = {}; // session path -> in-flight promise
// The viewer's F1 TV token, refreshed by every towerAt() call. One viewer
// per TV, so a module-level token is enough; downloads already in flight
// pick up the newer one on their next request.
var authToken = null;

function get(path) {
  var headers = { "User-Agent": USER_AGENT };
  if (authToken) headers["Authorization"] = "Bearer " + authToken;
  return new Promise(function (resolve, reject) {
    var req = https.get(
      // encodeURI: session folders follow the meeting's name, and some aren't
      // ASCII ("2026-11-08_São_Paulo_Grand_Prix"). Sent raw, F1 answers 400.
      { host: HOST, path: encodeURI(path), headers: headers, timeout: REQUEST_TIMEOUT_MS },
      function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          // The archive serves UTF-8 with a BOM on some files, and 404s as
          // HTML - both would break JSON.parse further up.
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""),
          });
        });
      }
    );
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

// The archive drops connections when asked for several files in a row, so
// every fetch retries, backing off a little each time. A 404 is an answer -
// plenty of topics simply don't exist for a given session type - but running
// out of retries is a failure, and has to be told apart from "not there", or
// a flaky network looks exactly like a session with no timing.
function getWithRetry(path, tries, waitMs) {
  tries = tries || REQUEST_TRIES;
  function again(err) {
    if (tries <= 1) throw err || new Error("archive unreachable: " + path);
    return new Promise(function (resolve) { setTimeout(resolve, waitMs || 1500); }).then(function () {
      return getWithRetry(path, tries - 1, (waitMs || 1500) * 2);
    });
  }
  return get(path).then(function (res) {
    if (res.statusCode === 200) return res;
    // 403 as well as 404: the archive is object storage that can't list, so
    // a file that was never recorded comes back forbidden rather than
    // missing. Plenty of topics are session-type specific - LapCount exists
    // for a race and not for qualifying - so this is a normal answer, and
    // retrying it would just add delay before the same result.
    if (res.statusCode === 404 || res.statusCode === 403) return null;
    // A refused sign-in won't change on a retry.
    if (res.statusCode === 401) throw new Error("F1's timing archive refused the sign-in (401)");
    return again(new Error("archive returned " + res.statusCode + " for " + path));
  }, again);
}

// "2026-09-13T15:00:00" plus "02:00:00" -> UTC ms.
function sessionStartUtc(startDate, gmtOffset) {
  var local = Date.parse(startDate + "Z");
  if (!local) return 0;
  var parts = String(gmtOffset || "00:00:00").split(":");
  var sign = String(gmtOffset || "").charAt(0) === "-" ? -1 : 1;
  var offset =
    (Math.abs(Number(parts[0]) || 0) * 3600 + (Number(parts[1]) || 0) * 60 + (Number(parts[2]) || 0)) * 1000;
  return local - sign * offset;
}

// Cached for the life of the service: it's 20KB, and webOS restarts this
// process often enough on its own.
function loadYearIndex(year) {
  if (yearIndexes[year]) return Promise.resolve(yearIndexes[year]);
  return getWithRetry(BASE + year + "/Index.json").then(function (res) {
    if (!res) return null; // no archive for that season
    var parsed = null;
    try { parsed = JSON.parse(res.body); } catch (e) {
      throw new Error("could not read the " + year + " season index");
    }
    yearIndexes[year] = parsed;
    return parsed;
  });
}

// Which archived session was being recorded at this instant. A UTC instant
// is enough to identify it - no need to match the video's title against
// F1's meeting names, which differ in wording often enough to be a trap.
function findSession(atUtcMs) {
  var year = new Date(atUtcMs).getUTCFullYear();
  // A session close to New Year could sit in the neighbouring year's index.
  var years = [year, year - 1];
  return years.reduce(function (chain, y) {
    return chain.then(function (found) {
      if (found) return found;
      return loadYearIndex(y).then(function (index) {
        if (!index || !index.Meetings) return null; // that year simply isn't archived
        var best = null;
        index.Meetings.forEach(function (meeting) {
          (meeting.Sessions || []).forEach(function (s) {
            if (!s.Path) return;
            var start = sessionStartUtc(s.StartDate, s.GmtOffset);
            var end = sessionStartUtc(s.EndDate, s.GmtOffset) || start + 2 * 3600 * 1000;
            if (atUtcMs < start - FEED_LEAD_MS || atUtcMs > end + FEED_TAIL_MS) return;
            // Overlapping windows are possible on a two-session day, so
            // prefer whichever session the instant is nearest to.
            var distance = atUtcMs < start ? start - atUtcMs : atUtcMs > end ? atUtcMs - end : 0;
            if (!best || distance < best.distance) {
              best = {
                distance: distance,
                path: s.Path,
                key: s.Key,
                type: s.Type,
                name: s.Name,
                meeting: meeting.Name,
                startUtc: start,
              };
            }
          });
        });
        return best;
      });
    });
  }, Promise.resolve(null));
}

// One .jsonStream into parallel arrays: the clock in milliseconds, and the
// patch still as text. Leaving bodies unparsed keeps a whole race in a few
// megabytes; they're parsed one at a time while replaying, and thrown away.
function parseStream(text) {
  var times = [];
  var bodies = [];
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.length < 13) continue;
    var h = Number(line.slice(0, 2));
    var m = Number(line.slice(3, 5));
    var s = Number(line.slice(6, 8));
    var ms = Number(line.slice(9, 12));
    if (isNaN(h) || isNaN(m) || isNaN(s)) continue;
    times.push(((h * 60 + m) * 60 + s) * 1000 + (isNaN(ms) ? 0 : ms));
    bodies.push(line.slice(12));
  }
  return { times: times, bodies: bodies, cursor: 0 };
}

// Where the stream clock sits in real time. Heartbeat carries both clocks on
// every line, so each one is a reading of the same offset.
//
// Two things stop a single reading from being enough. The offset jitters by
// a second or two either way, and - measured across a full race - the
// recorder's clock FREEZES once the session is finalised while heartbeats
// keep arriving every 15s, so every reading in that tail is wrong by however
// long the recorder kept running (19 minutes on the 2026 Spanish GP). The
// tail is dropped by keeping only readings where the clock is still moving,
// and the median of the rest absorbs the jitter.
function anchorFrom(heartbeat) {
  if (!heartbeat || !heartbeat.times.length) return null;
  var offsets = [];
  var lastClock = -1;
  for (var i = 0; i < heartbeat.times.length; i++) {
    var clock = heartbeat.times[i];
    if (clock <= lastClock) continue; // frozen tail, or a repeated timestamp
    lastClock = clock;
    try {
      var utc = Date.parse(JSON.parse(heartbeat.bodies[i]).Utc);
      if (utc) offsets.push(utc - clock);
    } catch (e) { /* a malformed heartbeat tells us nothing */ }
  }
  if (!offsets.length) return null;
  offsets.sort(function (a, b) { return a - b; });
  var median = offsets[Math.floor(offsets.length / 2)];
  var spread = offsets[offsets.length - 1] - offsets[0];
  if (spread > 30000) {
    // The clocks should stay in step once the frozen tail is gone. If they
    // don't, the anchor is shakier than it looks and timing may sit a little
    // off the video - worth saying so rather than pretending otherwise.
    console.log("[archive] heartbeat offsets spread " + Math.round(spread / 1000) + "s; anchor may be approximate");
  }
  return median;
}

function loadSession(path) {
  if (sessions[path]) return Promise.resolve(sessions[path]);
  if (loading[path]) return loading[path];

  var base = BASE + path;
  var wanted = ["Heartbeat"].concat(TOPICS);
  // One at a time: the archive resets connections when several requests
  // overlap, and this runs once per session.
  var streams = {};
  var chain = wanted.reduce(function (p, topic) {
    return p.then(function () {
      return getWithRetry(base + topic + ".jsonStream").then(function (res) {
        if (res) streams[topic] = parseStream(res.body);
      });
    });
  }, Promise.resolve());

  loading[path] = chain
    .then(function () {
      var anchor = anchorFrom(streams.Heartbeat);
      delete streams.Heartbeat; // only ever needed for the anchor
      if (anchor === null) throw new Error("no usable heartbeat in " + path);
      var lineCount = 0;
      Object.keys(streams).forEach(function (t) { lineCount += streams[t].times.length; });
      var session = {
        path: path,
        anchorMs: anchor,
        streams: streams,
        state: lt.emptyState(),
        appliedTo: -1,
        lineCount: lineCount,
      };
      // A race costs about 50MB held as text, so only the session being
      // watched stays in memory. Moving between sessions re-downloads, which
      // is a few seconds once, rather than stacking sessions up until the TV
      // runs out of room.
      Object.keys(sessions).forEach(function (other) { delete sessions[other]; });
      sessions[path] = session;
      delete loading[path];
      console.log(
        "[archive] loaded " + path + " - " + Object.keys(streams).length + " topics, " +
        lineCount + " lines, stream clock starts " + new Date(anchor).toISOString()
      );
      return session;
    })
    .catch(function (err) {
      delete loading[path];
      throw err;
    });
  return loading[path];
}

// Bring the session's state up to a point on its stream clock. Forward is
// cheap; going back means starting over, since a delta stream can't be
// rewound.
function applyUpTo(session, tStream) {
  if (tStream < session.appliedTo) {
    session.state = lt.emptyState();
    session.appliedTo = -1;
    Object.keys(session.streams).forEach(function (topic) { session.streams[topic].cursor = 0; });
  }
  lt.withState(session.state, function () {
    Object.keys(session.streams).forEach(function (topic) {
      var stream = session.streams[topic];
      while (stream.cursor < stream.times.length && stream.times[stream.cursor] <= tStream) {
        var body = stream.bodies[stream.cursor];
        stream.cursor++;
        var data = null;
        try { data = JSON.parse(body); } catch (e) { continue; }
        lt.__applyTopic(topic, data);
      }
    });
  });
  session.appliedTo = tStream;
}

// The timing tower as it stood at a UTC instant, or null when no archived
// session covers it. `token` is the viewer's F1 TV token (see authToken).
function towerAt(atUtcMs, token) {
  authToken = token || null;
  return findSession(atUtcMs).then(function (found) {
    if (!found) return null;
    return loadSession(found.path).then(function (session) {
      var tStream = atUtcMs - session.anchorMs;
      if (tStream < 0) tStream = 0;
      applyUpTo(session, tStream);
      var tower = lt.withState(session.state, function () { return lt.getTimingTower(); });
      var status = lt.withState(session.state, function () { return session.state.trackStatus; });
      return {
        session: { path: found.path, meeting: found.meeting, name: found.name, type: found.type },
        atUtc: new Date(atUtcMs).toISOString(),
        streamSeconds: Math.round(tStream / 1000),
        // Before the feed's own clock reaches the session, there is nothing
        // to show and that isn't an error - the video simply hasn't got
        // there yet.
        started: tStream > 0,
        trackStatus: status,
        drivers: tower,
      };
    });
  });
}

// --- the track map of a replay -------------------------------------------------
//
// The map wants Position.z, which is about 8MB for a race and is not part of
// the tower's session (see TOPICS), so it is loaded here, only when someone
// opens the map on a replay, and without the tower's 50MB: just Heartbeat (the
// clock anchor), SessionInfo (which circuit) and DriverList (names and colours)
// beside it. Those are small and answer at once, so the app has the outline to
// draw while the stream downloads in the background.
//
// The stream is never decoded whole. Its lines are indexed by their clock and
// the few seconds the app asks for are decoded on demand, so a race costs the
// 8MB of text and nothing more.
//
// Samples come out on the same "virtual" clock as live ones (see
// livetiming.js applyPositionUpdate): F1's stamp plus how late the feed ran,
// here measured from the recording, on the same anchor the tower uses. So on a
// replay the map and the tower agree about when things happened, and the one
// delay setting suits both.

var circuits = require("./circuits");
var poscache = require("./poscache");

var POSITION_FILE = "Position.z.jsonStream";
var POSITION_RETRY_MS = 15000; // after a failed download, before trying again
var LAG_PROBES = 60; // lines read to measure how late the feed ran
var DEFAULT_LAG_MS = 3000; // if none can be read: what a live session measured

var mapSessions = {}; // session path -> record; only the latest is kept
var mapLoading = {};

// A leftover from an earlier session's download goes at start-up.
poscache.prune();

function lowerBound(times, x) {
  var lo = 0, hi = times.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (times[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The lines' samples, decoded: [{t, cars}] (see livetiming.positionItems).
function decodeLine(body) {
  try {
    return lt.positionItems(lt.inflateBase64(JSON.parse(body)));
  } catch (e) {
    return [];
  }
}

// How many ms after a sample's own stamp its line reached the recorder,
// on the anchor's clock: the median over lines spread through the stream.
function measureLag(positions, anchorMs) {
  var lags = [];
  var n = positions.times.length;
  var step = Math.max(1, Math.floor(n / LAG_PROBES));
  for (var k = 0; k < n; k += step) {
    var items = decodeLine(positions.bodies[k]);
    if (!items.length) continue;
    lags.push(positions.times[k] + anchorMs - items[items.length - 1].t);
  }
  if (!lags.length) return DEFAULT_LAG_MS;
  lags.sort(function (a, b) { return a - b; });
  return lags[Math.floor(lags.length / 2)];
}

// Heartbeat, SessionInfo and DriverList: a second or two, and enough to
// anchor the clock, name the circuit and label the cars.
function mapSessionFor(path) {
  if (mapSessions[path]) return Promise.resolve(mapSessions[path]);
  if (mapLoading[path]) return mapLoading[path];
  var base = BASE + path;
  var streams = {};
  var chain = ["Heartbeat", "SessionInfo", "DriverList"].reduce(function (p, topic) {
    return p.then(function () {
      return getWithRetry(base + topic + ".jsonStream").then(function (res) {
        if (res) streams[topic] = parseStream(res.body);
      });
    });
  }, Promise.resolve());
  mapLoading[path] = chain
    .then(function () {
      var anchor = anchorFrom(streams.Heartbeat);
      if (anchor === null) throw new Error("no usable heartbeat in " + path);
      var scratch = lt.emptyState();
      lt.withState(scratch, function () {
        ["SessionInfo", "DriverList"].forEach(function (topic) {
          var stream = streams[topic];
          if (!stream) return;
          stream.bodies.forEach(function (body) {
            try { lt.__applyTopic(topic, JSON.parse(body)); } catch (e) { /* a bad line tells us nothing */ }
          });
        });
      });
      var rec = {
        path: path,
        anchorMs: anchor,
        circuitKey: circuits.keyOf(scratch.sessionInfo),
        drivers: scratch.driverList,
        positions: null,
        lagMs: null,
        phase: "idle", // idle -> loading -> ready | missing | failed
        promise: null,
        error: null,
        failedAt: 0,
      };
      // Only the session being watched stays in memory.
      Object.keys(mapSessions).forEach(function (other) { delete mapSessions[other]; });
      mapSessions[path] = rec;
      delete mapLoading[path];
      return rec;
    })
    .catch(function (err) {
      delete mapLoading[path];
      throw err;
    });
  return mapLoading[path];
}

// The stream itself: from disk if it's there, else downloaded (and kept for
// next time, see poscache.js). Runs in the background; the phase says where it is.
function loadPositions(rec) {
  rec.phase = "loading";
  var cached = poscache.read(rec.path);
  var fetched =
    cached !== null
      ? Promise.resolve(cached)
      : getWithRetry(BASE + rec.path + POSITION_FILE).then(function (res) {
          if (!res) return null;
          poscache.write(rec.path, res.body);
          return res.body;
        });
  rec.promise = fetched
    .then(function (text) {
      if (text === null) {
        // F1 recorded no positions for this session (some support races, early sessions).
        rec.phase = "missing";
        return;
      }
      rec.positions = parseStream(text);
      rec.lagMs = measureLag(rec.positions, rec.anchorMs);
      rec.phase = "ready";
      console.log(
        "[archive] positions for " + rec.path + " - " + rec.positions.times.length + " lines, feed ran " +
        Math.round(rec.lagMs) + "ms late" + (cached !== null ? " (from disk)" : "")
      );
    })
    .catch(function (err) {
      rec.phase = "failed";
      rec.error = String((err && err.message) || err);
      rec.failedAt = Date.now();
      rec.promise = null;
    });
}

// Every car's samples with a virtual stamp in [fromV, toV], as [stamp, x, y].
function windowSamples(rec, fromV, toV) {
  var P = rec.positions;
  // A line reaches us at U = its clock + the anchor, and the samples in it
  // sit on the virtual clock up to a second or so before U.
  var lo = lowerBound(P.times, fromV - rec.anchorMs - 500);
  var byCar = {};
  for (var k = lo; k < P.times.length && P.times[k] + rec.anchorMs <= toV + 2500; k++) {
    decodeLine(P.bodies[k]).forEach(function (item) {
      var v = Math.round(item.t + rec.lagMs);
      if (v < fromV || v > toV) return;
      item.cars.forEach(function (c) {
        (byCar[c.num] = byCar[c.num] || []).push([v, c.x, c.y]);
      });
    });
  }
  return Object.keys(byCar).map(function (num) {
    var info = rec.drivers[num] || {};
    var samples = byCar[num].sort(function (a, b) { return a[0] - b[0]; });
    return { racingNumber: num, tla: info.Tla, teamColour: info.TeamColour, samples: samples };
  });
}

// The map's answer for a replay: which circuit (and its outline, once), and the
// cars' samples between two instants on the picture's clock. `atUtcMs` only
// picks the session. Null when no archived session covers it. While the stream
// is still coming down, `phase` is "loading" and there are no samples yet.
function trackMapAt(atUtcMs, fromV, toV, haveCircuit, token) {
  authToken = token || null;
  return findSession(atUtcMs).then(function (found) {
    if (!found) return null;
    return mapSessionFor(found.path).then(function (rec) {
      if (rec.phase === "failed" && Date.now() - rec.failedAt > POSITION_RETRY_MS) rec.phase = "idle";
      if (rec.phase === "idle") loadPositions(rec);
      var res = {
        session: { path: found.path, meeting: found.meeting, name: found.name, type: found.type },
        circuitKey: rec.circuitKey,
        hasOutline: !!circuits.forKey(rec.circuitKey),
        phase: rec.phase,
        drivers: rec.phase === "ready" ? windowSamples(rec, fromV, toV) : [],
      };
      var outline = circuits.outlineFor(rec.circuitKey, haveCircuit);
      if (outline) res.outline = outline;
      if (rec.phase === "failed") res.errorText = rec.error;
      return res;
    });
  });
}

module.exports = {
  findSession: findSession,
  loadSession: loadSession,
  towerAt: towerAt,
  trackMapAt: trackMapAt,
};
