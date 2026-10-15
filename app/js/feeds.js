// Feed naming, grouping and ordering for the player's camera picker. Pure
// functions over a PLAY response's resultObj.tme.feeds - no DOM, no state.
//
// Feed URLs used to carry a readable path (".../Main/WIF-F1-R1/..."), but
// are opaque hashes as of 2026, so names come from the content's
// additionalStreams, which the service returns alongside PLAY as `streams`
// (see streamsFromContent in service/index.js): the main feeds by identifier,
// each onboard with its driver, team and team colour. Without those details a
// feed still gets a usable label from the known main-feed channel ids and its
// racing_number.

var MAIN_FEED_NAMES = { WIF: "International", PRES: "F1 Live", TRACKER: "Driver Tracker", DATA: "Data Channel" };
var MAIN_FEED_ORDER = ["WIF", "PRES", "TRACKER", "DATA"];
// Channel ids the main feeds have had in every session captured so far.
var MAIN_FEED_CHANNELS = { 1025: "WIF", 1033: "PRES", 1003: "TRACKER", 1004: "DATA" };

function streamsByChannel(streams) {
  var byChannel = {};
  (streams || []).forEach(function (s) { byChannel[s.channelId] = s; });
  return byChannel;
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// {channelId, main, group, color, code, name, order}
function describeFeed(feed, byChannel) {
  var id = feed.metadata.channel_id;
  var s = byChannel[id] || {};
  var number = feed.metadata.racing_number != null ? feed.metadata.racing_number : s.racingNumber;
  var identifier = s.identifier || MAIN_FEED_CHANNELS[id];
  var onboard = s.type ? s.type === "obc" : !!number && !MAIN_FEED_CHANNELS[id];
  if (onboard) {
    var name = [s.firstName, s.lastName].filter(Boolean).join(" ");
    return {
      channelId: id,
      main: false,
      group: s.team || "Onboards",
      color: s.color || null,
      code: s.title || "",
      name: name || "Car " + number,
      order: Number(number) || 0,
    };
  }
  return {
    channelId: id,
    main: true,
    group: "Main feeds",
    color: null,
    code: "",
    name: MAIN_FEED_NAMES[identifier] || (s.title ? titleCase(s.title) : "Channel " + id),
    order: MAIN_FEED_ORDER.indexOf(identifier) === -1 ? 50 : MAIN_FEED_ORDER.indexOf(identifier),
  };
}

// One line, e.g. "International" or "NOR: Lando Norris".
function labelForFeed(feed, streams) {
  var d = describeFeed(feed, streamsByChannel(streams));
  return d.code ? d.code + ": " + d.name : d.name;
}

// Picker groups: main feeds first, then one group per team in alphabetical
// order, drivers within a team by their three-letter code.
function groupFeeds(feeds, streams) {
  var byChannel = streamsByChannel(streams);
  var groups = {};
  var list = [];
  feeds.forEach(function (feed) {
    var d = describeFeed(feed, byChannel);
    d.feed = feed;
    var g = groups[d.group];
    if (!g) {
      g = groups[d.group] = { name: d.group, color: d.color, main: d.main, items: [] };
      list.push(g);
    }
    g.items.push(d);
  });
  list.sort(function (a, b) {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  list.forEach(function (g) {
    g.items.sort(function (a, b) {
      return g.main ? a.order - b.order : (a.code || a.name).localeCompare(b.code || b.name) || a.order - b.order;
    });
  });
  return list;
}

// The feed to start on: the international broadcast. F1's own default
// (resultObj.channelId, or the stream flagged default) has been the "F1 Live"
// pre-show feed, not the race broadcast.
function defaultFeed(feeds, streams, fallbackChannelId) {
  var byChannel = streamsByChannel(streams);
  function isWif(f) {
    var s = byChannel[f.metadata.channel_id];
    return s ? s.identifier === "WIF" : MAIN_FEED_CHANNELS[f.metadata.channel_id] === "WIF";
  }
  return (
    feeds.filter(isWif)[0] ||
    feeds.filter(function (f) { return f.metadata.channel_id === fallbackChannelId; })[0] ||
    feeds[0]
  );
}
