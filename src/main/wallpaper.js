'use strict';

const { BrowserWindow, screen } = require('electron');
const win32 = require('./native/win32');

/**
 * Owns the wallpaper BrowserWindow and keeps it parented to the Explorer
 * wallpaper surface (WorkerW). The window is a real Chromium surface, so video,
 * transparency, and GPU decoding work normally; it is simply re-parented so it
 * lives behind the desktop icons instead of above every window.
 */
const QUALITY_ORDER = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

/**
 * The YouTube embed runs in a cross-origin iframe, so the renderer cannot reach
 * the inner player. Chromium's own quality hints (setPlaybackQuality /
 * playerVars.vq) are suggestions that the adaptive bitrate logic overrides:
 * a live stream keeps sitting at 480p even when 1080p is available. Pinning the
 * range with setPlaybackQualityRange() on the inner player is the only thing
 * that actually holds, and Electron lets the main process evaluate JS inside the
 * iframe regardless of origin.
 */
function createWallpaperController(options) {
  let win = null;
  let hwnd = null;
  let attached = false;
  let watchdogTimer = null;
  let attachTimer = null;
  let stopped = false;
  let wantedQuality = 'auto';
  let qualityTimer = null;
  let qualityLog = '';

  function displayInfo() {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    return {
      dip: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.size.width,
        height: display.size.height,
      },
      physical: {
        width: Math.max(1, Math.round(display.size.width * scale)),
        height: Math.max(1, Math.round(display.size.height * scale)),
      },
    };
  }

  function reportAttached(ok, detail) {
    if (attached === ok) return;
    attached = ok;
    options.onAttached(ok, detail);
  }

  function attach() {
    if (stopped || !win || win.isDestroyed()) return false;
    const info = displayInfo();
    if (!hwnd || !win32.isWindow(hwnd)) {
      try {
        hwnd = win.getNativeWindowHandle();
      } catch (_) {
        hwnd = null;
      }
    }
    if (!hwnd) return false;

    let result;
    try {
      result = win32.attachWindow(hwnd, info.physical.width, info.physical.height);
    } catch (error) {
      result = { ok: false, error: error.message, host: null };
    }
    if (result.ok) {
      try {
        win.setIgnoreMouseEvents(true);
        if (!win.isVisible()) win.showInactive();
      } catch (_) {
        /* window is being torn down */
      }
    }
    reportAttached(!!result.ok, result);
    if (!result.ok) options.onLog('warn', 'WorkerW attach failed: ' + (result.error || 'unknown'));
    return !!result.ok;
  }

  function destroyWindow() {
    if (!win || win.isDestroyed()) return;
    try {
      if (hwnd && win32.isWindow(hwnd)) win32.detachWindow(hwnd);
    } catch (_) {
      /* ignore */
    }
    try {
      win.destroy();
    } catch (_) {
      /* ignore */
    }
    win = null;
    hwnd = null;
    reportAttached(false, null);
  }

  function findYouTubeFrame() {
    if (!win || win.isDestroyed()) return null;
    const queue = [win.webContents.mainFrame];
    while (queue.length) {
      const frame = queue.shift();
      try {
        if (/^https:\/\/www\.youtube\.com\/(embed|watch)/.test(frame.url || '')) return frame;
        for (const child of frame.frames) queue.push(child);
      } catch (_) {
        /* frame already detached */
      }
    }
    return null;
  }

  function qualityScript(quality) {
    return (
      '(function () {\n' +
      '  try {\n' +
      "    var mp = document.getElementById('movie_player');\n" +
      "    if (!mp || typeof mp.setPlaybackQualityRange !== 'function') return 'no-player';\n" +
      "    var levels = (typeof mp.getAvailableQualityLevels === 'function' && mp.getAvailableQualityLevels()) || [];\n" +
      '    var wanted = ' + JSON.stringify(quality) + ';\n' +
      '    var order = ' + JSON.stringify(QUALITY_ORDER) + ';\n' +
      '    var target = wanted;\n' +
      "    if (!wanted || wanted === 'auto') {\n" +
      "      target = 'auto';\n" +
      '      for (var i = 0; i < order.length; i += 1) {\n' +
      '        if (levels.indexOf(order[i]) !== -1) { target = order[i]; break; }\n' +
      '      }\n' +
      '    }\n' +
      "    if (target === 'auto') return 'auto';\n" +
      '    mp.setPlaybackQualityRange(target, target);\n' +
      "    if (typeof mp.setPlaybackQuality === 'function') mp.setPlaybackQuality(target);\n" +
      "    var current = (typeof mp.getPlaybackQuality === 'function' && mp.getPlaybackQuality()) || '?' ;\n" +
      "    return target + '/' + current;\n" +
      '  } catch (error) {\n' +
      "    return 'error:' + error.message;\n" +
      '  }\n' +
      '})()'
    );
  }

  async function applyQualityLock() {
    if (stopped) return false;
    const frame = findYouTubeFrame();
    if (!frame) return false;
    let result;
    try {
      result = await Promise.race([
        frame.executeJavaScript(qualityScript(wantedQuality), true),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
      ]);
    } catch (error) {
      result = 'error:' + error.message;
    }
    if (result !== qualityLog) {
      qualityLog = result;
      if (result === 'no-player' || result === 'timeout' || /^error:/.test(String(result))) {
        options.onLog('warn', 'quality lock: ' + result);
      } else {
        options.onLog('info', 'quality lock: ' + result);
      }
    }
    return !!result && !/^error:/.test(String(result)) && result !== 'no-player';
  }

  function scheduleQualityLock() {
    if (stopped) return;
    clearTimeout(qualityTimer);
    qualityTimer = setTimeout(() => {
      applyQualityLock().catch(() => {});
    }, 400);
  }

  function createWindow() {
    if (stopped) return;
    const info = displayInfo();
    win = new BrowserWindow({
      x: info.dip.x,
      y: info.dip.y,
      width: info.dip.width,
      height: info.dip.height,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      roundedCorners: false,
      backgroundColor: '#080706',
      title: 'Vellum Wallpaper',
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });

    win.setMenuBarVisibility(false);
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
      // The YouTube iframe finishing a load resets the adaptive range, so
      // re-apply the pinned quality whenever a frame (re)loads.
      if (!isMainFrame) setTimeout(scheduleQualityLock, 800);
    });
    win.webContents.on('did-finish-load', () => {
      options.onReady();
      scheduleQualityLock();
      // Show the window before re-parenting: Chromium creates its compositor
      // surface for a visible window. Reparenting while hidden leaves the
      // surface without a presented frame, which shows up as a black wallpaper.
      try {
        win.showInactive();
      } catch (_) {
        /* ignore */
      }
      clearTimeout(attachTimer);
      attachTimer = setTimeout(attach, 600);
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      options.onLog('error', 'wallpaper page failed to load (' + code + '): ' + description);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      options.onLog('error', 'wallpaper renderer gone: ' + details.reason);
      if (stopped) return;
      setTimeout(() => {
        if (stopped) return;
        destroyWindow();
        createWindow();
      }, 1200);
    });

    win.on('closed', () => {
      win = null;
      hwnd = null;
      reportAttached(false, null);
    });

    win.loadURL(options.origin + '/src/renderer/wallpaper/index.html').catch((error) => {
      options.onLog('error', 'could not load wallpaper page: ' + error.message);
    });
  }

  function recreate() {
    if (stopped) return;
    destroyWindow();
    createWindow();
  }

  function watchdog() {
    if (stopped) return;
    if (!win || win.isDestroyed()) {
      recreate();
      return;
    }
    if (!hwnd || !win32.isWindow(hwnd)) {
      recreate();
      return;
    }
    if (!attached) {
      attach();
      return;
    }
    if (!win32.isAttached(hwnd)) {
      attach();
    }
  }

  function resize() {
    if (stopped) return;
    const info = displayInfo();
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    try {
      win.setBounds({ x: info.dip.x, y: info.dip.y, width: info.dip.width, height: info.dip.height });
    } catch (_) {
      /* ignore */
    }
    attach();
  }

  function start() {
    stopped = false;
    createWindow();
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(watchdog, 4000);
    // Live streams re-negotiate their quality ladder over time (reconnects,
    // ad-free segment changes), and YouTube's ABR drifts back down; keep the
    // chosen level pinned.
    clearInterval(qualityTimer);
    qualityTimer = setInterval(() => {
      applyQualityLock().catch(() => {});
    }, 12000);
  }

  function stop() {
    stopped = true;
    clearInterval(watchdogTimer);
    clearInterval(qualityTimer);
    clearTimeout(attachTimer);
    clearTimeout(qualityTimer);
    destroyWindow();
  }

  function reload() {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.reloadIgnoringCache();
    } catch (_) {
      /* ignore */
    }
  }

  function setQuality(quality) {
    wantedQuality = quality || 'auto';
    qualityLog = '';
    scheduleQualityLock();
    setTimeout(scheduleQualityLock, 1500);
    setTimeout(scheduleQualityLock, 4000);
  }

  return {
    start,
    stop,
    reload,
    resize,
    attach,
    setQuality,
    reassertQuality: () => applyQualityLock().catch(() => {}),
    isAttached: () => attached,
    getWindow: () => win,
    send: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
    isReady: () => !!(win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()),
  };
}

module.exports = { createWallpaperController };
