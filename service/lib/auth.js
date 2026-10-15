// F1TV sign-in state: where the subscription token comes from, whether
// it's still good, and keeping it fresh.
//
// The service can't log in with a username and password. api.formula1.com's
// authenticate endpoint answers a plain client with an Imperva "Pardon Our
// Interruption" block page (403), and that challenge only clears in a real
// browser. So the token always starts from a login a person did in a real
// browser.
//
// Two ways a token arrives:
//   - "phone": pushed to the LAN setup server (setupServer.js) by a
//     bookmarklet run on a logged-in formula1.com page, or pasted there.
//   - "tv-browser": the TV's own web browser, if someone logged in to
//     formula1.com there. Only on a rooted TV with Homebrew Channel. F1's
//     login page writes the token into a `login-session` cookie from page
//     script, and the browser's cookie database stores it unencrypted.
//     The file is 0600 and owned by the browser's jail user, so this
//     service can't open it directly; it asks Homebrew Channel's service,
//     which runs as root and exposes a public `exec` method, to run one
//     read-only sqlite3 query and print just that cookie. That avoids
//     elevating this whole service to root, and unlike elevation it
//     survives reinstalling the app.
//     It's off until the viewer turns it on from the sign-in screen, and
//     the screen only offers it when Homebrew Channel's service answers.
//
// A subscription token lasts 96 hours, but it renews itself. Every token
// carries a `SessionId` claim which is itself a JWT, issued by ascendon.tv,
// with a much longer life: 30 days from the login, sometimes more (a
// desktop login has been seen to get about 180), so the session's own
// `exp` is what counts. F1's RetrieveSubscriber mints a brand new 96h
// subscription token for whoever presents that session id in a
// `cd-sessionid` header - but ONLY alongside `orderSubmitted: true`;
// without it the same call returns account details and no token. The
// renewal call needs no browser, so one login lasts the whole session.
//
// Whichever token stays useful longer wins, so an older import never
// replaces a fresher login from the other route. "Useful" counts the
// session behind the token, not just the token: a token that expired
// yesterday but whose session runs for three more weeks is worth more
// than nothing, because one renewal call makes it current again.

var https = require("https");
var store = require("./store");
var jwt = require("./jwt");

var BROWSER_COOKIES = "/var/palm/jail/com.webos.app.browser/mnt/lg/cache/webbrowser/chrome/Cookies";
var HBCHANNEL_EXEC = "luna://org.webosbrew.hbchannel.service/exec";
var BROWSER_CHECK_MIN_INTERVAL_MS = 30 * 1000;
var IMPORT_KEY = "tv_browser_import"; // the viewer's opt-in, stored
var EXPIRING_SOON_MS = 24 * 3600 * 1000;

// Renewal: F1's account API, not the F1TV one in f1tv.js.
var RENEW_HOST = "api.formula1.com";
var RENEW_PATH = "/v1/account/Subscriber/RetrieveSubscriber";
var RENEW_API_KEY = "fCUCjWrKPu9ylJwRAv8BpGLEgiAuThx7";
var RENEW_SYSTEM_ID = "60a9ad84-e93d-480f-80d6-af37494f2e22";
// A request with no User-Agent is refused by the CDN in front of F1's
// hosts - the same trap documented in f1tv.js.
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/133.0.0.0 Safari/537.36";
// Renew once a day's worth of life is left, so a weekend's viewing never
// starts with an expired token.
var RENEW_WHEN_LEFT_MS = 24 * 3600 * 1000;
var RENEW_RETRY_MS = 5 * 60 * 1000;

var service = null;
var lastBrowserCheckAt = 0;
var lastBrowserCheck = null; // {at, found, imported, error} - no token material
// Whether Homebrew Channel's exec answers: null until asked, then fixed for
// this service's life. A TV without root never will.
var homebrewAvailable = null;
var lastRenewal = null; // {at, ok, reason} - no token material
var renewInFlight = null;
var renewBlockedUntil = 0;

function init(svc) {
  service = svc;
}

function expiryMs(token) {
  var claims = jwt.decodePayload(token);
  return claims && claims.exp ? claims.exp * 1000 : 0;
}

// The 30-day login session riding inside the token (see the header).
function sessionIdOf(token) {
  var claims = jwt.decodePayload(token);
  var id = claims && claims.SessionId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function sessionExpiryMs(token) {
  var id = sessionIdOf(token);
  if (!id) return 0;
  var claims = jwt.decodePayload(id);
  return claims && claims.exp ? claims.exp * 1000 : 0;
}

// Carries F1TV's own subscription claims, so it's one of their tokens and
// not something else pasted into the box.
function looksLikeF1Token(token) {
  var claims = jwt.decodePayload(token);
  if (!claims || !claims.exp) return false;
  return "SubscriptionStatus" in claims || "SubscribedProduct" in claims;
}

// A token good to use right now.
function isValidToken(token) {
  return looksLikeF1Token(token) && expiryMs(token) > Date.now();
}

// A token worth keeping: either current, or expired but still renewable
// from its session.
function isUsableToken(token) {
  return looksLikeF1Token(token) && usefulUntil(token) > Date.now();
}

// How long this token can keep the app signed in, renewals included.
function usefulUntil(token) {
  return Math.max(expiryMs(token), sessionExpiryMs(token));
}

// Which of two tokens is worth keeping. Normally the one that lasts longer,
// but a login with a later session behind it wins outright even if its
// token is no fresher: that is someone logging in again to push the monthly
// deadline back, and it must not be discarded just because the TV renewed
// itself minutes earlier. Comparing only usefulUntil got this wrong in the
// other direction - a renewed token shares its session with the one it
// replaces, so it never looked like an improvement at all.
function isImprovement(candidate, current) {
  if (!current) return true;
  var sessionGain = sessionExpiryMs(candidate) - sessionExpiryMs(current);
  if (sessionGain > 24 * 3600 * 1000) return true;
  if (expiryMs(candidate) !== expiryMs(current)) return expiryMs(candidate) > expiryMs(current);
  return sessionGain > 0;
}

// Saves the token only if it improves on the one already stored. Returns
// true when it replaced the stored token.
function offerToken(token, source) {
  token = String(token || "").trim();
  if (!isUsableToken(token)) return false;
  var current = store.get("f1tv_token");
  if (!isImprovement(token, current)) return false;
  store.set("f1tv_token", token);
  store.set("f1tv_token_saved_at", new Date().toISOString());
  store.set("f1tv_token_source", source);
  console.log(
    "[f1hud.service] f1tv token updated from " + source +
    ", expires " + new Date(expiryMs(token)).toISOString() +
    ", session until " + (sessionExpiryMs(token) ? new Date(sessionExpiryMs(token)).toISOString() : "unknown")
  );
  return true;
}

function renewRequest(sessionId) {
  return new Promise(function (resolve, reject) {
    var body = "{}";
    var req = https.request(
      {
        method: "POST",
        host: RENEW_HOST,
        path: RENEW_PATH,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": USER_AGENT,
          apikey: RENEW_API_KEY,
          "CD-SystemId": RENEW_SYSTEM_ID,
          "cd-sessionid": sessionId,
          orderSubmitted: "true",
        },
        timeout: 15000,
      },
      function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          var parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* leave null */ }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end(body);
  });
}

function finishRenewal(ok, reason) {
  lastRenewal = { at: new Date().toISOString(), ok: ok, reason: reason || null };
  if (!ok) renewBlockedUntil = Date.now() + RENEW_RETRY_MS;
  console.log("[f1hud.service] token renewal " + (ok ? "succeeded" : "failed: " + reason));
  return ok;
}

// Trades the stored token's session for a brand new 96h token. Resolves
// true when the stored token was replaced. Never rejects: a failed
// renewal just leaves whatever we had in place.
function renew() {
  if (renewInFlight) return renewInFlight;
  var token = store.get("f1tv_token");
  var sessionId = token && sessionIdOf(token);
  if (!sessionId) return Promise.resolve(finishRenewal(false, "no session in the stored token"));
  if (sessionExpiryMs(token) && sessionExpiryMs(token) <= Date.now()) {
    return Promise.resolve(finishRenewal(false, "session expired - sign in again"));
  }
  if (Date.now() < renewBlockedUntil) return Promise.resolve(false);

  renewInFlight = renewRequest(sessionId)
    .then(function (res) {
      if (res.statusCode === 401 || res.statusCode === 403) {
        return finishRenewal(false, "session rejected - sign in again");
      }
      if (res.statusCode !== 200 || !res.body) {
        return finishRenewal(false, "renewal returned " + res.statusCode);
      }
      var fresh = res.body.data && res.body.data.subscriptionToken;
      if (!isValidToken(fresh)) return finishRenewal(false, "no usable token in the reply");
      if (!offerToken(fresh, "renewal")) return finishRenewal(false, "renewed token was not an improvement");
      return finishRenewal(true, null);
    })
    .catch(function (err) {
      return finishRenewal(false, String((err && err.message) || err));
    })
    .then(function (result) {
      renewInFlight = null;
      return result;
    });
  return renewInFlight;
}

// The token to use for an F1 call, renewed first if it is expired or
// close to it. Resolves null when there's nothing usable and only a
// browser sign-in can fix it.
function freshToken() {
  var token = store.get("f1tv_token");
  if (!token) return Promise.resolve(null);
  if (expiryMs(token) - Date.now() > RENEW_WHEN_LEFT_MS) return Promise.resolve(token);
  return renew().then(function () {
    var current = store.get("f1tv_token");
    return isValidToken(current) ? current : null;
  });
}

// login-session cookie value: URL-encoded JSON {data: {subscriptionToken}}.
function tokenFromCookieValue(raw) {
  try {
    var parsed = JSON.parse(decodeURIComponent(String(raw || "").trim()));
    return parsed && parsed.data && parsed.data.subscriptionToken;
  } catch (e) {
    return null;
  }
}

function execCommand(command, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve({ returnValue: false, timedOut: true, errorText: "timed out" });
    }, timeoutMs);
    service.call(HBCHANNEL_EXEC, { command: command }, function (message) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(message.payload || {});
    });
  });
}

// Asks Homebrew Channel's service to run a no-op, once. A timeout leaves
// the answer open so the next look asks again; a refusal is final.
function probeHomebrew() {
  if (!service) return Promise.resolve(false);
  if (homebrewAvailable !== null) return Promise.resolve(homebrewAvailable);
  return execCommand("true", 6000).then(function (p) {
    if (p.returnValue) homebrewAvailable = true;
    else if (!p.timedOut) homebrewAvailable = false;
    console.log("[f1hud.service] Homebrew Channel exec " + (p.returnValue ? "available" : "unavailable: " + p.errorText));
    return !!homebrewAvailable;
  });
}

function importEnabled() {
  return store.get(IMPORT_KEY) === true;
}

function setTvBrowserImport(enabled) {
  if (enabled) {
    store.set(IMPORT_KEY, true);
    return checkTvBrowser(true);
  }
  store.delete(IMPORT_KEY);
  lastBrowserCheck = null;
  return Promise.resolve(null);
}

// Reads the formula1.com login from the TV browser, when the viewer allowed
// it and Homebrew Channel is there to do the reading.
function checkTvBrowser(force) {
  if (!service) return Promise.resolve(lastBrowserCheck);
  return probeHomebrew().then(function (available) {
    if (!available || !importEnabled()) return null;
    return readTvBrowser(force);
  });
}

function readTvBrowser(force) {
  if (!force && Date.now() - lastBrowserCheckAt < BROWSER_CHECK_MIN_INTERVAL_MS) {
    return Promise.resolve(lastBrowserCheck);
  }
  lastBrowserCheckAt = Date.now();

  // Copy first: the browser may hold the live database open. The copy is
  // private to root, and removed straight after the query.
  var tmp = "/tmp/f1hud-cookies-" + process.pid + ".db";
  var command =
    "umask 077; cp '" + BROWSER_COOKIES + "' " + tmp + " 2>/dev/null && " +
    "sqlite3 " + tmp + " \"select value from cookies where host_key like '%formula1.com' " +
    "and name='login-session' order by expires_utc desc limit 1;\"; rm -f " + tmp;

  return execCommand(command, 6000).then(function (p) {
    if (!p.returnValue) {
      lastBrowserCheck = { at: new Date().toISOString(), found: false, imported: false, error: p.errorText || "exec failed" };
      return lastBrowserCheck;
    }
    // A browser that was logged in days ago still holds the token from
    // that login, expired by now - but its session renews, so it counts
    // as a find. Before renewal existed this looked like "nothing
    // happened" to anyone importing from an already-logged-in browser.
    var token = tokenFromCookieValue(p.stdoutString);
    var found = !!token && isUsableToken(token);
    lastBrowserCheck = {
      at: new Date().toISOString(),
      found: found,
      expiresAt: found ? new Date(expiryMs(token)).toISOString() : null,
      imported: found && offerToken(token, "tv-browser"),
      error: null,
    };
    return lastBrowserCheck;
  });
}

function status() {
  var token = store.get("f1tv_token");
  var exp = token ? expiryMs(token) : 0;
  var sessionExp = token ? sessionExpiryMs(token) : 0;
  var now = Date.now();
  // What the sign-in screen should actually count down to: the session,
  // since everything up to it is renewed without anyone doing anything.
  var renewable = sessionExp > now;
  return {
    hasToken: !!token && exp > now,
    expired: !!token && exp <= now,
    expiresAt: exp ? new Date(exp).toISOString() : null,
    hoursLeft: exp ? Math.max(0, Math.round(((exp - now) / 3600000) * 10) / 10) : 0,
    expiringSoon: !!token && exp > now && exp - now < EXPIRING_SOON_MS && !renewable,
    renewable: renewable,
    sessionExpiresAt: sessionExp ? new Date(sessionExp).toISOString() : null,
    sessionDaysLeft: renewable ? Math.max(0, Math.round(((sessionExp - now) / 86400000) * 10) / 10) : 0,
    lastRenewal: lastRenewal,
    savedAt: store.get("f1tv_token_saved_at") || null,
    source: store.get("f1tv_token_source") || null,
    tvBrowserCheck: lastBrowserCheck,
    tvBrowserImport: { available: homebrewAvailable === true, enabled: importEnabled() },
  };
}

module.exports = {
  init: init,
  offerToken: offerToken,
  isValidToken: isValidToken,
  isUsableToken: isUsableToken,
  renew: renew,
  freshToken: freshToken,
  checkTvBrowser: checkTvBrowser,
  setTvBrowserImport: setTvBrowserImport,
  status: status,
};
