// We never need to verify F1's signature - the token is only ever used as a
// bearer credential we hand back to F1's own servers, which do the actual
// verification. We only decode the payload locally to show/log the expiry.
function decodePayload(jwt) {
  var parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  try {
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

module.exports = { decodePayload: decodePayload };
