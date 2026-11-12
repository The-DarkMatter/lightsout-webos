// Tiny persistent JSON store for the service. It holds the viewer's F1 TV
// sign-in, so it lives where an uninstall removes it: a state/ folder inside
// the service's own install directory.
//
// Measured on an LG C5 (webOS 25 / 10.3.1, Homebrew Channel install):
// Luna runs the service jailed, as its own uid, with the install directory
// bind-mounted read-write (it is also the service's $HOME). A file there
// survives an update through Homebrew Channel's installer to a newer
// version, so updates don't sign the viewer out, and the directory is gone
// after an uninstall. /media/internal, used before, outlives the app, which
// webosbrew's rules forbid for anything it writes.
//
// /tmp is the fallback if the install directory isn't writable: the sign-in
// then lasts until the TV reboots, but nothing outlives the app.

var fs = require("fs");
var path = require("path");

var CANDIDATE_DIRS = [
  // Set by scripts/dev-server.js so a PC run keeps its own state in the
  // repo's .dev/ folder, never inside service/.
  process.env.LIGHTSOUT_STATE_DIR || null,
  path.join(__dirname, "..", "state"),
  "/tmp/lightsout",
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
