const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('conchilla', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  onSettingsChanged: on('settings:changed'),

  captureSources: () => ipcRenderer.invoke('capture:sources'),
  selectCapture: (req) => ipcRenderer.invoke('capture:select', req),
  displays: () => ipcRenderer.invoke('displays'),

  // overlay control (main window side)
  showOverlay: () => ipcRenderer.send('overlay:show'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  toOverlay: (msg) => ipcRenderer.send('to-overlay', msg),
  onOverlayMessage: on('overlay:message'),
  openChat: () => ipcRenderer.send('chat:open'),
  overlayMoveMode: (on) => ipcRenderer.send('overlay:move-mode', on),

  // overlay window side
  overlayEvents: on('overlay:event'),
  onOverlayOpen: on('overlay:open'),
  onOverlayClose: on('overlay:close'),
  onOverlaySettings: on('overlay:settings'),
  onMoveMode: on('overlay:move-mode'),
  overlayClosed: () => ipcRenderer.send('overlay:closed'),
  fromOverlay: (msg) => ipcRenderer.send('from-overlay', msg),

  hotkeyStatus: () => ipcRenderer.invoke('hotkeys:status'),
  onHotkeyStatus: on('hotkeys:status'),
  pauseHotkeys: (paused) => ipcRenderer.send('hotkeys:pause', paused),

  platform: process.platform,
  appAudioStart: (req) => ipcRenderer.invoke('appaudio:start', req),
  appAudioStop: () => ipcRenderer.send('appaudio:stop'),
  onAppAudioPcm: on('appaudio:pcm'),

  runUpdate: () => ipcRenderer.invoke('update:run'),
  pendingUpdate: () => ipcRenderer.invoke('update:pending'),
  onUpdateProgress: on('update:progress'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  openUrl: (url) => ipcRenderer.send('open:url', url),
  fullscreen: (on) => ipcRenderer.send('window:fullscreen', on),
});
