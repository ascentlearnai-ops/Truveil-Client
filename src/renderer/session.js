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
let audioContext = null;
let analyser = null;
let audioLevelTimer = null;
let recognition = null;
let recognitionRestartTimer = null;
let transcriptSequence = 0;
let transcriptCount = 0;
let transcriptFailures = 0;
let transcriptStartedAt = 0;
let lastRms = 0;
let lastPeak = 0;

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
  startTranscriptStreaming();
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
  if (audioStateEl) audioStateEl.textContent = status || 'Listening';
  if (audioChunkCountEl) audioChunkCountEl.textContent = String(transcriptCount);
  if (uploadStatusEl) {
    uploadStatusEl.textContent = transcriptFailures
      ? `${transcriptFailures} transcript send issue${transcriptFailures === 1 ? '' : 's'} detected`
      : 'Transcript relay healthy - raw audio is not stored';
    uploadStatusEl.className = transcriptFailures ? 'audio-status error' : 'audio-status ok';
  }
  if (waveformEl) {
    Array.from(waveformEl.children).forEach((bar, index) => {
      const pulse = Math.max(.12, Math.min(1, level + (peak * .35) + Math.sin(Date.now() / 180 + index) * .12));
      bar.style.transform = `scaleY(${pulse})`;
      bar.style.opacity = String(.35 + pulse * .55);
    });
  }
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

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

async function sendTranscriptText(text) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText || cleanText.length < 3 || sessionEnding) return;
  const now = Date.now();
  const durationMs = transcriptStartedAt ? Math.max(0, now - transcriptStartedAt) : undefined;
  const sequence = transcriptSequence++;
  transcriptStartedAt = now;

  try {
    const result = await window.truveil.sendTranscript({
      text: cleanText,
      timestamp: now,
      durationMs,
      sequence,
      source: 'candidate-web-speech'
    });
    if (!result?.ok) throw new Error(result?.error || 'Transcript send failed');
    transcriptCount++;
    transcriptFailures = 0;
    updateAudioUi({ status: 'Transcript sent' });
  } catch (err) {
    transcriptFailures++;
    logEvent(`Transcript send failed: ${err.message}`, 'warn');
    toast('Transcript send had a problem. Keep speaking; Truveil will keep trying.', 'warn');
    updateAudioUi({ status: 'Send issue' });
  }
}

function scheduleRecognitionRestart() {
  if (sessionEnding || !sessionStart) return;
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = setTimeout(() => {
    try {
      recognition?.start();
      updateAudioUi({ status: 'Listening' });
    } catch {}
  }, 750);
}

function startTranscriptStreaming() {
  transcriptSequence = 0;
  transcriptCount = 0;
  transcriptFailures = 0;
  transcriptStartedAt = Date.now();
  updateAudioUi({ status: 'Starting' });
  startAudioMeter();

  const RecognitionCtor = getSpeechRecognitionCtor();
  if (!RecognitionCtor) {
    logEvent('Live transcript engine is unavailable in this Electron runtime', 'warn');
    toast('Mic signal is live, but this runtime cannot create transcripts. Install the newest Truveil Secure build.', 'error');
    updateAudioUi({ status: 'Mic live - transcript unavailable' });
    return;
  }

  recognition = new RecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    logEvent('Live transcript relay started. Raw audio is not stored.', 'info');
    updateAudioUi({ status: 'Listening' });
  };

  recognition.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalText += text;
      else interimText += text;
    }
    if (interimText) updateAudioUi({ status: 'Hearing speech' });
    if (finalText) sendTranscriptText(finalText);
  };

  recognition.onerror = (event) => {
    const error = event.error || 'speech recognition error';
    const serious = error === 'not-allowed' || error === 'service-not-allowed';
    logEvent(`Transcript engine warning: ${error}`, serious ? 'warn' : 'info');
    if (serious) {
      toast('Speech transcription permission was blocked. Check microphone permissions and restart the session.', 'error');
      updateAudioUi({ status: 'Transcript blocked' });
    }
  };

  recognition.onend = () => {
    updateAudioUi({ status: sessionEnding ? 'Stopped' : 'Reconnecting' });
    scheduleRecognitionRestart();
  };

  try {
    recognition.start();
  } catch (err) {
    logEvent(`Transcript engine could not start: ${err.message}`, 'warn');
    toast('Transcript engine could not start.', 'error');
    updateAudioUi({ status: 'Transcript issue' });
  }
}

function stopTranscriptStreaming() {
  try {
    if (recognition) recognition.onend = null;
    recognition?.stop();
  } catch {}
  recognition = null;
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = null;
  if (audioLevelTimer) clearInterval(audioLevelTimer);
  audioLevelTimer = null;
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
  stopTranscriptStreaming();
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
