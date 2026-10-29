'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (error) {
      console.error('[vellum wallpaper preload] listener failed:', error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('vellumWallpaper', {
  getState: () => ipcRenderer.invoke('vellum:get-state'),
  onState: (callback) => subscribe('vellum:state', callback),
  ready: () => ipcRenderer.send('vellum:wallpaper-ready'),
  report: (patch) => {
    if (patch && typeof patch === 'object') ipcRenderer.send('vellum:wallpaper-report', patch);
  },
  log: (level, message) => {
    ipcRenderer.send('vellum:wallpaper-log', String(level || 'info'), String(message || ''));
  },
});
