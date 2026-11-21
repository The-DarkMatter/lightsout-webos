// Canned answers for every service method, so pages can be laid out and
// clicked through on a PC with no TV and no F1 TV sign-in:
//
//   node scripts/dev-server.js --mock
//
// The dev server injects this file ahead of js/luna.js, whose callService()
// then answers from here instead of the service. It lives outside app/, so
// it never ships in the package.
//
// Preview switches, as page query parameters:
//   ?auth=expiring|expired|none   sign-in states
//   ?root=0                       a TV without Homebrew Channel
//   ?tvb=1                        the TV-browser import already allowed
//   ?fail=<reason>                Browse and the player fail as F1 TV would:
//                                 signin, subscription, region, unavailable,
//                                 network, changed - or player, a feed that
//                                 won't load
//
// Video still needs a real, reachable manifest - the f1tvPlayTest mock below
// points at a public, unencrypted, CORS-friendly HLS test stream (Shaka
// Player's own demo asset) so Shaka has something real to load.

// A real, playable manifest is one specific file on Shaka's public demo bucket -
// there's no way to locally fake 20 different playable feeds. Each mock
// feed below points at that same file but carries a URL fragment (the
// "#..." part, never sent to the server, so it doesn't affect what actually
// loads), so every entry in the camera picker actually plays. Feed names
// don't come from URLs any more (F1's are opaque hashes as of 2026): the
// MOCK_STREAMS below mirror the per-feed details the service returns from
// CONTENT/VIDEO, using real entries from the 2026 Spanish GP race.
// Was Mux's test-streams.mux.dev asset until that hostname stopped
// resolving (September 2026). This one has 576p/480p/360p/240p renditions,
// which also makes it useful for exercising resolution caps locally.
var REAL_STREAM = "https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8";
function fakeFeedUrl(path) {
  return REAL_STREAM + "#/pa_test/hajvk2fd2vxr/out/v1/" + path + "/SDR-HD-CMAF-WV/index.m3u8";
}

var MOCK_PLAY_RESPONSE = {
  returnValue: true,
  result: {
    play: {
      statusCode: 200,
      body: {
        resultObj: {
          streamType: "HLS",
          channelId: 1025,
          tme: {
            // Deliberately NOT in "sensible" order - Presentation (the
            // paddock/pre-show feed) really does come before the World Feed
            // in F1TV's own response, per a real captured FP3 PLAY. This is
            // exactly the case the WIF-preferring default-pick logic in
            // watch.js exists to handle.
            feeds: [
              { metadata: { channel_id: 1033 }, url: fakeFeedUrl("Main/Presentation-R1") },
              { metadata: { channel_id: 1025 }, url: fakeFeedUrl("Main/WIF-F1-R1") },
              { metadata: { channel_id: 1003 }, url: fakeFeedUrl("Support/Driver-R1") },
              { metadata: { channel_id: 1004 }, url: fakeFeedUrl("Support/Data-R1") },
              { metadata: { channel_id: 1016, racing_number: 1 }, url: fakeFeedUrl("OBC/Car12-R1") },
              { metadata: { channel_id: 1007, racing_number: 44 }, url: fakeFeedUrl("OBC/Car03-R1") },
              { metadata: { channel_id: 1008, racing_number: 16 }, url: fakeFeedUrl("OBC/Car04-R1") },
              { metadata: { channel_id: 1015, racing_number: 81 }, url: fakeFeedUrl("OBC/Car11-R1") },
            ],
          },
        },
      },
    },
  },
};

// The service's `streams` for the feeds above (see streamsFromContent in
// service/index.js).
var MOCK_STREAMS = [
  { channelId: 1033, identifier: "PRES", type: "additional", title: "F1 LIVE", racingNumber: 0 },
  { channelId: 1025, identifier: "WIF", type: "additional", title: "INTERNATIONAL", racingNumber: 0,
    audioTrackNames: { eng: "English Int.", deu: "Deutsch", fra: "Francais", fx: "Track FX" } },
  { channelId: 1003, identifier: "TRACKER", type: "additional", title: "TRACKER", racingNumber: 0 },
  { channelId: 1004, identifier: "DATA", type: "additional", title: "DATA", racingNumber: 0 },
  { channelId: 1016, identifier: "OBC", type: "obc", title: "NOR", racingNumber: 1, firstName: "Lando", lastName: "Norris", team: "McLaren", color: "#FF8000" },
  { channelId: 1007, identifier: "OBC", type: "obc", title: "HAM", racingNumber: 44, firstName: "Lewis", lastName: "Hamilton", team: "Ferrari", color: "#E8002D" },
  { channelId: 1008, identifier: "OBC", type: "obc", title: "LEC", racingNumber: 16, firstName: "Charles", lastName: "Leclerc", team: "Ferrari", color: "#E8002D" },
  { channelId: 1015, identifier: "OBC", type: "obc", title: "PIA", racingNumber: 81, firstName: "Oscar", lastName: "Piastri", team: "McLaren", color: "#FF8000" },
];
MOCK_PLAY_RESPONSE.result.streams = MOCK_STREAMS;

function mockDriver(num, position, tla, colour, gap, opts) {
  opts = opts || {};
  return {
    racingNumber: String(num), position: position, tla: tla, teamColour: colour, gapToLeader: gap, inPit: false,
    lastLap: { Value: opts.lastLap || "1:23.456", PersonalFastest: !!opts.personalFastest, OverallFastest: !!opts.overallFastest },
    tyre: { compound: opts.compound || "SOFT", age: opts.age != null ? opts.age : 5, isNew: !!opts.isNew },
    telemetry: { rpm: 11000, speed: opts.speed || 310, gear: 7, throttle: 100, brake: 0 },
    sectors: [
      { value: "28.123", personalFastest: false, overallFastest: false, segments: [2049, 2048, 2049, 2048, 2064] },
      { value: "31.456", personalFastest: true, overallFastest: false, segments: [2048, 2049, 2049, 2049, 2048] },
      { value: "24.789", personalFastest: false, overallFastest: true, segments: [2051, 2051, 2048, 2049, 2048] },
    ],
  };
}

var MOCK_TOWER = [
  mockDriver(1, 1, "VER", "3671C6", "Leader", { lastLap: "1:22.167", overallFastest: true, compound: "SOFT", age: 4 }),
  mockDriver(44, 2, "HAM", "27F4D2", "+2.341", { lastLap: "1:23.242", personalFastest: true, compound: "MEDIUM", age: 12 }),
  mockDriver(16, 3, "LEC", "E8002D", "+5.887", { lastLap: "1:24.981", compound: "HARD", age: 20, isNew: false }),
];

// The track map as the service now answers it: an outline, and each car's
// timestamped samples. The "circuit" is a lumpy ellipse (units are tenths of
// a metre, like the real feed) and the cars lap it in 40s at four samples a
// second. As on a live session, a sample reaches the app about 3s after its
// own timestamp, so the map has to line them up by stamp to look right.
// ?nooutline=1 answers like a circuit F1 has no lap for.
var MOCK_LAP_MS = 40000;
var MOCK_SAMPLE_MS = 250;
var MOCK_ARRIVAL_LAG_MS = 3000;

function mockPoint(u) {
  var a = u * Math.PI * 2;
  var r = 1 + 0.12 * Math.sin(3 * a);
  return { x: Math.round(Math.cos(a) * 1800 * r), y: Math.round(Math.sin(a) * 900 * r) };
}

function mockTrackMap(since, haveCircuit) {
  var withOutline = !new URLSearchParams(window.location.search).get("nooutline");
  var newest = Math.floor((Date.now() - MOCK_ARRIVAL_LAG_MS) / MOCK_SAMPLE_MS) * MOCK_SAMPLE_MS;
  var from = since > 0 ? since : newest - 90000;
  var drivers = MOCK_TOWER.map(function (d, i) {
    var samples = [];
    for (var t = Math.floor(from / MOCK_SAMPLE_MS) * MOCK_SAMPLE_MS + MOCK_SAMPLE_MS; t <= newest; t += MOCK_SAMPLE_MS) {
      var p = mockPoint(((t / MOCK_LAP_MS) + i * 0.07) % 1);
      samples.push([t, p.x, p.y]);
    }
    return { racingNumber: String(d.racingNumber), tla: d.tla, teamColour: d.teamColour, samples: samples };
  });
  var res = { circuitKey: withOutline ? "0" : null, hasOutline: withOutline, newest: newest, drivers: drivers };
  if (withOutline && haveCircuit !== "0") {
    var x = [], y = [];
    for (var k = 0; k < 360; k++) {
      var q = mockPoint(k / 360);
      x.push(q.x);
      y.push(q.y);
    }
    res.outline = { x: x, y: y, short: "Mock", year: 2026 };
  }
  return res;
}

// ?tvb=1 previews the TV-browser import already allowed.
var mockTvBrowserImport = new URLSearchParams(window.location.search).get("tvb") === "1";

var MOCKS = {
  // Browse page and season list: dev/mock-browse.js, injected before this file.
  f1tvPage: function () {
    return typeof MOCK_BROWSE_PAGE !== "undefined" ? MOCK_BROWSE_PAGE : { returnValue: false, errorText: "no offline page data on this screen" };
  },
  // Missing years come back empty.
  f1tvSeason: function (p) {
    var year = p && p.season;
    return (typeof MOCK_SEASONS !== "undefined" && MOCK_SEASONS[year]) || { returnValue: true, season: year, meetings: [] };
  },
  // ?auth=expiring|expired|none previews the sign-in states locally.
  getAuthStatus: function () {
    var mode = new URLSearchParams(window.location.search).get("auth");
    var hours = mode === "expiring" ? 5 : mode === "expired" ? -2 : 60;
    return {
      returnValue: true,
      hasToken: mode !== "none" && hours > 0,
      expired: mode === "expired",
      expiresAt: mode === "none" ? null : new Date(Date.now() + hours * 3600000).toISOString(),
      hoursLeft: Math.max(0, hours),
      expiringSoon: hours > 0 && hours < 24,
      source: "phone",
      // ?root=0 previews a TV without Homebrew Channel.
      tvBrowserImport: { available: new URLSearchParams(window.location.search).get("root") !== "0", enabled: mockTvBrowserImport },
    };
  },
  setTvBrowserImport: function (p) {
    mockTvBrowserImport = !!(p && p.enabled);
    return MOCKS.getAuthStatus();
  },
  getSetupInfo: function () {
    return { returnValue: true, lanAddress: "127.0.0.1", setupUrl: "http://127.0.0.1:8787/setup", port: 8787, pairingCode: "482913", hasToken: true, tokenExpiresAt: null };
  },
  f1tvPlayTest: function () { return MOCK_PLAY_RESPONSE; },
  liveTimingStart: function () { return { returnValue: true }; },
  liveTimingStop: function () { return { returnValue: true }; },
  liveTimingSummary: function () {
    return {
      returnValue: true,
      running: true,
      connected: true,
      rawMessageCount: 1,
      driverCount: MOCK_TOWER.length,
      // Real circuit name from an actual captured session. Nothing on the
      // map reads this any more (the pre-drawn outline backdrop was
      // dropped - see overlays.js's header), but it keeps the mock's shape
      // matching what the service really returns.
      sessionInfo: { Meeting: { Location: "Madrid", Circuit: { ShortName: "Madring" } } },
      raceControlMessages: [],
    };
  },
  liveTimingTower: function () { return { returnValue: true, running: true, drivers: MOCK_TOWER }; },
  // A replay's map: the same cars and circuit, for whatever stretch of the
  // picture's clock is asked for (from/to are the stamps in ms).
  historicTrackMap: function (p) {
    var from = Number(p && p.from) || 0;
    var to = Number(p && p.to) || 0;
    var res = mockTrackMap(0, p && p.circuit);
    res.drivers = MOCK_TOWER.map(function (d, i) {
      var samples = [];
      for (var t = Math.ceil(from / MOCK_SAMPLE_MS) * MOCK_SAMPLE_MS; t <= to; t += MOCK_SAMPLE_MS) {
        var q = mockPoint(((t / MOCK_LAP_MS) + i * 0.07) % 1);
        samples.push([t, q.x, q.y]);
      }
      return { racingNumber: String(d.racingNumber), tla: d.tla, teamColour: d.teamColour, samples: samples };
    });
    res.available = true;
    res.phase = "ready";
    res.returnValue = true;
    return res;
  },
  liveTimingTrackMap: function (p) {
    var m = mockTrackMap(Number(p && p.since) || 0, p && p.circuit);
    m.returnValue = true;
    m.running = true;
    return m;
  },
};

var MOCK_FAIL = new URLSearchParams(window.location.search).get("fail");
var F1_CALLS = { f1tvPage: true, f1tvSeason: true, f1tvPlayTest: true };

// returnValue:false rejects, as Luna does on the TV.
function mockResponse(method, parameters) {
  var mock = MOCKS[method];
  if (!mock) {
    console.warn("[mocks] no mock registered for '" + method + "' - rejecting");
    return Promise.reject({ errorText: "no local mock for " + method, errorCode: -1 });
  }
  if (MOCK_FAIL && MOCK_FAIL !== "player" && F1_CALLS[method]) {
    return Promise.reject({
      returnValue: false,
      reason: MOCK_FAIL,
      needsSignIn: MOCK_FAIL === "signin",
      f1Message: MOCK_FAIL === "network" ? "" : "Sample message from F1 TV",
      errorText: "mock failure: " + MOCK_FAIL,
    });
  }
  var result = mock(parameters);
  if (MOCK_FAIL === "player" && method === "f1tvPlayTest") {
    result = JSON.parse(JSON.stringify(result).split(REAL_STREAM).join("http://127.0.0.1:9/missing.m3u8"));
  }
  return result && result.returnValue === false ? Promise.reject(result) : Promise.resolve(result);
}

window.LIGHTSOUT_MOCKS = { respond: mockResponse };
