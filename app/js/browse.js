// Content browser, "race first" layout: the weekend's headline session as a
// large hero, then horizontal rails - this weekend's sessions by series, then
// the page's other video trays (highlights, shows, press conferences,
// archive) with thumbnails.
//
// Data: PAGE/{pageId}. Top-level containers are trays; items are nested in
// tray.retrieveItems.resultObj.containers[]. The page for a race weekend
// carries:
//   - a gp_banner tray with the meeting's BUNDLE item (name, round, circuit,
//     dates in emfAttributes) - a link to a page, not playable;
//   - an interactive_schedule tray whose "ALL" group lists every session of
//     the weekend (F1, F2, F3) with start/end times, series, and OBC (true
//     when the session has driver onboards);
//   - horizontal_thumbnail trays of VIDEO items.
// Only VIDEO items play: sending a BUNDLE's contentId to PLAY gives a card
// that never plays (the old gp_banner "Meeting" card bug).
//
// Which weekend is on screen - and switching between weekends and seasons - is
// js/weekends.js, which sets currentPageId (and currentMeeting, that weekend's
// entry from the season list) and starts the first load.
var currentPageId = null;
var currentMeeting = null;

// callService() (Luna on the TV, the dev server on a PC) comes
// from js/luna.js, loaded before this file.

var SERIES = {
  F1: { name: "Formula 1", color: "#e10600", tint: [42, 15, 14] },
  F2: { name: "Formula 2", color: "#1583d8", tint: [12, 28, 43] },
  F3: { name: "Formula 3", color: "#f06a1a", tint: [43, 25, 13] },
  F1A: { name: "F1 Academy", color: "#d6197a", tint: [42, 12, 28] },
  PSC: { name: "Porsche Supercup", color: "#6f6f78", tint: [30, 30, 34] },
  OTHER: { name: "", color: "#55555e", tint: [26, 26, 31] },
};

// F1 TV's three-letter country codes (a mix of ISO and IOC style) to the
// bundled flags/<iso2>.svg files - one per 2026 host country.
var FLAGS = {
  AUS: "au", CHN: "cn", JPN: "jp", BHR: "bh", SAU: "sa", KSA: "sa", USA: "us", CAN: "ca",
  MON: "mc", MCO: "mc", ESP: "es", AUT: "at", GBR: "gb", BEL: "be", HUN: "hu", NED: "nl",
  NLD: "nl", ITA: "it", AZE: "az", SGP: "sg", MEX: "mx", BRA: "br", QAT: "qa", UAE: "ae", ARE: "ae",
  FRA: "fr", GER: "de", DEU: "de", RUS: "ru", POR: "pt", PRT: "pt", TUR: "tr",
};
// The season list names countries instead. Every host from 2018 on.
var COUNTRY_FLAGS = {
  "Australia": "au", "Austria": "at", "Azerbaijan": "az", "Bahrain": "bh", "Belgium": "be", "Brazil": "br",
  "Canada": "ca", "China": "cn", "France": "fr", "Germany": "de", "Great Britain": "gb", "United Kingdom": "gb",
  "Hungary": "hu", "Italy": "it", "Japan": "jp", "Mexico": "mx", "Monaco": "mc", "Netherlands": "nl",
  "Portugal": "pt", "Qatar": "qa", "Russia": "ru", "Saudi Arabia": "sa", "Singapore": "sg", "Spain": "es",
  "Turkey": "tr", "United Arab Emirates": "ae", "United States": "us",
};

// Flag file for a three-letter code (page data) or a country name (season list).
function flagFor(country) {
  var iso = FLAGS[String(country || "").toUpperCase()] || COUNTRY_FLAGS[country];
  return iso ? "flags/" + iso + ".svg" : null;
}

var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

// Session types, and which one leads the page when several have happened.
var PRIORITY = { race: 0, sprint: 1, quali: 2, practice: 3, show: 9 };
var KIND_LABEL = { race: "Race", sprint: "Sprint", quali: "Qualifying", practice: "Practice", show: "" };

// 24px-grid icons; they draw in currentColor.
function svg(inner, size) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
}
function checks(x0, y0, w, h) {
  var s = "";
  for (var r = 0; r < 4; r++) {
    for (var c = 0; c < 4; c++) {
      if ((r + c) % 2 === 0) s += '<rect x="' + (x0 + c * w) + '" y="' + (y0 + r * h) + '" width="' + w + '" height="' + h + '" fill="currentColor" stroke="none"/>';
    }
  }
  return s;
}
var ICON = {
  race: function (s) { return svg('<path d="M5 22V3"/><path d="M5 4h14v10H5"/>' + checks(5, 4, 3.5, 2.5), s); },
  sprint: function (s) { return svg('<path d="M10 22V3"/><path d="M10 4h11v9H10"/>' + checks(10, 4, 2.75, 2.25) + '<path d="M2 7h5"/><path d="M3 11h4"/><path d="M4 15h3"/>', s); },
  quali: function (s) { return svg('<circle cx="12" cy="14" r="7.5"/><path d="M12 14v-4"/><path d="M10 2.5h4"/><path d="M12 2.5v4"/><path d="M18.5 7.5l1.5-1.5"/>', s); },
  practice: function (s) { return svg('<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 17l4.5-5"/><path d="M6 12.5l1.2.8"/><path d="M12 8.5v1.4"/><path d="M18 12.5l-1.2.8"/>', s); },
  show: function (s) { return svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>', s); },
  press: function (s) { return svg('<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>', s); },
  onboard: function (s) { return svg('<rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="M15.5 11l6-3.5v9l-6-3.5"/>', s); },
  play: function (s) { return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>'; },
};

// ---- data -----------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function pad(n) { return (n < 10 ? "0" : "") + n; }
function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function dayShort(ms) { return DAYS[new Date(ms).getDay()]; }
function dayLong(ms) { var d = new Date(ms); return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; }

function trayItems(tray) {
  return (tray && tray.retrieveItems && tray.retrieveItems.resultObj && tray.retrieveItems.resultObj.containers) || [];
}

function isVideo(m) {
  return !!(m && m.contentId && m.contentType === "VIDEO");
}

function imageUrl(pictureUrl, w, h) {
  return pictureUrl
    ? "https://f1tv.formula1.com/image-resizer/image/" + pictureUrl + "?w=" + w + "&h=" + h + "&q=HI&o=L"
    : "";
}

// "02:11:42" -> "2:11:42", "00:29:48" -> "29:48"
function shortDuration(ui) {
  if (!ui) return "";
  return String(ui).replace(/^00:/, "").replace(/^0(\d)/, "$1");
}

function seriesOf(m) {
  var e = m.emfAttributes || {};
  var fromEmf = { "FORMULA 1": "F1", "FORMULA 2": "F2", "FORMULA 3": "F3" }[String(e.Series || "").toUpperCase()];
  var code = fromEmf || String(m.uiSeries || "").toUpperCase();
  return SERIES[code] ? code : code || "F1";
}

function seriesStyle(code) {
  var s = SERIES[code] || SERIES.OTHER;
  var t = s.tint.join(",");
  return "--series:" + s.color + ";--tint:rgb(" + t + ");--tint-rgb:" + t;
}

function kindOf(m) {
  var e = m.emfAttributes || {};
  var t = String(m.titleBrief || m.title || "").toLowerCase();
  if (String(e.ContentCategory || "").toUpperCase() === "EPISODIC") return "show";
  if (/show|kids|warm-?up|highlights|press conference/.test(t)) return "show";
  if (/sprint (qualifying|shootout)/.test(t)) return "quali";
  if (/sprint/.test(t)) return "sprint";
  if (/qualifying/.test(t)) return "quali";
  if (/practice/.test(t)) return "practice";
  if (/race|grand prix/.test(t)) return "race";
  return "show";
}

// The real "live right now" values haven't been observed yet (everything
// captured so far was a replay, with emfAttributes.state "Pre-Live" or
// "Archive"), so match the likely candidates. "Pre-Live" must not count.
function isLive(m) {
  var state = String((m.emfAttributes || {}).state || "");
  return /\b(LIVE|ON.?AIR)\b/i.test(m.contentSubtype || "") || /^live$/i.test(state);
}

function toSession(m) {
  var e = m.emfAttributes || {};
  return {
    id: String(m.contentId),
    title: String(m.titleBrief || m.title || "").trim() || "(untitled)",
    series: seriesOf(m),
    kind: kindOf(m),
    start: Number(e.sessionStartDate) || 0,
    end: Number(e.sessionEndDate) || 0,
    duration: shortDuration(m.uiDuration),
    onboard: e.OBC === true,
    live: isLive(m),
    picture: m.pictureUrl,
    country: m.country,
    meetingName: e.Meeting_Name || "",
  };
}

// Every session of the weekend, oldest first. Prefers the schedule tray;
// pages without one fall back to meeting-session videos in any tray.
function collectSessions(trays) {
  var seen = {};
  var list = [];
  function add(m) {
    if (!isVideo(m) || seen[m.contentId]) return;
    seen[m.contentId] = true;
    list.push(toSession(m));
  }
  var schedule = trays.filter(function (t) { return t.layout === "interactive_schedule"; })[0];
  if (schedule) {
    trayItems(schedule).forEach(function (group) {
      (group.events || []).forEach(function (ev) { add(ev.metadata); });
    });
  } else {
    trays.forEach(function (t) {
      trayItems(t).forEach(function (item) {
        var m = item.metadata;
        if (m && m.emfAttributes && m.emfAttributes.VideoType === "meetingSession" && m.emfAttributes.sessionStartDate) add(m);
      });
    });
  }
  list.sort(function (a, b) { return a.start - b.start; });
  return list;
}

function collectMeeting(trays, sessions) {
  var meeting = {};
  trays.forEach(function (t) {
    trayItems(t).forEach(function (item) {
      var m = item.metadata || {};
      if (m.contentType === "BUNDLE" && m.emfAttributes && m.emfAttributes.Meeting_Name && !meeting.name) {
        var e = m.emfAttributes;
        meeting = {
          name: e.Meeting_Name, round: e.Meeting_Number, circuit: e.Circuit_Short_Name, location: e.Meeting_Location,
          start: e.Meeting_Start_Date, end: e.Meeting_End_Date,
        };
      }
    });
  });
  var first = sessions[0];
  if (first) {
    if (!meeting.name) meeting.name = first.meetingName;
    meeting.country = first.country;
  }
  return meeting;
}

// "11–13 Sept 2026" (or without the year). Meeting dates come as UTC
// midnights, so read them as UTC.
function meetingDates(meeting, sessions, withoutYear) {
  sessions = sessions || [];
  var a = meeting.start ? new Date(meeting.start) : sessions.length ? new Date(sessions[0].start) : null;
  var b = meeting.end ? new Date(meeting.end) : sessions.length ? new Date(sessions[sessions.length - 1].start) : null;
  if (!a || !b || isNaN(a) || isNaN(b)) return "";
  var utc = !!meeting.start;
  function D(d) { return utc ? d.getUTCDate() : d.getDate(); }
  function M(d) { return utc ? d.getUTCMonth() : d.getMonth(); }
  function Y(d) { return utc ? d.getUTCFullYear() : d.getFullYear(); }
  var year = withoutYear ? "" : " " + Y(b);
  if (M(a) === M(b)) return D(a) + "–" + D(b) + " " + MONTHS[M(b)] + year;
  return D(a) + " " + MONTHS[M(a)] + " – " + D(b) + " " + MONTHS[M(b)] + year;
}

// Hero: a live session if there is one, otherwise the most important session
// that has already started (race > sprint > qualifying > practice, latest
// first), otherwise the weekend's first session.
function rankSessions(sessions, now) {
  return sessions
    .filter(function (s) { return s.kind !== "show" && s.start && s.start <= now; })
    .sort(function (a, b) {
      return (PRIORITY[a.kind] - PRIORITY[b.kind]) || (a.series === "F1" ? -1 : 0) - (b.series === "F1" ? -1 : 0) || b.start - a.start;
    });
}

// ---- rendering ------------------------------------------------------------

// Remembers what was focused and how far each row was scrolled, so coming
// back from the player lands on the same tile (see showTrays).
var VIEW_KEY = "f1hud.browse.view";

function go(contentId) {
  try {
    var view = snapshotView();
    delete view.element;
    view.pageTop = document.body.scrollTop;
    view.pageId = currentPageId;
    window.sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch (e) {
    /* returning just starts at the top */
  }
  window.location.href = "watch.html?contentId=" + encodeURIComponent(contentId);
}

function takeSavedView() {
  try {
    var view = JSON.parse(window.sessionStorage.getItem(VIEW_KEY));
    window.sessionStorage.removeItem(VIEW_KEY);
    return view && view.rows && view.pageId === currentPageId ? view : null;
  } catch (e) {
    return null;
  }
}

// A thin progress bar along a tile's bottom edge for a replay watched part
// way (js/resume.js).
function addProgress(tile, contentId) {
  var resume = getResume(contentId);
  if (!resume) return;
  var bar = document.createElement("div");
  bar.className = "progress";
  bar.innerHTML = "<i></i>";
  bar.firstChild.style.width = Math.min(100, (resume.t / resume.d) * 100) + "%";
  tile.appendChild(bar);
}

function makeFocusable(el, contentId, label) {
  el.tabIndex = 0;
  el.setAttribute("data-id", String(contentId));
  el.setAttribute("role", "link");
  el.setAttribute("aria-label", label);
  el.addEventListener("click", function () { go(contentId); });
  el.addEventListener("keydown", function (e) {
    if (e.keyCode === 13) go(contentId);
  });
  return el;
}

function badge(code, size) {
  return '<div class="badge" style="width:' + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.44) + 'px">' + esc(code) + "</div>";
}

function iconHtml(kind, size) {
  var accent = kind === "race" || kind === "sprint";
  return '<span style="color:' + (accent ? "var(--series)" : "var(--muted)") + '">' + ICON[kind](size) + "</span>";
}

function whenShort(s) {
  if (s.live) return '<span class="live-pill" style="font-size:20px">LIVE</span>';
  if (!s.start) return esc(s.duration);
  return esc(dayShort(s.start) + " " + hhmm(s.start)) + (s.duration ? '<span class="soft"> · ' + esc(s.duration) + "</span>" : "");
}

function thumbImg(pictureUrl, w, h) {
  var src = imageUrl(pictureUrl, w, h);
  return src
    ? '<img class="thumb" alt="" loading="lazy" decoding="async" src="' + esc(src) + '" onerror="this.style.visibility=\'hidden\'">'
    : '<div class="thumb"></div>';
}

// Wide tiles: a blurred, stretched copy fills the tile (painted by
// paintBackdrop once the image loads), a shade goes over it, and the whole
// 16:9 thumbnail sits sharp on the right above the shade.
function backdropUnder(pictureUrl) {
  return pictureUrl ? '<canvas class="backdrop" width="64" height="20"></canvas>' : '<div class="thumb"></div>';
}
function backdropSharp(pictureUrl, w, h) {
  return pictureUrl ? '<img class="sharp" alt="" decoding="async" src="' + esc(imageUrl(pictureUrl, w, h)) + '">' : "";
}

// Draws the tile's thumbnail, cropped to the tile's shape, into a 64px-wide
// canvas with a light blur; stretched to the tile by CSS, that reads as a
// heavy blur. Drawing a cross-origin image taints the canvas, which only
// blocks reading pixels back - displaying it is fine.
function paintBackdrop(tile) {
  var img = tile.querySelector("img.sharp");
  var canvas = tile.querySelector("canvas.backdrop");
  if (!img || !canvas) return;
  function draw() {
    var w = 64;
    var h = Math.max(8, Math.round((w * tile.offsetHeight) / Math.max(1, tile.offsetWidth)));
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    var nw = img.naturalWidth;
    var nh = img.naturalHeight;
    var sw = nw;
    var sh = nh;
    if (nw / nh > w / h) sw = nh * (w / h);
    else sh = nw / (w / h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "blur(1.5px)";
    // Overdraw past the edges so the blur doesn't fade to transparent there.
    ctx.drawImage(img, (nw - sw) / 2, (nh - sh) / 2, sw, sh, -3, -3, w + 6, h + 6);
    tile.classList.add("has-backdrop");
  }
  if (img.complete && img.naturalWidth) draw();
  else img.addEventListener("load", draw);
}

function sessionTile(s) {
  var el = document.createElement("div");
  el.className = "tile session " + s.kind;
  el.setAttribute("style", seriesStyle(s.series));
  el.innerHTML =
    '<div class="top">' + badge(s.series, 44) + (s.onboard ? ICON.onboard(28) : "") + "</div>" +
    '<div style="display:flex;flex-direction:column;gap:6px;min-width:0">' +
      '<div class="title-line">' + iconHtml(s.kind, 28) + '<div class="name ellipsis">' + esc(s.title) + "</div></div>" +
      '<div class="meta">' + whenShort(s) + "</div>" +
    "</div>";
  addProgress(el, s.id);
  return makeFocusable(el, s.id, (SERIES[s.series] ? SERIES[s.series].name + " " : "") + s.title);
}

function heroMain(s, now) {
  var el = document.createElement("div");
  el.id = "hero-main";
  el.className = "tile " + s.kind;
  el.setAttribute("style", seriesStyle(s.series));
  var seriesName = SERIES[s.series] ? SERIES[s.series].name : s.series;
  var eyebrow = s.series === "F1" && s.kind === "race" ? "Grand Prix" : seriesName + (KIND_LABEL[s.kind] ? " · " + KIND_LABEL[s.kind] : "");
  var resume = s.live ? null : getResume(s.id);
  var action = s.live
    ? "Watch live"
    : s.start > now ? "Starts " + dayShort(s.start) + " " + hhmm(s.start)
    : resume ? "Resume from " + resumeClock(resume.t) : "Watch replay";
  el.innerHTML =
    backdropUnder(s.picture) +
    '<div class="shade"></div>' +
    backdropSharp(s.picture, 704, 396) +
    '<div class="body">' +
      '<div class="eyebrow">' + badge(s.series, 52) + "<span>" + esc(eyebrow) + "</span>" + (s.live ? '<span class="live-pill" style="font-size:22px">LIVE</span>' : "") + "</div>" +
      '<div style="display:flex;flex-direction:column;gap:14px">' +
        '<div class="title-line" style="gap:16px">' + '<span style="color:var(--text)">' + ICON[s.kind](52) + "</span>" +
          '<div class="hero-title ellipsis">' + esc(s.title) + "</div></div>" +
        '<div class="hero-when">' +
          (s.start ? "<span>" + esc(dayLong(s.start) + " · " + hhmm(s.start) + (s.end ? "–" + hhmm(s.end) : "")) + "</span>" : "") +
          (s.duration ? '<span style="color:var(--muted)">' + esc(s.duration) + "</span>" : "") +
        "</div>" +
        '<div class="hero-cta">' +
          '<div class="play-label">' + ICON.play(22) + esc(action) + "</div>" +
          (s.onboard ? '<div class="tag">' + ICON.onboard(26) + "Onboard cameras</div>" : "") +
        "</div>" +
      "</div>" +
    "</div>";
  addProgress(el, s.id);
  return makeFocusable(el, s.id, eyebrow + " " + s.title);
}

function sideSession(s) {
  var el = document.createElement("div");
  el.className = "tile side-session " + s.kind;
  el.setAttribute("style", seriesStyle(s.series));
  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between">' + badge(s.series, 44) + (s.onboard ? ICON.onboard(28) : "") + "</div>" +
    '<div style="display:flex;flex-direction:column;gap:6px;min-width:0">' +
      '<div class="title-line" style="gap:12px">' + iconHtml(s.kind, 32) + '<div class="ellipsis" style="font-weight:600;font-size:36px">' + esc(s.title) + "</div></div>" +
      '<div class="meta" style="font-size:24px">' +
        (s.live ? '<span class="live-pill" style="font-size:20px">LIVE</span>'
          : esc(dayLong(s.start) + " · " + hhmm(s.start) + (s.end ? "–" + hhmm(s.end) : "")) + (s.duration ? '<span class="soft"> · ' + esc(s.duration) + "</span>" : "")) +
      "</div>" +
    "</div>";
  addProgress(el, s.id);
  return makeFocusable(el, s.id, s.title);
}

function sideVideo(m, kicker) {
  var el = document.createElement("div");
  el.className = "tile side-video";
  el.innerHTML =
    backdropUnder(m.pictureUrl) +
    '<div class="shade"></div>' +
    backdropSharp(m.pictureUrl, 384, 216) +
    '<div class="body">' +
      '<div class="kicker">' + esc(kicker) + "</div>" +
      '<div class="title-line" style="gap:12px">' + ICON.play(26) +
        '<div class="ellipsis" style="font-weight:600;font-size:32px">' + esc(m.title) + "</div>" +
        '<div class="meta" style="font-size:24px">' + esc(shortDuration(m.uiDuration)) + "</div>" +
      "</div>" +
    "</div>";
  addProgress(el, m.contentId);
  return makeFocusable(el, m.contentId, m.title);
}

function subtypeLabel(m) {
  var s = String(m.contentSubtype || "").toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function videoTile(m) {
  var code = seriesOf(m);
  var el = document.createElement("div");
  el.className = "video";
  el.setAttribute("style", seriesStyle(code));
  var press = /press/i.test(m.contentSubtype || "");
  el.innerHTML =
    '<div class="tile frame">' +
      thumbImg(m.pictureUrl, 400, 225) +
      '<div class="corner">' + badge(code, 38) + "</div>" +
      '<div class="chip">' + (isLive(m) ? '<span class="live-pill" style="font-size:18px">LIVE</span>' : (press ? ICON.press(22) : ICON.play(20)) + esc(shortDuration(m.uiDuration))) + "</div>" +
    "</div>" +
    '<div class="vtitle">' + esc(m.title || "(untitled)") + "</div>" +
    '<div class="vkind">' + esc(subtypeLabel(m)) + "</div>";
  addProgress(el.querySelector(".frame"), m.contentId);
  return makeFocusable(el, m.contentId, m.title || "");
}

function rail(title, tiles) {
  var section = document.createElement("div");
  section.className = "rail";
  section.setAttribute("data-rail", title);
  section.innerHTML =
    '<div class="rail-head"><div class="rail-title">' + esc(title) + '</div><div class="rail-count">' + tiles.length + "</div></div>";
  var viewport = document.createElement("div");
  viewport.className = "rail-viewport";
  var row = document.createElement("div");
  row.className = "rail-row";
  tiles.forEach(function (t) { row.appendChild(t); });
  viewport.appendChild(row);
  section.appendChild(viewport);
  return section;
}

// meeting: from the season list ({name, round, test, country, ...}) or from
// the page itself (collectMeeting). The season list wins when it's for this
// page - it knows tests from rounds.
function renderHeader(meeting, sessions) {
  if (currentMeeting && currentMeeting.pageId === currentPageId) meeting = currentMeeting;
  var flag = document.getElementById("flag");
  var src = flagFor(meeting.country);
  if (src) {
    if (flag.getAttribute("src") !== src) flag.src = src;
    flag.hidden = false;
  } else {
    flag.hidden = true;
  }
  document.getElementById("meeting-name").textContent = meeting.name || "Browse";
  var place = meeting.circuit && meeting.location && meeting.circuit !== meeting.location
    ? meeting.circuit + ", " + meeting.location
    : meeting.circuit || meeting.location || "";
  var label = meeting.test ? "Testing" : meeting.round ? "Round " + meeting.round : "";
  var parts = [label, place, meetingDates(meeting, sessions)].filter(Boolean);
  document.getElementById("meeting-sub").innerHTML = parts
    .map(function (p) { return "<span>" + esc(p) + "</span>"; })
    .join('<span class="sep">/</span>');
}

function render(trays) {
  var now = Date.now();
  var sessions = collectSessions(trays);
  var sessionIds = {};
  sessions.forEach(function (s) { sessionIds[s.id] = true; });
  renderHeader(collectMeeting(trays, sessions), sessions);

  // Hero.
  var hero = document.getElementById("hero");
  hero.innerHTML = "";
  var live = sessions.filter(function (s) { return s.live; });
  var ranked = rankSessions(sessions, now);
  var lead = live[0] || ranked[0] || sessions.filter(function (s) { return s.kind !== "show"; })[0];
  var tiles = 0;
  if (lead) {
    hero.appendChild(heroMain(lead, now));
    tiles++;
    var side = document.createElement("div");
    side.id = "hero-side";
    // Next most important session, from the same series as the hero first.
    var others = ranked.filter(function (s) { return s.id !== lead.id; });
    var second = others.filter(function (s) { return s.series === lead.series; })[0] || others[0];
    if (second) side.appendChild(sideSession(second));
    var highlightTray = trays.filter(function (t) { return /highlight/i.test(t.title || ""); })[0];
    var highlight = trayItems(highlightTray).map(function (i) { return i.metadata; }).filter(isVideo)[0];
    if (highlight) side.appendChild(sideVideo(highlight, subtypeLabel(highlight) || "Highlights"));
    if (side.children.length) hero.appendChild(side);
  }
  hero.hidden = !lead;
  Array.prototype.forEach.call(hero.querySelectorAll(".tile"), paintBackdrop);

  // Rails: this weekend's sessions, then the page's own video trays minus
  // anything already shown as a session.
  var railsEl = document.getElementById("rails");
  railsEl.innerHTML = "";
  var f1 = sessions.filter(function (s) { return s.series === "F1"; });
  var support = sessions.filter(function (s) { return s.series !== "F1"; });
  if (f1.length) railsEl.appendChild(rail("Formula 1 this weekend", f1.map(sessionTile)));
  if (support.length) {
    // Named after the series actually racing: "Formula 2, Formula 3 & Porsche Supercup".
    var order = ["F2", "F3", "F1A", "PSC"];
    var codes = [];
    support.forEach(function (s) { if (codes.indexOf(s.series) === -1) codes.push(s.series); });
    codes.sort(function (x, y) { return (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99); });
    var names = codes.map(function (c) { return SERIES[c] ? SERIES[c].name : c; });
    var title = names.length > 1 ? names.slice(0, -1).join(", ") + " & " + names[names.length - 1] : names[0] || "Support races";
    railsEl.appendChild(rail(title, support.map(sessionTile)));
  }
  trays.forEach(function (tray) {
    if (tray.layout === "interactive_schedule") return;
    var videos = trayItems(tray)
      .map(function (i) { return i.metadata; })
      .filter(function (m) { return isVideo(m) && !sessionIds[String(m.contentId)]; });
    if (!videos.length) return;
    railsEl.appendChild(rail(tray.title || "Videos", videos.map(videoTile)));
  });

  Array.prototype.forEach.call(railsEl.querySelectorAll(".rail-row"), function (row) {
    row.addEventListener("scroll", function () { updateRowEdges(row); });
    updateRowEdges(row);
  });

  return tiles + railsEl.querySelectorAll("[tabindex]").length;
}

// --- D-pad navigation ------------------------------------------------------
// The Magic Remote's D-pad sends arrow keydowns, which don't move focus on
// their own.
//   - Left/Right inside a rail steps to the neighbouring tile. The row slides
//     so the focused tile sits at a fixed spot with the previous one peeking
//     in, and at either end the tile bounces instead of focus jumping rows.
//   - Everything else is geometric nearest-neighbour in the pressed
//     direction; Up/Down prefer tiles on screen, so entering a rail lands on
//     what's visible and doesn't slide the row.
var REDUCE_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
var SCROLL = REDUCE_MOTION ? "auto" : "smooth";
var ROW_GUTTER = 64; // the rows' left padding: where a tile sits at rest
var ROW_PEEK = 206; // where a focused tile sits once the row slides, the previous one peeking in

function focusables() {
  return Array.prototype.slice.call(document.querySelectorAll(".tile[tabindex], .video[tabindex], #meeting .round-btn:not([aria-disabled=true]), #meeting-title, #auth-banner a"))
    .filter(function (el) { return el.offsetParent !== null; });
}

function updateRowEdges(row) {
  var max = row.scrollWidth - row.clientWidth;
  var viewport = row.parentElement;
  viewport.classList.toggle("more-left", row.scrollLeft > 4);
  viewport.classList.toggle("more-right", row.scrollLeft < max - 4);
}

// offsetLeft is relative to the row (it's position: relative) and ignores
// both its scroll position and the focus scale.
function scrollRow(row, el, alongRow) {
  var max = row.scrollWidth - row.clientWidth;
  var target;
  if (alongRow) {
    target = el === row.firstElementChild ? 0 : el.offsetLeft - ROW_PEEK;
  } else {
    var left = el.offsetLeft - ROW_GUTTER;
    var right = el.offsetLeft + el.offsetWidth + ROW_GUTTER - row.clientWidth;
    target = row.scrollLeft;
    if (left < row.scrollLeft) target = left;
    else if (right > row.scrollLeft) target = right;
  }
  target = Math.max(0, Math.min(max, target));
  if (Math.abs(target - row.scrollLeft) > 1) row.scrollTo({ left: target, behavior: SCROLL });
}

function reveal(el, alongRow) {
  if (el.closest("#hero, #meeting, #auth-banner")) {
    document.getElementById("page").scrollIntoView({ block: "start", behavior: SCROLL });
    return;
  }
  var row = el.closest(".rail-row");
  if (row) {
    el.closest(".rail").scrollIntoView({ block: "nearest", behavior: SCROLL });
    scrollRow(row, el, alongRow);
    return;
  }
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: SCROLL });
}

function focusEl(el, alongRow) {
  el.focus({ preventScroll: true });
  reveal(el, alongRow);
}

// A short push in the pressed direction and back: "nothing further this way".
function bounce(el, dx, dy) {
  if (REDUCE_MOTION || !el.animate) return;
  // Keep the tile's own focus transform (large tiles scale less) under the push.
  var current = window.getComputedStyle(el).transform;
  var base = current && current !== "none" ? current + " " : "";
  var push = "translate(" + dx * 18 + "px, " + dy * 12 + "px)";
  el.animate(
    [
      { transform: base + "translate(0, 0)" },
      { transform: base + push, offset: 0.35 },
      { transform: base + "translate(0, 0)" },
    ],
    { duration: 320, easing: "ease-out" }
  );
}

function moveFocus(dx, dy) {
  var all = focusables();
  if (!all.length) return;
  var current = document.activeElement;
  if (all.indexOf(current) === -1) {
    focusEl(document.getElementById("hero-main") || all[0], false);
    return;
  }

  var row = current.parentElement && current.parentElement.classList.contains("rail-row") ? current.parentElement : null;
  if (row && dx !== 0) {
    var next = dx > 0 ? current.nextElementSibling : current.previousElementSibling;
    if (next) focusEl(next, true);
    else bounce(current, dx, 0);
    return;
  }

  var cr = current.getBoundingClientRect();
  var cx = cr.left + cr.width / 2;
  var cy = cr.top + cr.height / 2;
  var viewW = window.innerWidth;

  // Tiles sharing the current tile's band - its rows for Left/Right, its
  // columns for Up/Down - always beat tiles outside it, then the nearest edge
  // wins. Scoring by centres alone let a small tile below beat a big tile
  // beside: Left from the highlight tile under Qualifying went down to a
  // Practice tile instead of across to the tall race tile.
  function pick(candidates) {
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (el) {
      if (el === current) return;
      var r = el.getBoundingClientRect();
      var vx = r.left + r.width / 2 - cx;
      var vy = r.top + r.height / 2 - cy;
      if (vx * dx + vy * dy <= 0) return;
      var gap = dx > 0 ? r.left - cr.right : dx < 0 ? cr.left - r.right : dy > 0 ? r.top - cr.bottom : cr.top - r.bottom;
      var overlap = dx !== 0
        ? Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top)
        : Math.min(r.right, cr.right) - Math.max(r.left, cr.left);
      var offAxis = dx !== 0 ? Math.abs(vy) : Math.abs(vx);
      // Within the band, line up edges rather than centres: Right from the
      // tall race tile goes to the top tile beside it (Qualifying), not
      // whichever stacked tile's centre is a few pixels nearer.
      var edgeOffset = dx !== 0 ? Math.abs(r.top - cr.top) : Math.abs(r.left - cr.left);
      var score = overlap > 0 ? Math.max(0, gap) + edgeOffset * 0.5 : 1e6 + Math.max(0, gap) + offAxis * 3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  var best = null;
  if (dy !== 0) {
    best = pick(all.filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.right > 0 && r.left < viewW;
    }));
  }
  best = best || pick(all);
  if (best) focusEl(best, false);
  else bounce(current, dx, dy);
}

document.addEventListener("keydown", function (e) {
  var DIRS = { 37: [-1, 0], 38: [0, -1], 39: [1, 0], 40: [0, 1] };
  var d = DIRS[e.keyCode];
  if (!d) return;
  e.preventDefault();
  moveFocus(d[0], d[1]);
});

// ---- load -----------------------------------------------------------------
// Opens on the last page this TV fetched, saved in the app's localStorage,
// then refreshes it in the background every time. The saved copy is read the
// moment the page loads; a fresh copy has to wait for the app's service to
// start, which can take seconds on the TV. Only the very first open shows the
// skeleton.
//
// Always refreshing (rather than trusting the saved copy until some date) is
// deliberate: it's one request, and a weekend's page keeps changing for days
// - highlights, shows and press conferences land after the sessions, and LIVE
// badges must clear. Dates decide how often to re-check while Browse stays
// open instead: during a race weekend, every two minutes.
//
// Dev-only URL flags: ?nocache ignores the saved copy, ?skeleton holds the
// loading skeleton on screen.
function pageCacheKey() {
  return "f1hud.browse.page." + currentPageId + ".v1";
}
var WEEKEND_REFRESH_MS = 2 * 60 * 1000;
var DAY_MS = 24 * 3600 * 1000;
var params = new URLSearchParams(window.location.search);

var shownSignature = null; // JSON of the trays currently on screen
var shownFetchedAt = 0; // when that data came from F1 TV
var inFlight = null;
var inFlightPageId = null;
var keepHeaderFocus = false; // set when a weekend switch starts from the header
var refreshTimer = null;

function readCache() {
  if (params.has("nocache")) return null;
  try {
    var saved = JSON.parse(window.localStorage.getItem(pageCacheKey()));
    return saved && Array.isArray(saved.trays) ? saved : null;
  } catch (e) {
    return null;
  }
}

function writeCache(trays) {
  try {
    window.localStorage.setItem(pageCacheKey(), JSON.stringify({ savedAt: Date.now(), trays: trays }));
  } catch (e) {
    /* storage full or unavailable: the page still works, it just opens slower */
  }
}

function setStatus(text, kind) {
  var el = document.getElementById("status");
  el.textContent = text;
  el.className = kind || "";
  el.hidden = !text;
}

function railByName(name) {
  var rails = document.querySelectorAll(".rail");
  for (var i = 0; i < rails.length; i++) {
    if (rails[i].getAttribute("data-rail") === name) return rails[i];
  }
  return null;
}

// What the viewer is looking at, so a background refresh can re-render
// without moving their focus or scrolling rows back to the start.
function snapshotView() {
  var active = document.activeElement;
  var rows = {};
  Array.prototype.forEach.call(document.querySelectorAll(".rail"), function (r) {
    rows[r.getAttribute("data-rail")] = r.querySelector(".rail-row").scrollLeft;
  });
  var inRail = active && active.closest ? active.closest(".rail") : null;
  return {
    id: active && active.getAttribute ? active.getAttribute("data-id") : null,
    rail: inRail ? inRail.getAttribute("data-rail") : null,
    rows: rows,
    element: active,
  };
}

function restoreView(view) {
  Object.keys(view.rows).forEach(function (name) {
    var r = railByName(name);
    if (!r) return;
    var row = r.querySelector(".rail-row");
    row.scrollLeft = view.rows[name];
    updateRowEdges(row);
  });
  var target = null;
  if (view.id) {
    var scope = view.rail ? railByName(view.rail) : document.getElementById("hero");
    var selector = '[data-id="' + view.id.replace(/"/g, "") + '"]';
    target = (scope && scope.querySelector(selector)) || document.querySelector(selector);
  } else if (view.element && document.body.contains(view.element) && view.element !== document.body) {
    target = view.element; // header buttons and the banner aren't re-rendered
  }
  target = target || document.getElementById("hero-main") || focusables()[0];
  if (target) target.focus({ preventScroll: true });
  if (typeof view.pageTop === "number") document.body.scrollTop = view.pageTop;
}

// Renders trays unless they're what's already on screen. Returns whether it
// rendered.
function showTrays(trays, signature) {
  if (signature === shownSignature || params.has("skeleton")) return false;
  var firstRender = shownSignature === null;
  var view = firstRender ? null : snapshotView();
  var count = render(trays);
  shownSignature = signature;
  document.body.classList.remove("is-loading");
  if (!count) {
    setStatus("Nothing to watch on this page yet.", "fail");
    return true;
  }
  // First render after coming back from the player: pick up where the
  // viewer left Browse.
  if (!view && firstRender) view = takeSavedView();
  if (keepHeaderFocus) {
    // Switched weekends from the header: stay there for the next press.
    keepHeaderFocus = false;
  } else if (view) {
    restoreView(view);
  } else {
    var lead = document.getElementById("hero-main") || focusables()[0];
    if (lead) focusEl(lead);
  }
  return true;
}

// During a race weekend - from a day before its first session to a day after
// its last - sessions go live and replays and highlights appear, so re-check
// while Browse stays open. Any other time, opening or returning to the app
// (or the refresh button) is enough.
function scheduleRefresh(trays) {
  clearTimeout(refreshTimer);
  var sessions = collectSessions(trays);
  if (!sessions.length) return;
  var first = sessions[0].start;
  var lastSession = sessions[sessions.length - 1];
  var last = lastSession.end || lastSession.start;
  var now = Date.now();
  if (first && now > first - DAY_MS && now < last + DAY_MS) {
    refreshTimer = setTimeout(loadAndRender, WEEKEND_REFRESH_MS);
  }
}

function savedAtText(ms) {
  return dayShort(ms) + " " + new Date(ms).getDate() + " " + MONTHS[new Date(ms).getMonth()] + ", " + hhmm(ms);
}

// manual: the refresh button. Only then does the button spin - the check on
// every open runs quietly, so a page shown from the saved copy doesn't look
// like it's reloading.
function loadAndRender(manual) {
  if (inFlight && inFlightPageId === currentPageId) return inFlight;
  var pageId = currentPageId;
  if (shownSignature === null) {
    var saved = readCache();
    if (saved) {
      // Shown straight away, without the fade-in a first fetch gets.
      document.body.classList.add("instant");
      showTrays(saved.trays, JSON.stringify(saved.trays));
      shownFetchedAt = saved.savedAt || 0;
      scheduleRefresh(saved.trays);
    }
  }
  var refresh = document.getElementById("refresh-link");
  if (manual === true) refresh.classList.add("busy");

  // err: the failed reply, explained by js/errors.js.
  function failed(err) {
    if (shownSignature === null) {
      var why = explainFailure(err);
      document.body.classList.remove("is-loading");
      setStatus(why.title + ". " + why.text, "fail");
    } else {
      var when = shownFetchedAt ? savedAtText(shownFetchedAt) : "";
      setStatus("Couldn't refresh from F1 TV" + (when ? " - showing the page from " + when : "") + ".", "note");
    }
  }

  inFlightPageId = pageId;
  var request = (inFlight = callService("f1tvPage", { pageId: pageId })
    .then(function (res) {
      if (pageId !== currentPageId) return; // switched weekends meanwhile
      if (!res.returnValue) {
        failed(res);
        return;
      }
      var trays = (res.body && res.body.resultObj && res.body.resultObj.containers) || [];
      setStatus("");
      showTrays(trays, JSON.stringify(trays));
      shownFetchedAt = Date.now();
      writeCache(trays);
      scheduleRefresh(trays);
    })
    .catch(function (err) {
      if (pageId !== currentPageId) return;
      failed(err);
    })
    .then(function () {
      if (inFlight === request) {
        inFlight = null;
        inFlightPageId = null;
      }
      refresh.classList.remove("busy");
    }));
  return request;
}

document.getElementById("refresh-link").addEventListener("click", function (e) {
  e.preventDefault();
  loadAndRender(true);
});

// Coming back to the app (webOS keeps it running in the background).
document.addEventListener("visibilitychange", function () {
  if (!document.hidden) loadAndRender();
});

// Sign-in check. F1 issues 96-hour passes, but the service renews them from
// the 30-day session behind them, so a warning here means the session
// itself is nearly up and someone has to log in again in a browser. The
// service reports that as expiringSoon only when renewal can't save it.
function checkSignIn() {
  callService("getAuthStatus")
    .then(function (res) {
      if (!res.hasToken) {
        window.location.href = "setup.html";
        return;
      }
      var banner = document.getElementById("auth-banner");
      if (res.expiringSoon) {
        var hours = Math.max(1, Math.round(res.hoursLeft));
        document.getElementById("auth-banner-text").textContent =
          "Your F1 TV sign-in expires in " + (res.hoursLeft < 1 ? "under an hour" : hours + " hour" + (hours === 1 ? "" : "s")) +
          ". Log in on formula1.com again to extend it.";
        banner.style.display = "flex";
      } else {
        banner.style.display = "none";
      }
    })
    .catch(function () { /* the page itself still works; nothing to warn about */ });
}

checkSignIn();
// The first load is started by js/weekends.js once it knows which weekend.
