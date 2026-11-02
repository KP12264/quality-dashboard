// Loads browser scripts (config.js + pure modules) into one vm context, like a page does,
// so Node unit tests run the exact files the pages use. Returns the context (its window).
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');

function loadModules(files, extra) {
  const ctx = { console, Map, Set, Date, Math, JSON, Promise, Number, String, Array, Object, Error, RegExp, URLSearchParams };
  ctx.window = ctx; ctx.self = ctx;
  Object.assign(ctx, extra || {});
  vm.createContext(ctx);
  files.forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}
module.exports = { loadModules, ROOT };
