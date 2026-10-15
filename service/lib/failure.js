// Failed F1 TV calls, sorted into a few reasons the app can explain to a
// viewer (app/js/errors.js does the explaining):
//
//   signin       the sign-in is gone or was refused
//   subscription F1 TV won't serve this to this account
//   region       F1 TV won't serve this in the viewer's country
//   unavailable  the content isn't there (gone, or not published yet)
//   network      F1 TV couldn't be reached at all
//   changed      F1 TV answered in a shape this app doesn't understand
//
// F1 TV's error replies aren't documented, so subscription vs region is
// read from the wording of F1's own message, and that message is passed
// along so the viewer sees F1's words even when the guess is wrong.

var NETWORK_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/;

function f1Message(body) {
  if (!body || typeof body !== "object") return "";
  var m = body.message || body.errorDescription || (body.resultObj && body.resultObj.message) || "";
  return String(m).slice(0, 300);
}

// what: names the call in errorText, e.g. "F1 TV PLAY".
function fromResponse(res, what) {
  var status = res && res.statusCode;
  var message = f1Message(res && res.body);
  var reason;
  if (status === 401) reason = "signin";
  else if (status === 403 || status === 451) {
    reason = /geo|region|countr|locat|territor|not available in/i.test(message) ? "region" : "subscription";
  } else if (status === 404) reason = "unavailable";
  else reason = "changed";
  return {
    returnValue: false,
    reason: reason,
    f1Status: status,
    f1Message: message,
    errorText: what + " returned " + status + (message ? ": " + message : ""),
  };
}

function fromError(err, what) {
  var network = NETWORK_CODES.test((err && err.code) || "") || /timeout/i.test(String(err && err.message));
  return {
    returnValue: false,
    reason: network ? "network" : "changed",
    errorText: what + " failed: " + String((err && err.message) || err),
  };
}

module.exports = {
  fromResponse: fromResponse,
  fromError: fromError,
};
