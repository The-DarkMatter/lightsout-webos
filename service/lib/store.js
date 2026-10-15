// Tiny persistent JSON store for the service. webOS services run in a
// permissions-restricted environment and the docs only promise a service
// can write its own data under /media/internal - but we haven't yet seen
// what the *actual* runtime uid/permissions are when Luna itself launches
// this service (as opposed to our raw dev-mode ssh shell), so this tries a
// short list of candidate locations and falls back to memory-only (with a
// loud warning) rather than crashing. Once we see which one actually works
// on this device, trim the list down and note it in the plan.

var fs = require("fs");
var path = require("path");

var CANDIDATE_DIRS = [
  // Set by scripts/dev-server.js so a PC run keeps its own state in the
  // repo's .dev/ folder, never on the TV's paths.
  process.env.LIGHTSOUT_STATE_DIR || null,
  "/media/internal/lightsout",
  process.env.HOME ? path.join(process.env.HOME, "lightsout") : null,
  "/tmp/lightsout", // last resort: doesn't survive reboot, but better than nothing
];

var STATE_FILE = "state.json";

function tryDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    var probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function Store() {
  this.dir = null;
  for (var i = 0; i < CANDIDATE_DIRS.length; i++) {
    var dir = CANDIDATE_DIRS[i];
    if (dir && tryDir(dir)) {
      this.dir = dir;
      break;
    }
  }
  this.data = {};
  if (this.dir) {
    this.file = path.join(this.dir, STATE_FILE);
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      this.data = {};
    }
    console.log("[lightsout.service] store persisting to", this.file);
  } else {
    console.warn(
      "[lightsout.service] WARNING: no writable dir found among",
      CANDIDATE_DIRS.filter(Boolean).join(", "),
      "- running memory-only, state will not survive a restart"
    );
  }
}

Store.prototype.get = function (key) {
  return this.data[key];
};

Store.prototype.set = function (key, value) {
  this.data[key] = value;
  this._flush();
  return value;
};

Store.prototype.delete = function (key) {
  delete this.data[key];
  this._flush();
};

Store.prototype._flush = function () {
  if (!this.file) return;
  try {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  } catch (e) {
    console.error("[lightsout.service] store flush failed:", e && e.message);
  }
};

module.exports = new Store();
