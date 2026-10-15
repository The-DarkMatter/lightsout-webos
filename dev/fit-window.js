// Injected by scripts/dev-server.js into every page it serves.
//
// Every page is a fixed 1920x1080 canvas with overflow:hidden - correct
// for how webOS scales a TV app to the panel, but in a normal browser
// window that's not 1920x1080, overflow:hidden means the excess is
// clipped and invisible, not just scrollable. Auto-scale the whole page
// to fit the actual window, only when not running in real webOS (the TV
// always gets the untouched, unscaled canvas).
function fitToWindow() {
  if (window.PalmServiceBridge) return;
  var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
  document.body.style.transformOrigin = "top left";
  document.body.style.transform = "scale(" + scale + ")";
}
window.addEventListener("resize", fitToWindow);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", fitToWindow);
} else {
  fitToWindow();
}

