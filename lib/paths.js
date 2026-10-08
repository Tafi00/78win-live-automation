// Writable data paths — resolve ngoài app.asar (read-only) khi packaged.
// Dev: <repo>/… ; Packaged: <userData>/…
const path = require('path');
const fs = require('fs');

const IS_PACKAGED = __dirname.includes('app.asar');
let DATA_ROOT;
if (IS_PACKAGED) {
  const { app } = require('electron');
  DATA_ROOT = app.getPath('userData');
} else {
  DATA_ROOT = path.join(__dirname, '..');
}

function dataPath(...segments) {
  return path.join(DATA_ROOT, ...segments);
}
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}

// read-only config — đọc trong repo/asar (files đã gồm bounty.config.json)
const CONFIG_FILE = path.join(__dirname, '..', 'bounty.config.json');

module.exports = { IS_PACKAGED, DATA_ROOT, dataPath, ensureDir, CONFIG_FILE };
