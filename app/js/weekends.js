// Weekends and seasons on Browse: which weekend is on screen, the ‹ › buttons
// around the header that step to the previous and next weekend, and the
// season list that opens from the weekend title.
//
// Data: the service's f1tvSeason - every meeting (race weekends and tests) of
// a season, oldest first, each with the pageId browse.js loads. Seasons from
// 2018 on. Season lists are kept in localStorage like pages are: past seasons
// don't change, and the current one is re-checked every few hours.
//
// Loaded after browse.js, whose functions and state (currentPageId,
// currentMeeting, loadAndRender, renderHeader, ...) it uses.

var SEASON_FIRST_YEAR = 2018;
var THIS_YEAR = new Date().getFullYear();
var SEASON_REFRESH_MS = 6 * 3600 * 1000;
var WEEKEND_KEY = "f1hud.browse.weekend"; // sessionStorage: the weekend picked this session
var FALLBACK_PAGE_ID = 12324; // 2026 Spanish GP, if no season list can be had at all

var currentSeason = THIS_YEAR;
var seasons = {}; // year -> meetings

// ---- season data ------------------------------------------------------------

function seasonCacheKey(year) {
  return "f1hud.season." + year + ".v1";
}

function fetchSeason(year) {
  return callService("f1tvSeason", { season: year }).then(function (res) {
    if (!res.returnValue) throw res;
    seasons[year] = res.meetings || [];
    try {
      window.localStorage.setItem(seasonCacheKey(year), JSON.stringify({ savedAt: Date.now(), meetings: seasons[year] }));
    } catch (e) {
      /* the list just gets fetched again next time */
    }
    updateWeekendNav();
    return seasons[year];
  });
}

// A season's meetings: from memory, else the saved copy (refreshing the
// current season in the background when it's a few hours old), else fetched.
function loadSeason(year) {
  if (seasons[year]) return Promise.resolve(seasons[year]);
  try {
    var saved = JSON.parse(window.localStorage.getItem(seasonCacheKey(year)));
    if (saved && Array.isArray(saved.meetings)) {
      seasons[year] = saved.meetings;
      if (year >= THIS_YEAR && Date.now() - saved.savedAt > SEASON_REFRESH_MS) {
        fetchSeason(year).catch(function () {});
      }
      return Promise.resolve(saved.meetings);
    }
  } catch (e) {
    /* fall through to fetching */
  }
  return fetchSeason(year);
}

function startMs(m) { return Date.parse(m.start) || 0; }
function endMs(m) { return Date.parse(m.end) || startMs(m); }
function hasStarted(m, now) { return startMs(m) <= now; }

// ---- which weekend ----------------------------------------------------------

function applyWeekend(meeting, season) {
  currentPageId = meeting.pageId;
  currentMeeting = meeting.name ? meeting : null;
  currentSeason = season;
  try {
    window.sessionStorage.setItem(WEEKEND_KEY, JSON.stringify({ season: season, meeting: meeting }));
  } catch (e) {
    /* a reopened Browse just starts on the latest weekend */
  }
  updateWeekendNav();
}

// The weekend picked earlier this session (so coming back from the player
// stays on it), else the latest one that has started - this season, or the
// end of last season before this one's first weekend.
function initialWeekend() {
  try {
    var saved = JSON.parse(window.sessionStorage.getItem(WEEKEND_KEY));
    if (saved && saved.meeting && saved.meeting.pageId) {
      return Promise.resolve({ meeting: saved.meeting, season: saved.season });
    }
  } catch (e) {
    /* pick the latest instead */
  }
  var now = Date.now();
  function latestOf(year) {
    return loadSeason(year).then(function (list) {
      var started = list.filter(function (m) { return hasStarted(m, now); });
      return started.length ? { meeting: started[started.length - 1], season: year } : null;
    });
  }
  return latestOf(THIS_YEAR)
    .then(function (found) { return found || latestOf(THIS_YEAR - 1); })
    .then(function (found) { return found || { meeting: { pageId: FALLBACK_PAGE_ID }, season: THIS_YEAR }; })
    .catch(function () { return { meeting: { pageId: FALLBACK_PAGE_ID }, season: THIS_YEAR }; });
}

// The weekend before (dir -1) or after (dir 1) the one on screen, crossing
// into the neighbouring season at either end. Null at the ends of the range.
function neighbourWeekend(dir) {
  var list = seasons[currentSeason] || [];
  var i = indexOfPage(list, currentPageId);
  if (i === -1) return Promise.resolve(null);
  var j = i + dir;
  if (j >= 0 && j < list.length) return Promise.resolve({ meeting: list[j], season: currentSeason });
  var year = currentSeason + dir;
  if (year < SEASON_FIRST_YEAR || year > THIS_YEAR) return Promise.resolve(null);
  return loadSeason(year).then(function (other) {
    if (!other.length) return null;
    return { meeting: dir < 0 ? other[other.length - 1] : other[0], season: year };
  }, function () { return null; });
}

function indexOfPage(list, pageId) {
  for (var i = 0; i < list.length; i++) if (list[i].pageId === pageId) return i;
  return -1;
}

var prevWeekendBtn = document.getElementById("prev-weekend");
var nextWeekendBtn = document.getElementById("next-weekend");

function updateWeekendNav() {
  var list = seasons[currentSeason];
  var i = list ? indexOfPage(list, currentPageId) : -1;
  var atStart = i === -1 || (i === 0 && currentSeason <= SEASON_FIRST_YEAR);
  var atEnd = i === -1 || (i === list.length - 1 && currentSeason >= THIS_YEAR);
  prevWeekendBtn.setAttribute("aria-disabled", String(atStart));
  nextWeekendBtn.setAttribute("aria-disabled", String(atEnd));
}

// ---- switching, with the page sliding across ----------------------------------

var SLIDE_DISTANCE = 80;
var switching = false;

function slideTargets() {
  return ["meeting-title", "hero"].map(function (id) {
    return document.getElementById(id);
  });
}

// Content leaves towards the side it came from: going back in time it exits
// right and the older weekend enters from the left, like turning a page back.
function slide(elements, fromX, toX, fromOpacity, toOpacity, duration, easing) {
  if (REDUCE_MOTION || !elements[0].animate) return Promise.resolve([]);
  elements.forEach(function (el) { el.style.willChange = "transform, opacity"; });
  var animations = elements.map(function (el) {
    return el.animate(
      [
        { transform: "translateX(" + fromX + "px)", opacity: fromOpacity },
        { transform: "translateX(" + toX + "px)", opacity: toOpacity },
      ],
      { duration: duration, easing: easing, fill: "forwards" }
    );
  });
  function done() {
    elements.forEach(function (el) { el.style.willChange = ""; });
    return animations;
  }
  return Promise.all(animations.map(function (a) { return a.finished; })).then(done, done);
}

function switchWeekend(meeting, season, dir, fromHeader) {
  if (!meeting || switching) return;
  if (meeting.pageId === currentPageId) return;
  switching = true;
  var targets = slideTargets();
  slide(targets, 0, dir * -SLIDE_DISTANCE, 1, 0, 160, "ease-in").then(function (outAnimations) {
    applyWeekend(meeting, season);

    // Clear the old weekend; the new one renders from its saved copy straight
    // away if there is one, or shows the skeleton until it arrives.
    clearTimeout(refreshTimer);
    shownSignature = null;
    shownFetchedAt = 0;
    setStatus("");
    var hero = document.getElementById("hero");
    hero.hidden = true;
    hero.innerHTML = "";
    document.getElementById("rails").innerHTML = "";
    document.body.classList.add("is-loading", "instant", "header-ready");
    document.body.scrollTop = 0;
    renderHeader({}, []);
    keepHeaderFocus = !!fromHeader;
    loadAndRender();

    outAnimations.forEach(function (a) { a.cancel(); });
    return slide(targets, dir * SLIDE_DISTANCE, 0, 0, 1, 300, "cubic-bezier(0.2, 0.8, 0.2, 1)");
  }).then(function (inAnimations) {
    inAnimations.forEach(function (a) { a.cancel(); });
    switching = false;
  });
}

function stepWeekend(dir) {
  neighbourWeekend(dir).then(function (next) {
    if (next) switchWeekend(next.meeting, next.season, dir, true);
  });
}

prevWeekendBtn.addEventListener("click", function (e) {
  e.preventDefault();
  stepWeekend(-1);
});
nextWeekendBtn.addEventListener("click", function (e) {
  e.preventDefault();
  stepWeekend(1);
});
document.getElementById("meeting-title").addEventListener("click", function () {
  openSeasonView();
});

// ---- season list ------------------------------------------------------------------

var seasonView = document.getElementById("season-view");
var seasonList = document.getElementById("season-list");
var seasonTitle = document.getElementById("season-title");
var seasonPrevBtn = document.getElementById("season-prev");
var seasonNextBtn = document.getElementById("season-next");
var shownSeasonYear = null;
var seasonClosingTimer = null;

var CHEVRON_RIGHT = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

function seasonViewOpen() {
  return !seasonView.hidden && seasonView.classList.contains("open");
}

function openSeasonView() {
  clearTimeout(seasonClosingTimer);
  seasonView.hidden = false;
  void seasonView.offsetWidth; // start the fade from transparent
  seasonView.classList.add("open");
  showSeason(currentSeason, 0);
}

function closeSeasonView(returnFocus) {
  seasonView.classList.remove("open");
  seasonClosingTimer = setTimeout(function () { seasonView.hidden = true; }, 220);
  if (returnFocus) document.getElementById("meeting-title").focus({ preventScroll: true });
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

// dir: 0 when opening (rows ripple in around the focused one), or -1/1 when
// changing year (the list slides across).
function showSeason(year, dir) {
  shownSeasonYear = year;
  seasonTitle.textContent = year + " Season";
  seasonPrevBtn.setAttribute("aria-disabled", String(year <= SEASON_FIRST_YEAR));
  seasonNextBtn.setAttribute("aria-disabled", String(year >= THIS_YEAR));
  if (!seasons[year]) {
    seasonList.innerHTML = '<div class="season-empty">Loading the ' + year + " season…</div>";
  }
  loadSeason(year).then(function (meetings) {
    if (shownSeasonYear !== year) return;
    buildSeasonRows(year, meetings, dir);
  }, function () {
    if (shownSeasonYear !== year) return;
    seasonList.innerHTML = '<div class="season-empty">Couldn’t load the ' + year + " season. Try again in a moment.</div>";
  });
}

function buildSeasonRows(year, meetings, dir) {
  var now = Date.now();
  seasonList.innerHTML = "";
  if (!meetings.length) {
    seasonList.innerHTML = '<div class="season-empty">F1 TV has no weekends listed for ' + year + ".</div>";
    return;
  }
  var focusRow = null;
  var latestStarted = null;
  var rows = meetings.map(function (m) {
    var upcoming = !hasStarted(m, now);
    var thisWeekend = !upcoming && now <= endMs(m) + DAY_MS;
    var row = document.createElement("div");
    row.className = "season-row" + (upcoming ? " upcoming" : "");
    row.tabIndex = -1;
    row.innerHTML =
      '<img class="flag" alt="" loading="lazy" decoding="async">' +
      '<div class="info">' +
        '<div class="line1"><span class="name"></span><span class="chips"></span></div>' +
        '<div class="line2"><span class="round"></span><span class="official"></span></div>' +
      "</div>" +
      '<span class="dates"></span>' + CHEVRON_RIGHT;
    var flag = row.querySelector(".flag");
    var src = flagFor(m.country);
    if (src) flag.src = src;
    else flag.style.visibility = "hidden";
    row.querySelector(".name").textContent = m.test ? "Pre-Season Testing" : m.name;
    row.querySelector(".round").textContent = m.test ? "Testing" : m.round ? "Round " + pad2(m.round) : "";
    row.querySelector(".official").textContent = m.official || "";
    row.querySelector(".dates").textContent = meetingDates(m, null, true);
    var chips = [];
    if (m.pageId === currentPageId) chips.push('<span class="chip viewing">Viewing</span>');
    if (thisWeekend) chips.push('<span class="chip now">This weekend</span>');
    if (upcoming) chips.push('<span class="chip upcoming">Upcoming</span>');
    row.querySelector(".chips").innerHTML = chips.join("");
    row.addEventListener("click", function () { pickSeasonMeeting(m, year); });
    seasonList.appendChild(row);
    if (m.pageId === currentPageId) focusRow = row;
    if (!upcoming) latestStarted = row;
    return row;
  });
  focusRow = focusRow || latestStarted || rows[0];
  focusSeasonRow(focusRow, true);

  if (REDUCE_MOTION || !focusRow.animate) return;
  if (dir) {
    slide([seasonList], dir * SLIDE_DISTANCE, 0, 0, 1, 300, "cubic-bezier(0.2, 0.8, 0.2, 1)").then(function (a) {
      a.forEach(function (x) { x.cancel(); });
    });
  } else {
    // Rows ripple in outwards from the focused one.
    var fi = rows.indexOf(focusRow);
    rows.forEach(function (row, i) {
      var distance = Math.abs(i - fi);
      if (distance > 5) return;
      row.animate(
        [{ opacity: 0, transform: "translateY(" + (i < fi ? -14 : 14) + "px)" }, { opacity: 1, transform: "none" }],
        { duration: 260, delay: distance * 28, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" }
      );
    });
  }
}

// Keeps the focused row near the middle of the list as focus moves.
function focusSeasonRow(row, instant) {
  row.focus({ preventScroll: true });
  var top = row.offsetTop - seasonList.clientHeight / 2 + row.offsetHeight / 2;
  seasonList.scrollTo({ top: Math.max(0, top), behavior: instant || REDUCE_MOTION ? "auto" : "smooth" });
}

function changeSeasonYear(dir) {
  var year = shownSeasonYear + dir;
  if (year < SEASON_FIRST_YEAR || year > THIS_YEAR) {
    bounce(seasonTitle, dir, 0);
    return;
  }
  slide([seasonList], 0, dir * -SLIDE_DISTANCE, 1, 0, 140, "ease-in").then(function (a) {
    a.forEach(function (x) { x.cancel(); });
    showSeason(year, dir);
  });
}

function pickSeasonMeeting(meeting, year) {
  closeSeasonView(meeting.pageId === currentPageId);
  if (meeting.pageId === currentPageId) return;
  var dir = currentMeeting && currentMeeting.start
    ? (startMs(meeting) < startMs(currentMeeting) ? -1 : 1)
    : year < currentSeason ? -1 : 1;
  switchWeekend(meeting, year, dir, false);
}

seasonPrevBtn.addEventListener("click", function () { changeSeasonYear(-1); });
seasonNextBtn.addEventListener("click", function () { changeSeasonYear(1); });

// Remote keys while the season list is open. Capture phase, so Browse's own
// arrow-key handling and back-nav.js (Back would exit the app) never see them.
window.addEventListener(
  "keydown",
  function (e) {
    if (!seasonViewOpen()) return;
    var k = e.keyCode;
    var handled = [13, 27, 37, 38, 39, 40, 461].indexOf(k) !== -1;
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (k === 461 || k === 27) {
      closeSeasonView(true);
      return;
    }
    if (k === 37 || k === 39) {
      changeSeasonYear(k === 39 ? 1 : -1);
      return;
    }
    var rows = Array.prototype.slice.call(seasonList.querySelectorAll(".season-row"));
    var i = rows.indexOf(document.activeElement);
    if (k === 13) {
      if (i !== -1) rows[i].click();
      return;
    }
    if (!rows.length) return;
    if (i === -1) {
      focusSeasonRow(rows[0]);
      return;
    }
    var j = i + (k === 40 ? 1 : -1);
    if (j >= 0 && j < rows.length) focusSeasonRow(rows[j]);
    else bounce(rows[i], 0, k === 40 ? 1 : -1);
  },
  true
);

// ---- start -------------------------------------------------------------------

initialWeekend().then(function (pick) {
  applyWeekend(pick.meeting, pick.season);
  if (currentMeeting) {
    document.body.classList.add("header-ready");
    renderHeader({}, []);
  }
  loadAndRender();
  // The season list behind the ‹ › buttons, if the pick came from this session.
  loadSeason(currentSeason).then(function (list) {
    var fresh = list[indexOfPage(list, currentPageId)];
    if (fresh) {
      currentMeeting = fresh;
      renderHeader({}, []);
    }
    updateWeekendNav();
  }, function () {});
});
