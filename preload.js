const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('truveil', {
  getDemoConfig: () => ipcRenderer.invoke('demo:config'),
  pairBrowser: () => ipcRenderer.invoke('browser:pair'),
  stopBrowserSharing: () => ipcRenderer.invoke('browser:stop'),
  copyBrowserPairing: () => ipcRenderer.invoke('browser:copy-pairing'),
  openBrowserExtension: () => ipcRenderer.invoke('browser:open-extension'),
  onBrowserState: (cb) => ipcRenderer.on('browser:state', (_, data) => cb(data)),
  onDemoInvite: (cb) => ipcRenderer.on('demo:invite', (_, data) => cb(data)),
  startSession: (data) => ipcRenderer.invoke('session:start', data),
  sendTranscript: (data) => ipcRenderer.invoke('session:transcript', data),
  uploadAudioChunk: (data) => ipcRenderer.invoke('audio:chunk', data),
  sendAudioLevel: (data) => ipcRenderer.invoke('audio:level', data),
  getTranscriptionToken: () => ipcRenderer.invoke('transcription:token'),
  endSession: () => ipcRenderer.invoke('session:end'),
  withdrawExternalReview: () => ipcRenderer.invoke('provider-review:withdraw'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onTranscriptCaption: (cb) => ipcRenderer.on('transcript-caption', (_, data) => cb(data)),

  onFocusLost: (cb) => ipcRenderer.on('focus-lost', cb),
  onFocusGained: (cb) => ipcRenderer.on('focus-gained', cb),
  onShortcutBlocked: (cb) => ipcRenderer.on('shortcut-blocked', cb),
  onRemoteSessionEnded: (cb) => ipcRenderer.on('remote-session-ended', cb),
  onSessionStarted: (cb) => ipcRenderer.on('session-started', cb),
  onSessionDisconnected: (cb) => ipcRenderer.on('session-disconnected', () => cb()),
  onInviteCode: (cb) => ipcRenderer.on('invite-code', (_, code) => cb(code)),
  onBlockingWarning: (cb) => ipcRenderer.on('blocking-warning', (_, data) => cb(data)),
  onSessionPolicyUpdated: (cb) => ipcRenderer.on('session-policy-updated', (_, data) => cb(data))
});
