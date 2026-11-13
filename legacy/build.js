var fs = require("fs");
var path = require("path");
var execSync = require("child_process").execSync;

var root = path.join(__dirname, "..", "build", "legacy");
var appDir = path.join(root, "app");
var serviceDir = path.join(root, "service");
var modulesDir = path.join(serviceDir, "node_modules");
var depsDir = path.join(__dirname, "deps", "node_modules");

patchService();
patchApp();

function patchService() {
  copy(path.join(__dirname, "service-compat.js"), path.join(serviceDir, "compat.js"));
  prependLine(path.join(serviceDir, "index.js"), 'require("./compat");');

  execSync("rm -rf ws", { cwd: modulesDir });
  ["ws", "options", "ultron"].forEach(function (name) {
    execSync("cp -r " + path.join(depsDir, name) + " " + modulesDir);
  });

  var stubDir = path.join(modulesDir, "webos-service");
  execSync("rm -rf " + stubDir);
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, "index.js"),
    'module.exports = require("/usr/lib/node_modules/webos-service");\n');
}

function patchApp() {
  copy(path.join(__dirname, "app-compat.js"), path.join(appDir, "js", "compat.js"));

  fs.readdirSync(appDir).forEach(function (name) {
    if (!/\.html$/.test(name)) return;
    var file = path.join(appDir, name);
    var html = fs.readFileSync(file, "utf8");
    html = html.replace(/<style>([\s\S]*?)<\/style>/, function (all, css) {
      return "<style>" + patchCss(css) + "</style>";
    });
    html = html.replace(/(\n[ \t]*)<script /, '$1<script src="js/compat.js"></script>$1<script ');
    fs.writeFileSync(file, html);
  });
}

function patchCss(css) {
  var rule = /([^{}]+)\{([^{}]*)\}/g;

  var direction = {};
  css.replace(rule, function (all, selectors, body) {
    var match = /flex-direction\s*:\s*([a-z-]+)/.exec(body);
    if (match) {
      selectorList(selectors).forEach(function (selector) {
        direction[selector] = match[1];
      });
    }
  });

  var gapRules = [];
  css = css.replace(rule, function (all, selectors, body) {
    var gap = /(^|[;\s])gap\s*:\s*([^;}]+)/.exec(body);
    if (gap) {
      var values = gap[2].trim().split(/\s+/);
      var rowGap = values[0];
      var columnGap = values[1] || values[0];
      selectorList(selectors).forEach(function (selector) {
        var isColumn = /column/.test(direction[selector] || "");
        gapRules.push(selector + " > * + * { " +
          (isColumn ? "margin-top: " + rowGap : "margin-left: " + columnGap) + "; }");
      });
    }
    body = body.replace(/(^|[;\s])inset\s*:\s*0\s*(;|$)/g, "$1top: 0; right: 0; bottom: 0; left: 0$2");
    body = body.replace(/aspect-ratio\s*:\s*16\s*\/\s*9\s*;?/g, "width: auto;");
    return selectors + "{" + body + "}";
  });

  return "\n" + gapRules.join("\n") + "\n" + css;
}

function selectorList(selectors) {
  return selectors
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(",")
    .map(function (s) { return s.trim().replace(/\s+/g, " "); });
}

function prependLine(file, line) {
  var text = fs.readFileSync(file, "utf8");
  if (text.indexOf(line) !== 0) fs.writeFileSync(file, line + "\n" + text);
}

function copy(from, to) {
  fs.writeFileSync(to, fs.readFileSync(from));
}
