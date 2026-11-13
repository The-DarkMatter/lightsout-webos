var fs = require("fs");
var path = require("path");

if (!Object.assign) {
  Object.assign = function (target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source == null) continue;
      Object.keys(source).forEach(function (key) {
        target[key] = source[key];
      });
    }
    return target;
  };
}

if (!Buffer.from) {
  Buffer.from = function (value, encoding) {
    return new Buffer(value, encoding);
  };
}

var mkdirSync = fs.mkdirSync;

fs.mkdirSync = function (dir, options) {
  if (!options || typeof options !== "object") {
    return mkdirSync.apply(fs, arguments);
  }
  try {
    return mkdirSync.call(fs, dir, options.mode);
  } catch (e) {
    if (!options.recursive) throw e;
    if (e.code === "EEXIST" && fs.statSync(dir).isDirectory()) return;
    if (e.code !== "ENOENT") throw e;
    fs.mkdirSync(path.dirname(dir), options);
    return mkdirSync.call(fs, dir, options.mode);
  }
};

["http", "https"].forEach(function (name) {
  var mod = require(name);
  var request = mod.request;

  mod.request = function (options) {
    var req = request.apply(mod, arguments);
    if (!req.destroy) {
      req.destroy = function (err) {
        req.abort();
        if (err) req.emit("error", err);
      };
    }
    if (options && options.timeout) {
      req.setTimeout(options.timeout);
    }
    return req;
  };

  mod.get = function () {
    var req = mod.request.apply(mod, arguments);
    req.end();
    return req;
  };
});
