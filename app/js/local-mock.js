// Shared local-browser preview layer. webOSTV.js always defines
// window.webOS regardless of environment - the real signal for "are we
// inside actual webOS" is window.PalmServiceBridge, the native bridge
// object that only exists in the real runtime. When it's missing (a
// normal desktop browser), every page's callService() call is answered
// from MOCKS below instead of erroring out, so layout, navigation, and
// overlay rendering can all be iterated on without the TV.
//
// This only fakes the Luna layer. Video playback still needs a real,
// reachable manifest - the f1tvPlayTest mock below points at a public,
// unencrypted, CORS-friendly HLS test stream (Shaka Player's own demo asset)
// specifically so Shaka has something real to load in a plain browser,
// not just placeholder data.
//
// Real on-device behavior is completely unaffected: this file only ever
// substitutes anything when PalmServiceBridge is absent.

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

function mockTrackMap() {
  // A simple ellipse of trail points, standing in for "a session's worth
  // of accumulated position data" - not a real track shape, just enough
  // to verify the map overlay's rendering/scaling code with something.
  var trail = [];
  for (var i = 0; i < 60; i++) {
    var t = (i / 60) * Math.PI * 2;
    trail.push({ x: Math.cos(t) * 200, y: Math.sin(t) * 90 });
  }
  var drivers = MOCK_TOWER.map(function (d, i) {
    var t = (i / MOCK_TOWER.length) * Math.PI * 2;
    return { racingNumber: d.racingNumber, tla: d.tla, teamColour: d.teamColour, x: Math.cos(t) * 200, y: Math.sin(t) * 90 };
  });
  return { drivers: drivers, trail: trail };
}

var MOCKS = {
  // Offline page data: define MOCK_BROWSE_PAGE in a script loaded before this one.
  f1tvPage: function () {
    return typeof MOCK_BROWSE_PAGE !== "undefined" ? MOCK_BROWSE_PAGE : { returnValue: false, errorText: "no offline page data on this screen" };
  },
  // Offline season lists: MOCK_SEASONS[year]. Missing years come back empty.
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
    };
  },
  getSetupInfo: function () {
    return { returnValue: true, lanAddress: "127.0.0.1", setupUrl: "http://127.0.0.1:8787/setup", port: 8787, hasToken: true, tokenExpiresAt: null };
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
  liveTimingTrackMap: function () {
    var m = mockTrackMap();
    return { returnValue: true, running: true, drivers: m.drivers, trail: m.trail };
  },
};

// Every page is a fixed 1920x1080 canvas with overflow:hidden - correct
// for how webOS scales a TV app to the panel, but in a normal browser
// window that's not 1920x1080, overflow:hidden means the excess is
// clipped and invisible, not just scrollable. Auto-scale the whole page
// to fit the actual window, only when not running in real webOS (the TV
// always gets the untouched, unscaled canvas).
function fitToWindow() {
  if (window.PalmServiceBridge) return;
  var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
  document.body.style.transformOrigin = "top left";
  document.body.style.transform = "scale(" + scale + ")";
}
if (!window.PalmServiceBridge) {
  window.addEventListener("resize", fitToWindow);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fitToWindow);
  } else {
    fitToWindow();
  }
}

function callService(method, parameters) {
  if (window.PalmServiceBridge) {
    return new Promise(function (resolve, reject) {
      webOS.service.request("luna://com.amogh.f1hud.service", {
        method: method,
        parameters: parameters || {},
        onSuccess: resolve,
        onFailure: reject,
      });
    });
  }
  // Served over http by scripts/dev-server.js: the real service code answers
  // at /api/<method>, against the real F1 TV API. It marks its responses
  // with X-F1HUD-Dev, so any other static server falls through to the mocks.
  // returnValue:false rejects, as Luna's onFailure does on the TV.
  if (/^https?:$/.test(window.location.protocol)) {
    return fetch("/api/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parameters || {}),
    })
      .then(function (res) {
        if (!res.headers.get("X-F1HUD-Dev")) return mockResponse(method, parameters);
        return res.json().then(function (body) {
          if (body && body.returnValue === false) throw body;
          return body;
        });
      }, function () {
        return mockResponse(method, parameters);
      });
  }
  return mockResponse(method, parameters);
}

function mockResponse(method, parameters) {
  var mock = MOCKS[method];
  if (!mock) {
    console.warn("[local-mock] no mock registered for '" + method + "' - rejecting");
    return Promise.reject({ errorText: "no local mock for " + method, errorCode: -1 });
  }
  return Promise.resolve(mock(parameters));
}
