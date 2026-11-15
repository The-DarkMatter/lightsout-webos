#!/usr/bin/env node
// Offline protocol/player checks. No account, signed URLs or network needed.
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var EventEmitter = require("events");
var root = path.join(__dirname, "..");
var source = fs.readFileSync(path.join(root, "app/js/watch.js"), "utf8");

// Evaluate the actual named production functions, without booting the TV UI.
function functions(context, names) {
  names.forEach(function (name) {
    var match = source.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
    assert(match, name);
    vm.runInContext(match[0], context);
  });
}

async function protocol() {
  var requests = [];
  var client = { exports: {} };
  var https = {
    request: function (options, callback) {
      requests.push(options);
      var req = new EventEmitter();
      req.end = function () {
        var res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        callback(res);
        res.emit("data", Buffer.from("{}"));
        res.emit("end");
      };
      return req;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "service/lib/f1tv.js"), "utf8"), {
    require: function (name) { assert.equal(name, "https"); return https; },
    module: client, Buffer: Buffer, Promise: Promise,
  });
  var api = client.exports;
  await api.getPlay("content id", "mock-subscription", "mock-entitlement");
  var standard = requests[0];
  assert.equal(standard.path, "/3.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY?contentId=content%20id&player=player_tm");
  assert.equal(standard.headers["X-F1-Device-Info"],
    "device=web;screen=browser;os=macos;browser=chrome;browserVersion=142;" +
    "model=Macintosh;osVersion=26.0.1;appVersion=release-R48.0.5;playerVersion=8.212.0;p=true;tms=1");
  await api.getPlay("content id", "mock-subscription", "mock-entitlement", { profile: "uhd", channelId: "1025" });
  assert.equal(requests[1].headers["X-F1-Device-Info"], "device=android_tv");
  assert.equal(requests[1].path, standard.path.replace("&player", "&channelId=1025&player"));
  assert.equal(requests[1].headers.ascendontoken, "mock-subscription");
  assert.equal(requests[1].headers.entitlementtoken, "mock-entitlement");
  await api.getEntitlement("mock-subscription");
  assert.equal(requests[2].headers["X-F1-Device-Info"], standard.headers["X-F1-Device-Info"]);
  await api.getPlay("x", "mock-subscription", "mock-entitlement", { profile: "web" });
  assert.equal(requests[3].headers["X-F1-Device-Info"], standard.headers["X-F1-Device-Info"]);
  assert.throws(function () { api.getPlay("x", "", "", { profile: "__proto__" }); }, /unknown playback profile/);
}

function harness() {
  var values = {};
  var elements = {};
  var events = {};
  var tracks = [{ width: 1920, height: 1080, videoCodec: "avc1.640028", active: true }];
  var abr = true;
  var ctx = vm.createContext({
    Promise: Promise, console: console,
    window: { localStorage: {
      getItem: function (k) { return values[k] || null; },
      setItem: function (k, v) { values[k] = v; },
    } },
    document: { getElementById: function (id) {
      return elements[id] || (elements[id] = { textContent: "", classList: { add: function () {}, remove: function () {} } });
    } },
    shaka: { polyfill: { installAll: function () {} }, Player: function () { return ctx.mockPlayer; },
      net: { NetworkingEngine: { RequestType: { LICENSE: 2 } } } },
    video: { currentTime: 123, duration: 600, playbackRate: 1.25, videoWidth: 1920, videoHeight: 1080,
      paused: false, buffered: { length: 0 }, play: function () { ctx.plays++; return Promise.resolve(); },
      pause: function () { ctx.pauses++; } },
    plays: 0, pauses: 0, failures: 0, toasts: [],
    player: null, currentFeeds: [], currentStreams: [], currentChannelId: "1025", currentContentId: "session",
    standardVideoPreferences: null, currentDrmHeaders: null, requestedProfile: "web", playbackProfile: "web", returnedStreamType: "unknown",
    hdFallback: false, contentTicket: 0, loadTicket: 0, feedLoading: false, playbackOptions: {}, scrubTime: null,
    CODEC_NAMES: { hvc1: "HEVC", avc1: "H.264" },
    hideFailure: function () {}, showFailure: function () { ctx.failures++; },
    showToast: function (s) { ctx.toasts.push(s); },
    explainFailure: function (e) { return e; }, explainPlayerError: function (e) { return e; },
    showCaptions: function () {}, showQuality: function () {}, cancelScrub: function () {},
    getResume: function () { return null; }, resumeClock: String,
    activeCaption: function () { return { language: "nl" }; },
    audioTracks: function () { return [{ language: "en", active: true }]; },
    textTracks: function () { return [{ language: "nl" }]; },
    renderFeeds: function (feeds, channel) { ctx.currentFeeds = feeds; ctx.currentChannelId = channel; },
    defaultFeed: function (feeds) { return feeds[0]; }, labelForFeed: function () { return "International"; },
    setInterval: function (fn) { ctx.statsTick = fn; },
  });
  ctx.mockPlayer = {
    attach: function () {}, addEventListener: function (name, fn) { events[name] = fn; },
    getNetworkingEngine: function () { return { registerRequestFilter: function (fn) { ctx.licenseFilter = fn; } }; },
    configure: function (config) {
      if (config.abr) abr = config.abr.enabled;
      if (config.preferredVideo) ctx.videoPreferences = config.preferredVideo;
      ctx.lastConfig = config;
    },
    getConfiguration: function () { return { abr: { enabled: abr }, preferredVideo: [{ hdrLevel: "AUTO" }] }; },
    getVariantTracks: function () { return tracks; },
    getStats: function () { return { decodedFrames: 50, droppedFrames: 1 }; },
    selectVariantTrack: function (track) { ctx.selected = track; },
    selectAudioLanguage: function (lang) { ctx.audio = lang; }, selectTextTrack: function (track) { ctx.caption = track.language; },
    unload: function () { ctx.unloads++; return Promise.resolve(); },
    load: function (_url, time) { ctx.loadedTime = time; ctx.loads++; return Promise.resolve(); },
    isLive: function () { return false; },
  };
  ctx.loads = 0; ctx.unloads = 0;
  functions(ctx, ["uhdEnabled", "playbackCarry", "accessDenied", "fallbackToHD", "uhdChoices", "ensurePlayer",
    "playUrl", "loadContent", "variantTracks", "abrEnabled", "qualityChoices", "hasDuration", "setStatus", "startStatsLoop", "togglePlay", "selectFeed"]);
  ctx.setTracks = function (list) { tracks = list; };
  ctx.events = events;
  return ctx;
}

// Drain promise chains, including a fallback request and player load.
async function settle() { for (var i = 0; i < 30; i++) await Promise.resolve(); }
function response() {
  return { returnValue: true, result: { play: { statusCode: 200, body: { resultObj: {
    streamType: "HDR_UHD_CMAFWV", tme: { feeds: [{ metadata: { channel_id: "1025" }, url: "https://example.invalid/mock.m3u8" }] },
  } } } } };
}

async function playback() {
  var ctx = harness();
  var calls = [];
  ctx.callService = function (_method, payload) { calls.push(payload); return Promise.resolve(response()); };
  assert.equal(ctx.uhdEnabled(), false);
  ctx.loadContent("session"); await settle();
  assert.equal(calls[0].profile, "web");
  assert.equal(ctx.loads, 1);
  ctx.video.playbackRate = 1.25;
  ctx.uhdChoices()[1].pick(); await settle();
  assert.deepEqual(calls.map(function (p) { return p.profile; }), ["web", "uhd", "web"]);
  assert.equal(ctx.hdFallback, true); // HD-only playable manifest cannot pass as UHD
  assert.equal(ctx.loadedTime, 123);
  assert.equal(ctx.audio, "en"); assert.equal(ctx.caption, "nl");
  assert.equal(ctx.video.playbackRate, 1.25);
  assert(ctx.toasts.some(function (s) { return /standard HD/.test(s); }));
  assert.equal(ctx.fallbackToHD({ category: 6 }), false);
  var uhd = { width: 3840, height: 2160, videoCodec: "hvc1.2.4.L153.B0", frameRate: 50, hdr: "HLG", active: true };
  ctx.setTracks([uhd]);
  ctx.uhdChoices()[1].pick(); await settle();
  assert.equal(calls[calls.length - 1].profile, "uhd");
  assert.equal(ctx.hdFallback, false);
  assert.equal(ctx.videoPreferences[0].codec, "hvc1");
  var choices = ctx.qualityChoices();
  assert.equal(choices[1].label, "2160p");
  choices[1].pick(); assert.equal(ctx.selected, uhd); assert.equal(ctx.abrEnabled(), false);
  choices[0].pick(); assert.equal(ctx.abrEnabled(), true);
  ctx.startStatsLoop(); ctx.statsTick();
  var stats = ctx.document.getElementById("stats").textContent;
  assert(stats.includes("manifest max=3840x2160"));
  assert(stats.includes("Decoded video=1920x1080"));
  assert(stats.includes("fps=50")); assert(stats.includes("HDR output signal=not observable"));
  var deniedCount = calls.length;
  ctx.events.error({ detail: { severity: 2, category: 6, code: 6007, data: [{ data: ["redacted", 403] }] } });
  await settle();
  assert.equal(calls.length, deniedCount); // explicit licence refusal is not hidden
  assert.equal(ctx.playbackProfile, "uhd");
  ctx.events.error({ detail: { severity: 2, category: 6, code: 6001 } }); await settle();
  assert.equal(calls[calls.length - 1].profile, "web");
  var count = calls.length;
  ctx.events.error({ detail: { severity: 2, category: 6, code: 6001 } }); await settle();
  assert.equal(calls.length, count);
  ctx.uhdChoices()[0].pick(); await settle();
  assert.equal(ctx.uhdEnabled(), false); assert.equal(ctx.requestedProfile, "web");
  assert.equal(ctx.hdFallback, false);
  assert.equal(ctx.videoPreferences[0].codec, undefined);
  ctx.setTracks([{ width: 1920, height: 1080, videoCodec: "avc1.640028" }]);
  assert(!ctx.qualityChoices().some(function (c) { return c.label === "2160p"; }));
  ctx.togglePlay(); assert.equal(ctx.pauses, 1);
  ctx.video.paused = true; ctx.togglePlay(); assert(ctx.plays > 0);
  ctx.selectFeed(response().result.play.body.resultObj.tme.feeds[0], [], null); await settle();
  assert.equal(ctx.loadedTime, 123); // camera switch keeps replay position
  assert(ctx.unloads >= 4);
  ctx.currentDrmHeaders = { entitlementToken: "mock-entitlement", ascendontoken: "mock-subscription" };
  var license = { headers: {} };
  ctx.licenseFilter(2, license);
  assert.equal(license.headers.entitlementtoken, "mock-entitlement");
  assert.equal(license.headers.ascendontoken, "mock-subscription");
  var manifest = { headers: {} };
  ctx.licenseFilter(0, manifest);
  assert.equal(Object.keys(manifest.headers).length, 0);
  [401, 403, 451].forEach(function (status) {
    assert(ctx.accessDenied({ data: [{ category: 1, data: ["redacted", status] }] }));
  });
  ["signin", "subscription", "region"].forEach(function (reason) {
    ctx.playbackProfile = "uhd"; ctx.hdFallback = false;
    assert.equal(ctx.fallbackToHD({ reason: reason }), false);
  });
}

async function failures() {
  for (var failure of [
    { returnValue: false, reason: "changed", f1Status: 500 }, // stream-rule failure
    { returnValue: true, result: { play: { statusCode: 200, body: { resultObj: { tme: { feeds: [null, {}, { url: "http://example.invalid/insecure.m3u8", metadata: {} }] } } } } } },
  ]) {
    var ctx = harness(); var calls = [];
    ctx.window.localStorage.setItem("lightsout.uhd", "1");
    ctx.callService = function (_method, payload) { calls.push(payload.profile); return Promise.resolve(failure); };
    ctx.loadContent("session"); await settle();
    assert.deepEqual(calls, ["uhd", "web"]);
    assert.equal(ctx.failures, 1);
  }
  for (var reason of ["signin", "subscription", "region"]) {
    var denied = harness(); var count = 0;
    denied.window.localStorage.setItem("lightsout.uhd", "1");
    denied.callService = function () { count++; return Promise.resolve({ returnValue: false, reason: reason }); };
    denied.loadContent("session"); await settle();
    assert.equal(count, 1); assert.equal(denied.failures, 1);
  }
  for (var category of [3, 4, 6]) { // unsupported codec, manifest, DRM
    var player = harness(); var profiles = [];
    player.window.localStorage.setItem("lightsout.uhd", "1");
    player.callService = function (_method, payload) { profiles.push(payload.profile); return Promise.resolve(response()); };
    player.mockPlayer.load = function () { return Promise.reject({ category: category, code: category * 1000, data: ["DO_NOT_LOG_SIGNED_URL"] }); };
    player.loadContent("session"); await settle();
    assert.deepEqual(profiles, ["uhd", "web"]);
    assert(!player.document.getElementById("status").textContent.includes("DO_NOT_LOG"));
  }
  // A stale PLAY response cannot replace the newer request or trigger fallback.
  var race = harness(); var resolveOld;
  race.callService = function (_method, payload) {
    return payload.contentId === "old" ? new Promise(function (r) { resolveOld = r; }) : Promise.resolve(response());
  };
  race.loadContent("old"); await settle();
  race.loadContent("new");
  // A previous stream's event during unload must not overwrite the new UI.
  race.ensurePlayer();
  race.events.error({ detail: { severity: 2, category: 6, code: 6001 } });
  assert.equal(race.failures, 0);
  await settle();
  resolveOld({ returnValue: false, reason: "changed" }); await settle();
  assert.equal(race.currentContentId, "new"); assert.equal(race.loads, 1);
}

(async function () {
  await protocol(); await playback(); await failures();
  console.log("Playback checks passed: profiles, negotiation, UHD metadata/quality, controls, diagnostics, one-shot fallback, denials and stale requests.");
})().catch(function (err) { console.error(err); process.exitCode = 1; });
