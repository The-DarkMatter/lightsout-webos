// F1TV REST client. Undocumented API, reverse-engineered from a mix of
// community projects (F1OpenViewer, f1viewer's Go client) and a real HAR
// capture of MultiViewer's own traffic against a live account - see plan
// doc for sources and the full trail of what was tried and why.
//
// We deliberately do NOT do server-side email/password login: an older
// client (f1viewer) documents that path as blocked by F1TV's anti-bot
// checks, and the current community-standard workaround is to log in in a
// real browser (which passes the bot check because a human is actually
// there) and reuse the resulting subscriptionToken JWT from the
// `login-session` cookie as a bearer credential. That's what the /setup
// pairing page collects; this module just uses it.
//
// Confirmed against real responses:
//   - LOGIN_STATUS is "R", not "L" - ENTITLEMENT is lenient about this
//     segment (both worked), but LOCATION only succeeds with "R", matching
//     f1viewer's Go client which uses "R" throughout.
//   - PLAY needs playAPIVersion "3.0" (matches /config's
//     apiConfig.playAPIVersion) and a player=player_tm query param.
//   - PLAY's real success shape:
//       resultObj: { entitlementToken, tme: { feeds: [{metadata:{channel_id}, url}] },
//                    streamType, channelId, playApiVersion, cdnType, settings }
//     `feeds` lists EVERY available camera/channel for that content in one
//     response - a race session's feeds array had 26 entries (world feed,
//     every onboard, data channel). Switching POV during playback should
//     mean picking a different feeds[] entry, not calling PLAY again.
//   - The manifest URLs returned are HLS (CMAF fMP4 for full sessions,
//     plain .ts for short VOD clips) with NO EME/DRM at all - no
//     #EXT-X-KEY anywhere in a real, current race session's playlists.
//     Access control is entirely a signed, time-limited token embedded in
//     the URL path itself (~24min TTL seen), not content encryption. M1's
//     Widevine+DASH proof stays useful as a capability check, but F1
//     content itself may not need DRM at all - confirm against a genuinely
//     live session before assuming this generalizes.
//   - PLATFORM is confusing: WEB_HLS succeeded for a given contentId while
//     WEB_DASH, BIG_SCREEN_DASH, and BIG_SCREEN_HLS all failed identically
//     with "Failed to evaluate stream rule" (ACN_2008) for that SAME
//     content. Not conclusively a platform bug - could be content-specific
//     licensing (e.g. this particular press-conference clip only being
//     cleared for web/mobile). Needs testing against genuinely live
//     content, where getPlay's platform param can be overridden per call.
//   - CONTENT/VIDEO (api version 4.0, matching /config's videoAPIVersion)
//     is self-describing: its response includes a `steering.uri` field
//     with the exact FEATURESTEERING URL to call next, and a
//     `personalisation.uri` for resume-progress. Prefer following those
//     over constructing FEATURESTEERING URLs by hand.
//   - PAGE/{pageId} (api version 2.0) is how the real client browses
//     catalog/schedule. Confirmed structure: top-level containers are
//     TRAYS (e.g. "Live & Replays", "F1 Highlights"), and the actual
//     watchable items are nested one level deeper in
//     container.retrieveItems.resultObj.containers[], each with a
//     metadata.contentSubtype field (REPLAY / HIGHLIGHTS / PRESS
//     CONFERENCE / ANALYSIS / SHOW seen so far - watch for this flipping
//     to something like LIVE once a session is actually live). BUT: a
//     pageId is scoped to one specific race weekend (12324 turned out to
//     be the Spanish GP's page specifically, confirmed by its gp_banner
//     tray), not a universal "what's on right now" page across events -
//     so this only helps once you already know which weekend's page to
//     ask for. A generic pageId (395, seen in the same capture) is a
//     top-level nav/wall page whose trays need a separate follow-up fetch
//     per tray (their retrieveItems came back empty with no populated
//     uriOriginal in the capture we have) - not yet solved. In practice,
//     for now: get a live session's contentId the same way we got PLAY's
//     shape - a real captured request - rather than guessing page IDs.
//   - svc.formula1.com/whereami (different host!) is a lightweight geo
//     lookup returning {countryCodeAlpha2, countryCodeAlpha3} - simpler
//     than f1tv.formula1.com's LOCATION endpoint for just "what country".
//
// The 403 seen when this was first tested from the TV was NOT a path
// segment problem - it was f1tv.formula1.com's CloudFront/WAF layer
// blocking any request with no User-Agent header at all, which is Node's
// https default and not something curl (or a real browser) ever does.
// Confirmed by reproducing the exact 403 locally with Node's bare https
// client, then watching it flip to 200 the moment any User-Agent was
// added.
//
// SOLVED the "Failed to evaluate stream rule" (ACN_2008) mystery: PLAY
// needs an `X-F1-Device-Info` header, missing from every attempt above.
// Diffing our request against MultiViewer's real captured one (identical
// contentId/channelId/platform, everything else the same) found it -
// without it, "stream rule" apparently can't even be evaluated. Confirmed
// by adding the exact captured value verbatim: WEB_HLS immediately went
// from 500 to 200 with a real 26-feed response. A fabricated "tv" device
// declaration (device=tv;screen=tv;os=webos;...) with BIG_SCREEN_HLS still
// failed the same way, suggesting the rule engine validates against known
// registered client versions rather than accepting any well-formed value -
// and since F1TV has no official webOS app, there's no legitimate
// "smart TV" string to use. Declaring as the real captured web client
// works reliably, so that's what this app does; BIG_SCREEN/4K stays an
// open question for later, not blocking real playback now.

var https = require("https");

var HOST = "f1tv.formula1.com";
var GEO_HOST = "svc.formula1.com";
var DEFAULT_PLATFORM = "WEB_HLS"; // see X-F1-Device-Info note above
var LANGUAGE = "ENG";
var LOGIN_STATUS = "R";
var PLAY_API_VERSION = "3.0";
var VIDEO_API_VERSION = "4.0";
var PAGE_API_VERSION = "2.0";
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.7871.46 Safari/537.36";
// Verbatim from a real captured MultiViewer request against a working
// account - see the SOLVED note above for why this can't just be any
// well-formed value.
var DEVICE_INFO =
  "device=web;screen=browser;os=macos;browser=chrome;browserVersion=142;" +
  "model=Macintosh;osVersion=26.0.1;appVersion=release-R48.0.5;playerVersion=8.212.0;p=true;tms=1";

function request(host, pathAndQuery, headers) {
  return new Promise(function (resolve, reject) {
    var req = https.request(
      {
        host: host,
        path: pathAndQuery,
        method: "GET",
        headers: Object.assign(
          { Accept: "application/json", "User-Agent": USER_AGENT, "X-F1-Device-Info": DEVICE_INFO },
          headers || {}
        ),
        timeout: 15000,
      },
      function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          var body = Buffer.concat(chunks).toString("utf8");
          var parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { /* leave null */ }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed !== null ? parsed : body,
          });
        });
      }
    );
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function f1tvRequest(pathAndQuery, headers) {
  return request(HOST, pathAndQuery, headers);
}

function getConfig() {
  return f1tvRequest("/config", {});
}

function getWhereami() {
  return request(GEO_HOST, "/whereami", {});
}

function getEntitlement(subscriptionToken) {
  var path = "/2.0/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + DEFAULT_PLATFORM + "/ALL/USER/ENTITLEMENT";
  return f1tvRequest(path, { ascendontoken: subscriptionToken });
}

function getLocation(entitlementToken) {
  var path = "/1.0/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + DEFAULT_PLATFORM + "/ALL/USER/LOCATION";
  var headers = {};
  if (entitlementToken) headers.entitlementtoken = entitlementToken;
  return f1tvRequest(path, headers);
}

// UNCONFIRMED - real client traffic showed catalog browsing via PAGE/{id}
// instead. Kept as a fallback path to try.
function getLiveNow(subscriptionToken, entitlementToken, groupId) {
  var path =
    "/2.0/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + DEFAULT_PLATFORM +
    "/ALL/EVENTS/LIVENOW/" + encodeURIComponent(entitlementToken) + "/" + encodeURIComponent(groupId);
  return f1tvRequest(path, { ascendontoken: subscriptionToken, entitlementtoken: entitlementToken });
}

// Every meeting of a season (race weekends and tests), oldest first, from the
// catalogue search behind the web client's season pages. Confirmed for 2018
// through 2026 (earlier seasons return a single archive item). Each meeting's
// weekend page id is in metadata.emfAttributes.PageID - what getPage takes.
function getSeason(season, subscriptionToken, entitlementToken) {
  var path =
    "/" + PAGE_API_VERSION + "/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + DEFAULT_PLATFORM +
    "/ALL/PAGE/SEARCH/VOD/PREMIUM/2?filter_objectSubtype=Meeting&orderBy=meeting_End_Date&sortOrder=asc" +
    "&filter_season=" + encodeURIComponent(season) + "&filter_orderByFom=Y&filter_fetchAll=Y";
  return f1tvRequest(path, { ascendontoken: subscriptionToken, entitlementtoken: entitlementToken });
}

// Confirmed shape: /2.0/R/ENG/{platform}/ALL/PAGE/{pageId}/{subscriptionTier}/{groupId}
// pageId 395 and 12324 were both seen in real traffic (likely "home"/"live"
// style catalog pages) but their specific meaning isn't confirmed yet.
function getPage(pageId, subscriptionTier, groupId, subscriptionToken, entitlementToken, platform) {
  var path =
    "/" + PAGE_API_VERSION + "/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + (platform || DEFAULT_PLATFORM) +
    "/ALL/PAGE/" + encodeURIComponent(pageId) + "/" + encodeURIComponent(subscriptionTier) + "/" + encodeURIComponent(groupId);
  return f1tvRequest(path, { ascendontoken: subscriptionToken, entitlementtoken: entitlementToken });
}

// Confirmed shape: /4.0/R/ENG/{platform}/ALL/CONTENT/VIDEO/{contentId}/{subscriptionTier}/{groupId}?contentId=X&entitlement={subscriptionTier}
// Response includes resultObj.steering.uri - the exact FEATURESTEERING URL
// to call next - and resultObj.personalisation.uri for resume progress.
function getContentVideo(contentId, subscriptionTier, groupId, subscriptionToken, entitlementToken, platform) {
  var p = platform || DEFAULT_PLATFORM;
  var path =
    "/" + VIDEO_API_VERSION + "/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + p +
    "/ALL/CONTENT/VIDEO/" + encodeURIComponent(contentId) + "/" + encodeURIComponent(subscriptionTier) + "/" + encodeURIComponent(groupId) +
    "?contentId=" + encodeURIComponent(contentId) + "&entitlement=" + encodeURIComponent(subscriptionTier);
  return f1tvRequest(path, { ascendontoken: subscriptionToken, entitlementtoken: entitlementToken });
}

// Confirmed shape from a real captured browser request:
//   /3.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY?contentId=X&player=player_tm
//   /3.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY?contentId=X&channelId=Y&player=player_tm
// channelId selects which feed is "primary" in the response, but a
// multi-feed session's response includes ALL feeds regardless - so calling
// this once and switching between resultObj.tme.feeds[] entries client-side
// should work for POV switching without another PLAY call per switch.
function getPlay(contentId, subscriptionToken, entitlementToken, opts) {
  opts = opts || {};
  var platform = opts.platform || DEFAULT_PLATFORM;
  var path =
    "/" + PLAY_API_VERSION + "/" + LOGIN_STATUS + "/" + LANGUAGE + "/" + platform +
    "/ALL/CONTENT/PLAY?contentId=" + encodeURIComponent(contentId);
  if (opts.channelId) path += "&channelId=" + encodeURIComponent(opts.channelId);
  path += "&player=player_tm";
  return f1tvRequest(path, {
    ascendontoken: subscriptionToken,
    entitlementtoken: entitlementToken,
  });
}

// Debug escape hatch for iterating on unverified endpoint shapes without a
// redeploy - called directly over the Luna bus. Not for production use.
function raw(pathAndQuery, headers) {
  return f1tvRequest(pathAndQuery, headers);
}

module.exports = {
  getConfig: getConfig,
  getWhereami: getWhereami,
  getEntitlement: getEntitlement,
  getLocation: getLocation,
  getLiveNow: getLiveNow,
  getPage: getPage,
  getSeason: getSeason,
  getContentVideo: getContentVideo,
  getPlay: getPlay,
  raw: raw,
  DEFAULT_PLATFORM: DEFAULT_PLATFORM,
  LANGUAGE: LANGUAGE,
  LOGIN_STATUS: LOGIN_STATUS,
};
