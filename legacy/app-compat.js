(function () {
  if ("scrollBehavior" in document.documentElement.style) return;

  var scrollIntoView = Element.prototype.scrollIntoView;

  Element.prototype.scrollIntoView = function (options) {
    if (!options || typeof options !== "object") {
      return scrollIntoView.apply(this, arguments);
    }
    if (options.block === "nearest" && this.scrollIntoViewIfNeeded) {
      return this.scrollIntoViewIfNeeded(false);
    }
    return scrollIntoView.call(this, options.block !== "end");
  };
})();

// Chrome 53 has no element.scrollTo, which browse.js and weekends.js use to
// keep the rails and the season list following D-pad focus. "smooth" is
// animated here, since a jump on every key press reads as flicker.
(function () {
  if (Element.prototype.scrollTo) return;

  var DURATION = 250;

  Element.prototype.scrollTo = function (options, y) {
    var left = this.scrollLeft;
    var top = this.scrollTop;
    if (options && typeof options === "object") {
      if (options.left != null) left = +options.left;
      if (options.top != null) top = +options.top;
    } else if (arguments.length >= 2) {
      left = +options;
      top = +y;
    }

    var el = this;
    if (el._compatScroll) cancelAnimationFrame(el._compatScroll);
    el._compatScroll = null;

    if (!options || options.behavior !== "smooth") {
      el.scrollLeft = left;
      el.scrollTop = top;
      return;
    }

    var fromLeft = el.scrollLeft;
    var fromTop = el.scrollTop;
    var start = null;
    function step(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / DURATION);
      var ease = 1 - Math.pow(1 - t, 3);
      el.scrollLeft = fromLeft + (left - fromLeft) * ease;
      el.scrollTop = fromTop + (top - fromTop) * ease;
      el._compatScroll = t < 1 ? requestAnimationFrame(step) : null;
    }
    el._compatScroll = requestAnimationFrame(step);
  };
})();
