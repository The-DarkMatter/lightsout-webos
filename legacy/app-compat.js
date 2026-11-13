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
