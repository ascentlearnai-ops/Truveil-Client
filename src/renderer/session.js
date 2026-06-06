// Truveil Secure - Candidate Renderer
const $ = id => document.getElementById(id);
const AUDIO_SEGMENT_MS = 10000;
const TRANSCRIPT_BATCH_MS = 900;
const TRANSCRIPT_BATCH_MAX_WORDS = 16;
const SPEECH_RMS_THRESHOLD = 0.012;
const SPEECH_PEAK_THRESHOLD = 0.06;

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
let audioStream = null;
let sessionEnding = false;
let audioContext = null;
let analyser = null;
let audioLevelTimer = null;
let recognition = null;
let recognitionRestartTimer = null;
let transcriptWatchdogTimer = null;
let mediaRecorder = null;
let audioFallbackSegmentTimer = null;
let transcriptSequence = 0;
let transcriptCount = 0;
let transcriptFailures = 0;
let transcriptStartedAt = 0;
let transcriptBuffer = [];
let transcriptBufferStartedAt = 0;
let transcriptFlushTimer = null;
let audioFallbackActive = false;
let audioFallbackSequence = 0;
let audioFallbackChunks = 0;
let pendingAudioUploads = 0;
let lastAudioChunkAt = 0;
let recognitionNetworkFailures = 0;
let lastRms = 0;
let lastPeak = 0;
let lastSpeechLevelAt = 0;
let lastFinalTranscriptAt = 0;
let lastInterimSentAt = 0;
let lastInterimText = '';
let activeSegmentStats = null;

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
    toast('Please consent to monitoring and restricted-site controls to start.', 'error');
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
  const count = audioFallbackActive ? audioFallbackChunks : transcriptCount;
  if (audioStateEl) audioStateEl.textContent = status || (audioFallbackActive ? 'Cloud transcription' : 'Listening');
  if (audioChunkCountEl) audioChunkCountEl.textContent = String(count);
  if (uploadStatusEl) {
    if (audioFallbackActive) {
      uploadStatusEl.textContent = pendingAudioUploads
        ? `${pendingAudioUploads} voice segment${pendingAudioUploads === 1 ? '' : 's'} syncing`
        : 'Voice relay active';
      uploadStatusEl.className = pendingAudioUploads ? 'audio-status busy' : 'audio-status ok';
    } else {
      uploadStatusEl.textContent = transcriptFailures
        ? `${transcriptFailures} transcript send issue${transcriptFailures === 1 ? '' : 's'} detected`
        : 'Live transcript relay active';
      uploadStatusEl.className = transcriptFailures ? 'audio-status error' : 'audio-status ok';
    }
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
    if (activeSegmentStats) {
      activeSegmentStats.maxRms = Math.max(activeSegmentStats.maxRms, lastRms);
      activeSegmentStats.maxPeak = Math.max(activeSegmentStats.maxPeak, lastPeak);
    }
    if (lastRms > SPEECH_RMS_THRESHOLD || lastPeak > 0.08) lastSpeechLevelAt = Date.now();
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

function getSupportedAudioMimeType() {
  if (!window.MediaRecorder) return '';
  const options = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  return options.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function scheduleTranscriptFlush(delay = TRANSCRIPT_BATCH_MS) {
  clearTimeout(transcriptFlushTimer);
  transcriptFlushTimer = setTimeout(() => {
    flushTranscriptBuffer().catch((err) => {
      logEvent(`Transcript flush failed: ${err.message}`, 'warn');
    });
  }, delay);
}

async function sendTranscriptText(text) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText || cleanText.length < 3 || sessionEnding) return;
  if (!transcriptBufferStartedAt) transcriptBufferStartedAt = Date.now();
  transcriptBuffer.push(cleanText);
  lastFinalTranscriptAt = Date.now();
  updateAudioUi({ status: 'Transcript queued' });

  if (wordCount(transcriptBuffer.join(' ')) >= TRANSCRIPT_BATCH_MAX_WORDS) {
    await flushTranscriptBuffer();
    return;
  }
  scheduleTranscriptFlush();
}

function sendInterimTranscript(text) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  const now = Date.now();
  if (!cleanText || cleanText.length < 4 || sessionEnding) return;
  if (now - lastInterimSentAt < 550 && cleanText.length < lastInterimText.length + 8) return;
  if (cleanText === lastInterimText) return;
  lastInterimSentAt = now;
  lastInterimText = cleanText;
  window.truveil.sendTranscript({
    text: cleanText,
    timestamp: now,
    durationMs: 0,
    sequence: transcriptSequence,
    source: 'candidate-web-speech-interim',
    interim: true
  }).catch(() => {});
}

async function flushTranscriptBuffer() {
  if (!transcriptBuffer.length) return;
  const cleanText = transcriptBuffer.join(' ').replace(/\s+/g, ' ').trim();
  if (!cleanText || cleanText.length < 3) return;
  const now = Date.now();
  const durationMs = transcriptBufferStartedAt ? Math.max(0, now - transcriptBufferStartedAt) : undefined;
  const sequence = transcriptSequence++;
  transcriptStartedAt = now;
  transcriptBuffer = [];
  transcriptBufferStartedAt = 0;
  clearTimeout(transcriptFlushTimer);
  transcriptFlushTimer = null;

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
  if (sessionEnding || !sessionStart || audioFallbackActive) return;
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = setTimeout(() => {
    try {
      recognition?.start();
      updateAudioUi({ status: 'Listening' });
    } catch {}
  }, 750);
}

async function uploadFallbackAudioBlob(blob, sequence, startedAt, stats = {}, attempt = 1) {
  if (!blob || blob.size < 128 || sessionEnding) return;
  pendingAudioUploads++;
  updateAudioUi({ status: attempt > 1 ? `Retrying segment ${attempt}/3` : 'Uploading transcript segment' });
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const result = await window.truveil.uploadAudioChunk({
      arrayBuffer,
      mimeType: blob.type || mediaRecorder?.mimeType || 'audio/webm;codecs=opus',
      sequence,
      durationMs: Math.max(0, Date.now() - startedAt),
      rms: Number(stats.rms) || lastRms,
      peak: Number(stats.peak) || lastPeak,
      timestamp: Date.now()
    });
    if (!result?.ok) throw new Error(result?.error || 'Audio upload failed');
    if (!result.skipped) audioFallbackChunks++;
    updateAudioUi({ status: 'Segment sent' });
  } catch (err) {
    logEvent(`Audio segment upload failed: ${err.message}`, 'warn');
    if (attempt < 3 && !sessionEnding) {
      const retryDelay = 1200 * attempt;
      setTimeout(() => uploadFallbackAudioBlob(blob, sequence, startedAt, stats, attempt + 1), retryDelay);
      updateAudioUi({ status: 'Segment retry scheduled' });
    } else {
      toast('Audio segment upload failed. Check your connection and keep Truveil open.', 'warn');
      updateAudioUi({ status: 'Segment upload issue' });
    }
  } finally {
    pendingAudioUploads = Math.max(0, pendingAudioUploads - 1);
    updateAudioUi();
  }
}

function startAudioFallback(reason = 'cloud transcription primary') {
  if (audioFallbackActive || sessionEnding) return;
  if (!window.MediaRecorder || !window.truveil.uploadAudioChunk) {
    logEvent('Voice fallback unavailable in this build', 'warn', { visible: false });
    updateAudioUi({ status: 'Transcript unavailable' });
    return;
  }

  audioFallbackActive = true;
  audioFallbackSequence = 0;
  audioFallbackChunks = 0;
  pendingAudioUploads = 0;
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = null;
  try {
    if (recognition) recognition.onend = null;
    recognition?.stop();
  } catch {}
  recognition = null;

  lastAudioChunkAt = Date.now();

  logEvent(`Voice fallback started: ${reason}`, 'info', { visible: false });
  updateAudioUi({ status: 'Voice relay active' });
  startFallbackRecorderSegment();
}

function startFallbackRecorderSegment() {
  if (!audioFallbackActive || sessionEnding || !audioStream) return;

  const mimeType = getSupportedAudioMimeType();
  const sequence = audioFallbackSequence++;
  const startedAt = Date.now();
  const segmentStats = { startedAt, maxRms: 0, maxPeak: 0 };
  activeSegmentStats = segmentStats;
  const parts = [];
  let recorder;

  try {
    recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
    mediaRecorder = recorder;
  } catch (err) {
    audioFallbackActive = false;
    logEvent(`Audio fallback could not start: ${err.message}`, 'warn');
    updateAudioUi({ status: 'Fallback failed' });
    return;
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) parts.push(event.data);
  };
  recorder.onerror = (event) => {
    const message = event.error?.message || 'Audio fallback recorder error';
    logEvent(message, 'warn');
    updateAudioUi({ status: 'Fallback recorder issue' });
  };
  recorder.onstart = () => {
    lastAudioChunkAt = startedAt;
    updateAudioUi({ status: 'Syncing voice segment' });
  };
  recorder.onstop = () => {
    if (activeSegmentStats === segmentStats) activeSegmentStats = null;
    if (parts.length && !sessionEnding) {
      const blob = new Blob(parts, { type: recorder.mimeType || mimeType || 'audio/webm;codecs=opus' });
      const rms = Math.max(segmentStats.maxRms, lastRms);
      const peak = Math.max(segmentStats.maxPeak, lastPeak);
      const hasSpeech = rms >= SPEECH_RMS_THRESHOLD || peak >= SPEECH_PEAK_THRESHOLD;
      if (hasSpeech) {
        uploadFallbackAudioBlob(blob, sequence, startedAt, { rms, peak });
      } else {
        updateAudioUi({ status: 'Mic live - no speech detected' });
      }
    }
    if (mediaRecorder === recorder) mediaRecorder = null;
    if (audioFallbackActive && !sessionEnding) {
      audioFallbackSegmentTimer = setTimeout(startFallbackRecorderSegment, 250);
    } else {
      updateAudioUi({ status: 'Stopped' });
    }
  };

  try {
    recorder.start();
    clearTimeout(audioFallbackSegmentTimer);
    updateAudioUi({ status: 'Syncing voice segment' });
    audioFallbackSegmentTimer = setTimeout(() => {
      try {
        if (recorder.state === 'recording') {
          recorder.requestData();
          recorder.stop();
        }
      } catch {}
    }, AUDIO_SEGMENT_MS);
  } catch (err) {
    audioFallbackActive = false;
    logEvent(`Audio fallback could not start: ${err.message}`, 'warn');
    updateAudioUi({ status: 'Fallback failed' });
  }
}

function startTranscriptWatchdog() {
  clearInterval(transcriptWatchdogTimer);
  transcriptWatchdogTimer = setInterval(() => {
    if (sessionEnding || audioFallbackActive || !sessionStart) return;
    const now = Date.now();
    const sessionOldEnough = now - sessionStart > 18000;
    const heardSpeechRecently = now - lastSpeechLevelAt < 8000;
    const transcriptStale = !lastFinalTranscriptAt || now - lastFinalTranscriptAt > 22000;
    if (sessionOldEnough && heardSpeechRecently && transcriptStale) {
      logEvent('Live transcript stalled; switching to audio fallback.', 'warn');
      startAudioFallback('transcript watchdog timeout');
    }
  }, 5000);
}

function startTranscriptStreaming() {
  transcriptSequence = 0;
  transcriptCount = 0;
  transcriptFailures = 0;
  audioFallbackActive = false;
  audioFallbackChunks = 0;
  pendingAudioUploads = 0;
  recognitionNetworkFailures = 0;
  lastSpeechLevelAt = 0;
  lastFinalTranscriptAt = 0;
  lastInterimSentAt = 0;
  lastInterimText = '';
  transcriptBuffer = [];
  transcriptBufferStartedAt = 0;
  clearTimeout(transcriptFlushTimer);
  transcriptFlushTimer = null;
  transcriptStartedAt = Date.now();
  updateAudioUi({ status: 'Starting' });
  startAudioMeter();
  startWebSpeechUiOnly();
  startTranscriptWatchdog();
  if (!getSpeechRecognitionCtor()) {
    startAudioFallback('live transcript unavailable');
  }
}

function startWebSpeechUiOnly() {
  const RecognitionCtor = getSpeechRecognitionCtor();
  if (!RecognitionCtor) return;
  recognition = new RecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    logEvent('Live transcript relay started.', 'info', { visible: false });
    updateAudioUi({ status: 'Live transcript active' });
  };

  recognition.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalText += text;
      else interimText += text;
    }
    if (interimText) {
      lastSpeechLevelAt = Date.now();
      updateAudioUi({ status: 'Hearing speech' });
      sendInterimTranscript(interimText);
    }
    if (finalText) sendTranscriptText(finalText);
  };

  recognition.onerror = (event) => {
    const error = event.error || 'speech recognition error';
    const serious = error === 'not-allowed' || error === 'service-not-allowed';
    logEvent(`Transcript engine warning: ${error}`, serious ? 'warn' : 'info', { visible: false });
    if (error === 'network' || error === 'audio-capture') {
      recognitionNetworkFailures++;
      if (recognitionNetworkFailures >= 1) startAudioFallback(error);
      return;
    }
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
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.requestData(); } catch {}
      mediaRecorder.stop();
    }
  } catch {}
  mediaRecorder = null;
  audioFallbackActive = false;
  activeSegmentStats = null;
  clearTimeout(audioFallbackSegmentTimer);
  audioFallbackSegmentTimer = null;
  clearTimeout(transcriptFlushTimer);
  transcriptFlushTimer = null;
  flushTranscriptBuffer().catch(() => {});
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = null;
  clearInterval(transcriptWatchdogTimer);
  transcriptWatchdogTimer = null;
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

function logEvent(text, kind = 'warn', options = {}) {
  if (options.visible === false) return;
  const feed = $('flagFeed');
  if (feed.querySelector('.ff-empty')) feed.innerHTML = '';

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
    text.textContent = '';
  } else {
    text.textContent = '';
  }
  summary.hidden = true;
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
  setStatus('warn', 'Return to session');
});

window.truveil.onFocusGained(() => {
  if (!sessionStart) return;
  setStatus('active', 'Monitoring');
});

window.truveil.onShortcutBlocked(() => {
  if (!sessionStart) return;
  setStatus('warn', 'Session protected');
});

window.truveil.onBlockingWarning((warning = {}) => {
  if (!sessionStart) return;
  const processName = warning.processName || 'Unknown app';
  const title = warning.windowTitle || 'Unknown window';
  const detectedHost = warning.detectedHost || '';
  const detectedUrl = warning.detectedUrl || '';
  const target = detectedHost
    ? `Opened ${detectedHost}`
    : detectedUrl
      ? `Opened ${detectedUrl}`
      : `Opened ${processName} - ${title}`;
  const banner = $('blockingBanner');
  $('blockingDetail').textContent = target;
  banner.hidden = false;
  setTimeout(() => { banner.hidden = true; }, 6000);
  logEvent(detectedHost ? `Opened ${detectedHost}` : `Opened ${processName}`, 'warn');
  setStatus('warn', 'Restricted site closed');
});

window.truveil.onSessionPolicyUpdated((policy = {}) => {
  renderPolicy(policy);
  logEvent('Interview policy synced', 'info', { visible: false });
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
