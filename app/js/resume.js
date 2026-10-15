// Where each replay was left off, per contentId, in this app's localStorage -
// written by the player (watch.js), read by the player to resume and by
// Browse to draw progress bars. Live streams are never recorded.

var RESUME_KEY = "lightsout.resume.v1";
var RESUME_MAX_ENTRIES = 100;
var RESUME_MIN_SECONDS = 30; // any earlier counts as not started
var RESUME_END_MARGIN = 120; // within this of the end counts as finished

function readAllResume() {
  try {
    return JSON.parse(window.localStorage.getItem(RESUME_KEY)) || {};
  } catch (e) {
    return {};
  }
}

// {t, d, at} for a replay worth resuming, else null.
function getResume(contentId) {
  var entry = readAllResume()[String(contentId)];
  if (!entry || !(entry.d > 0)) return null;
  if (entry.t < RESUME_MIN_SECONDS || entry.t > entry.d - RESUME_END_MARGIN) return null;
  return entry;
}

function saveResume(contentId, t, d) {
  if (!contentId || !isFinite(d) || !(d > 0) || !isFinite(t)) return;
  var all = readAllResume();
  var key = String(contentId);
  if (t > d - RESUME_END_MARGIN) {
    delete all[key]; // finished
  } else if (t >= RESUME_MIN_SECONDS || all[key]) {
    all[key] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };
  } else {
    return; // never got going: nothing to remember
  }
  var keys = Object.keys(all);
  if (keys.length > RESUME_MAX_ENTRIES) {
    keys
      .sort(function (a, b) { return all[b].at - all[a].at; })
      .slice(RESUME_MAX_ENTRIES)
      .forEach(function (k) { delete all[k]; });
  }
  try {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify(all));
  } catch (e) {
    /* storage unavailable: resuming just won't happen */
  }
}

// 3015 -> "50:15", 3735 -> "1:02:15"
function resumeClock(seconds) {
  var s = Math.floor(seconds);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  var mm = h > 0 && m < 10 ? "0" + m : String(m);
  return (h > 0 ? h + ":" : "") + mm + ":" + (sec < 10 ? "0" : "") + sec;
}
