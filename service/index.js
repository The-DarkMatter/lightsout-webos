// On-TV service. Grows across milestones per the plan:
//   M0: ping (done)
//   M2: F1TV pairing (this file) - token storage, entitlement/location/PLAY
//   M4: SignalR-core live timing client
//
// Everything that talks to F1 lives here, never in the page, because F1's
// endpoints send no CORS headers and a packaged webOS app can't call them
// directly from the page (see plan doc).

var pkgInfo = require("./package.json");
var Service = require("webos-service");
var store = require("./lib/store");
var setupServer = require("./lib/setupServer");
var f1tv = require("./lib/f1tv");
var livetiming = require("./lib/livetiming");
var archive = require("./lib/archive");
var auth = require("./lib/auth");

var service = new Service(pkgInfo.name);
var startedAt = Date.now();
auth.init(service);

setupServer.start();

// A stored token is only good for 96 hours, but it renews itself from the
// 30-day session inside it without anyone signing in again (lib/auth.js).
// So every handler that talks to F1 asks for its token through here
// instead of reading the store: a stale one is refreshed first, and only a
// dead session comes back as "sign in again".
function withToken(message, run) {
  auth.freshToken().then(function (token) {
    if (!token) {
      var state = auth.status();
      return message.respond({
        returnValue: false,
        errorText: state.expired || state.hasToken ? "F1 TV sign-in expired" : "no token stored",
        needsSignIn: true,
      });
    }
    run(token);
  });
}

service.register("ping", function (message) {
  message.respond({
    returnValue: true,
    service: pkgInfo.name,
    version: pkgInfo.version,
    nodeVersion: process.version,
    uptimeMs: Date.now() - startedAt,
    receivedFrom: (message.payload && message.payload.source) || null,
    serverTime: new Date().toISOString(),
  });
});

// Tells the app what to put in the QR code / on-screen fallback text. The
// QR code carries the pairing code (lib/setupServer.js); the screen also
// shows it on its own, for a browser that didn't come from the QR code.
service.register("getSetupInfo", function (message) {
  var status = auth.status();
  var pairingCode = setupServer.pairingCode();
  // Under scripts/dev-server.js there is no TV: the sign-in screen runs in
  // this PC's browser and signs in through a bookmark, with the setup
  // server on loopback.
  if (process.env.F1HUD_DEV) {
    return message.respond({
      returnValue: true,
      dev: true,
      setupUrl: "http://localhost:" + setupServer.PORT + "/setup",
      bookmarklet: setupServer.bookmarklet("localhost"),
      pairingCode: pairingCode,
      hasToken: status.hasToken,
      tokenExpiresAt: status.expiresAt,
    });
  }
  var ip = setupServer.getLanAddress();
  message.respond({
    returnValue: true,
    lanAddress: ip,
    setupUrl: ip ? "http://" + ip + ":" + setupServer.PORT + "/setup" : null,
    port: setupServer.PORT,
    pairingCode: pairingCode,
    hasToken: status.hasToken,
    tokenExpiresAt: status.expiresAt,
  });
});

// Sign-in state (see lib/auth.js). Also looks for a newer formula1.com login
// in the TV's own browser first - throttled to once every 30s unless
// forceBrowserCheck is set - so logging in there and coming back to the app
// is enough. Responds with no token material, only dates and flags.
service.register("getAuthStatus", function (message) {
  var force = !!(message.payload && message.payload.forceBrowserCheck);
  auth
    .checkTvBrowser(force)
    // Renew here too, not only before an F1 call: whoever is looking at the
    // sign-in screen should see it fix itself rather than be told to go and
    // find a browser.
    .then(function () { return auth.freshToken(); })
    .then(function () {
      message.respond(Object.assign({ returnValue: true }, auth.status()));
    });
});

service.register("clearToken", function (message) {
  store.delete("f1tv_token");
  store.delete("f1tv_token_saved_at");
  store.delete("f1tv_token_source");
  message.respond({ returnValue: true });
});

// What each feed in a PLAY response is. Feed URLs used to carry a readable
// path (".../OBC/Car03-R1/..."), but are opaque hashes as of 2026, so names
// come from CONTENT/VIDEO's metadata.additionalStreams: the main feeds by
// identifier (WIF, PRES, TRACKER, DATA) and every onboard with its driver,
// team and team colour, all keyed by channelId. Playback URLs are left out -
// PLAY already supplies those.
function streamsFromContent(res) {
  var container = res && res.body && res.body.resultObj && res.body.resultObj.containers && res.body.resultObj.containers[0];
  var list = (container && container.metadata && container.metadata.additionalStreams) || [];
  return list.map(function (s) {
    return {
      channelId: s.channelId,
      identifier: s.identifier,
      type: s.type,
      title: s.title,
      racingNumber: s.racingNumber,
      firstName: s.driverFirstName,
      lastName: s.driverLastName,
      team: s.teamName,
      color: s.hex,
      audioTrackNames: s.audioTrackNames,
    };
  });
}

// Full chain test: entitlement -> PLAY for a given contentId. platform and
// channelId are optional overrides (see lib/f1tv.js notes on why platform
// choice isn't fully understood yet - WEB_HLS worked for one piece of
// content while every BIG_SCREEN/DASH variant failed with the same
// "stream rule" error, which may be content-specific rather than a real
// platform restriction).
service.register("f1tvPlayTest", function (message) {
  var payload = message.payload || {};
  var contentId = payload.contentId;
  if (!contentId) return message.respond({ returnValue: false, errorText: "missing 'contentId' parameter" });

  var result = {};
  withToken(message, function (token) {
  f1tv
    .getEntitlement(token)
    .then(function (entRes) {
      result.entitlement = { statusCode: entRes.statusCode };
      var entitlementToken = entRes.body && entRes.body.resultObj && entRes.body.resultObj.entitlementToken;
      if (!entitlementToken) {
        result.entitlement.body = entRes.body;
        return null;
      }
      // PLAY and the content's details in parallel. Details only name the
      // feeds, so a failure there must never stop playback.
      return Promise.all([
        f1tv.getPlay(contentId, token, entitlementToken, { platform: payload.platform, channelId: payload.channelId }),
        f1tv.getContentVideo(contentId, "PREMIUM", 2, token, entitlementToken).catch(function () { return null; }),
      ])
        .then(function (responses) {
          var playRes = responses[0];
          result.play = { statusCode: playRes.statusCode, body: playRes.body };
          result.streams = streamsFromContent(responses[1]);
          // Live content's PLAY response includes a laURL (Widevine license
          // endpoint) the page needs to call directly for EME - and a real
          // captured license request needs BOTH ascendontoken and
          // entitlementtoken headers, confirmed against MultiViewer's own
          // traffic during an actual live session. entitlementToken already
          // ships in the PLAY response body itself; ascendontoken doesn't,
          // so it's added here specifically for that purpose.
          if (playRes.body && playRes.body.resultObj && playRes.body.resultObj.laURL) {
            result.ascendontoken = token;
          }
        });
    })
    .then(function () {
      message.respond({ returnValue: true, result: result });
    })
    .catch(function (err) {
      message.respond({ returnValue: false, errorText: String(err), result: result });
    });
  });
});

// A season's meetings for Browse's weekend switcher and season list, trimmed
// to what those show. Tests have no championship round.
function meetingsFromSearch(res) {
  var list = (res && res.body && res.body.resultObj && res.body.resultObj.containers) || [];
  return list
    .map(function (c) {
      var m = c.metadata || {};
      var e = m.emfAttributes || {};
      return {
        pageId: Number(e.PageID) || null,
        name: e.Meeting_Name || m.titleBrief || m.title,
        official: e.Meeting_Official_Name || m.title,
        country: e.Meeting_Country_Name || "",
        location: e.Meeting_Location || "",
        circuit: e.Circuit_Short_Name || "",
        round: Number(e.Championship_Meeting_Ordinal) || null,
        test: String(e.IsTestEvent) === "true",
        start: e.Meeting_Start_Date || null,
        end: e.Meeting_End_Date || null,
      };
    })
    .filter(function (m) { return m.pageId; });
}

service.register("f1tvSeason", function (message) {
  var season = message.payload && message.payload.season;
  if (!season) return message.respond({ returnValue: false, errorText: "missing 'season' parameter" });
  withToken(message, function (token) {
  f1tv
    .getEntitlement(token)
    .then(function (entRes) {
      var entitlementToken = entRes.body && entRes.body.resultObj && entRes.body.resultObj.entitlementToken;
      return f1tv.getSeason(season, token, entitlementToken);
    })
    .then(function (res) {
      if (res.statusCode !== 200) {
        return message.respond({ returnValue: false, errorText: "season search returned " + res.statusCode });
      }
      message.respond({ returnValue: true, season: Number(season), meetings: meetingsFromSearch(res) });
    })
    .catch(function (err) {
      message.respond({ returnValue: false, errorText: String(err) });
    });
  });
});

// Browse a catalog page (e.g. pageId 395 or 12324, seen in real traffic) to
// hunt for what's currently live/available, since EVENTS/LIVENOW is
// unconfirmed. subscriptionTier defaults to PREMIUM (matches this account).
service.register("f1tvPage", function (message) {
  var payload = message.payload || {};
  var pageId = payload.pageId;
  if (!pageId) return message.respond({ returnValue: false, errorText: "missing 'pageId' parameter" });

  withToken(message, function (token) {
  f1tv
    .getEntitlement(token)
    .then(function (entRes) {
      var entitlementToken = entRes.body && entRes.body.resultObj && entRes.body.resultObj.entitlementToken;
      return f1tv.getPage(
        pageId,
        payload.subscriptionTier || "PREMIUM",
        payload.groupId || 2,
        token,
        entitlementToken,
        payload.platform
      );
    })
    .then(function (pageRes) {
      message.respond({ returnValue: true, statusCode: pageRes.statusCode, body: pageRes.body });
    })
    .catch(function (err) {
      message.respond({ returnValue: false, errorText: String(err) });
    });
  });
});

// Timing for a session that already happened (lib/archive.js). The app
// sends the absolute instant showing on screen - which it knows because F1
// TV's manifests carry EXT-X-PROGRAM-DATE-TIME - and gets the tower as it
// stood then. No token: F1's session archive needs no sign-in.
service.register("historicTiming", function (message) {
  var atUtc = message.payload && message.payload.atUtc;
  var at = atUtc ? Date.parse(atUtc) : NaN;
  if (!at) return message.respond({ returnValue: false, errorText: "missing or unreadable 'atUtc'" });
  archive
    .towerAt(at)
    .then(function (result) {
      if (!result) {
        // No archived session covers this instant: a pre-season test, a
        // support race F1 doesn't publish timing for, or a season older
        // than the archive. Not an error, just nothing to show.
        return message.respond({ returnValue: true, available: false, atUtc: new Date(at).toISOString() });
      }
      message.respond(Object.assign({ returnValue: true, available: true }, result));
    })
    .catch(function (err) {
      message.respond({ returnValue: false, errorText: String((err && err.message) || err) });
    });
});

// Live timing (M4). Started/stopped on demand from the app when the
// overlays are toggled on/off, rather than always-on, so the connection
// only exists while something is actually watching it. Untested against a
// live session as of writing - see lib/livetiming.js for exactly what's
// confirmed vs still a guess.
service.register("liveTimingStart", function (message) {
  // Position.z/CarData.z came back completely empty unauthenticated during
  // a real live session - see livetiming.js's negotiate() comment. Reusing
  // the F1TV login token already stored for PLAY/DRM as an attempt at the
  // SignalR auth token, since it's the same account system.
  auth.freshToken().then(function (token) {
    livetiming.start(token);
  });
  message.respond({ returnValue: true });
});

service.register("liveTimingStop", function (message) {
  livetiming.stop();
  message.respond({ returnValue: true });
});

service.register("liveTimingSummary", function (message) {
  message.respond(Object.assign({ returnValue: true, running: livetiming.isRunning() }, livetiming.getSummary()));
});

service.register("liveTimingTower", function (message) {
  message.respond({ returnValue: true, running: livetiming.isRunning(), drivers: livetiming.getTimingTower() });
});

service.register("liveTimingTrackMap", function (message) {
  message.respond(Object.assign({ returnValue: true, running: livetiming.isRunning() }, livetiming.getTrackMap()));
});

process.on("uncaughtException", function (err) {
  console.error("[f1hud.service] uncaughtException:", (err && err.stack) || err);
});
