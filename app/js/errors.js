// Words for what went wrong, for someone on the sofa rather than a
// developer. Each returns {title, text, signIn}; signIn means the way out
// is the sign-in screen.

// A failed service call. F1 TV failures carry a reason from the service
// (service/lib/failure.js), and F1's own message when it sent one.
function explainFailure(err) {
  err = err || {};
  var said = err.f1Message ? " F1 TV said: “" + err.f1Message + "”" : "";
  switch (err.needsSignIn ? "signin" : err.reason) {
    case "signin":
      return { title: "Sign in again", text: "Your F1 TV sign-in has ended. Sign in again to keep watching.", signIn: true };
    case "subscription":
      return {
        title: "Not included in your F1 TV plan",
        text: "F1 TV won't play this on your account. Live sessions and onboard cameras need F1 TV Pro or Premium." + said,
      };
    case "region":
      return { title: "Not available where you are", text: "F1 TV doesn't offer this in your country." + said };
    case "unavailable":
      return { title: "Not available", text: "F1 TV doesn't have this video, or it isn't ready yet." + said };
    case "network":
      return { title: "Can't reach F1 TV", text: "Check the TV's internet connection, then try again." };
    case "changed":
      return {
        title: "F1 TV answered unexpectedly",
        text: "F1 TV may have changed something this app relies on. Look for an update in Homebrew Channel, " +
          "or report it on the app's GitHub page." + said,
      };
    default:
      return {
        title: "Something went wrong",
        text: (err.errorText || "The app's service didn't answer.") + " Try again, or relaunch the app.",
      };
  }
}

// A Shaka Player error while loading or playing a feed. Category 6 is DRM:
// on F1 TV only live streams are protected, and the licence is where an
// account without live access gets turned away. Category 1 is the network.
function explainPlayerError(err) {
  var code = err && err.code ? " (player error " + err.code + ")" : "";
  if (err && err.category === 6) {
    return {
      title: "Couldn't unlock this live stream",
      text: "F1 TV refused the stream's licence" + code + ". Live sessions need F1 TV Pro or Premium; " +
        "if your plan includes them, try signing in again.",
      signIn: true,
    };
  }
  if (err && err.category === 1) {
    return { title: "Couldn't load the video", text: "The stream didn't download" + code + ". Check the TV's internet connection." };
  }
  return { title: "Couldn't play this feed", text: "The player stopped" + code + ". Try another camera, or go back and try again." };
}
