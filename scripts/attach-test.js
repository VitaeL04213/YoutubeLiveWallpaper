'use strict';
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logFile = path.join(__dirname, '..', '.cache', 'attach.log');
fs.writeFileSync(logFile, 'start ' + new Date().toISOString() + '\n');
const L = (...a) => { fs.appendFileSync(logFile, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); };
process.on('uncaughtException', e => { L('UNCAUGHT', e.stack || String(e)); });
const win32 = require(path.join(__dirname, '..', 'src', 'main', 'native', 'win32'));
L('electron', process.versions.electron, 'os', os.version());
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.whenReady().then(async () => {
  try {
    L('ready');
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const width = Math.round(display.size.width * scale);
    const height = Math.round(display.size.height * scale);
    L('display', display.size, 'scale', scale, 'physical', width, height);
    const win = new BrowserWindow({
      show: false, frame: false, transparent: false, backgroundColor: '#7a2f1f',
      width: display.bounds.width, height: display.bounds.height,
      x: display.bounds.x, y: display.bounds.y,
      focusable: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      hasShadow: false, roundedCorners: false, title: 'Vellum Attach Test',
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    });
    win.setIgnoreMouseEvents(true);
    await win.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 40% 30%,#d97757,#3a1710);color:#f7f4ed;font-family:Georgia,serif;font-size:80px">VELLUM ATTACH TEST</body>'
    ));
    L('loaded');
    await new Promise(r => setTimeout(r, 500));
    const hwnd = win.getNativeWindowHandle();
    L('hwnd', hwnd.toString('hex'), 'host before', win32.hostInfo());
    const res = win32.attachWindow(hwnd, width, height);
    L('ATTACH', res);
    L('parent', win32.parentOf(hwnd), 'attached', win32.isAttached(hwnd));
    win.showInactive();
    L('showInactive called, visible', win.isVisible());
    setTimeout(() => L('still attached', win32.isAttached(hwnd)), 3000);
    setTimeout(() => { L('quit'); app.quit(); }, 30000);
  } catch (e) { L('ERR', e.stack || String(e)); app.quit(); }
});
