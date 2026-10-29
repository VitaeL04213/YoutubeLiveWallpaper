'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (error) {
      console.error('[vellum preload] listener failed:', error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('vellum', {
  getState: () => ipcRenderer.invoke('vellum:get-state'),
  onState: (callback) => subscribe('vellum:state', callback),
  setPaused: (paused) => ipcRenderer.invoke('vellum:set-paused', !!paused),
  setQuality: (quality) => ipcRenderer.invoke('vellum:set-quality', String(quality || 'auto')),
  setVolume: (volume) => ipcRenderer.invoke('vellum:set-volume', Number(volume)),
  setMuted: (muted) => ipcRenderer.invoke('vellum:set-muted', !!muted),
  loadStream: (url) => ipcRenderer.invoke('vellum:load-stream', String(url || '')),
  reconnect: () => ipcRenderer.invoke('vellum:reconnect'),
  setSetting: (key, value) => ipcRenderer.invoke('vellum:set-setting', String(key), value),
  hidePanel: () => ipcRenderer.send('vellum:hide-panel'),
  getAppInfo: () => ipcRenderer.invoke('vellum:get-app-info'),
  onPanelShown: (callback) => subscribe('vellum:panel-shown', callback),
});
