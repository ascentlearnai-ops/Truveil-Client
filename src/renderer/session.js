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
let mediaRecorder = null;
let audioContext = null;
let analyser = null;
let audioLevelTimer = null;
let chunkSequence = 0;
let uploadedChunks = 0;
let failedChunks = 0;
let pendingUploads = 0;
let lastChunkAt = 0;
let lastRms = 0;
let lastPeak = 0;
let audioRetryTimer = null;
let audioRetryQueue = [];

const MAX_AUDIO_RETRY_ITEMS = 12;
const MAX_AUDIO_RETRY_ATTEMPTS = 4;

const statusPill = $('statusPill');
const statusText = $('statusText');
const toastEl = $('toast');
const startBtn = $('startBtn');
const sessionCodeInput = $('sessionCodeInput');
const sessionConsentInput = $('sessionConsentInput');
const micLevelFill = $('micLevelFill');
const micLevelLabel = $('micLevelLabel');
const uploadStatusEl = $('uploadStatus');
const audioStateEl = $('audioState');
const audioChunkCountEl = $('audioChunkCount');
const waveformEl = $('micWaveform');

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
  renderPolicy(result.policy || {});
  setStatus('active', 'Monitoring');

  sessionStart = Date.now();
  sessionEnding = false;
  startTimer();
  startAudioStreaming();
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

function getSupportedMimeType() {
  const options = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  return options.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function ensureWaveformBars() {
  if (!waveformEl || waveformEl.children.length) return;
  for (let i = 0; i < 32; i++) {
    const bar = document.createElement('span');
    bar.style.setProperty('--h', `${18 + (i % 6) * 7}%`);
    waveformEl.appendChild(bar);
  }
}

function updateAudioUi({ rms = lastRms, peak = lastPeak, status } = {}) {
  const level = Math.max(0, Math.min(1, rms * 4));
  if (micLevelFill) micLevelFill.style.width = `${Math.round(level * 100)}%`;
  if (micLevelLabel) micLevelLabel.textContent = `${Math.round(level * 100)}%`;
  if (audioStateEl) audioStateEl.textContent = status || (pendingUploads ? 'Uploading' : 'Streaming');
  if (audioChunkCountEl) audioChunkCountEl.textContent = String(uploadedChunks);
  if (uploadStatusEl) {
    uploadStatusEl.textContent = failedChunks
      ? `${failedChunks} upload retry${failedChunks === 1 ? '' : 's'} queued`
      : pendingUploads
        ? `${pendingUploads} chunk${pendingUploads === 1 ? '' : 's'} uploading`
        : 'Audio relay healthy';
    uploadStatusEl.className = failedChunks ? 'audio-status error' : pendingUploads ? 'audio-status busy' : 'audio-status ok';
  }
  if (waveformEl) {
    Array.from(waveformEl.children).forEach((bar, index) => {
      const pulse = Math.max(.12, Math.min(1, level + (peak * .35) + Math.sin(Date.now() / 180 + index) * .12));
      bar.style.transform = `scaleY(${pulse})`;
      bar.style.opacity = String(.35 + pulse * .55);
    });
  }
}

function queueAudioRetry(blob, sequence, startedAt, attempts = 0) {
  if (sessionEnding || !blob || attempts >= MAX_AUDIO_RETRY_ATTEMPTS) return;
  audioRetryQueue.push({ blob, sequence, startedAt, attempts: attempts + 1, queuedAt: Date.now() });
  if (audioRetryQueue.length > MAX_AUDIO_RETRY_ITEMS) audioRetryQueue = audioRetryQueue.slice(-MAX_AUDIO_RETRY_ITEMS);
  failedChunks = audioRetryQueue.length;
  updateAudioUi({ status: 'Retry queued' });
}

async function processAudioRetryQueue() {
  if (sessionEnding || !audioRetryQueue.length || pendingUploads > 1) return;
  const next = audioRetryQueue.shift();
  failedChunks = audioRetryQueue.length;
  updateAudioUi({ status: 'Retrying upload' });
  await uploadRecorderBlob(next.blob, next.sequence, next.startedAt, {
    fromRetry: true,
    attempts: next.attempts
  });
}

function startAudioMeter() {
  ensureWaveformBars();
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(audioStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const samples = new Uint8Array(analyser.fftSize);
  let lastSentAt = 0;
  audioLevelTimer = setInterval(() => {
    if (!analyser || sessionEnding) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    let peak = 0;
    for (const value of samples) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
      peak = Math.max(peak, Math.abs(centered));
    }
    lastRms = Math.sqrt(sum / samples.length);
    lastPeak = peak;
    updateAudioUi({ rms: lastRms, peak: lastPeak });

    if (Date.now() - lastSentAt > 900) {
      lastSentAt = Date.now();
      window.truveil.sendAudioLevel({ rms: lastRms, peak: lastPeak, timestamp: Date.now() });
    }
  }, 120);
}

async function uploadRecorderBlob(blob, sequence, startedAt, options = {}) {
  const durationMs = Math.max(0, Date.now() - startedAt);
  pendingUploads++;
  updateAudioUi({ status: 'Uploading' });

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const result = await window.truveil.uploadAudioChunk({
      arrayBuffer,
      mimeType: blob.type || mediaRecorder?.mimeType || 'audio/webm;codecs=opus',
      sequence,
      durationMs,
      rms: lastRms,
      peak: lastPeak,
      timestamp: Date.now()
    });

    if (!result?.ok) throw new Error(result?.error || 'Upload failed');
    if (!result.skipped) uploadedChunks++;
    updateAudioUi({ status: 'Streaming' });
  } catch (err) {
    if (!options.fromRetry) {
      queueAudioRetry(blob, sequence, startedAt);
    } else {
      queueAudioRetry(blob, sequence, startedAt, options.attempts);
    }
    logEvent(`Audio upload failed: ${err.message}`, 'warn');
    toast('Audio upload had a problem. Truveil is retrying it in the background.', 'warn');
    updateAudioUi({ status: 'Upload issue' });
  } finally {
    pendingUploads = Math.max(0, pendingUploads - 1);
    updateAudioUi();
  }
}

function startAudioStreaming() {
  if (!window.MediaRecorder) {
    toast('This runtime cannot record audio. Update Truveil Secure and try again.', 'error');
    logEvent('MediaRecorder is unavailable in this app runtime', 'warn');
    return;
  }

  chunkSequence = 0;
  uploadedChunks = 0;
  failedChunks = 0;
  pendingUploads = 0;
  audioRetryQueue = [];
  if (audioRetryTimer) clearInterval(audioRetryTimer);
  audioRetryTimer = setInterval(processAudioRetryQueue, 4500);
  updateAudioUi({ status: 'Starting' });
  startAudioMeter();

  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
  lastChunkAt = Date.now();

  mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size < 128 || sessionEnding) return;
    const sequence = chunkSequence++;
    const startedAt = lastChunkAt || Date.now();
    lastChunkAt = Date.now();
    uploadRecorderBlob(event.data, sequence, startedAt);
  };

  mediaRecorder.onerror = (event) => {
    const message = event.error?.message || 'MediaRecorder error';
    logEvent(message, 'warn');
    toast(message, 'error');
  };

  mediaRecorder.onstart = () => {
    logEvent('Encrypted mic audio relay started', 'info');
    updateAudioUi({ status: 'Streaming' });
  };

  mediaRecorder.onstop = () => {
    updateAudioUi({ status: 'Stopped' });
  };

  try {
    mediaRecorder.start(7000);
  } catch (err) {
    logEvent(`Audio recorder could not start: ${err.message}`, 'warn');
    toast('Audio recording could not start.', 'error');
  }
}

function stopAudioStreaming() {
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch {}
  mediaRecorder = null;
  if (audioLevelTimer) clearInterval(audioLevelTimer);
  audioLevelTimer = null;
  if (audioRetryTimer) clearInterval(audioRetryTimer);
  audioRetryTimer = null;
  audioRetryQueue = [];
  failedChunks = 0;
  try { audioContext?.close(); } catch {}
  audioContext = null;
  analyser = null;
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

function renderPolicy(policy = {}) {
  const blocked = Array.isArray(policy.blocked_sites) ? policy.blocked_sites : [];
  const summary = $('policySummary');
  const text = $('blockedSitesText');
  if (!summary || !text) return;

  if (!blocked.length) {
    text.textContent = 'No recruiter-blocked websites were sent for this session.';
  } else {
    text.textContent = blocked.join(', ');
  }
  summary.hidden = false;
}

async function finishSession(message) {
  if (sessionEnding) return;
  sessionEnding = true;
  clearInterval(timerInterval);
  stopAudioStreaming();
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

window.truveil.onSessionPolicyUpdated((policy = {}) => {
  renderPolicy(policy);
  logEvent('Recruiter website policy synced', 'info');
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
