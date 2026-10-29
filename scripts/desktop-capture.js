'use strict';
const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();
    const w = Math.round(d.size.width * d.scaleFactor);
    const h = Math.round(d.size.height * d.scaleFactor);
    console.log('display', JSON.stringify({size:d.size, scaleFactor:d.scaleFactor, physical:{w,h}}));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    console.log('sources', sources.map(s => ({ id: s.id, name: s.name, size: s.thumbnail.getSize() })));
    const out = path.join(process.cwd(), '.cache', 'desktop-capturer.png');
    fs.writeFileSync(out, sources[0].thumbnail.toPNG());
    console.log('saved', out);
    app.quit();
  } catch (e) {
    console.error('capture failed', e);
    app.exit(1);
  }
});
