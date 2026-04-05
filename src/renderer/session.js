let wsClient;
let micRecorder;
let currentSessionId = '';
let elapsedInterval;
let sessionStartTime;

// ——— Screen Management ————————————————————————————————————————
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(name + '-screen').classList.add('active');
}

// ——— Consent Flow —————————————————————————————————————————————
document.getElementById('acceptBtn').addEventListener('click', () => {
  showScreen('session');
  startSession();
});

function startSession() {
  sessionStartTime = Date.now();
  elapsedInterval = setInterval(updateClock, 1000);
}

function updateClock() {
  const elapsed = Date.now() - sessionStartTime;
  const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
  document.getElementById('elapsed-time').textContent = `${h}:${m}:${s}`;
}

// ——— Connection Status ————————————————————————————————————————
function setConnectionStatus(status) {
  const dot = document.getElementById('connectionDot');
  const text = document.getElementById('connectionText');
  dot.className = 'connection-dot ' + status;
  if (status === 'connected') text.textContent = 'Connected';
  else if (status === 'disconnected') text.textContent = 'Reconnecting...';
  else text.textContent = 'Connecting...';
}

// ——— Session ID from main process —————————————————————————————
window.truveil?.onSessionId((id) => {
  currentSessionId = id;
  document.getElementById('session-display').textContent = id || '—';

  wsClient = new window.WSClient(id);

  // Monitor WSClient connection state
  const origConnect = wsClient.connect.bind(wsClient);
  const origWs = wsClient.ws;

  // Patch to track connection status
  const checkConnection = setInterval(() => {
    if (wsClient.ws) {
      if (wsClient.ws.readyState === WebSocket.OPEN) setConnectionStatus('connected');
      else if (wsClient.ws.readyState === WebSocket.CONNECTING) setConnectionStatus('');
      else setConnectionStatus('disconnected');
    }
  }, 1000);

  window.setupEventMonitors((flag) => {
    wsClient.sendFlag(flag);
    showAlert(flag.detail || 'Security event logged');
  });

  micRecorder = new window.MicRecorder(wsClient);
  micRecorder.start().catch(err => console.error('Mic error:', err));
});

// ——— Security Flags from Main Process —————————————————————————
window.truveil?.onSecurityFlag((flag) => {
  if (wsClient) {
    wsClient.sendFlag(flag);
    showAlert(flag.detail || 'Security condition detected');
  }
});

window.truveil?.onEscapeAttempt(() => {
  if (wsClient) {
    wsClient.sendFlag({
      type: 'KEYBOARD_ESCAPE',
      detail: 'Blocked keyboard shortcut attempt',
      severity: 'LOW',
      timestamp: Date.now()
    });
    showAlert('Keyboard shortcut blocked');
  }
});

window.truveil?.onCloseAttempted(() => {
  if (wsClient) {
    wsClient.sendFlag({
      type: 'CLOSE_ATTEMPT',
      detail: 'Window close attempt blocked',
      severity: 'HIGH',
      timestamp: Date.now()
    });
    showAlert('Cannot close during active session');
  }
});

// ——— Alert Toasts —————————————————————————————————————————————
function showAlert(msg) {
  const area = document.getElementById('alerts');
  area.innerHTML = '';
  const toast = document.createElement('div');
  toast.className = 'alert-toast';
  toast.textContent = msg;
  area.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 3000);
}
