// Bootstrap: check whether we're paired with F1TV and go straight to the
// right screen - Browse when signed in, the sign-in screen otherwise.

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function setError(text) {
  document.getElementById("error").textContent = text;
}

// callService() (real Luna on-device, mocked in a plain browser) comes
// from js/local-mock.js, loaded before this file.

setStatus("checking pairing status…");
callService("getAuthStatus")
  .then(function (res) {
    window.location.href = res.hasToken ? "browse.html" : "setup.html";
  })
  .catch(function (err) {
    setStatus("");
    setError(
      "Could not reach the on-TV service (" + (err.errorText || JSON.stringify(err)) +
      "). Try relaunching the app."
    );
  });
