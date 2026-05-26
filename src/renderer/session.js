// Truveil Secure - Candidate Renderer
const $ = id => document.getElementById(id);

const screens = {
  setup: $('setup-screen'),
  active: $('active-screen'),
  ended: $('ended-screen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

let sessionStart = null;
let timerInterval = null;
let integrity = 100;
let audioStream = null;
let sessionEnding = false;
let recognition = null;
let recognitionShouldRun = false;

const statusPill = $('statusPill');
const statusText = $('statusText');
const toastEl = $('toast');
const startBtn = $('startBtn');
const sessionCodeInput = $('sessionCodeInput');
const sessionConsentInput = $('sessionConsentInput');

function setStatus(kind, text) {
  statusPill.classList.remove('active', 'warn');
  if (kind) statusPill.classList.add(kind);
  statusText.textContent = text;
}

function toast(msg, kind = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast visible ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('visible'), 3200);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

sessionCodeInput.addEventListener('input', (e) => {
  let v = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (v.length > 3 && v.startsWith('TRV') && v[3] !== '-') v = 'TRV-' + v.slice(3);
  e.target.value = v;
});

sessionCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startBtn.click();
});

startBtn.addEventListener('click', startSession);

async function startSession() {
  const code = sessionCodeInput.value.trim();
  const name = $('candidateNameInput').value.trim();

  if (!code) {
    toast('Enter your session code (TRV-XXXXXX)', 'error');
    sessionCodeInput.focus();
    return;
  }

  if (!/^TRV-[A-Z0-9]{6}$/.test(code)) {
    toast('Session code should look like TRV-8FR2XP (10 characters)', 'error');
    sessionCodeInput.focus();
    return;
  }

  if (!name) {
    toast('Please enter your name', 'error');
    $('candidateNameInput').focus();
    return;
  }

  if (!sessionConsentInput.checked) {
    toast('Please consent to monitoring and warning/refocus blocking to start.', 'error');
    sessionConsentInput.focus();
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = 'Checking session...';
  setStatus(null, 'Checking session');

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone permission is required for a verified session.', 'error');
    resetStartButton();
    setStatus(null, 'Not started');
    return;
  }

  const result = await window.truveil.startSession({ sessionCode: code, candidateName: name });
  if (!result.ok) {
    toast(result.error || 'Could not start session', 'error');
    stopAudio();
    resetStartButton();
    setStatus(null, 'Not started');
    return;
  }

  $('displayName').textContent = name;
  $('displayCode').textContent = code;
  setStatus('active', 'Monitoring');

  sessionStart = Date.now();
  sessionEnding = false;
  startTimer();
  startSpeechRecognition();
  showScreen('active');
  resetStartButton();
}

function resetStartButton() {
  startBtn.disabled = false;
  startBtn.textContent = 'Start Secure Session';
}

function stopAudio() {
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
}

function startSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    logEvent('Speech recognition is not available in this runtime', 'warn');
    toast('Speech recognition is unavailable, but focus monitoring is active.', 'warn');
    return;
  }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
  recognitionShouldRun = true;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const text = result[0]?.transcript?.trim();
      if (text) {
        window.truveil.sendTranscript({ text, timestamp: Date.now() });
      }
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      recognitionShouldRun = false;
      logEvent('Speech transcription permission was blocked', 'warn');
    }
  };

  recognition.onend = () => {
    if (!recognitionShouldRun || sessionEnding) return;
    setTimeout(() => {
      try { recognition.start(); } catch {}
    }, 250);
  };

  try {
    recognition.start();
  } catch {
    logEvent('Speech transcription could not start', 'warn');
  }
}

function stopSpeechRecognition() {
  recognitionShouldRun = false;
  try { recognition?.stop(); } catch {}
  recognition = null;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    $('elapsed').textContent = fmtElapsed(Date.now() - sessionStart);
  }, 1000);
}

function logEvent(text, kind = 'warn') {
  const feed = $('flagFeed');
  if (feed.querySelector('.ff-empty')) feed.innerHTML = '';

  if (kind === 'warn') integrity = Math.max(0, integrity - 5);
  $('integrity').textContent = integrity + '%';

  const el = document.createElement('div');
  el.className = 'ff-item';
  el.innerHTML = `<span>${text}</span><span class="ff-time">${fmtTime(Date.now())}</span>`;
  feed.prepend(el);
}

async function finishSession(message) {
  if (sessionEnding) return;
  sessionEnding = true;
  clearInterval(timerInterval);
  stopSpeechRecognition();
  stopAudio();
  sessionStart = null;
  setStatus(null, 'Complete');
  if (message) toast(message, 'info');
  showScreen('ended');
}

window.truveil.onFocusLost(() => {
  if (!sessionStart) return;
  logEvent('You switched away from Truveil Secure');
  setStatus('warn', 'Focus lost');
});

window.truveil.onFocusGained(() => {
  if (!sessionStart) return;
  setStatus('active', 'Monitoring');
});

window.truveil.onShortcutBlocked(() => {
  if (!sessionStart) return;
  logEvent('Blocked a close/minimize shortcut');
});

window.truveil.onBlockingWarning((warning = {}) => {
  if (!sessionStart) return;
  const processName = warning.processName || 'Unknown app';
  const title = warning.windowTitle || 'Unknown window';
  const banner = $('blockingBanner');
  $('blockingDetail').textContent = `${processName}: ${title}`;
  banner.hidden = false;
  setTimeout(() => { banner.hidden = true; }, 6000);
  logEvent(`Disallowed app or tab detected: ${processName}`, 'warn');
  setStatus('warn', 'Action required');
});

window.truveil.onRemoteSessionEnded(() => {
  finishSession('Your recruiter ended the session.');
});

window.truveil.onInviteCode((code) => {
  if (!code || sessionStart) return;
  sessionCodeInput.value = code;
  sessionCodeInput.dispatchEvent(new Event('input'));
  sessionCodeInput.focus();
  toast(`Session code ${code} loaded from your invite.`, 'info');
});

$('endBtn').addEventListener('click', async () => {
  if (!confirm('End your secure session now? This will tell your recruiter the interview is finished.')) return;
  await window.truveil.endSession();
  finishSession();
});

$('quitBtn').addEventListener('click', () => {
  window.truveil.quit();
});

setStatus(null, 'Not started');
setTimeout(() => sessionCodeInput.focus(), 400);
