// Truveil Secure - Candidate Renderer
const $ = id => document.getElementById(id);
const AUDIO_SEGMENT_MS = 2500;
const TRANSCRIPT_BATCH_MS = 450;
const TRANSCRIPT_BATCH_MAX_WORDS = 10;
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
let lastRms = 0;
let lastPeak = 0;
let lastSpeechLevelAt = 0;
let lastFinalTranscriptAt = 0;
let lastInterimSentAt = 0;
let lastInterimText = '';
let activeSegmentStats = null;
let liveTranscriptionSocket = null;
let liveStreamReady = false;
let activeConnection = null;
let liveReconnectAttempts = 0;
let liveKeepAliveTimer = null;
let pcmSource = null;
let pcmWorklet = null;
let pcmSilentGain = null;
let liveFinalSegments = [];
let liveFinalConfidences = [];
let liveSegmentMaxRms = 0;
let liveSegmentMaxPeak = 0;
let liveStreamEpoch = 0;
let liveUtteranceId = 0;
let interviewStarted = false;

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
const instructionTrack = $('instructionTrack');
const instructionViewport = $('instructionViewport');
const instructionDots = $('instructionDots');
const instructionPrev = $('instructionPrev');
const instructionNext = $('instructionNext');
let instructionIndex = 0;
let instructionSwipeStart = null;

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

function updateInstructionCarousel(index = instructionIndex) {
  const cards = Array.from(instructionTrack?.children || []);
  if (!cards.length) return;
  instructionIndex = Math.max(0, Math.min(cards.length - 1, index));
  instructionTrack.style.transform = `translateX(-${instructionIndex * 100}%)`;
  cards.forEach((card, cardIndex) => {
    card.toggleAttribute('aria-hidden', cardIndex !== instructionIndex);
  });
  Array.from(instructionDots?.children || []).forEach((dot, dotIndex) => {
    dot.classList.toggle('active', dotIndex === instructionIndex);
  });
  if (instructionPrev) instructionPrev.disabled = instructionIndex === 0;
  if (instructionNext) instructionNext.disabled = instructionIndex === cards.length - 1;
}

function setupInstructionCarousel() {
  const cards = Array.from(instructionTrack?.children || []);
  if (!cards.length || !instructionDots) return;
  instructionDots.innerHTML = '';
  cards.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Show instruction ${index + 1}`);
    dot.addEventListener('click', () => updateInstructionCarousel(index));
    instructionDots.appendChild(dot);
  });
  instructionPrev?.addEventListener('click', () => updateInstructionCarousel(instructionIndex - 1));
  instructionNext?.addEventListener('click', () => updateInstructionCarousel(instructionIndex + 1));
  instructionViewport?.addEventListener('pointerdown', event => {
    instructionSwipeStart = { x: event.clientX, y: event.clientY };
    instructionViewport.setPointerCapture?.(event.pointerId);
  });
  instructionViewport?.addEventListener('pointerup', event => {
    if (!instructionSwipeStart) return;
    const dx = event.clientX - instructionSwipeStart.x;
    const dy = event.clientY - instructionSwipeStart.y;
    instructionSwipeStart = null;
    if (Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy)) return;
    updateInstructionCarousel(instructionIndex + (dx < 0 ? 1 : -1));
  });
  instructionViewport?.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') updateInstructionCarousel(instructionIndex - 1);
    if (event.key === 'ArrowRight') updateInstructionCarousel(instructionIndex + 1);
  });
  instructionViewport?.setAttribute('tabindex', '0');
  updateInstructionCarousel(0);
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
    toast('Please confirm the session verification notice before starting.', 'error');
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
  activeConnection = result;
  renderPolicy(result.policy || {});
  setStatus('active', result.waitingForInterviewer ? 'Ready' : 'Monitoring');
  sessionEnding = false;
  showScreen('active');
  $('displayName').textContent = result.waitingForInterviewer ? `${name} - ready` : name;
  $('connectionState').textContent = result.waitingForInterviewer ? 'Waiting for interviewer' : 'Secure';
  $('activeTitle').textContent = result.waitingForInterviewer ? 'Ready for the interviewer' : 'Session active';
  $('activeSubtitle').textContent = result.waitingForInterviewer
    ? 'Your microphone preflight passed. The interview has not started yet.'
    : 'Keep this window open and continue your interview normally.';
  updateAudioUi({ status: result.waitingForInterviewer ? 'Microphone ready - waiting for interviewer' : 'Starting' });
  if (!result.waitingForInterviewer) beginActiveInterview();
  resetStartButton();
}

function beginActiveInterview() {
  if (interviewStarted || sessionEnding || !activeConnection) return;
  interviewStarted = true;
  sessionStart = Date.now();
  $('displayName').textContent = activeConnection.candidateName || $('candidateNameInput').value.trim();
  $('connectionState').textContent = 'Secure';
  $('activeTitle').textContent = 'Session active';
  $('activeSubtitle').textContent = 'Keep this window open and continue your interview normally.';
  setStatus('active', 'Monitoring');
  startTimer();
  startTranscriptStreaming();
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
    liveSegmentMaxRms = Math.max(liveSegmentMaxRms, lastRms);
    liveSegmentMaxPeak = Math.max(liveSegmentMaxPeak, lastPeak);
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

function sendInterimTranscript(text, metadata = {}) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  const now = Date.now();
  if (!cleanText || cleanText.length < 4 || sessionEnding) return;
  if (now - lastInterimSentAt < 250 && cleanText.length < lastInterimText.length + 4) return;
  if (cleanText === lastInterimText) return;
  lastInterimSentAt = now;
  lastInterimText = cleanText;
  window.truveil.sendTranscript({
    text: cleanText,
    timestamp: now,
    durationMs: 0,
    sequence: transcriptSequence,
    source: 'deepgram-nova-3-direct',
    interim: true,
    streamEpoch: Number.isFinite(Number(metadata.streamEpoch)) ? Number(metadata.streamEpoch) : liveStreamEpoch,
    utteranceId: Number.isFinite(Number(metadata.utteranceId)) ? Number(metadata.utteranceId) : liveUtteranceId,
    segmentId: metadata.segmentId || `live-${liveStreamEpoch}-${liveUtteranceId}`,
    revision: Number(metadata.revision) || 0,
    rms: lastRms,
    peak: lastPeak
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
      source: 'deepgram-nova-3-direct',
      rms: lastRms,
      peak: lastPeak
    });
    if (!result?.ok) throw new Error(result?.error || 'Transcript send failed');
    if (result.skipped) {
      updateAudioUi({ status: result.reason === 'low-confidence' ? 'Speech unclear - still listening' : 'Listening' });
      return;
    }
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
  stopLiveTranscription();
  audioFallbackSequence = 0;
  audioFallbackChunks = 0;
  pendingAudioUploads = 0;

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
    const sessionOldEnough = now - sessionStart > 8000;
    const heardSpeechRecently = now - lastSpeechLevelAt < 8000;
    const transcriptStale = !lastFinalTranscriptAt || now - lastFinalTranscriptAt > 9000;
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
  lastSpeechLevelAt = 0;
  lastFinalTranscriptAt = 0;
  lastInterimSentAt = 0;
  lastInterimText = '';
  liveFinalSegments = [];
  liveFinalConfidences = [];
  liveSegmentMaxRms = 0;
  liveSegmentMaxPeak = 0;
  liveStreamEpoch = 0;
  liveUtteranceId = 0;
  transcriptBuffer = [];
  transcriptBufferStartedAt = 0;
  clearTimeout(transcriptFlushTimer);
  transcriptFlushTimer = null;
  transcriptStartedAt = Date.now();
  updateAudioUi({ status: 'Starting' });
  startAudioMeter();
  startLiveTranscription();
  startTranscriptWatchdog();
}

function stopLiveTranscription() {
  liveStreamReady = false;
  clearInterval(liveKeepAliveTimer);
  liveKeepAliveTimer = null;
  try { pcmWorklet?.disconnect(); } catch {}
  try { pcmSource?.disconnect(); } catch {}
  try { pcmSilentGain?.disconnect(); } catch {}
  pcmWorklet = null;
  pcmSource = null;
  pcmSilentGain = null;
  try {
    if (liveTranscriptionSocket) liveTranscriptionSocket.onclose = null;
    liveTranscriptionSocket?.close();
  } catch {}
  liveTranscriptionSocket = null;
}

function publishLiveTranscript(message = {}) {
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  if (!text || sessionEnding) return;
  lastSpeechLevelAt = Date.now();
  if (message.interim) {
    sendInterimTranscript(text, message);
    updateAudioUi({ status: 'Transcribing live' });
    return;
  }
  lastFinalTranscriptAt = Date.now();
  window.truveil.sendTranscript({
    text,
    timestamp: message.timestamp || Date.now(),
    durationMs: 0,
    sequence: transcriptSequence++,
    source: message.source || 'deepgram-nova-3-live',
    segmentId: message.segmentId || `live-${transcriptSequence}`,
    revision: Number(message.revision) || 0,
    streamEpoch: Number.isFinite(Number(message.streamEpoch)) ? Number(message.streamEpoch) : liveStreamEpoch,
    utteranceId: Number.isFinite(Number(message.utteranceId)) ? Number(message.utteranceId) : liveUtteranceId,
    finalReason: message.finalReason || 'speech_final',
    transcriptConfidence: message.confidence,
    rms: message.rms ?? liveSegmentMaxRms,
    peak: message.peak ?? liveSegmentMaxPeak
  }).then(result => {
    if (!result?.ok) throw new Error(result?.error || 'Transcript send failed');
    if (result.skipped) {
      updateAudioUi({ status: result.reason === 'low-confidence' ? 'Speech unclear - still listening' : 'Listening' });
      return;
    }
    transcriptCount++;
    transcriptFailures = 0;
    updateAudioUi({ status: 'Live transcript sent' });
  }).catch(err => {
    transcriptFailures++;
    logEvent(`Live transcript relay failed: ${err.message}`, 'warn', { visible: false });
    updateAudioUi({ status: 'Transcript relay issue' });
  });
}

function average(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function flushLiveFinal(finalReason = 'speech_final') {
  const text = liveFinalSegments.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const sequence = transcriptSequence;
  const currentUtteranceId = liveUtteranceId;
  publishLiveTranscript({
    text,
    interim: false,
    confidence: average(liveFinalConfidences),
    source: 'deepgram-nova-3-direct',
    segmentId: `live-${liveStreamEpoch}-${currentUtteranceId}`,
    revision: liveFinalSegments.length,
    streamEpoch: liveStreamEpoch,
    utteranceId: currentUtteranceId,
    finalReason,
    rms: liveSegmentMaxRms,
    peak: liveSegmentMaxPeak,
    timestamp: Date.now()
  });
  liveUtteranceId++;
  liveFinalSegments = [];
  liveFinalConfidences = [];
  liveSegmentMaxRms = 0;
  liveSegmentMaxPeak = 0;
}

async function startPcmStream() {
  if (!liveTranscriptionSocket || liveTranscriptionSocket.readyState !== WebSocket.OPEN || !audioStream || !audioContext) return;
  await audioContext.audioWorklet.addModule('../audio/pcm-worklet.js');
  pcmSource = audioContext.createMediaStreamSource(audioStream);
  pcmWorklet = new AudioWorkletNode(audioContext, 'truveil-pcm-processor', {
    processorOptions: { targetRate: 16000 }
  });
  pcmSilentGain = audioContext.createGain();
  pcmSilentGain.gain.value = 0;
  pcmWorklet.port.onmessage = event => {
    if (liveTranscriptionSocket?.readyState !== WebSocket.OPEN || !event.data) return;
    try { liveTranscriptionSocket.send(event.data); } catch {}
  };
  pcmSource.connect(pcmWorklet);
  pcmWorklet.connect(pcmSilentGain);
  pcmSilentGain.connect(audioContext.destination);
}

async function startLiveTranscription() {
  if (!window.truveil.getTranscriptionToken) {
    updateAudioUi({ status: 'Live transcription unavailable' });
    startAudioFallback('live transcription token unavailable');
    return;
  }

  stopLiveTranscription();
  updateAudioUi({ status: liveReconnectAttempts ? 'Reconnecting live transcript' : 'Connecting live transcript' });
  const tokenResult = await window.truveil.getTranscriptionToken().catch(error => ({ ok: false, error: error.message }));
  if (!tokenResult?.ok || !tokenResult.accessToken) {
    logEvent(`Live transcription token failed: ${tokenResult?.error || 'unavailable'}`, 'warn', { visible: false });
    startAudioFallback('live transcription token unavailable');
    return;
  }

  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    smart_format: 'true',
    punctuate: 'true',
    filler_words: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true'
  });
  (activeConnection.technicalVocabulary || []).slice(0, 30).forEach(term => params.append('keyterm', term));
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  try {
    liveTranscriptionSocket = new WebSocket(url, ['token', tokenResult.accessToken]);
    liveTranscriptionSocket.binaryType = 'arraybuffer';
  } catch {
    startAudioFallback('live relay connection failed');
    return;
  }

  liveTranscriptionSocket.onopen = () => {
    liveStreamReady = true;
    liveReconnectAttempts = 0;
    updateAudioUi({ status: 'Live transcript connected' });
    startPcmStream().catch(error => {
      logEvent(`PCM stream unavailable: ${error.message}`, 'warn', { visible: false });
      startAudioFallback('PCM stream unavailable');
    });
    liveKeepAliveTimer = setInterval(() => {
      if (liveTranscriptionSocket?.readyState === WebSocket.OPEN) {
        liveTranscriptionSocket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 4000);
  };
  liveTranscriptionSocket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data || '{}'));
      if (message.type === 'SpeechStarted') {
        updateAudioUi({ status: 'Hearing speech' });
        return;
      }
      if (message.type === 'UtteranceEnd') {
        if (Number(message.last_word_end) === -1) return;
        flushLiveFinal('utterance_end');
        return;
      }
      const alternative = message.channel?.alternatives?.[0];
      const text = String(alternative?.transcript || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const confidence = Number(alternative?.confidence || 0);
      if (message.is_final) {
        if (liveFinalSegments.at(-1) !== text) liveFinalSegments.push(text);
        if (confidence > 0) liveFinalConfidences.push(confidence);
      }
      if (message.speech_final) {
        flushLiveFinal('speech_final');
        return;
      }
      const combined = [...liveFinalSegments, message.is_final ? '' : text].filter(Boolean).join(' ');
      if (combined) publishLiveTranscript({
        text: combined,
        interim: true,
        confidence,
        source: 'deepgram-nova-3-direct',
        segmentId: `live-${liveStreamEpoch}-${liveUtteranceId}`,
        revision: message.is_final ? liveFinalSegments.length : 0,
        streamEpoch: liveStreamEpoch,
        utteranceId: liveUtteranceId
      });
    } catch {}
  };
  liveTranscriptionSocket.onerror = () => updateAudioUi({ status: 'Live transcript reconnecting' });
  liveTranscriptionSocket.onclose = () => {
    liveStreamReady = false;
    if (sessionEnding || audioFallbackActive) return;
    liveReconnectAttempts++;
    if (liveReconnectAttempts <= 2) {
      liveStreamEpoch++;
      liveUtteranceId = 0;
      liveFinalSegments = [];
      liveFinalConfidences = [];
      liveSegmentMaxRms = 0;
      liveSegmentMaxPeak = 0;
      setTimeout(() => startLiveTranscription().catch(() => {}), 900 * liveReconnectAttempts);
    } else {
      startAudioFallback('live relay unavailable');
    }
  };
}

function stopTranscriptStreaming() {
  stopLiveTranscription();
  activeConnection = null;
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
  clearInterval(transcriptWatchdogTimer);
  transcriptWatchdogTimer = null;
  if (audioLevelTimer) clearInterval(audioLevelTimer);
  audioLevelTimer = null;
  try { audioContext?.close(); } catch {}
  audioContext = null;
  analyser = null;
  interviewStarted = false;
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

window.truveil.onSessionStarted(() => {
  beginActiveInterview();
});

window.truveil.onInviteCode((code) => {
  if (!code || activeConnection) return;
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
setupInstructionCarousel();
setTimeout(() => sessionCodeInput.focus(), 400);
