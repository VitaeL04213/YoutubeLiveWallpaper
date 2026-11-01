'use strict';

const { Tray, Menu, nativeImage } = require('electron');

function qualityLabel(level) {
  if (!level) return 'Auto';
  if (level === 'auto') return 'Auto';
  if (level === 'highres') return '4K+';
  const map = {
    hd2880: '2880p',
    hd2160: '2160p',
    hd1440: '1440p',
    hd1080: '1080p',
    hd720: '720p',
    large: '480p',
    medium: '360p',
    small: '240p',
    tiny: '144p',
  };
  return map[level] || level;
}

function createTray(options) {
  let tray = null;

  function buildMenu(state) {
    const playing = state.status === 'playing';
    const paused = state.paused || state.status === 'paused';
    const statusCopy = {
      idle: 'Standby',
      resolving: 'Resolving stream',
      loading: 'Tuning in',
      playing: 'Playing live',
      paused: 'Paused',
      error: 'Stream error',
    }[state.status] || 'Standby';

    const qualities = ['auto', ...(state.availableQualities || [])].filter(
      (value, index, list) => list.indexOf(value) === index
    );

    return Menu.buildFromTemplate([
      { label: 'Vellum — ' + statusCopy, enabled: false },
      { type: 'separator' },
      {
        label: options.panelVisible() ? 'Hide controls' : 'Show controls',
        accelerator: 'CommandOrControl+Alt+V',
        click: () => options.togglePanel(),
      },
      {
        label: paused ? 'Resume wallpaper' : state.status === 'idle' || state.status === 'error' ? 'Start stream' : 'Pause wallpaper',
        accelerator: 'CommandOrControl+Alt+P',
        enabled: state.status !== 'idle' || !!state.url,
        click: () => options.setPaused(state.status === 'idle' || state.status === 'error' ? false : !paused),
      },
      { type: 'separator' },
      {
        label: 'Quality',
        submenu: qualities.map((level) => ({
          label: qualityLabel(level) + (level === 'auto' ? '' : '  ·  ' + level),
          type: 'radio',
          checked: state.quality === level,
          click: () => options.setQuality(level),
        })),
      },
      {
        label: state.muted ? 'Unmute' : 'Mute',
        click: () => options.setMuted(!state.muted),
      },
      { type: 'separator' },
      {
        label: 'Reconnect stream',
        enabled: !!state.videoId,
        click: () => options.reconnect(),
      },
      {
        label: 'Change stream…',
        click: () => options.showPanel(),
      },
      {
        label: 'Open in browser',
        click: () => options.openExternal(state.url),
      },
      { type: 'separator' },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: !!state.launchAtLogin,
        click: (item) => options.setSetting('launchAtLogin', item.checked),
      },
      {
        label: 'Play stream on launch',
        type: 'checkbox',
        checked: !!state.autoPlay,
        click: (item) => options.setSetting('autoPlay', item.checked),
      },
      { type: 'separator' },
      { label: 'Quit Vellum', click: () => options.quit() },
    ]);
  }

  function update(state) {
    if (!tray) return;
    tray.setToolTip('Vellum — ' + (state.status === 'error' ? 'stream error' : state.status));
    tray.setContextMenu(buildMenu(state));
  }

  function start(state, iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip('Vellum');
    tray.on('click', () => options.togglePanel());
    tray.on('double-click', () => options.showPanel());
    update(state);
    return tray;
  }

  function stop() {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  }

  return { start, update, stop };
}

module.exports = { createTray, qualityLabel };
