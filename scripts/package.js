'use strict';
// Build a self-contained portable Vellum folder (no installer, no network).
// Layout: dist/Vellum/Vellum.exe + resources/app/{package.json,src,assets,node_modules/koffi}
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_ROOT = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'dist', 'Vellum');
const APP = path.join(OUT, 'resources', 'app');

if (!fs.existsSync(path.join(ELECTRON_ROOT, 'electron.exe'))) {
  console.error('electron dist missing; run npm install first');
  process.exit(1);
}

fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 1. Electron runtime
fs.cpSync(ELECTRON_ROOT, OUT, { recursive: true });
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'Vellum.exe'));
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 2. App source
fs.cpSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));
fs.cpSync(path.join(ROOT, 'src'), path.join(APP, 'src'), { recursive: true });
fs.cpSync(path.join(ROOT, 'assets'), path.join(APP, 'assets'), { recursive: true });
fs.cpSync(path.join(ROOT, 'docs'), path.join(APP, 'docs'), { recursive: true });

// 3. Native dependency (koffi ships prebuilt binaries)
fs.cpSync(path.join(ROOT, 'node_modules', 'koffi'), path.join(APP, 'node_modules', 'koffi'), { recursive: true });
const optionalScope = path.join(ROOT, 'node_modules', '@koromix');
if (fs.existsSync(optionalScope)) {
  fs.cpSync(optionalScope, path.join(APP, 'node_modules', '@koromix'), { recursive: true });
}

// 4. Small user-facing files
const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme)) fs.cpSync(readme, path.join(OUT, 'README.md'));
fs.writeFileSync(path.join(OUT, 'Vellum.cmd'), [
  '@echo off',
  'rem Launch Vellum wallpaper. Arguments are forwarded (--hidden for silent start).',
  'start "" "%~dp0Vellum.exe" %*',
].join('\r\n') + '\r\n');

let bytes = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else bytes += fs.statSync(full).size;
  }
}
walk(OUT);
console.log('built ' + OUT);
console.log('size ' + (bytes / 1024 / 1024).toFixed(1) + ' MB');
