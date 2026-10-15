// Timing for sessions that already happened.
//
// The live SignalR feed (livetiming.js) only ever describes the session
// happening right now, so watching a replay used to show whatever the last
// session left behind - last week's finishing order over this week's race.
// This module answers the different question a replay asks: what did the
// timing look like at this exact moment?
//
// F1 archives every session's raw feed on the same host the live connection
// uses, unauthenticated, one file per topic:
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
// opened. The map stays live-only until that's worth solving separately.
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

function get(path) {
  return new Promise(function (resolve, reject) {
    var req = https.get(
      { host: HOST, path: path, headers: { "User-Agent": USER_AGENT }, timeout: REQUEST_TIMEOUT_MS },
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
// session covers it.
function towerAt(atUtcMs) {
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

module.exports = {
  findSession: findSession,
  loadSession: loadSession,
  towerAt: towerAt,
};
