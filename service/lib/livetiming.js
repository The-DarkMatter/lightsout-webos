// F1 live timing client (SignalR Core). Feeds the timing tower and track
// map overlays. See plan doc + inline notes below for what's confirmed vs
// still a guess.
//
// CONFIRMED (tested directly against the live endpoint):
//   - No F1 account auth needed just to negotiate/connect/subscribe -
//     earlier research assumed auth was required post the SignalR-core
//     migration; a plain unauthenticated negotiate+connect+subscribe
//     worked fine. FastF1's own client (github.com/theOehrly/Fast-F1,
//     fastf1/livetiming/client.py) explicitly supports a no_auth mode too,
//     but warns it "may only work for some sessions or may only return
//     empty or partial data" when authenticated - worth revisiting if a
//     real live session comes back suspiciously thin.
//   - This is the modern ASP.NET Core SignalR wire protocol, NOT classic
//     SignalR - a first attempt using the classic {H,M,A,I} hub-invocation
//     shape (from older blog posts/gists) got an immediate server-side
//     "Connection closed with an error" (SignalR CloseMessage, type 7).
//     The core protocol's Invocation shape ({type:1, target, arguments})
//     fixed it immediately - connection stayed open cleanly afterward.
//     Endpoint (wss://livetiming.formula1.com/signalrcore) matches
//     FastF1's client exactly.
//   - negotiate (POST, no body) returns {connectionToken, ...} and
//     Set-Cookie: AWSALB/AWSALBCORS, which must be replayed as a Cookie
//     header on the websocket upgrade (ALB stickiness - the connectionToken
//     is only valid on the backend node that issued it).
//   - The JSON protocol frames are newline-record-separated: each frame is
//     JSON text followed by \x1e (record separator), not plain newlines.
//   - Handshake: send {"protocol":"json","version":1}+RS immediately after
//     open; server replies "{}"+RS on success.
//   - Pushed updates arrive as target "feed" with [topicName, data,
//     timestamp] arguments - confirmed against FastF1's client, which
//     registers `self._connection.on("feed", self._on_message)` and
//     receives exactly that 3-element list shape.
//   - Every per-topic data shape assumed in applyTopic() below (TimingData,
//     DriverList, CarData.z/Position.z after inflating, TrackStatus,
//     WeatherData, RaceControlMessages) is confirmed correct against a real
//     recorded session, not just community docs: see
//     scripts/replay-test.js, which runs F1's own public static session
//     archive (livetiming.formula1.com/static/<session>/<Topic>.jsonStream
//     - the same per-topic files this reducer would build state from live)
//     through this exact reducer. One real bug this caught: TimingData's
//     GapToLeader/IntervalToPositionAhead only exist in Race sessions -
//     Practice/Quali use TimeDiffToFastest/TimeDiffToPositionAhead instead
//     (plain strings, not {Value}-wrapped) - getTimingTower() now falls
//     back to those.
//   - Subscribe's response is a SignalR Completion message (type 3), not a
//     "feed" push - it carries one full initial snapshot per topic in
//     msg.result, the live equivalent of the static archive's per-topic
//     keyframe file. This requires the Subscribe invocation to actually
//     carry an invocationId (FastF1's client sends one via
//     `on_invocation=self._on_message` specifically to receive this).
//     Previously missing entirely: Subscribe had no invocationId and
//     type:3 fell into unrecognizedMessageCount, so every topic would only
//     ever see incremental deltas with no baseline - indistinguishable
//     from "no session live" from the overlay's point of view even on a
//     fully live, correctly-connected session.
//
// UNCONFIRMED (no live session to check against yet):
//   - Whether a keepalive ping is required to avoid an idle timeout during
//     a long, mostly-quiet stretch - sending one every 15s regardless,
//     cheap insurance.
//   - Whether the account-auth caveat above (empty/partial data on some
//     sessions without it) actually bites in practice.

var https = require("https");
var WebSocket = require("ws"); // vendored in node_modules/ws - pure JS, zero deps, Node >=10
var zlib = require("zlib");

var HOST = "livetiming.formula1.com";
var RS = String.fromCharCode(0x1e);

var TOPICS = [
  "Heartbeat", "CarData.z", "Position.z", "ExtrapolatedClock", "TopThree",
  "RcmSeries", "TimingStats", "TimingAppData", "WeatherData", "TrackStatus",
  "DriverList", "RaceControlMessages", "SessionInfo", "SessionData",
  "LapCount", "TimingData",
];

// --- state -------------------------------------------------------------
// Everything the overlays read. Rebuilt incrementally as patches arrive;
// never replaced wholesale (a fresh connection re-subscribes but keeps
// accumulated position trails so the track shape doesn't reset).
function emptyState() {
  return {
  connected: false,
  lastMessageAt: null,
  sessionInfo: null,
  trackStatus: null,
  weatherData: null,
  lapCount: null,
  driverList: {}, // racingNumber -> {tla, teamName, teamColour, ...}
  timingData: {}, // racingNumber -> {position, gapToLeader, interval, ...}
  timingAppData: {}, // racingNumber -> {Stints: [...]} - tyre compound/age history
  carData: {}, // racingNumber -> {rpm, speed, gear, throttle, brake}
  positionTrail: {}, // racingNumber -> [{x,y}, ...] capped ring buffer
  raceControlMessages: [],
  // Diagnostics: the topic/argument shape below is a guess (see file
  // header). If it's wrong, everything above silently stays empty with no
  // sign of why. Tracking raw arrivals separately means a real session can
  // immediately show "messages ARE arriving, they're just not shaped how
  // applyTopic expects" instead of an ambiguous "nothing happened" - the
  // same class of mistake the captions API rename bug was, caught by
  // instrumenting instead of re-guessing.
  rawMessageCount: 0,
  topicCounts: {}, // topic name -> count, so we can see what's actually flowing
  lastRawMessage: null, // one full example, truncated, for inspection
  unrecognizedMessageCount: 0, // messages that didn't match the type:1/target:"feed" shape at all
  };
}

var state = emptyState();

// Replaying an archived session (lib/archive.js) needs this same reducer but
// its own state, so a replay can't disturb - or be disturbed by - a live
// connection running at the same time. Swapping the module's state around a
// synchronous block is enough: nothing here yields part-way through.
function withState(other, fn) {
  var live = state;
  state = other;
  try {
    return fn();
  } finally {
    state = live;
  }
}

var ws = null;
var pingTimer = null;
var reconnectTimer = null;
var running = false;
var authToken = null; // F1TV login token, tried as the SignalR auth token - see negotiate()'s comment

function deepMerge(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  // F1's incremental patches sometimes replace an array-valued field (e.g.
  // TimingAppData's Stints, TimingData's Sectors - both arrays in the
  // initial keyframe) with a plain object keyed by numeric index for later
  // per-element updates. Confirmed against a real archived session: the
  // keyframe has Stints:[...] but a later patch is Stints:{"1":{...}}.
  // Treating that as a generic object merge (the old behaviour) would wipe
  // the whole array and replace it with a plain object, losing every
  // earlier stint/sector. Detect this shape and patch the array by index
  // in place instead.
  if (Array.isArray(target) && Object.keys(patch).every(function (k) { return /^\d+$/.test(k); })) {
    Object.keys(patch).forEach(function (key) {
      var idx = Number(key);
      target[idx] = deepMerge(target[idx], patch[key]);
    });
    return target;
  }
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    target = {};
  }
  Object.keys(patch).forEach(function (key) {
    target[key] = deepMerge(target[key], patch[key]);
  });
  return target;
}

// Drops any key that isn't a plain racing number (e.g. "1", "44") before
// merging into a driver-keyed state map - see the DriverList case in
// applyTopic() for why this exists.
function onlyNumericKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  var out = {};
  Object.keys(obj).forEach(function (k) {
    if (/^\d+$/.test(k)) out[k] = obj[k];
  });
  return out;
}

function inflateBase64(b64) {
  try {
    return JSON.parse(zlib.inflateRawSync(Buffer.from(b64, "base64")).toString("utf8"));
  } catch (e) {
    console.error("[livetiming] inflate failed:", e && e.message);
    return null;
  }
}

var MAX_TRAIL_POINTS = 2000; // per driver - enough for a full-lap outline without unbounded growth

function applyPositionUpdate(data) {
  // Best-guess shape: {Position: [{Timestamp, Entries: {racingNumber: {X,Y,Status}}}]}
  var entries = data && data.Position && data.Position[0] && data.Position[0].Entries;
  if (!entries) return;
  Object.keys(entries).forEach(function (num) {
    var e = entries[num];
    if (typeof e.X !== "number" || typeof e.Y !== "number") return;
    if (!state.positionTrail[num]) state.positionTrail[num] = [];
    var trail = state.positionTrail[num];
    trail.push({ x: e.X, y: e.Y });
    if (trail.length > MAX_TRAIL_POINTS) trail.shift();
  });
}

function applyCarDataUpdate(data) {
  // Shape confirmed against a real recorded session (scripts/replay-test.js):
  // {Entries: [{Utc, Cars: {racingNumber: {Channels: {"0":rpm,"2":speed,"3":gear,"4":throttle,"5":brake}}}}]}.
  // Channel "45" (DRS, per some community write-ups) never actually
  // appeared in that real data - only 0/2/3/4/5 were present - so a drs
  // field isn't exposed at all rather than silently reading undefined as
  // "DRS off". Revisit once a real session's data is checked for whichever
  // channel DRS actually lives under, if any.
  var entry = data && data.Entries && data.Entries[0];
  if (!entry || !entry.Cars) return;
  Object.keys(entry.Cars).forEach(function (num) {
    var ch = entry.Cars[num] && entry.Cars[num].Channels;
    if (!ch) return;
    state.carData[num] = {
      rpm: ch["0"], speed: ch["2"], gear: ch["3"],
      throttle: ch["4"], brake: ch["5"],
    };
  });
}

function applyTopic(topic, data) {
  switch (topic) {
    case "Position.z":
      applyPositionUpdate(inflateBase64(data));
      return;
    case "CarData.z":
      applyCarDataUpdate(inflateBase64(data));
      return;
    case "DriverList":
      // A real live session (not the archive, which is already
      // pre-cleaned) showed a stray "_kf" entry appear in driverList,
      // inflating driverCount and rendering a bogus row - almost certainly
      // some metadata field sitting alongside the real per-driver keys in
      // whatever wrapper the live feed uses (unconfirmed exactly which,
      // since there's no way to inspect the raw live frame directly - see
      // file header). Rather than guess the wrapper shape, defensively
      // drop any key that isn't a plain racing number before merging, here
      // and in every getter that enumerates these maps.
      state.driverList = deepMerge(state.driverList, onlyNumericKeys(data));
      return;
    case "TimingData":
      state.timingData = deepMerge(state.timingData, onlyNumericKeys(data && data.Lines ? data.Lines : data));
      return;
    case "TimingAppData":
      // Carries per-driver tyre stint history (compound, age, whether the
      // set is new) - shape confirmed against a real recorded session:
      // {Lines: {racingNumber: {Stints: [{Compound, New, TotalLaps,
      // StartLaps, ...}, ...]}}}. Needs the deepMerge array-patch fix above
      // (Stints starts as an array but later patches arrive as a
      // numeric-keyed object) to accumulate correctly instead of losing
      // earlier stints on every update.
      state.timingAppData = deepMerge(state.timingAppData, onlyNumericKeys(data && data.Lines ? data.Lines : data));
      return;
    case "SessionInfo":
      state.sessionInfo = deepMerge(state.sessionInfo, data);
      return;
    case "TrackStatus":
      state.trackStatus = deepMerge(state.trackStatus, data);
      return;
    case "WeatherData":
      state.weatherData = deepMerge(state.weatherData, data);
      return;
    case "LapCount":
      state.lapCount = deepMerge(state.lapCount, data);
      return;
    case "RaceControlMessages":
      var msgs = data && data.Messages;
      if (msgs) {
        var list = Array.isArray(msgs) ? msgs : Object.keys(msgs).map(function (k) { return msgs[k]; });
        state.raceControlMessages = list.concat(state.raceControlMessages).slice(0, 50);
      }
      return;
    case "Heartbeat":
      return; // just proves the connection is alive, no state to keep
    default:
      return; // topics we subscribed to but don't render yet
  }
}

function negotiate() {
  return new Promise(function (resolve, reject) {
    var headers = { "Content-Length": 0 };
    // Position.z/CarData.z (car telemetry) came back completely absent -
    // topicCounts stayed at 0 for both - during a real live session, while
    // basic classification topics (TimingData/DriverList) worked fine.
    // FastF1's own client (github.com/theOehrly/Fast-F1) explicitly warns
    // an unauthenticated connection "may only return empty or partial
    // data" - exactly this symptom. Trying the F1TV login token we already
    // have for PLAY/DRM as the SignalR auth token, since it's the same F1
    // account system - UNCONFIRMED whether this specific token is what the
    // live-timing endpoint actually expects, so this needs a real retest.
    if (authToken) headers["Authorization"] = "Bearer " + authToken;
    var req = https.request(
      { host: HOST, path: "/signalrcore/negotiate?negotiateVersion=1", method: "POST", headers: headers },
      function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          try {
            var body = JSON.parse(Buffer.concat(chunks).toString());
            var cookies = (res.headers["set-cookie"] || []).map(function (c) { return c.split(";")[0]; }).join("; ");
            resolve({ token: body.connectionToken, cookies: cookies });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (running) connect();
  }, 5000);
}

function connect() {
  negotiate()
    .then(function (neg) {
      var url = "wss://" + HOST + "/signalrcore?id=" + neg.token + (authToken ? "&access_token=" + encodeURIComponent(authToken) : "");
      var wsHeaders = { Cookie: neg.cookies, "User-Agent": "Mozilla/5.0" };
      if (authToken) wsHeaders["Authorization"] = "Bearer " + authToken;
      ws = new WebSocket(url, { headers: wsHeaders });

      ws.on("open", function () {
        ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      });

      var handshakeDone = false;

      ws.on("message", function (raw) {
        state.lastMessageAt = Date.now();
        var text = raw.toString();
        text.split(RS).filter(Boolean).forEach(function (chunk) {
          var msg;
          try { msg = JSON.parse(chunk); } catch (e) { return; }

          if (!handshakeDone) {
            handshakeDone = true;
            state.connected = true;
            console.log("[livetiming] handshake ok, subscribing to", TOPICS.length, "topics");
            // invocationId is required to get a Completion (type 3) message
            // back for this call - see the type===3 handling below for why
            // that matters. Any string is fine; nothing else is in flight
            // to confuse it with.
            ws.send(JSON.stringify({ type: 1, target: "Subscribe", arguments: [TOPICS], invocationId: "0" }) + RS);
            pingTimer = setInterval(function () {
              if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 6 }) + RS);
            }, 15000);
            return;
          }

          state.rawMessageCount++;
          state.lastRawMessage = chunk.length > 500 ? chunk.slice(0, 500) + "…" : chunk;

          if (msg.type === 1 && msg.target === "feed" && Array.isArray(msg.arguments)) {
            var topicName = msg.arguments[0];
            state.topicCounts[topicName] = (state.topicCounts[topicName] || 0) + 1;
            applyTopic(topicName, msg.arguments[1]);
          } else if (msg.type === 3) {
            // Completion of our Subscribe call - carries one full initial
            // snapshot per topic in msg.result (e.g. {DriverList: {...},
            // TimingData: {...}, ...}), the live equivalent of the static
            // archive's per-topic "keyframe" file. Confirmed against
            // FastF1's SignalR-core client (github.com/theOehrly/Fast-F1,
            // fastf1/livetiming/client.py), which registers exactly this
            // completion callback on its own Subscribe call for exactly
            // this reason. Previously this branch didn't exist at all -
            // type:3 fell into unrecognizedMessageCount - so every topic
            // would only ever see incremental deltas with no baseline,
            // which could look identical to "no session live" from the
            // overlay's point of view even on a fully live connection.
            if (msg.result && typeof msg.result === "object") {
              Object.keys(msg.result).forEach(function (topicName) {
                state.topicCounts[topicName] = (state.topicCounts[topicName] || 0) + 1;
                applyTopic(topicName, msg.result[topicName]);
              });
            }
          } else if (msg.type === 6) {
            // server ping, no action needed
          } else if (msg.type === 7) {
            console.error("[livetiming] server closed:", msg.error);
          } else {
            state.unrecognizedMessageCount++;
          }
        });
      });

      ws.on("error", function (err) {
        console.error("[livetiming] ws error:", err && err.message);
      });

      ws.on("close", function () {
        state.connected = false;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        scheduleReconnect();
      });
    })
    .catch(function (err) {
      console.error("[livetiming] negotiate failed:", err && err.message);
      scheduleReconnect();
    });
}

function start(token) {
  if (running) return;
  authToken = token || null;
  running = true;
  connect();
}

function stop() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
  state.connected = false;
}

// Trimmed view for the app - the full positionTrail/carData objects can
// get large over a session, so callers ask for just what they need.
function getSummary() {
  return {
    connected: state.connected,
    lastMessageAt: state.lastMessageAt,
    sessionInfo: state.sessionInfo,
    trackStatus: state.trackStatus,
    weatherData: state.weatherData,
    lapCount: state.lapCount,
    driverCount: Object.keys(state.driverList).length,
    raceControlMessages: state.raceControlMessages.slice(0, 10),
    // See the state.rawMessageCount comment: these let a real test tell
    // "nothing arrived at all" (rawMessageCount stays 0 - check F1 has a
    // session live, not just F2/F3) apart from "things arrived but didn't
    // parse the way applyTopic expects" (rawMessageCount grows,
    // driverCount/timingData stay empty) apart from "topics are arriving
    // but under a different name than we subscribed" (topicCounts shows
    // what's actually being received).
    rawMessageCount: state.rawMessageCount,
    topicCounts: state.topicCounts,
    lastRawMessage: state.lastRawMessage,
    unrecognizedMessageCount: state.unrecognizedMessageCount,
  };
}

function getTimingTower() {
  var drivers = Object.keys(state.driverList).map(function (num) {
    var info = state.driverList[num] || {};
    var timing = state.timingData[num] || {};
    return {
      racingNumber: num,
      tla: info.Tla,
      teamName: info.TeamName,
      teamColour: info.TeamColour,
      position: timing.Position,
      // GapToLeader/IntervalToPositionAhead only exist in Race sessions -
      // confirmed against a real recorded Practice session (via
      // scripts/replay-test.js) that they're absent there entirely, and
      // Practice/Quali instead carry TimeDiffToFastest/
      // TimeDiffToPositionAhead as plain strings (not {Value}-wrapped).
      // Previously this only read the race-only fields, so gap/interval
      // silently stayed blank for every non-Race session.
      gapToLeader: timing.GapToLeader || timing.TimeDiffToFastest || "",
      interval:
        (timing.IntervalToPositionAhead && timing.IntervalToPositionAhead.Value) ||
        timing.TimeDiffToPositionAhead ||
        "",
      lastLapTime: timing.LastLapTime && timing.LastLapTime.Value,
      // Full objects (not just the value string) so the app can colour
      // purple/green for overall/personal fastest, matching what F1's own
      // broadcast graphics do - confirmed present on real data.
      lastLap: timing.LastLapTime,
      bestLap: timing.BestLapTime,
      sectors: normalizeSectors(timing.Sectors),
      speeds: timing.Speeds,
      numberOfLaps: timing.NumberOfLaps,
      inPit: timing.InPit,
      retired: timing.Retired,
      tyre: currentTyre(state.timingAppData[num]),
      // rpm/speed/gear/throttle/brake - see applyCarDataUpdate's comment on
      // why there's no drs field here.
      telemetry: state.carData[num] || null,
    };
  });
  drivers.sort(function (a, b) { return (Number(a.position) || 99) - (Number(b.position) || 99); });
  return drivers;
}

// Sectors starts as an array in the initial keyframe (see deepMerge's
// array-patch handling) and should stay one - this just also copies each
// sector's Segments (an object keyed by numeric string, e.g. {"0":{Status},
// "1":{Status}}, confirmed against real data) into an ordered array so the
// app can render a left-to-right mini-sector bar without re-sorting keys
// itself.
function normalizeSectors(sectors) {
  if (!Array.isArray(sectors)) return [];
  return sectors.map(function (s) {
    if (!s) return null;
    var segmentKeys = s.Segments ? Object.keys(s.Segments).sort(function (a, b) { return Number(a) - Number(b); }) : [];
    return {
      value: s.Value,
      personalFastest: s.PersonalFastest,
      overallFastest: s.OverallFastest,
      segments: segmentKeys.map(function (k) { return s.Segments[k].Status; }),
    };
  });
}

// Current tyre = the most recent stint in TimingAppData's Stints history.
// age is StartLaps (laps already on the tyre when this stint's most recent
// update was recorded) + how many laps have passed in this stint per
// TotalLaps - TimingAppData reports TotalLaps as the stint's own running
// lap count already, so that alone is the tyre's current age. Confirmed
// against a real recorded session (scripts/replay-test.js).
function currentTyre(appData) {
  var stints = appData && appData.Stints;
  if (!Array.isArray(stints) || !stints.length) return null;
  var last = stints[stints.length - 1];
  if (!last) return null;
  return { compound: last.Compound, age: last.TotalLaps, isNew: last.New === "true" || last.New === true };
}

function getTrackMap() {
  var drivers = Object.keys(state.positionTrail).map(function (num) {
    var trail = state.positionTrail[num];
    var latest = trail[trail.length - 1];
    var info = state.driverList[num] || {};
    return {
      racingNumber: num,
      tla: info.Tla,
      teamColour: info.TeamColour,
      x: latest ? latest.x : null,
      y: latest ? latest.y : null,
      // Each driver's OWN trail, in order - a real live session showed why
      // this needs to stay separate per driver rather than concatenated:
      // one flat array of every car's points back-to-back, rendered as a
      // single connected polyline, draws a spurious line from the last
      // point of one car's trail to the first point of the next car's -
      // a "wireframe" of nonsense diagonals across the whole map. The app
      // now draws one polyline per driver using this instead.
      trail: trail,
    };
  });
  // Flat merged points too, but ONLY for bounds/auto-fit computation on the
  // app side (min/max don't care about point order or which car a point
  // came from) - never render this one as a connected line, for the same
  // reason as above.
  var allPoints = [];
  Object.keys(state.positionTrail).forEach(function (num) {
    allPoints = allPoints.concat(state.positionTrail[num]);
  });
  return { drivers: drivers, trail: allPoints };
}

module.exports = {
  start: start,
  stop: stop,
  isRunning: function () { return running; },
  getSummary: getSummary,
  getTimingTower: getTimingTower,
  getTrackMap: getTrackMap,
  // Exposed for scripts/replay-test.js only: runs a real recorded session's
  // per-topic archive files through the exact same reducer live data uses,
  // so the parsing logic (previously pure guesswork - see file header) can
  // be checked against real F1 data offline instead of waiting on a live
  // session and hoping the shapes were right.
  __applyTopic: applyTopic,
  __getState: function () { return state; },
  // For lib/archive.js: a private state to replay an archive into, and the
  // reducer/getters bound to it.
  emptyState: emptyState,
  withState: withState,
};
