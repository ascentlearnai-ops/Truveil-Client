const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('truveil', {
  onEscapeAttempt: (cb) => ipcRenderer.on('escape-attempt', cb),
  onSecurityFlag: (cb) => ipcRenderer.on('security-flag', (e, data) => cb(data)),
  onSessionId: (cb) => ipcRenderer.on('session-id', (e, data) => cb(data)),
  onCloseAttempted: (cb) => ipcRenderer.on('close-attempted', cb),
  endSession: () => ipcRenderer.send('session-ended')
});
