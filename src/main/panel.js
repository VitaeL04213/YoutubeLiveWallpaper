'use strict';

const { BrowserWindow, screen } = require('electron');

const PANEL_WIDTH = 392;
const PANEL_HEIGHT = 640;
const MARGIN = 24;

function createPanelController(options) {
  let win = null;
  let ready = false;
  let wantsVisible = false;
  let quitting = false;

  function position() {
    const display = screen.getPrimaryDisplay();
    const area = display.workArea;
    const x = Math.round(area.x + area.width - PANEL_WIDTH - MARGIN);
    const y = Math.round(area.y + area.height - PANEL_HEIGHT - MARGIN);
    if (win && !win.isDestroyed()) win.setPosition(x, y);
    return { x, y };
  }

  function create() {
    const initial = screen.getPrimaryDisplay().workArea;
    const x = Math.round(initial.x + initial.width - PANEL_WIDTH - MARGIN);
    const y = Math.round(initial.y + initial.height - PANEL_HEIGHT - MARGIN);
    win = new BrowserWindow({
      x,
      y,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Vellum',
      icon: options.iconPath,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    win.setAlwaysOnTop(true, 'floating');
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && options.openExternal) options.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== options.origin + '/src/renderer/panel/index.html') event.preventDefault();
    });
    win.webContents.on('did-finish-load', () => {
      ready = true;
      options.onReady();
      if (wantsVisible) show();
    });
    win.webContents.on('render-process-gone', () => {
      ready = false;
      setTimeout(() => {
        if (quitting) return;
        try {
          win.reload();
        } catch (_) {
          /* ignore */
        }
      }, 1000);
    });
    win.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        hide();
      }
    });
    win.on('closed', () => {
      win = null;
      ready = false;
    });

    win.loadURL(options.origin + '/src/renderer/panel/index.html').catch((error) => {
      options.onLog('error', 'could not load panel page: ' + error.message);
    });
  }

  function show() {
    wantsVisible = true;
    if (!win || win.isDestroyed()) {
      create();
      return;
    }
    position();
    if (!ready) return;
    win.show();
    win.focus();
    try {
      win.moveTop();
    } catch (_) {
      /* ignore */
    }
    options.onShown();
  }

  function hide() {
    wantsVisible = false;
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    options.onHidden();
  }

  function toggle() {
    if (win && !win.isDestroyed() && win.isVisible()) hide();
    else show();
  }

  function start() {
    create();
  }

  function stop() {
    quitting = true;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    win = null;
  }

  return {
    start,
    stop,
    show,
    hide,
    toggle,
    position,
    isVisible: () => !!(win && !win.isDestroyed() && win.isVisible()),
    isReady: () => ready,
    getWindow: () => win,
    send: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  };
}

module.exports = { createPanelController, PANEL_WIDTH, PANEL_HEIGHT };
