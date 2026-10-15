// callService(method, parameters): one call to this app's on-TV service,
// resolving with its response or rejecting with {errorText, ...}.
//
// On the TV it goes over the Luna bus. window.PalmServiceBridge, the native
// bridge object, only exists in the real webOS runtime - webOSTV.js defines
// window.webOS everywhere, so that isn't the signal.
//
// On a PC, scripts/dev-server.js serves the app and runs the real service
// code, answering at /api/<method>; returnValue:false rejects, as Luna's
// onFailure does on the TV. With --mock it also injects dev/mocks.js, which
// answers from canned data instead and never reaches F1.

function callService(method, parameters) {
  if (window.PalmServiceBridge) {
    return new Promise(function (resolve, reject) {
      webOS.service.request("luna://com.amogh.f1hud.service", {
        method: method,
        parameters: parameters || {},
        onSuccess: resolve,
        onFailure: reject,
      });
    });
  }
  if (window.F1HUD_MOCKS) return window.F1HUD_MOCKS.respond(method, parameters);
  return fetch("/api/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parameters || {}),
  })
    .then(function (res) {
      return res.json();
    }, function () {
      throw { errorText: "the dev server isn't answering (node scripts/dev-server.js)" };
    })
    .then(function (body) {
      if (body && body.returnValue === false) throw body;
      return body;
    });
}
