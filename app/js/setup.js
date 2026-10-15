// Sign-in screen. Shows whether the TV has a current F1 TV sign-in, and the
// ways to get one (see service/lib/auth.js for why a username and password
// can't be used): a QR code to the LAN setup page, which sets up a phone
// bookmark, and - on a TV with Homebrew Channel, once the viewer allows it -
// a button that opens F1's login in the TV's own browser.
//
// Polls getAuthStatus, which also imports a newer login from the TV browser
// when that's allowed, so either route lands here without pressing anything. The polling is also
// what keeps the service - and the LAN setup page with it - alive while a
// phone is being used.

// callService() (Luna on the TV, the dev server on a PC) comes
// from js/luna.js, loaded before this file.

var F1_LOGIN_URL = "https://account.formula1.com/#/en/login";

function renderQr(text) {
  var qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  document.getElementById("qr").innerHTML = qr.createSvgTag(6, 8);
}

function setStatus(text, cls) {
  var el = document.getElementById("status");
  el.textContent = text;
  el.className = cls;
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatHours(h) {
  if (h >= 48) return Math.floor(h / 24) + " days";
  if (h >= 1) return Math.round(h) + " hours";
  return "under an hour";
}

var pollTimer = null;
// Arrived here without a working sign-in (from index.html, or a banner):
// once one shows up, move on to Browse by itself. Arriving from the gear
// icon with a sign-in already in place, stay put.
var cameSignedIn = null;

function showAuth(res) {
  var signedIn = !!res.hasToken;
  if (cameSignedIn === null) cameSignedIn = signedIn;

  if (signedIn && res.renewable) {
    // The 4-day pass renews itself, so the date worth showing is the one
    // that ends it all (service/lib/auth.js).
    setStatus("Signed in, renewing itself until " + formatWhen(res.sessionExpiresAt), "ok");
  } else if (signedIn) {
    setStatus(
      "Signed in until " + formatWhen(res.expiresAt) + " (" + formatHours(res.hoursLeft) + " left)" +
        (res.expiringSoon ? " - renew soon" : ""),
      res.expiringSoon ? "pending" : "ok"
    );
  } else if (res.expired) {
    setStatus("Your sign-in expired " + formatWhen(res.expiresAt) + ". Sign in again below.", "fail");
  } else {
    setStatus("Not signed in yet.", "fail");
  }

  document.getElementById("browse-link").style.display = signedIn ? "inline-block" : "none";
  showTvBrowserImport(res.tvBrowserImport || {});
  // Something for OK on the remote to press straight away.
  if (!document.activeElement || document.activeElement === document.body) {
    var first = focusables()[0];
    if (first) first.focus();
  }
  document.getElementById("play-test").style.display = signedIn ? "block" : "none";

  if (signedIn && !cameSignedIn) {
    setStatus("Signed in until " + formatWhen(res.renewable ? res.sessionExpiresAt : res.expiresAt) + ". Opening Browse…", "ok");
    clearInterval(pollTimer);
    setTimeout(function () { window.location.href = "browse.html"; }, 1500);
  }
}

// The TV-browser route needs Homebrew Channel, and the viewer's say-so
// before the app reads anything from that browser.
function showTvBrowserImport(state) {
  var shown = function (id, on) { document.getElementById(id).style.display = on ? "" : "none"; };
  shown("tv-browser", state.available);
  shown("tv-browser-note", !state.enabled);
  shown("tv-browser-allow", !state.enabled);
  shown("tv-browser-btn", state.enabled);
  shown("tv-browser-off", state.enabled);
}

function setTvBrowserImport(enabled) {
  callService("setTvBrowserImport", { enabled: enabled })
    .then(function (res) {
      showAuth(res);
      var next = document.getElementById(enabled ? "tv-browser-btn" : "tv-browser-allow");
      if (next.offsetParent !== null) next.focus();
    })
    .catch(function (err) {
      setStatus("Could not change that setting: " + (err.errorText || JSON.stringify(err)), "fail");
    });
}

document.getElementById("tv-browser-allow").addEventListener("click", function () { setTvBrowserImport(true); });
document.getElementById("tv-browser-off").addEventListener("click", function () { setTvBrowserImport(false); });

// The D-pad's arrows don't move focus by themselves. Up/Down (and
// Left/Right) step through the controls in page order.
function focusables() {
  return Array.prototype.slice
    .call(document.querySelectorAll("#left a[href], #left button, #left summary"))
    .filter(function (el) { return el.offsetParent !== null; });
}

document.addEventListener("keydown", function (e) {
  var step = { 37: -1, 38: -1, 39: 1, 40: 1 }[e.keyCode];
  if (!step) return;
  if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  var list = focusables();
  if (!list.length) return;
  var i = list.indexOf(document.activeElement);
  var next = list[Math.max(0, Math.min(list.length - 1, i === -1 ? 0 : i + step))];
  next.focus();
  e.preventDefault();
});

function poll(forceBrowserCheck) {
  callService("getAuthStatus", forceBrowserCheck ? { forceBrowserCheck: true } : {})
    .then(showAuth)
    .catch(function (err) {
      setStatus("Could not reach the app's service: " + JSON.stringify(err), "fail");
    });
}

function init() {
  callService("getSetupInfo")
    .then(function (res) {
      if (res.dev) return showPcSignIn(res);
      if (!res.setupUrl) {
        document.getElementById("url").textContent = "Could not find this TV's network address. Is it on Wi-Fi or Ethernet?";
        return;
      }
      document.getElementById("url").textContent = res.setupUrl;
      // The QR code carries the pairing code, so a phone that scans it is
      // never asked; it's also shown for one that didn't.
      renderQr(res.pairingCode ? res.setupUrl + "?code=" + res.pairingCode : res.setupUrl);
      showPairingCode(res.pairingCode);
    })
    .catch(function (err) {
      document.getElementById("url").textContent = "getSetupInfo failed: " + JSON.stringify(err);
    });

  poll(true);
  pollTimer = setInterval(function () { poll(false); }, 3000);
}

// Dev app on a PC (scripts/dev-server.js): no phone or TV browser to use,
// so swap those for a paste box and a draggable bookmark. The polling above
// still moves on to Browse once a sign-in is saved.
function showPcSignIn(res) {
  document.getElementById("tv-options").style.display = "none";
  document.getElementById("qr-card").style.display = "none";
  document.getElementById("pc-signin").style.display = "block";
  var link = document.getElementById("pc-bookmarklet");
  link.href = res.bookmarklet;
  link.addEventListener("click", function (e) {
    e.preventDefault(); // it's for dragging; run here it would find no F1 login
  });
  document.getElementById("pc-pair-code").textContent = res.pairingCode || "";
}

// "123456" -> "123 456", easier to read across a room.
function showPairingCode(code) {
  if (!code) return;
  document.getElementById("pair-code").textContent = code.slice(0, 3) + " " + code.slice(3);
  document.getElementById("pair").style.display = "block";
}

document.getElementById("pc-save").addEventListener("click", function () {
  var out = document.getElementById("pc-result");
  var field = document.getElementById("pc-token");
  out.className = "pending";
  out.textContent = "Saving…";
  callService("devSaveToken", { token: field.value })
    .then(function (res) {
      field.value = "";
      out.className = res.saved ? "ok" : "pending";
      out.textContent = res.message;
      poll(false);
    })
    .catch(function (err) {
      out.className = "fail";
      out.textContent = err.errorText || JSON.stringify(err);
    });
});

// Opens F1's login in the TV's built-in browser. Coming back to the app
// fires visibilitychange, which forces an immediate re-check.
document.getElementById("tv-browser-btn").addEventListener("click", function () {
  if (!window.PalmServiceBridge) {
    window.open(F1_LOGIN_URL, "_blank");
    return;
  }
  webOS.service.request("luna://com.webos.applicationManager", {
    method: "launch",
    parameters: { id: "com.webos.app.browser", params: { target: F1_LOGIN_URL } },
    onFailure: function (err) {
      setStatus("Could not open the TV browser: " + (err.errorText || JSON.stringify(err)), "fail");
    },
  });
});

document.addEventListener("visibilitychange", function () {
  if (!document.hidden) poll(true);
});

document.getElementById("play-test-btn").addEventListener("click", function () {
  var contentId = document.getElementById("content-id").value.trim();
  var out = document.getElementById("play-result");
  if (!contentId) {
    out.textContent = "Enter a contentId first.";
    return;
  }
  out.textContent = "calling f1tvPlayTest…";
  callService("f1tvPlayTest", { contentId: contentId })
    .then(function (res) {
      out.textContent = JSON.stringify(res, null, 2);
    })
    .catch(function (err) {
      out.textContent = "FAILED: " + JSON.stringify(err, null, 2);
    });
});

document.getElementById("page-test-btn").addEventListener("click", function () {
  var pageId = document.getElementById("page-id").value.trim();
  var out = document.getElementById("page-result");
  if (!pageId) {
    out.textContent = "Enter a pageId first.";
    return;
  }
  out.textContent = "calling f1tvPage…";
  callService("f1tvPage", { pageId: pageId })
    .then(function (res) {
      if (!res.returnValue) {
        out.textContent = "FAILED: " + JSON.stringify(res, null, 2);
        return;
      }
      var trays = (res.body && res.body.resultObj && res.body.resultObj.containers) || [];
      if (!trays.length) {
        out.textContent = "status=" + res.statusCode + "\n" + JSON.stringify(res.body).slice(0, 1500);
        return;
      }
      // Real shape: top-level containers are trays (e.g. "Live & Replays");
      // the actual watchable items are nested one level deeper in
      // retrieveItems.resultObj.containers, with a contentSubtype field
      // (REPLAY when nothing's live - watch for it flipping to something
      // else, e.g. LIVE, once a session starts).
      var lines = [];
      trays.forEach(function (tray) {
        var items = (tray.retrieveItems && tray.retrieveItems.resultObj && tray.retrieveItems.resultObj.containers) || [];
        if (!items.length) return;
        lines.push("[" + (tray.title || tray.layout) + "]");
        items.forEach(function (item) {
          var m = item.metadata || {};
          lines.push(
            "  contentId=" + (m.contentId || item.id) +
            "  subtype=" + m.contentSubtype +
            "  title=" + (m.title || "").slice(0, 50)
          );
        });
      });
      out.textContent = "status=" + res.statusCode + "  (" + trays.length + " trays)\n\n" +
        (lines.length ? lines.join("\n") : "(no nested items found - trays may need a follow-up fetch)");
    })
    .catch(function (err) {
      out.textContent = "FAILED: " + JSON.stringify(err, null, 2);
    });
});

// Developer toggle: whether the player shows its manual-load panel. Kept in
// this page's storage rather than the service, since it only changes what a
// page draws. js/watch.js reads the same key.
var DEBUG_PANEL_KEY = "lightsout.devtools.panel";

function debugPanelOn() {
  try {
    return window.localStorage.getItem(DEBUG_PANEL_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function paintDebugPanelBtn() {
  var btn = document.getElementById("debug-panel-btn");
  var on = debugPanelOn();
  btn.textContent = on ? "On" : "Off";
  btn.style.background = on ? "#1f6b3f" : "#2a2a30";
}

document.getElementById("debug-panel-btn").addEventListener("click", function () {
  try {
    window.localStorage.setItem(DEBUG_PANEL_KEY, debugPanelOn() ? "0" : "1");
  } catch (e) { /* private mode: the toggle just won't stick */ }
  paintDebugPanelBtn();
});
paintDebugPanelBtn();

init();
