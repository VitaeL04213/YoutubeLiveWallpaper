'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen, shell, globalShortcut, dialog, powerMonitor } = require('electron');

const configStore = require('./config');
const server = require('./server');
const { resolveStream, isVideoId } = require('./stream');
const { createWallpaperController } = require('./wallpaper');
const { createPanelController } = require('./panel');
const { createTray } = require('./tray');

// ---------------------------------------------------------------------------
// Chromium flags. The wallpaper is a full-screen video with sound and no user
// gesture, and it must keep decoding while another app is in the foreground.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// Opt-in Chrome DevTools Protocol for local QA; never set in normal use.
if (process.env.VELLUM_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.VELLUM_DEBUG_PORT));
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

app.setAppUserModelId('com.vellum.wallpaper');

const APP_ROOT = path.join(__dirname, '..', '..');
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const PRELOAD_PANEL = path.join(__dirname, '..', 'preload', 'panel.js');
const PRELOAD_WALLPAPER = path.join(__dirname, '..', 'preload', 'wallpaper.js');

const QUALITY_LEVELS = configStore.QUALITY_LEVELS;
const STATUS_VALUES = ['idle', 'resolving', 'loading', 'playing', 'paused', 'error'];
const START_HIDDEN = process.argv.includes('--hidden') || process.argv.includes('--silent');

let configFile = '';
let config = { ...configStore.DEFAULT_CONFIG };
let serverInfo = null;
let panel = null;
let wallpaper = null;
let tray = null;
let quitting = false;
let saveTimer = null;
let loadToken = 0;

const state = {
  url: config.url,
  videoId: null,
  title: '',
  channel: '',
  status: 'idle',
  paused: false,
  quality: config.quality,
  availableQualities: [],
  activeQuality: null,
  volume: config.volume,
  muted: config.muted,
  veil: config.veil,
  launchAtLogin: config.launchAtLogin,
  autoPlay: config.autoPlay,
  attached: false,
  error: null,
  panelVisible: false,
  updatedAt: Date.now(),
};

function snapshot() {
  return {
    ...state,
    availableQualities: Array.isArray(state.availableQualities) ? state.availableQualities.slice() : [],
  };
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function broadcast() {
  const payload = snapshot();
  if (panel) panel.send('vellum:state', payload);
  if (wallpaper) wallpaper.send('vellum:state', payload);
  if (tray) tray.update(payload);
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    config = configStore.save(configFile, {
      url: state.url,
      quality: state.quality,
      volume: state.volume,
      muted: state.muted,
      veil: state.veil,
      launchAtLogin: state.launchAtLogin,
      autoPlay: state.autoPlay,
    });
  }, 250);
}

function patchState(patch, options = {}) {
  let changed = false;
  for (const key of Object.keys(patch)) {
    if (!valuesEqual(state[key], patch[key])) {
      state[key] = patch[key];
      changed = true;
    }
  }
  if (!changed) return;
  state.updatedAt = Date.now();
  broadcast();
  syncWallpaperSurface();
  if (wallpaper) {
    // The renderer's quality hints are advisory; the wallpaper controller pins
    // the actual level inside the cross-origin YouTube iframe.
    if (Object.prototype.hasOwnProperty.call(patch, 'quality')) wallpaper.setQuality(state.quality);
    if (patch.status === 'playing') wallpaper.reassertQuality();
  }
  if (options.persist !== false) schedulePersist();
}

// The desktop is only ours while a stream is actually on it. Idle (nothing
// loaded, e.g. autoplay off at login) and error states leave Explorer's own
// wallpaper untouched instead of covering it with a black window.
const WALLPAPER_STATUSES = ['resolving', 'loading', 'playing', 'paused'];

function wallpaperWanted() {
  return WALLPAPER_STATUSES.includes(state.status);
}

function syncWallpaperSurface() {
  if (!wallpaper) return;
  const wanted = wallpaperWanted();
  if (wanted !== wallpaper.isActive()) wallpaper.setActive(wanted);
}

function log(level, message) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[vellum]', message);
}

// ---------------------------------------------------------------------------
// Playback control
// ---------------------------------------------------------------------------

async function loadStream(input, options = {}) {
  const token = ++loadToken;
  input = String(input || '').trim();
  patchState({ url: input, status: 'resolving', error: null, paused: false }, { persist: false });
  const result = await resolveStream(input);
  if (token !== loadToken) return { ok: false, error: 'superseded' };
  if (!result.ok) {
    patchState({
      status: 'error',
      error: result.error,
      videoId: null,
      title: '',
      channel: '',
      availableQualities: [],
      activeQuality: null,
    });
    return { ok: false, error: result.error };
  }
  patchState(
    {
      // Keep what the user asked for: a /live channel URL keeps following the
      // current broadcast across restarts instead of freezing a stale video id.
      url: /^https?:\/\//i.test(input) ? input : result.url,
      videoId: result.videoId,
      title: result.title || state.title,
      channel: result.channel || state.channel,
      status: 'loading',
      error: null,
      paused: false,
      availableQualities: [],
      activeQuality: null,
    },
    { persist: options.persist !== false }
  );
  return { ok: true };
}

async function reconnect() {
  if (!state.videoId) return loadStream(state.url);
  patchState({
    status: 'loading',
    error: null,
    paused: false,
    availableQualities: [],
    activeQuality: null,
  });
  if (wallpaper) wallpaper.reload();
  const fresh = await resolveStream(state.url);
  if (fresh.ok) {
    patchState({
      videoId: fresh.videoId,
      url: fresh.url,
      title: fresh.title || state.title,
      channel: fresh.channel || state.channel,
    });
  }
  return { ok: true };
}

function setPaused(paused) {
  const next = !!paused;
  if (!next && (state.status === 'error' || state.status === 'idle')) {
    // The panel's play button doubles as "start the configured stream" while
    // nothing is running (autoplay off, or after an error).
    if (state.url) reconnect();
    return;
  }
  if (next && !state.videoId) return;
  patchState({
    paused: next,
    status: next ? 'paused' : state.videoId ? 'playing' : 'idle',
    error: next ? state.error : null,
  });
}

function setQuality(quality) {
  if (!QUALITY_LEVELS.includes(quality)) return;
  patchState({ quality });
}

function setVolume(volume) {
  let number = Number(volume);
  if (!Number.isFinite(number)) return;
  number = Math.min(100, Math.max(0, Math.round(number)));
  const patch = { volume: number };
  if (number > 0 && state.muted) patch.muted = false;
  patchState(patch);
}

function setMuted(muted) {
  patchState({ muted: !!muted });
}

function setSetting(key, value) {
  if (key === 'veil') {
    patchState({ veil: !!value });
    return { ok: true };
  }
  if (key === 'launchAtLogin') {
    patchState({ launchAtLogin: !!value });
    applyLaunchAtLogin(!!value);
    return { ok: true };
  }
  if (key === 'autoPlay') {
    patchState({ autoPlay: !!value });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown setting' };
}

function applyLaunchAtLogin(enabled) {
  try {
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args,
    });
  } catch (error) {
    log('warn', 'could not update login item: ' + error.message);
  }
}

// ---------------------------------------------------------------------------
// Windows / visibility
// ---------------------------------------------------------------------------

function showPanel() {
  if (!panel) return;
  panel.show();
}

function hidePanel() {
  if (panel) panel.hide();
}

function togglePanel() {
  if (!panel) return;
  if (panel.isVisible()) hidePanel();
  else showPanel();
}

function appInfo() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isKnownSender(event) {
  const id = event.sender.id;
  for (const candidate of [panel && panel.getWindow(), wallpaper && wallpaper.getWindow()]) {
    if (candidate && !candidate.isDestroyed() && candidate.webContents.id === id) return true;
  }
  return false;
}

function installIpc() {
  ipcMain.handle('vellum:get-state', (event) => {
    if (!isKnownSender(event)) return null;
    return snapshot();
  });

  ipcMain.handle('vellum:get-app-info', (event) => {
    if (!isKnownSender(event)) return null;
    return appInfo();
  });

  ipcMain.handle('vellum:set-paused', (event, paused) => {
    if (!isKnownSender(event)) return;
    setPaused(!!paused);
  });

  ipcMain.handle('vellum:set-quality', (event, quality) => {
    if (!isKnownSender(event)) return;
    setQuality(String(quality || 'auto'));
  });

  ipcMain.handle('vellum:set-volume', (event, volume) => {
    if (!isKnownSender(event)) return;
    setVolume(volume);
  });

  ipcMain.handle('vellum:set-muted', (event, muted) => {
    if (!isKnownSender(event)) return;
    setMuted(!!muted);
  });

  ipcMain.handle('vellum:load-stream', async (event, url) => {
    if (!isKnownSender(event)) return { ok: false, error: 'Not allowed' };
    return loadStream(String(url || ''));
  });

  ipcMain.handle('vellum:reconnect', async (event) => {
    if (!isKnownSender(event)) return { ok: false, error: 'Not allowed' };
    return reconnect();
  });

  ipcMain.handle('vellum:set-setting', (event, key, value) => {
    if (!isKnownSender(event)) return { ok: false, error: 'Not allowed' };
    return setSetting(String(key), value);
  });

  ipcMain.on('vellum:hide-panel', (event) => {
    if (!isKnownSender(event)) return;
    hidePanel();
  });

  ipcMain.on('vellum:wallpaper-ready', (event) => {
    if (!isKnownSender(event)) return;
    if (wallpaper) wallpaper.send('vellum:state', snapshot());
  });

  ipcMain.on('vellum:wallpaper-report', (event, patch) => {
    if (!isKnownSender(event)) return;
    if (!patch || typeof patch !== 'object') return;
    const next = {};
    if (STATUS_VALUES.includes(patch.status)) {
      // A 'playing' report that races a just-requested pause must not flip the
      // panel back to playing; the renderer will confirm 'paused' right after.
      if (!(patch.status === 'playing' && state.paused)) next.status = patch.status;
    }
    if (typeof patch.error === 'string' || patch.error === null) next.error = patch.error;
    if (typeof patch.title === 'string' && patch.title) next.title = patch.title;
    if (typeof patch.channel === 'string' && patch.channel) next.channel = patch.channel;
    if (Array.isArray(patch.availableQualities)) {
      next.availableQualities = patch.availableQualities
        .filter((value) => typeof value === 'string')
        .slice(0, 24);
    }
    if (typeof patch.activeQuality === 'string' || patch.activeQuality === null) {
      next.activeQuality = patch.activeQuality;
    }
    if (patch.status === 'error' && typeof patch.error !== 'string') {
      next.error = state.error || 'The stream stopped. Try reconnecting.';
    }
    if (patch.status === 'playing') next.error = null;
    // 'paused' can mean a transient YouTube stall or autoplay hiccup; only the
    // user (or the controller) may actually change the paused flag. The
    // renderer retries playback on its own when the desired state is playing.
    if (patch.status === 'paused' && !state.paused) delete next.status;
    if (patch.status === 'playing' && state.paused) delete next.status;
    patchState(next);
  });

  ipcMain.on('vellum:wallpaper-log', (event, level, message) => {
    if (!isKnownSender(event)) return;
    log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', 'renderer: ' + message);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  configFile = path.join(app.getPath('userData'), 'config.json');
  config = configStore.load(configFile);
  Object.assign(state, {
    url: config.url,
    quality: config.quality,
    volume: config.volume,
    muted: config.muted,
    veil: config.veil,
    launchAtLogin: config.launchAtLogin,
    autoPlay: config.autoPlay,
  });

  try {
    serverInfo = await server.start(APP_ROOT);
    log('info', 'renderer origin ' + serverInfo.origin);
  } catch (error) {
    dialog.showErrorBox('Vellum could not start', 'The local renderer server failed: ' + error.message);
    app.quit();
    return;
  }

  installIpc();

  panel = createPanelController({
    origin: serverInfo.origin,
    preloadPath: PRELOAD_PANEL,
    iconPath: ICON_PATH,
    openExternal: (url) => shell.openExternal(url),
    onLog: log,
    onReady: () => {
      if (panel) panel.send('vellum:state', snapshot());
    },
    onShown: () => {
      patchState({ panelVisible: true }, { persist: false });
      if (panel) panel.send('vellum:panel-shown');
    },
    onHidden: () => patchState({ panelVisible: false }, { persist: false }),
  });
  panel.start();

  wallpaper = createWallpaperController({
    origin: serverInfo.origin,
    preloadPath: PRELOAD_WALLPAPER,
    onAttached: (attached, detail) => {
      patchState({ attached }, { persist: false });
      if (!attached && detail && detail.error) log('warn', detail.error);
    },
    onReady: () => {
      if (wallpaper) wallpaper.send('vellum:state', snapshot());
    },
    onLog: log,
  });
  // Starts with no desktop window at all; it is created the moment a stream
  // begins loading (see syncWallpaperSurface).
  wallpaper.start({ active: false });
  wallpaper.setQuality(state.quality);

  tray = createTray({
    panelVisible: () => !!(panel && panel.isVisible()),
    togglePanel,
    showPanel,
    setPaused,
    setQuality,
    setMuted,
    reconnect,
    setSetting,
    openExternal: (url) => shell.openExternal(url),
    quit: () => app.quit(),
  });
  tray.start(snapshot(), ICON_PATH);

  applyLaunchAtLogin(state.launchAtLogin);

  try {
    globalShortcut.register('CommandOrControl+Alt+V', togglePanel);
    globalShortcut.register('CommandOrControl+Alt+P', () => setPaused(!state.paused));
    globalShortcut.register('CommandOrControl+Alt+Shift+V', () => {
      if (wallpaper) wallpaper.reload();
    });
  } catch (error) {
    log('warn', 'global shortcuts unavailable: ' + error.message);
  }

  screen.on('display-metrics-changed', () => wallpaper && wallpaper.resize());
  screen.on('display-added', () => wallpaper && wallpaper.resize());
  screen.on('display-removed', () => wallpaper && wallpaper.resize());
  powerMonitor.on('resume', () => {
    setTimeout(() => wallpaper && wallpaper.resize(), 1200);
  });

  if (!START_HIDDEN) {
    setTimeout(() => showPanel(), 650);
  }

  if (state.autoPlay) {
    await loadStream(config.url);
  } else {
    log('info', 'autoplay is off; waiting for play');
  }
  broadcast();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPanel();
  });

  app.whenReady().then(boot).catch((error) => {
    log('error', 'boot failed: ' + (error.stack || error.message));
    dialog.showErrorBox('Vellum failed to start', String(error.stack || error.message));
    app.quit();
  });

  app.on('activate', () => {
    showPanel();
  });

  app.on('window-all-closed', () => {
    // Vellum lives in the tray; the wallpaper window is intentionally never
    // counted as an app window the user closes.
  });

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    clearTimeout(saveTimer);
    try {
      configStore.save(configFile, {
        url: state.url,
        quality: state.quality,
        volume: state.volume,
        muted: state.muted,
        veil: state.veil,
        launchAtLogin: state.launchAtLogin,
        autoPlay: state.autoPlay,
      });
    } catch (_) {
      /* ignore */
    }
    try {
      globalShortcut.unregisterAll();
    } catch (_) {
      /* ignore */
    }
    if (wallpaper) wallpaper.stop();
    if (panel) panel.stop();
    if (tray) tray.stop();
    if (serverInfo && serverInfo.server) {
      try {
        serverInfo.server.close();
      } catch (_) {
        /* ignore */
      }
    }
  });
}
