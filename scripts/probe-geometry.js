'use strict';

// Diagnostic: report the native geometry of every Vellum window and the
// primary display metrics, so DPI/client-area mismatches are measurable.

const { app, screen } = require('electron');
const path = require('node:path');

app.setPath('userData', path.join(__dirname, '..', '.cache', 'probe-geometry-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const win32 = require('../src/main/native/win32');
  win32.load();
  const display = screen.getPrimaryDisplay();
  console.log(
    JSON.stringify({
      display: {
        size: display.size,
        scaleFactor: display.scaleFactor,
        physical: {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor),
        },
      },
    })
  );

  const found = new Set();
  for (const hwnd of win32.collectTopLevel((h) => win32.titleOf(h).includes('Vellum'))) found.add(hwnd);
  // The wallpaper window is a child of the Explorer WorkerW, so walk the
  // wallpaper host's children too.
  const host = win32.findWallpaperHost();
  if (host) {
    for (const hwnd of win32.collectChildren(host, (h) => win32.titleOf(h).includes('Vellum'))) found.add(hwnd);
  }
  const windows = [...found];
  for (const hwnd of windows) {
    console.log(
      JSON.stringify({
        title: win32.titleOf(hwnd),
        handle: String(hwnd),
        parent: win32.parentOf(hwnd),
        geometry: win32.geometryOf(hwnd),
      })
    );
  }
  if (!windows.length) console.log('no Vellum windows found');
  app.quit();
});
