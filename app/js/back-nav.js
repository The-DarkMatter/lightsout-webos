// Handles the Magic Remote's Back button. appinfo.json sets
// disableBackHistoryAPI so webOS's automatic history.back()-on-Back
// behavior is off, and we navigate deliberately instead - with a small
// multi-page app (separate HTML files per screen, not client-side
// routing), relying on raw browser history across full navigations is
// less predictable than just saying where Back goes from each screen.
//
// Include this after webOSTV.js and put the target on <body data-back="...">.
// Omit data-back on a screen that should be treated as "home" - Back there
// calls webOS.platformBack() (minimize/exit), not a no-op.
(function () {
  var BACK_KEYCODE = 461; // documented webOS TV remote Back key
  var ESCAPE_KEYCODE = 27; // desktop-testing fallback, harmless on-device

  document.addEventListener("keydown", function (e) {
    if (e.keyCode !== BACK_KEYCODE && e.keyCode !== ESCAPE_KEYCODE) return;
    var target = document.body.getAttribute("data-back");
    if (target) {
      window.location.href = target;
    } else if (window.webOS && typeof window.webOS.platformBack === "function") {
      window.webOS.platformBack();
    }
  });
})();
