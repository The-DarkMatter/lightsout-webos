// Small HTTP server bound to the TV's LAN interface (not loopback - this one
// needs to be reachable from your phone/PC) for getting an F1TV sign-in onto
// the TV without typing on it. The TV's sign-in screen shows a QR code
// pointing here.
//
// The main route is a bookmarklet. After logging in on formula1.com on a
// phone (where a password manager can fill the password), tapping the
// bookmark reads the `login-session` cookie - F1's page writes it from
// script, so it isn't HttpOnly - and navigates to /setup/receive on this
// server with the token in the URL fragment. That page posts it back here.
// A top-level navigation from an https page to this http address is
// allowed, where a fetch from that page would be blocked as mixed content
// and private-network access. The fragment is never sent over the network
// in the request line, and the receive page wipes it from history.
//
// Pasting the token by hand stays available as a fallback.
//
// Only runs while the app's service is alive. webOS stops an idle service
// within seconds, and only the TV's sign-in screen polls it continuously, so
// that screen has to be open while a phone sends a sign-in.

var http = require("http");
var os = require("os");
var url = require("url");
var auth = require("./auth");

var PORT = 8787;

function getLanAddress() {
  var ifaces = os.networkInterfaces();
  for (var name in ifaces) {
    var addrs = ifaces[name] || [];
    for (var i = 0; i < addrs.length; i++) {
      var a = addrs[i];
      if (a.family === "IPv4" && !a.internal) {
        return a.address;
      }
    }
  }
  return null;
}

function readBody(req, cb) {
  var chunks = [];
  var total = 0;
  req.on("data", function (c) {
    total += c.length;
    if (total > 64 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", function () {
    cb(Buffer.concat(chunks).toString("utf8"));
  });
}

function parseFormOrJson(req, body) {
  var ct = req.headers["content-type"] || "";
  if (ct.indexOf("application/json") !== -1) {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  var out = {};
  body.split("&").forEach(function (pair) {
    var idx = pair.indexOf("=");
    if (idx === -1) return;
    var k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, " "));
    var v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    out[k] = v;
  });
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// The bookmark's code. No literal "#" (some browsers treat it as the start
// of a fragment inside a javascript: URL) and no "%" (bookmark storage may
// percent-decode it), hence \x23.
function bookmarklet(host) {
  return (
    "javascript:(function(){" +
    "var m=document.cookie.match(/(?:^|;\\s*)login-session=([^;]+)/);" +
    "if(!m){alert('Not logged in here yet. Log in on formula1.com, then tap this bookmark again.');return;}" +
    "var t;try{t=JSON.parse(decodeURIComponent(m[1])).data.subscriptionToken;}catch(e){}" +
    "if(!t){alert('Found an F1 login, but could not read its token.');return;}" +
    "location.href='http://" + host + ":" + PORT + "/setup/receive\\x23t='+encodeURIComponent(t);" +
    "})();"
  );
}

// How a save attempt went, in words for the person holding the phone.
// Async because a sign-in that has already run past its 96 hours is still
// worth taking - one renewal call makes it current again (see auth.js), so
// an old browser login doesn't have to be repeated.
function saveResult(token, cb) {
  if (!String(token || "").trim()) return cb({ saved: false, message: "Nothing was received." });
  if (!auth.isUsableToken(token)) {
    return cb({ saved: false, message: "That isn't a current F1 TV sign-in. It may be more than a month old - log in on formula1.com again and retry." });
  }
  if (!auth.offerToken(token, "phone")) {
    return cb({ saved: false, message: "The TV already has a sign-in that lasts at least as long, so nothing changed." });
  }
  if (auth.isValidToken(token)) return cb({ saved: true, message: "Signed in. You can go back to the TV." });
  auth.renew().then(function (ok) {
    cb(
      ok
        ? { saved: true, message: "Signed in, and refreshed from an older login. You can go back to the TV." }
        : { saved: false, message: "That sign-in had expired and could not be refreshed. Log in on formula1.com again, then retry." }
    );
  });
}

var STYLE =
  "body{font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px 18px 48px;background:#0b0b0d;color:#f2f2f2;line-height:1.5}" +
  "h1{color:#e10600;font-size:26px;margin:0 0 16px}h2{font-size:18px;margin:28px 0 8px}" +
  "ol{padding-left:22px}li{margin:6px 0}" +
  "textarea{width:100%;height:110px;font-family:monospace;font-size:12px;background:#16161a;color:#f2f2f2;" +
  "border:1px solid #2a2a30;border-radius:8px;padding:10px;box-sizing:border-box}" +
  "button{background:#e10600;color:#fff;border:none;padding:12px 20px;border-radius:8px;font-size:16px;margin-top:10px}" +
  "button.secondary{background:#2a2a30}" +
  ".card{padding:12px 14px;border-radius:10px;margin-bottom:8px;background:#16161a;border:1px solid #2a2a30}" +
  ".ok{border-color:#1f6b3f;color:#3ddc84}.warn{border-color:#6b5a1f;color:#ffcc00}.bad{border-color:#6b1f1f;color:#ff7a7a}" +
  "details{margin-top:28px}summary{cursor:pointer;opacity:.7}code{background:#16161a;padding:1px 5px;border-radius:4px}";

// Renders an ISO date in the phone's own locale and time zone.
var LOCAL_TIME_SCRIPT =
  "<script>document.querySelectorAll('[data-time]').forEach(function(el){" +
  "el.textContent=new Date(el.getAttribute('data-time')).toLocaleString([], {weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});});</script>";

// What the TV's sign-in state means for the person reading it. The date
// that matters is the session's: everything before it the TV refreshes on
// its own (see auth.js).
function statusCard(status) {
  if (status.hasToken && status.renewable) {
    return (
      "<div class='card ok'>Signed in, and renewing itself until <b data-time='" +
      escapeHtml(status.sessionExpiresAt) + "'></b>." +
      "<br><small>Current pass runs out <span data-time='" + escapeHtml(status.expiresAt) +
      "'></span>, then the TV fetches another by itself.</small></div>"
    );
  }
  if (status.hasToken) {
    return (
      "<div class='card " + (status.expiringSoon ? "warn" : "ok") + "'>Signed in until <b data-time='" +
      escapeHtml(status.expiresAt) + "'></b>" + (status.expiringSoon ? " - renew soon" : "") + "</div>"
    );
  }
  if (status.renewable) {
    return (
      "<div class='card warn'>The TV's pass ran out, but its sign-in is good until <b data-time='" +
      escapeHtml(status.sessionExpiresAt) + "'></b> - open the app and it will fetch a new one.</div>"
    );
  }
  if (status.expired) {
    return "<div class='card bad'>The TV's sign-in expired on <b data-time='" + escapeHtml(status.expiresAt) + "'></b>.</div>";
  }
  return "<div class='card bad'>The TV isn't signed in yet.</div>";
}

function setupPage(host, message) {
  var status = auth.status();
  var code = bookmarklet(host);
  return (
    "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>F1 HUD sign-in</title><style>" + STYLE + "</style></head><body>" +
    "<h1>Sign the TV in to F1 TV</h1>" +
    (message ? "<div class='card " + (message.saved ? "ok" : "bad") + "'>" + escapeHtml(message.message) + "</div>" : "") +
    statusCard(status) +
    "<p>One sign-in lasts <b>30 days</b>. F1 only issues 4-day passes, but the TV quietly swaps in a new one " +
    "as each runs out, so you only come back here about once a month.</p>" +

    "<h2>Once: add the bookmark</h2>" +
    "<p><b>Chrome and Edge on Android refuse to run bookmarks like this one</b> - they block the whole " +
    "category, so there is nothing to fix on our side. Use <b>Firefox for Android</b>, or any desktop " +
    "browser, where it works. Otherwise skip to signing in on the TV's own browser.</p>" +
    "<ol>" +
    "<li>Tap <b>Copy</b> to copy the bookmark code.</li>" +
    "<li>Bookmark this page (or any page), then edit that bookmark.</li>" +
    "<li>Name it <b>Send F1 to TV</b> and replace its address with the copied code. Save.</li>" +
    "</ol>" +
    "<textarea id='code' readonly>" + escapeHtml(code) + "</textarea>" +
    "<button id='copy'>Copy</button> <span id='copied'></span>" +

    "<h2>Once a month: sign in</h2>" +
    "<ol>" +
    "<li>On the TV, open the F1 HUD app's sign-in screen (the gear icon on Browse) and leave it there.</li>" +
    "<li>On this phone, open <b>formula1.com</b> and log in. Your password manager can fill it in.</li>" +
    "<li>While still on formula1.com, tap the address bar, type <b>Send F1 to TV</b> and tap the bookmark.</li>" +
    "</ol>" +
    "<p>The phone jumps to a confirmation page, and the TV picks the sign-in up within a few seconds.</p>" +

    "<h2>Or sign in on the TV itself</h2>" +
    "<p>Log in to <b>formula1.com</b> in the TV's own web browser, then come back to the app's sign-in " +
    "screen - it reads that login straight across, and the browser remembers your password for next " +
    "month. A login already sitting in that browser works too, even an old one.</p>" +

    "<details><summary>Paste a token by hand instead</summary>" +
    "<form method='POST' action='/setup'>" +
    "<p>The subscription token is the <code>data.subscriptionToken</code> value inside the " +
    "<code>login-session</code> cookie on formula1.com.</p>" +
    "<textarea name='token' placeholder='eyJ...'></textarea><br>" +
    "<button type='submit'>Save</button></form></details>" +

    "<script>document.getElementById('copy').onclick=function(){var t=document.getElementById('code');" +
    "t.focus();t.select();t.setSelectionRange(0,t.value.length);var ok=false;try{ok=document.execCommand('copy');}catch(e){}" +
    "document.getElementById('copied').textContent=ok?'Copied':'Select the text and copy it';};</script>" +
    LOCAL_TIME_SCRIPT +
    "</body></html>"
  );
}

// Landing page for the bookmarklet. The token arrives in the fragment,
// gets posted back to this server, and is then wiped from the address bar
// and history.
function receivePage() {
  return (
    "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>F1 HUD sign-in</title><style>" + STYLE + "</style></head><body>" +
    "<h1>Sending your sign-in to the TV</h1>" +
    "<div id='result' class='card'>Sending&hellip;</div>" +
    "<p><a href='/setup' style='color:#e10600'>Sign-in page</a></p>" +
    "<script>(function(){" +
    "var el=document.getElementById('result');" +
    "var m=/[#&]t=([^&]+)/.exec(location.hash);" +
    "history.replaceState(null,'',location.pathname);" +
    "if(!m){el.className='card bad';el.textContent='No sign-in arrived. Run the bookmark from a logged-in formula1.com page.';return;}" +
    "var x=new XMLHttpRequest();x.open('POST','/setup/token');x.setRequestHeader('Content-Type','application/json');" +
    "x.onload=function(){var r={};try{r=JSON.parse(x.responseText);}catch(e){}" +
    "el.className='card '+(r.saved?'ok':'bad');el.textContent=r.message||('Unexpected reply ('+x.status+')');};" +
    "x.onerror=function(){el.className='card bad';el.textContent='Could not reach the TV. Open the sign-in screen in the F1 HUD app, then tap the bookmark again.';};" +
    "x.send(JSON.stringify({token:decodeURIComponent(m[1])}));" +
    "})();</script></body></html>"
  );
}

function start() {
  var server = http.createServer(function (req, res) {
    var parsed = url.parse(req.url);
    // The address the phone used to reach this page is, by definition, one
    // it can reach again - safer for the bookmark than guessing among the
    // TV's interfaces.
    var host = String(req.headers.host || "").replace(/:\d+$/, "") || getLanAddress() || "localhost";

    if (req.method === "GET" && parsed.pathname === "/setup") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(setupPage(host, null));
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/setup/receive") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(receivePage());
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/setup/status.json") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(auth.status()));
      return;
    }

    // Bookmarklet route (JSON in, JSON out).
    if (req.method === "POST" && parsed.pathname === "/setup/token") {
      readBody(req, function (body) {
        saveResult(parseFormOrJson(req, body).token, function (result) {
          res.writeHead(result.saved ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        });
      });
      return;
    }

    // Manual paste form.
    if (req.method === "POST" && parsed.pathname === "/setup") {
      readBody(req, function (body) {
        saveResult(parseFormOrJson(req, body).token, function (result) {
          res.writeHead(result.saved ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(setupPage(host, result));
        });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.on("error", function (err) {
    console.error("[f1hud.service] setup server error:", err && err.message);
  });

  // scripts/dev-server.js sets 127.0.0.1 so a PC run isn't reachable from
  // the LAN; the TV needs 0.0.0.0 so a phone can reach it.
  var host = process.env.F1HUD_SETUP_HOST || "0.0.0.0";
  server.listen(PORT, host, function () {
    console.log("[f1hud.service] setup server listening on " + host + ":" + PORT);
  });

  return server;
}

module.exports = {
  start: start,
  getLanAddress: getLanAddress,
  bookmarklet: bookmarklet,
  PORT: PORT,
};
