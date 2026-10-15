// Runs the app in a desktop browser on the PC, without deploying to the TV.
//
//   node scripts/dev-server.js          against the real F1 TV API
//   node scripts/dev-server.js --mock   canned data, no sign-in, no network
//   then open http://localhost:8788/browse.html
//
// Real mode loads the actual service (service/index.js) in this Node
// process, with the webOS Luna bus swapped for a stand-in, and serves app/
// over HTTP. Pages' callService() (app/js/luna.js) posts to /api/<method>.
// Mock mode skips the service and injects dev/mocks.js into each page, which
// answers instead - see that file for its preview switches. Either way
// dev/fit-window.js is injected too, scaling the 1920x1080 canvas to the
// window. Nothing under dev/ ships in the package.
//
// Sign-in (real mode): the service's own setup server comes up on
// http://localhost:8787/setup (with its pairing code), bound to loopback.
// Log in on formula1.com in this PC's browser, then use the sign-in
// screen's paste box or bookmark. The token is stored in .dev/state.json
// (gitignored), not copied from the TV. The TV-browser import is TV-only
// and reports as unavailable here; LIGHTSOUT_DEV_HOMEBREW=1 fakes a rooted TV
// to show it.

var fs = require("fs");
var http = require("http");
var path = require("path");
var Module = require("module");

var ROOT = path.resolve(__dirname, "..");
var APP_DIR = path.join(ROOT, "app");
var DEV_DIR = path.join(ROOT, "dev");
var PORT = Number(process.env.PORT) || 8788;
var MOCK = process.argv.indexOf("--mock") !== -1;

process.env.LIGHTSOUT_STATE_DIR = path.join(ROOT, ".dev");
process.env.LIGHTSOUT_SETUP_HOST = "127.0.0.1";
process.env.LIGHTSOUT_DEV = "1";

var handlers = {};
var setupServer = null;
if (!MOCK) startService();

function startService() {
  // --- Luna bus stand-in ----------------------------------------------------

  function DevService(name) {
    this.name = name;
  }
  DevService.prototype.register = function (method, fn) {
    handlers[method] = fn;
    return { on: function () {} };
  };
  // Only auth.js calls out (Homebrew Channel's exec, for the TV browser
  // import). There's no Luna bus on a PC, so answer the way a missing
  // service would - or, with LIGHTSOUT_DEV_HOMEBREW=1, like a rooted TV whose
  // browser holds no F1 login, to see the sign-in screen's import controls.
  DevService.prototype.call = function (uri, params, cb) {
    setImmediate(function () {
      if (process.env.LIGHTSOUT_DEV_HOMEBREW === "1") {
        return cb({ payload: { returnValue: true, stdoutString: "" } });
      }
      cb({ payload: { returnValue: false, errorText: "dev-server: no Luna bus on this PC (" + uri + ")" } });
    });
  };

  var originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "webos-service") return DevService;
    return originalLoad.apply(this, arguments);
  };

  require(path.join(ROOT, "service", "index.js"));

  // Dev-only sign-in, behind the sign-in screen's paste box on this PC. Takes
  // either the login-session cookie value (URL-encoded JSON) or the bare token.
  var auth = require(path.join(ROOT, "service", "lib", "auth.js"));
  setupServer = require(path.join(ROOT, "service", "lib", "setupServer.js"));
  handlers.devSaveToken = function (message) {
    var raw = String((message.payload && message.payload.token) || "").trim();
    var token = raw;
    if (raw && raw.indexOf("eyJ") !== 0) {
      try {
        token = JSON.parse(decodeURIComponent(raw)).data.subscriptionToken;
      } catch (e) {
        token = "";
      }
    }
    if (!token) {
      return message.respond({ returnValue: false, errorText: "That doesn't look like the login-session cookie or a token." });
    }
    // Usable, not valid: an expired token whose 30-day session is alive
    // still signs us in, because auth.renew() turns it back into a current
    // one (service/lib/auth.js).
    if (!auth.isUsableToken(token)) {
      return message.respond({ returnValue: false, errorText: "That isn't a current F1 TV sign-in. Log in on formula1.com again and copy it fresh." });
    }
    if (!auth.offerToken(token, "pc")) {
      return message.respond({ returnValue: true, saved: false, message: "Already signed in with one that lasts at least as long." });
    }
    message.respond({ returnValue: true, saved: true, message: "Signed in. Opening Browse…" });
  };
}

// --- HTTP -----------------------------------------------------------------
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function callMethod(method, payload) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      resolve({ returnValue: false, errorText: "dev-server: '" + method + "' did not respond within 30s" });
    }, 30000);
    handlers[method]({
      payload: payload,
      respond: function (response) {
        clearTimeout(timer);
        resolve(response);
      },
    });
  });
}

function handleApi(req, res, method) {
  if (req.method !== "POST") return sendJson(res, 405, { returnValue: false, errorText: "POST only" });
  if (!handlers[method]) return sendJson(res, 404, { returnValue: false, errorText: "no service method '" + method + "'" });
  var chunks = [];
  req.on("data", function (c) { chunks.push(c); });
  req.on("end", function () {
    var payload = {};
    try {
      var text = Buffer.concat(chunks).toString("utf8");
      if (text) payload = JSON.parse(text);
    } catch (e) {
      return sendJson(res, 400, { returnValue: false, errorText: "body is not JSON" });
    }
    var started = Date.now();
    callMethod(method, payload).then(function (response) {
      // Method name and timing only: responses can carry tokens.
      console.log("[dev-server] " + method + " -> " + (response && response.returnValue === false ? "failed" : "ok") + " (" + (Date.now() - started) + "ms)");
      sendJson(res, 200, response);
    });
  });
}

// Dev-only scripts go in ahead of luna.js, so they're in place before any
// page code calls the service.
var DEV_SCRIPTS =
  '<script src="/__dev/fit-window.js"></script>' +
  (MOCK ? '<script src="/__dev/mock-browse.js"></script><script src="/__dev/mocks.js"></script>' : "");

function handleStatic(req, res, pathname) {
  if (pathname === "/") {
    res.writeHead(302, { Location: "/browse.html" });
    return res.end();
  }
  var dev = pathname.indexOf("/__dev/") === 0;
  var base = dev ? DEV_DIR : APP_DIR;
  var file = path.normalize(path.join(base, decodeURIComponent(dev ? pathname.slice(6) : pathname)));
  if (file.indexOf(base + path.sep) !== 0) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found: " + pathname);
    }
    var ext = path.extname(file).toLowerCase();
    if (ext === ".html") {
      data = data.toString("utf8").replace('<script src="js/luna.js"></script>', DEV_SCRIPTS + '<script src="js/luna.js"></script>');
    }
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

http
  .createServer(function (req, res) {
    var pathname = req.url.split("?")[0];
    var api = pathname.match(/^\/api\/([A-Za-z0-9_]+)$/);
    if (api && !MOCK) return handleApi(req, res, api[1]);
    handleStatic(req, res, pathname);
  })
  .listen(PORT, "127.0.0.1", function () {
    console.log("");
    console.log("Lights Out dev server (" + (MOCK ? "mock data" : "real F1 TV API") + ")");
    console.log("  App:     http://localhost:" + PORT + "/browse.html");
    if (!MOCK) {
      console.log("  Sign in: http://localhost:8787/setup?code=" + setupServer.pairingCode());
      console.log("  State:   " + process.env.LIGHTSOUT_STATE_DIR);
    }
    console.log("");
  });
