// Invented catalogue for Browse in mock mode (dev/mocks.js answers f1tvPage
// and f1tvSeason from these). The shape follows F1 TV's PAGE and season
// search responses as browse.js and service/index.js read them; every name,
// id and date is made up, and there are no thumbnails.
//
// The weekend is placed around the current time, so the schedule shows
// finished sessions, one live now, and ones still to come.

(function () {
  var HOUR = 3600 * 1000;
  var now = Date.now();
  var MEETING = {
    Meeting_Name: "Testland Grand Prix",
    Meeting_Number: "7",
    Circuit_Short_Name: "Testring",
    Meeting_Location: "Testville",
    Meeting_Country_Name: "Testland",
  };
  var nextId = 900000001;

  function video(series, titleBrief, startOffsetH, hours, extra) {
    var start = now + startOffsetH * HOUR;
    var state = startOffsetH <= 0 && startOffsetH + hours > 0 ? "Live" : startOffsetH > 0 ? "Pre-Live" : "Archive";
    var emf = Object.assign(
      {
        Series: { F1: "FORMULA 1", F2: "FORMULA 2", F3: "FORMULA 3" }[series] || "",
        OBC: false,
        state: state,
        ContentCategory: "RACE",
        sessionStartDate: start,
        sessionEndDate: start + hours * HOUR,
      },
      MEETING,
      extra || {}
    );
    var h = Math.floor(hours);
    var m = Math.round((hours - h) * 60);
    return {
      metadata: {
        contentId: nextId++,
        contentType: "VIDEO",
        contentSubtype: state === "Live" ? "LIVE" : "REPLAY",
        title: "Testland GP - " + series + " " + titleBrief,
        titleBrief: titleBrief,
        uiDuration: "0" + h + ":" + (m < 10 ? "0" : "") + m + ":00",
        uiSeries: series,
        pictureUrl: "",
        country: "TST",
        emfAttributes: emf,
      },
    };
  }

  var schedule = [
    video("F1", "Practice 1", -50, 1),
    video("F2", "Practice", -47, 0.75),
    video("F1", "Practice 2", -46, 1),
    video("F1", "Practice 3", -26, 1),
    video("F1", "Qualifying", -22, 1),
    video("F2", "Sprint Race", -2, 1),
    video("F1", "Race", -0.5, 2),
    video("F3", "Feature Race", 20, 1),
    video("F1", "Post-Race Show", 3, 1, { ContentCategory: "EPISODIC" }),
  ];

  function rail(title, items) {
    return { layout: "horizontal_thumbnail", title: title, retrieveItems: { resultObj: { containers: items } } };
  }

  window.MOCK_BROWSE_PAGE = {
    returnValue: true,
    statusCode: 200,
    body: {
      resultObj: {
        containers: [
          {
            layout: "gp_banner",
            title: "",
            retrieveItems: {
              resultObj: {
                containers: [
                  {
                    metadata: {
                      contentId: 950000007,
                      contentType: "BUNDLE",
                      contentSubtype: "MEETING",
                      title: "TESTLAND GRAND PRIX",
                      titleBrief: "Testland Grand Prix",
                      uiSeries: "",
                      pictureUrl: "",
                      emfAttributes: Object.assign({
                        OBC: false,
                        sessionStartDate: 0,
                        sessionEndDate: 0,
                        Meeting_Start_Date: new Date(now - 50 * HOUR).toISOString(),
                        Meeting_End_Date: new Date(now + 24 * HOUR).toISOString(),
                      }, MEETING),
                    },
                  },
                ],
              },
            },
          },
          {
            layout: "interactive_schedule",
            title: "",
            retrieveItems: { resultObj: { containers: [{ eventName: "ALL", events: schedule }] } },
          },
          rail("Replays", schedule.filter(function (v) { return v.metadata.emfAttributes.state === "Archive"; })),
          rail("Shows & Analysis", [
            video("F1", "Weekend Warm-Up", -52, 0.5, { ContentCategory: "EPISODIC" }),
            video("F1", "Tech Talk", -30, 0.25, { ContentCategory: "EPISODIC" }),
            video("F1", "Highlights", -20, 0.2, { ContentCategory: "EPISODIC" }),
          ]),
          rail("Formula 2", schedule.filter(function (v) { return v.metadata.uiSeries === "F2"; })),
        ],
      },
    },
  };

  var year = new Date(now).getFullYear();
  var names = ["Opening", "Northland", "Eastport", "Lakeside", "Highfield", "Coastal", "Testland", "Valley", "Final"];
  window.MOCK_SEASONS = {};
  window.MOCK_SEASONS[year] = {
    returnValue: true,
    season: year,
    meetings: names.map(function (name, i) {
      var start = now + (i - 6) * 14 * 24 * HOUR - 48 * HOUR;
      return {
        pageId: 990000 + i,
        name: name + " Grand Prix",
        official: name.toUpperCase() + " GRAND PRIX " + year,
        country: name + "land",
        location: name + " City",
        circuit: name + " Circuit",
        round: i + 1,
        test: false,
        start: new Date(start).toISOString(),
        end: new Date(start + 72 * HOUR).toISOString(),
      };
    }),
  };
})();
