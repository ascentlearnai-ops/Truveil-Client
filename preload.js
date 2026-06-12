const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('truveil', {
  startSession: (data) => ipcRenderer.invoke('session:start', data),
  sendTranscript: (data) => ipcRenderer.invoke('session:transcript', data),
  uploadAudioChunk: (data) => ipcRenderer.invoke('audio:chunk', data),
  sendAudioLevel: (data) => ipcRenderer.invoke('audio:level', data),
  getTranscriptionToken: () => ipcRenderer.invoke('transcription:token'),
  endSession: () => ipcRenderer.invoke('session:end'),
  quit: () => ipcRenderer.invoke('app:quit'),

  onFocusLost: (cb) => ipcRenderer.on('focus-lost', cb),
  onFocusGained: (cb) => ipcRenderer.on('focus-gained', cb),
  onShortcutBlocked: (cb) => ipcRenderer.on('shortcut-blocked', cb),
  onRemoteSessionEnded: (cb) => ipcRenderer.on('remote-session-ended', cb),
  onSessionStarted: (cb) => ipcRenderer.on('session-started', cb),
  onInviteCode: (cb) => ipcRenderer.on('invite-code', (_, code) => cb(code)),
  onBlockingWarning: (cb) => ipcRenderer.on('blocking-warning', (_, data) => cb(data)),
  onSessionPolicyUpdated: (cb) => ipcRenderer.on('session-policy-updated', (_, data) => cb(data))
});
