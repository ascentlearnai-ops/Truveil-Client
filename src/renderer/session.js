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
  screens[name].focus({ preventScroll: true });
  screens[name].scrollIntoView?.({ block: 'start' });
}

let sessionStart = null;
let timerInterval = null;
let audioStream = null;
let sessionEnding = false;
let joiningSession = false;
let pendingSessionStart = false;
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
let interimSendTimer = null;
let pendingInterim = null;
let lastProviderResultAt = 0;
let liveCaptionRevision = 0;
let liveFinalEndSeconds = -1;
let liveLatestResultEnd = -1;
let liveEnergySamples = [];
const finalRelayRetries = new Set();
let activeSegmentStats = null;
let liveTranscriptionSocket = null;
let liveStreamReady = false;
let activeConnection = null;
let liveReconnectAttempts = 0;
let liveKeepAliveTimer = null;
let liveReconnectTimer = null;
let liveConnectionGeneration = 0;
const LIVE_GRANT_COOLDOWN_MS = 10250;
const LIVE_GRANT_WINDOW_MS = 60250;
const LIVE_MAX_RETRIES = 5;
let liveGrantRequests = [];
let liveLastGrantAt = null;
let liveTokenPending = false;
let liveAttemptStartedAt = 0;
let liveStartupTimer = null;
let liveRetryAt = 0;
let liveCaptionStatus = '';
let liveCaptionFailure = null;
let pcmSource = null;
let pcmWorklet = null;
let pcmSilentGain = null;
let liveFinalSegments = [];
let liveFinalKeys = new Set();
let liveAudioStartedAt = 0;
let liveSegmentMaxRms = 0;
let liveSegmentMaxPeak = 0;
let liveStreamEpoch = 0;
let liveUtteranceId = 0;
let interviewStarted = false;
let demoSpeechUnavailable = false;
let browserSharingPermitted = false;
let taviBrowserPhase = null;
const captionEntries = new Map();
let captionStreamId = null;
let captionRevision = 0;
let captionStreamOrder = 0;
let captionArrivalOrder = 0;
const retiredCaptionStreams = new Set();

function resetCaptions() {
  captionEntries.clear();
  captionStreamId = null;
  captionRevision = 0;
  captionStreamOrder = 0;
  captionArrivalOrder = 0;
  retiredCaptionStreams.clear();
  $('captionHistory').textContent = '';
  $('captionDraft').textContent = '';
  $('captionEmpty').hidden = false;
  $('captionState').textContent = 'Listening';
}

function renderCaption(caption = {}) {
  if (sessionEnding) return;
  const scroller = $('captionScroll');
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  const stream = caption.captionStreamId || 'legacy';
  if (retiredCaptionStreams.has(stream)) return;
  if (captionStreamId !== stream) {
    if (captionStreamId) retiredCaptionStreams.add(captionStreamId);
    if (retiredCaptionStreams.size > 32) retiredCaptionStreams.delete(retiredCaptionStreams.values().next().value);
    captionStreamId = stream;
    captionStreamOrder++;
    captionRevision = 0;
    $('captionDraft').textContent = '';
  }
  const revision = Number(caption.revision) || 0;
  const text = typeof caption.text === 'string' ? caption.text : '';
  const isCurrent = revision >= captionRevision;
  if (caption.interim) {
    if (!isCurrent || revision === captionRevision) return;
    captionRevision = revision;
    $('captionDraft').textContent = caption.captionClear ? '' : text;
    $('captionState').textContent = demoSpeechUnavailable ? 'Live captions unavailable'
      : audioFallbackActive ? 'Backup transcription - slower updates' : caption.captionClear ? 'Listening' : 'Live draft';
  } else if (text) {
    if (isCurrent) {
      captionRevision = revision;
      $('captionDraft').textContent = '';
    }
    const identity = caption.segmentId || `${stream}:${caption.sequence}:${caption.timestamp}`;
    if (captionEntries.has(identity)) return;
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    const record = { element: paragraph, streamOrder: captionStreamOrder,
      epoch: Number(caption.streamEpoch) || 0, sequence: caption.sequence,
      capturedAt: caption.startedAt ?? caption.timestamp, arrival: ++captionArrivalOrder };
    const ordered = [...captionEntries.values()].sort(compareCaptionOrder);
    const before = ordered.find(entry => compareCaptionOrder(record, entry) < 0);
    captionEntries.set(identity, record);
    $('captionHistory').insertBefore(paragraph, before?.element || null);
    if (captionEntries.size > 80) {
      const oldest = [...captionEntries].sort((a, b) => compareCaptionOrder(a[1], b[1]))[0][0];
      captionEntries.get(oldest).element.remove();
      captionEntries.delete(oldest);
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    $('captionState').textContent = demoSpeechUnavailable ? 'Live captions unavailable' : audioFallbackActive ? 'Backup transcription - slower updates'
      : caption.qualityReason ? 'Uncertain speech - review needed' : 'Confirmed speech';
  }
  $('captionEmpty').hidden = captionEntries.size > 0 || Boolean($('captionDraft').textContent);
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

function compareCaptionOrder(a, b) {
  return a.streamOrder - b.streamOrder || a.epoch - b.epoch
    || (Number.isFinite(a.sequence) && Number.isFinite(b.sequence) ? a.sequence - b.sequence : 0)
    || (Number.isFinite(a.capturedAt) && Number.isFinite(b.capturedAt) ? a.capturedAt - b.capturedAt : 0)
    || a.arrival - b.arrival;
}

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
  statusText.textContent = sessionPresentation.message(text);
}

function toast(msg, kind = 'info') {
  toastEl.textContent = sessionPresentation.message(msg);
  if (kind === 'error' && !sessionEnding) {
    setTaviGuidance(activeConnection ? 'sessionGuide' : 'setupGuide', toastEl.textContent);
  }
  toastEl.className = `toast visible ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('visible'), 3200);
}

// Text-only guidance: never trigger session, permission, or browser actions here.
function setTaviGuidance(id, text) {
  const target = $(id);
  if (target && target.textContent !== text) target.textContent = text;
}

function updateInstructionCarousel(index = instructionIndex) {
  const cards = Array.from(instructionTrack?.children || []);
  if (!cards.length) return;
  instructionIndex = Math.max(0, Math.min(cards.length - 1, index));
  instructionTrack.style.transform = `translateX(-${instructionIndex * 100}%)`;
  cards.forEach((card, cardIndex) => {
    card.setAttribute('aria-hidden', String(cardIndex !== instructionIndex));
  });
  Array.from(instructionDots?.children || []).forEach((dot, dotIndex) => {
    dot.classList.toggle('active', dotIndex === instructionIndex);
    dot.setAttribute('aria-pressed', String(dotIndex === instructionIndex));
  });
  if (instructionPrev) instructionPrev.disabled = instructionIndex === 0;
  if (instructionNext) instructionNext.disabled = instructionIndex === cards.length - 1;
  const instruction = cards[instructionIndex].textContent?.trim().replace(/\s+/g, ' ');
  if (instruction) setTaviGuidance('instructionAnnouncement', instruction);
}

function setupInstructionCarousel() {
  const cards = Array.from(instructionTrack?.children || []);
  if (!cards.length || !instructionDots) return;
  instructionDots.innerHTML = '';
  cards.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Show instruction ${index + 1}`);
    dot.setAttribute('title', `Show instruction ${index + 1}`);
    dot.setAttribute('aria-controls', 'instructionTrack');
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
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') updateInstructionCarousel(instructionIndex - 1);
    if (event.key === 'ArrowRight') updateInstructionCarousel(instructionIndex + 1);
    if (event.key === 'Home') updateInstructionCarousel(0);
    if (event.key === 'End') updateInstructionCarousel(cards.length - 1);
  });
  instructionViewport?.addEventListener('pointercancel', () => {
    instructionSwipeStart = null;
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

const sessionPresentation = window.TruveilSession;

sessionCodeInput.addEventListener('input', (e) => {
  let v = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (v.length > 3 && v.startsWith('TRV') && v[3] !== '-') v = 'TRV-' + v.slice(3);
  v = sessionPresentation.displayCode(v);
  e.target.value = v;
  const legacy = /^TRV-[A-Z0-9]{0,6}$/.test(v);
  $('browserConsentOptions').hidden = legacy;
  $('activityNoticeTitle').textContent = legacy ? 'Foreground activity' : 'Optional browser sharing';
  $('activityNoticeText').textContent = legacy
    ? 'The interviewer may receive the active app name, window title, browser host or URL when Windows exposes it, and restricted-target events.'
    : 'Only your explicitly connected browser window is shared, with permission. Domain names and tab changes are visible, never titles, full URLs, or page contents. Other windows and apps are not monitored.';
});

sessionCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startBtn.click();
});

startBtn.addEventListener('click', startSession);

async function refreshMicrophones() {
  if (joiningSession || activeConnection || sessionEnding || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (joiningSession || activeConnection || sessionEnding) return;
    const input = $('microphoneInput');
    const selected = input.value;
    const microphones = devices.filter(device => device.kind === 'audioinput' && device.deviceId);
    const options = [{ deviceId: '', label: 'System default microphone' }, ...microphones];
    if (selected && !options.some(device => device.deviceId === selected)) {
      options.push({ deviceId: selected, label: 'Previously selected microphone (unavailable)' });
    }
    input.replaceChildren(...options.map((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index}`;
      return option;
    }));
    input.value = selected;
  } catch {
    if (joiningSession || activeConnection || sessionEnding) return;
    toast('Could not list microphones. Check Windows microphone permissions and try again.', 'error');
  }
}

$('refreshMicrophonesBtn').addEventListener('click', refreshMicrophones);
$('microphoneInput').addEventListener('focus', refreshMicrophones);

async function startSession() {
  if (joiningSession || activeConnection || sessionEnding) return;
  const code = sessionCodeInput.value.trim();
  const name = $('candidateNameInput').value.trim();

  if (!code) {
    toast('Enter the complete session code from your invitation.', 'error');
    sessionCodeInput.focus();
    return;
  }

  const demo = /^(?:DEMO-[A-Z2-9]{16}|TRV-[A-Z2-7]{16})$/.test(code);
  if (!demo && !/^TRV-[A-Z0-9]{6}$/.test(code)) {
    toast('Paste the complete interview code from your invitation.', 'error');
    sessionCodeInput.focus();
    return;
  }

  const relayUrl = $('demoRelayInput').value.trim();
  if (demo) {
    try {
      const url = new URL(relayUrl);
      if (url.username || url.password || url.search || url.hash || !(url.protocol === 'wss:' || (url.protocol === 'ws:' && url.hostname === '127.0.0.1'))) throw new Error();
    } catch {
      toast('Enter the secure session server address from your interviewer.', 'error');
      $('demoRelayInput').focus();
      return;
    }
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
  $('microphoneInput').disabled = true;
  $('refreshMicrophonesBtn').disabled = true;
  joiningSession = true;
  pendingSessionStart = false;
  startBtn.textContent = 'Checking session...';
  $('cancelJoinBtn').hidden = false;
  setStatus(null, 'Checking session');
  setTaviGuidance('setupGuide', 'Allow the microphone prompt for your session check.');

  try {
    const deviceId = $('microphoneInput').value;
    audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      channelCount: { ideal: 1 }
    } });
    const tracks = audioStream.getAudioTracks();
    if (!tracks.some(track => track.readyState === 'live')) throw new Error('Microphone is not available.');
    tracks.forEach(track => track.addEventListener('ended', () => {
      if (sessionEnding) return;
      finishSession('The microphone disconnected. Local capture has stopped.', { disconnected: true });
      window.truveil.endSession().catch(() => {});
    }, { once: true }));
  } catch {
    stopAudio();
    if (sessionEnding) { resetStartButton(); return; }
    toast('Microphone permission is required. Check your selected input and try joining again.', 'error');
    resetStartButton();
    setStatus(null, 'Not started');
    return;
  }

  if (sessionEnding) { stopAudio(); resetStartButton(); return; }
  if (!sessionConsentInput.checked) {
    stopAudio();
    resetStartButton();
    setStatus(null, 'Not started');
    toast('Please confirm the session verification notice before starting.', 'error');
    return;
  }
  const externalReviewConsent = $('externalReviewConsentInput')?.checked === true;
  const tabObserveConsent = demo && $('tabObserveConsentInput').checked === true;
  const tabCloseConsent = tabObserveConsent && $('tabCloseConsentInput').checked === true;
  if (demo) { startBtn.textContent = 'Waiting for interviewer approval...'; setStatus(null, 'Waiting for approval'); }
  setTaviGuidance('setupGuide', demo
    ? 'Your microphone is open for preflight. Check your name above while you wait for approval.'
    : 'Your microphone is open for preflight. Check your name above while the session connects.');
  const result = await window.truveil.startSession({ sessionCode: code, candidateName: name, consentConfirmed: true, microphoneReady: true, externalReviewConsent,
    relayUrl, tabObserveConsent, tabCloseConsent })
    .catch(error => ({ ok: false, error: error.message }));
  if (sessionEnding) { stopAudio(); resetStartButton(); return; }
  if (!result?.ok) {
    toast(result?.error || 'Could not start session', 'error');
    stopAudio();
    resetStartButton();
    setStatus(null, 'Not started');
    return;
  }
  if (!sessionConsentInput.checked || $('externalReviewConsentInput').checked !== externalReviewConsent ||
      (demo && ($('tabObserveConsentInput').checked !== tabObserveConsent || (tabObserveConsent && $('tabCloseConsentInput').checked !== tabCloseConsent)))) {
    await finishSession('Permission changed while joining. Local capture has stopped.');
    await window.truveil.endSession().catch(() => {});
    return;
  }

  $('displayName').textContent = name;
  $('displayCode').textContent = code;
  if (pendingSessionStart) result.waitingForInterviewer = false;
  activeConnection = result;
  browserSharingPermitted = tabObserveConsent;
  taviBrowserPhase = tabObserveConsent ? 'disconnected' : 'unshared';
  $('browserPanel').hidden = !result.demo;
  $('browserState').textContent = tabObserveConsent ? 'Waiting for the interview to start' : 'Not shared. Browser-sharing permission was not granted.';
  setTaviGuidance('browserGuide', tabObserveConsent
    ? 'Browser sharing can wait until the interview starts.'
    : 'Your browser is not shared. You did not grant browser-sharing permission.');
  $('pairBrowserBtn').disabled = true;
  $('activityFactTitle').textContent = result.demo ? 'Browser sharing' : 'Foreground activity';
  $('activityFactValue').textContent = result.demo ? 'Only the window you connect, with permission' : 'App and browser details may be shared';
  if ($('externalReviewConsentInput')) $('externalReviewConsentInput').checked = false;
  $('withdrawProviderConsentBtn').hidden = !externalReviewConsent;
  $('externalReviewState').textContent = externalReviewConsent ? 'External text review is permitted. You can stop future checks here.' : 'External text review is not permitted.';
  renderPolicy(result.policy || {});
  setStatus('active', result.waitingForInterviewer ? 'Ready' : 'Monitoring');
  showScreen('active');
  $('displayName').textContent = result.waitingForInterviewer ? `${name} - ready` : name;
  $('connectionState').textContent = result.waitingForInterviewer ? 'Waiting for interviewer' : 'Secure';
  $('activeTitle').textContent = result.waitingForInterviewer ? 'Ready for the interviewer' : 'Session active';
  $('activeSubtitle').textContent = result.waitingForInterviewer
    ? 'Your microphone preflight passed. The interview has not started yet.'
    : 'Keep this window open and continue your interview normally.';
  setTaviGuidance('sessionGuide', result.waitingForInterviewer
    ? "Your microphone is open for preflight; transcription hasn't started. Wait for your interviewer."
    : 'Keep Secure open and use your normal calling app.');
  updateAudioUi({ status: result.waitingForInterviewer ? 'Microphone ready - waiting for interviewer' : 'Starting' });
  if (!result.waitingForInterviewer) beginActiveInterview();
  resetStartButton();
}

function beginActiveInterview() {
  if (interviewStarted || sessionEnding || !activeConnection) return;
  interviewStarted = true;
  $('pairBrowserBtn').disabled = !browserSharingPermitted;
  sessionStart = Date.now();
  $('displayName').textContent = activeConnection.candidateName || $('candidateNameInput').value.trim();
  $('connectionState').textContent = 'Secure';
  $('activeTitle').textContent = 'Session active';
  $('activeSubtitle').textContent = 'Keep this window open and continue your interview normally.';
  setTaviGuidance('sessionGuide', 'Keep Secure open and use your normal calling app.');
  if (browserSharingPermitted) setTaviGuidance('browserGuide', 'To share a prepared interview window, start with Open extension folder.');
  setStatus('active', 'Monitoring');
  startTimer();
  startTranscriptStreaming();
}

function resetStartButton() {
  joiningSession = false;
  $('microphoneInput').disabled = false;
  $('refreshMicrophonesBtn').disabled = false;
  startBtn.disabled = false;
  startBtn.textContent = 'Join interview';
  $('cancelJoinBtn').hidden = true;
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
  if (status) liveCaptionStatus = status;
  if (demoSpeechUnavailable) {
    const retry = liveReconnectTimer ? ` - retrying in ${Math.max(1, Math.ceil((liveRetryAt - Date.now()) / 1000))}s`
      : liveTokenPending ? ' - waiting for the pending request to finish' : '';
    status = `Live captions unavailable - ${liveCaptionFailure?.message || 'speech connection unavailable'}${retry}`;
  } else {
    status = liveCaptionStatus || (audioFallbackActive ? 'Backup transcription - slower updates' : 'Listening');
  }
  $('retrySpeechBtn').disabled = liveTokenPending || Boolean(liveReconnectTimer);
  const level = Math.max(0, Math.min(1, rms * 4));
  if (micLevelFill) micLevelFill.style.width = `${Math.round(level * 100)}%`;
  if (micLevelLabel) micLevelLabel.textContent = `${Math.round(level * 100)}%`;
  const count = audioFallbackActive ? audioFallbackChunks : transcriptCount;
  if (audioStateEl) audioStateEl.textContent = status || (audioFallbackActive ? 'Backup transcription - slower updates' : 'Listening');
  if (audioChunkCountEl) audioChunkCountEl.textContent = String(count);
  if (uploadStatusEl) {
    if (demoSpeechUnavailable) {
      uploadStatusEl.textContent = activeConnection?.directSpeechOnly
        ? 'No audio is being sent. Backup audio uploads are unavailable for this connection.'
        : 'No audio is being sent while the speech connection recovers.';
      uploadStatusEl.className = 'audio-status error';
    } else if (audioFallbackActive) {
      uploadStatusEl.textContent = pendingAudioUploads
        ? `${pendingAudioUploads} voice segment${pendingAudioUploads === 1 ? '' : 's'} syncing`
        : 'Backup transcription - updates take several seconds';
      uploadStatusEl.className = pendingAudioUploads ? 'audio-status busy' : 'audio-status ok';
    } else {
      uploadStatusEl.textContent = transcriptFailures
        ? `${transcriptFailures} transcript send issue${transcriptFailures === 1 ? '' : 's'} detected`
        : pcmWorklet && liveStreamReady ? 'Live speech connection active' : 'No audio is being sent.';
      uploadStatusEl.className = transcriptFailures ? 'audio-status error' : pcmWorklet && liveStreamReady ? 'audio-status ok' : 'audio-status busy';
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
    const sampledAt = Date.now();
    liveEnergySamples.push({ at: sampledAt, rms: lastRms, peak: lastPeak });
    while (liveEnergySamples.length > 1000 || liveEnergySamples[0]?.at < sampledAt - 120000) liveEnergySamples.shift();
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
      window.truveil.sendAudioLevel({ rms: lastRms, peak: lastPeak, timestamp: Date.now() }).catch(() => {});
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
  if ((!cleanText && !metadata.captionClear) || sessionEnding) return;
  pendingInterim = { text: cleanText, metadata };
  if (!metadata.captionClear && lastInterimSentAt && now - lastInterimSentAt < 100) {
    if (!interimSendTimer) interimSendTimer = setTimeout(() => {
      interimSendTimer = null;
      const latest = pendingInterim;
      pendingInterim = null;
      if (latest && !sessionEnding) relayInterimTranscript(latest.text, latest.metadata);
    }, Math.max(1, 100 - (now - lastInterimSentAt)));
    return;
  }
  cancelPendingInterim();
  relayInterimTranscript(cleanText, metadata);
}

function cancelPendingInterim() {
  clearTimeout(interimSendTimer);
  interimSendTimer = null;
  pendingInterim = null;
}

function relayInterimTranscript(cleanText, metadata) {
  if (sessionEnding) return;
  const now = Date.now();
  lastInterimSentAt = now;
  lastInterimText = cleanText;
  window.truveil.sendTranscript({
    text: cleanText,
    timestamp: now,
    durationMs: Number(metadata.durationMs) || 0,
    sequence: transcriptSequence,
    source: 'deepgram-nova-3-direct',
    interim: true,
    captionClear: metadata.captionClear === true,
    streamEpoch: Number.isFinite(Number(metadata.streamEpoch)) ? Number(metadata.streamEpoch) : liveStreamEpoch,
    utteranceId: Number.isFinite(Number(metadata.utteranceId)) ? Number(metadata.utteranceId) : liveUtteranceId,
    segmentId: metadata.segmentId || `live-${liveStreamEpoch}-${liveUtteranceId}`,
    revision: Number(metadata.revision) || 0,
    transcriptConfidence: metadata.confidence,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    wordCount: metadata.wordCount,
    lowConfidenceWordRatio: metadata.lowConfidenceWordRatio,
    confidenceKnown: metadata.confidenceKnown === true,
    qualityReason: metadata.qualityReason,
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
    if (sessionEnding) return;
    const result = await window.truveil.uploadAudioChunk({
      arrayBuffer,
      mimeType: blob.type || mediaRecorder?.mimeType || 'audio/webm;codecs=opus',
      sequence,
      durationMs: Math.max(0, stats.endedAt - startedAt),
      startedAt,
      endedAt: stats.endedAt,
      rms: stats.rms ?? lastRms,
      peak: stats.peak ?? lastPeak,
      timestamp: stats.endedAt
    });
    if (sessionEnding) return;
    if (!result?.ok) throw new Error(result?.error || 'Audio upload failed');
    if (!result.skipped) audioFallbackChunks++;
    updateAudioUi({ status: 'Segment sent' });
  } catch (err) {
    if (sessionEnding) return;
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
    if (!sessionEnding) updateAudioUi();
  }
}

function startAudioFallback(reason = 'cloud transcription primary') {
  if (audioFallbackActive || sessionEnding) return;
  if (activeConnection?.directSpeechOnly) {
    stopLiveTranscription();
    demoSpeechUnavailable = true;
    liveCaptionFailure ||= { code: 'SPEECH_UNAVAILABLE', message: 'speech connection unavailable' };
    $('retrySpeechBtn').hidden = false;
    $('captionState').textContent = 'Live captions unavailable';
    setTaviGuidance('sessionGuide', 'Live captions are unavailable. Check Voice health for the issue and retry option.');
    updateAudioUi();
    return;
  }
  if (!window.MediaRecorder || !window.truveil.uploadAudioChunk) {
    logEvent('Voice fallback unavailable in this build', 'warn', { visible: false });
    updateAudioUi({ status: 'Transcript unavailable' });
    setTaviGuidance('sessionGuide', 'Captions are unavailable. Let your interviewer know.');
    return;
  }

  audioFallbackActive = true;
  demoSpeechUnavailable = false;
  liveCaptionFailure = null;
  flushLiveFinal('fallback');
  stopLiveTranscription();
  audioFallbackSequence = 0;
  audioFallbackChunks = 0;
  pendingAudioUploads = 0;

  lastAudioChunkAt = Date.now();

  logEvent(`Voice fallback started: ${reason}`, 'info', { visible: false });
  updateAudioUi({ status: 'Voice relay active' });
  $('captionState').textContent = 'Backup transcription - slower updates';
  setTaviGuidance('sessionGuide', 'Captions are using slower backup updates. Keep Secure open.');
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
        uploadFallbackAudioBlob(blob, sequence, startedAt, { rms, peak, endedAt: segmentStats.endedAt || Date.now() });
      } else {
        updateAudioUi({ status: 'Mic live - no speech detected' });
      }
    }
    if (mediaRecorder === recorder) mediaRecorder = null;
    if (audioFallbackActive && !sessionEnding) {
      // Restart immediately; a deliberate delay clips speech between recordings.
      startFallbackRecorderSegment();
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
          segmentStats.endedAt = Date.now();
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
    if (sessionEnding || audioFallbackActive || !sessionStart || liveTokenPending || liveReconnectTimer || demoSpeechUnavailable) return;
    const now = Date.now();
    const sessionOldEnough = now - Math.max(sessionStart, liveAttemptStartedAt) > 9000;
    const heardSpeechRecently = now - lastSpeechLevelAt < 8000;
    const progressAt = Math.max(lastFinalTranscriptAt, lastProviderResultAt);
    const transcriptStale = !progressAt || now - progressAt > 9000;
    if (sessionOldEnough && heardSpeechRecently && transcriptStale) {
      failLiveTranscription('TRANSCRIPT_STALLED');
    }
  }, 5000);
}

function startTranscriptStreaming() {
  stopLiveTranscription();
  liveReconnectAttempts = 0;
  demoSpeechUnavailable = false;
  liveCaptionFailure = null;
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
  cancelPendingInterim();
  lastProviderResultAt = 0;
  liveCaptionRevision = 0;
  liveFinalEndSeconds = -1;
  liveLatestResultEnd = -1;
  liveEnergySamples = [];
  resetCaptions();
  liveFinalSegments = [];
  liveFinalKeys.clear();
  liveAudioStartedAt = 0;
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
  void startLiveTranscription().catch(() => failLiveTranscription('WS_CONNECT_FAILED'));
  startTranscriptWatchdog();
}

function stopLiveTranscription() {
  cancelPendingInterim();
  liveConnectionGeneration++;
  liveStreamReady = false;
  clearTimeout(liveReconnectTimer);
  liveReconnectTimer = null;
  liveRetryAt = 0;
  clearTimeout(liveStartupTimer);
  liveStartupTimer = null;
  liveAttemptStartedAt = 0;
  liveCaptionStatus = '';
  clearInterval(liveKeepAliveTimer);
  liveKeepAliveTimer = null;
  if (pcmWorklet) pcmWorklet.port.onmessage = null;
  try { pcmWorklet?.disconnect(); } catch {}
  try { pcmSource?.disconnect(); } catch {}
  try { pcmSilentGain?.disconnect(); } catch {}
  pcmWorklet = null;
  pcmSource = null;
  pcmSilentGain = null;
  try {
    if (liveTranscriptionSocket) {
      liveTranscriptionSocket.onopen = null;
      liveTranscriptionSocket.onmessage = null;
      liveTranscriptionSocket.onerror = null;
      liveTranscriptionSocket.onclose = null;
    }
    liveTranscriptionSocket?.close();
  } catch {}
  liveTranscriptionSocket = null;
}

function publishLiveTranscript(message = {}) {
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  if ((!text && !message.captionClear) || sessionEnding) return;
  lastSpeechLevelAt = Date.now();
  if (message.interim) {
    sendInterimTranscript(text, message);
    updateAudioUi({ status: 'Transcribing live' });
    return;
  }
  cancelPendingInterim();
  lastFinalTranscriptAt = Date.now();
  const payload = {
    text,
    timestamp: message.timestamp || Date.now(),
    durationMs: Number(message.durationMs) || 0,
    sequence: transcriptSequence++,
    source: message.source || 'deepgram-nova-3-live',
    segmentId: message.segmentId || `live-${transcriptSequence}`,
    revision: Number(message.revision) || 0,
    streamEpoch: Number.isFinite(Number(message.streamEpoch)) ? Number(message.streamEpoch) : liveStreamEpoch,
    utteranceId: Number.isFinite(Number(message.utteranceId)) ? Number(message.utteranceId) : liveUtteranceId,
    finalReason: message.finalReason || 'speech_final',
    transcriptConfidence: message.confidence,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
    wordCount: message.wordCount,
    lowConfidenceWordRatio: message.lowConfidenceWordRatio,
    confidenceKnown: message.confidenceKnown === true,
    qualityReason: message.qualityReason,
    rms: message.rms,
    peak: message.peak
  };
  relayFinalTranscript(payload);
}

function relayFinalTranscript(payload, attempt = 1) {
  if (sessionEnding) return;
  return window.truveil.sendTranscript(payload).then(result => {
    if (sessionEnding) return;
    if (!result?.ok) throw new Error(result?.error || 'Transcript send failed');
    if (result.skipped) {
      updateAudioUi({ status: result.reason === 'low-confidence' ? 'Speech unclear - still listening' : 'Listening' });
      return;
    }
    transcriptCount++;
    transcriptFailures = 0;
    updateAudioUi({ status: 'Live transcript sent' });
  }).catch(err => {
    if (sessionEnding) return;
    transcriptFailures++;
    logEvent(`Live transcript relay failed: ${err.message}`, 'warn', { visible: false });
    if (attempt < 3 && finalRelayRetries.size < 64) {
      const timer = setTimeout(() => {
        finalRelayRetries.delete(timer);
        return relayFinalTranscript(payload, attempt + 1);
      }, 500 * attempt);
      finalRelayRetries.add(timer);
      updateAudioUi({ status: 'Retrying confirmed speech' });
    } else {
      updateAudioUi({ status: 'Transcript gap - check your connection' });
    }
  });
}

function validConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function capturedSpeechEnergy(startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return { qualityReason: 'missing-audio-energy' };
  // Meter samples describe capture time, never the (possibly delayed) STT arrival.
  const samples = liveEnergySamples.filter(sample => sample.at >= startedAt - 160 && sample.at <= endedAt + 160);
  if (!samples.length) return { qualityReason: 'missing-audio-energy' };
  return { rms: Math.max(...samples.map(sample => sample.rms)), peak: Math.max(...samples.map(sample => sample.peak)) };
}

function summarizeLiveSegments(segments, audioStartedAt) {
  const text = segments.map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  const scores = [];
  const wordScores = [];
  const starts = [];
  const ends = [];
  let count = 0;
  let timingKnown = true;
  for (const segment of segments) {
    const words = Array.isArray(segment.words) ? segment.words : [];
    const size = words.length || wordCount(segment.text);
    count += size;
    if (words.length) {
      for (const word of words) if (validConfidence(word.confidence)) {
        scores.push(word.confidence);
        wordScores.push(word.confidence);
      }
    } else if (validConfidence(segment.confidence)) {
      for (let i = 0; i < size; i++) scores.push(segment.confidence);
    }
    const timedWords = words.filter(word => Number.isFinite(word.start) && word.start >= 0 && Number.isFinite(word.end) && word.end >= word.start);
    if (words.length && timedWords.length === words.length) {
      starts.push(...timedWords.map(word => word.start));
      ends.push(...timedWords.map(word => word.end));
    } else if (Number.isFinite(segment.start) && segment.start >= 0 && Number.isFinite(segment.duration) && segment.duration >= 0) {
      starts.push(segment.start);
      ends.push(segment.start + segment.duration);
    } else {
      timingKnown = false;
    }
  }
  const confidenceKnown = count > 0 && scores.length === count;
  const confidence = confidenceKnown ? scores.reduce((sum, value) => sum + value, 0) / count : undefined;
  const hasTiming = timingKnown && starts.length > 0;
  const startedAt = hasTiming && audioStartedAt > 0 ? Math.round(audioStartedAt + Math.min(...starts) * 1000) : undefined;
  const endedAt = hasTiming && audioStartedAt > 0 ? Math.round(audioStartedAt + Math.max(...ends) * 1000) : undefined;
  return {
    text, confidence, confidenceKnown, wordCount: count,
    lowConfidenceWordRatio: count > 0 && wordScores.length === count ? wordScores.filter(value => value < 0.55).length / count : undefined,
    qualityReason: confidenceKnown ? (confidence < 0.58 ? 'low-confidence' : null) : 'missing-confidence',
    startedAt, endedAt,
    endSeconds: hasTiming ? Math.max(...ends) : undefined,
    durationMs: hasTiming ? Math.round((Math.max(...ends) - Math.min(...starts)) * 1000) : 0
  };
}

function flushLiveFinal(finalReason = 'speech_final') {
  // Stable spans were already sent. A boundary only discards the revisable tail.
  publishLiveTranscript({
    text: '',
    interim: true,
    captionClear: true,
    source: 'deepgram-nova-3-direct',
    segmentId: `live-${liveStreamEpoch}-boundary-${liveUtteranceId}`,
    revision: ++liveCaptionRevision,
    streamEpoch: liveStreamEpoch,
    utteranceId: liveUtteranceId,
    finalReason
  });
  liveUtteranceId++;
  liveFinalSegments = [];
  lastInterimText = '';
  lastInterimSentAt = 0;
  liveSegmentMaxRms = 0;
  liveSegmentMaxPeak = 0;
}

async function startPcmStream() {
  if (!liveTranscriptionSocket || liveTranscriptionSocket.readyState !== WebSocket.OPEN || !audioStream || !audioContext) return;
  const context = audioContext;
  const socket = liveTranscriptionSocket;
  const generation = liveConnectionGeneration;
  await context.audioWorklet.addModule('../audio/pcm-worklet.js');
  if (sessionEnding || generation !== liveConnectionGeneration || audioContext !== context || liveTranscriptionSocket !== socket || !audioStream) return;
  pcmSource = audioContext.createMediaStreamSource(audioStream);
  pcmWorklet = new AudioWorkletNode(audioContext, 'truveil-pcm-processor', {
    processorOptions: { targetRate: 16000 }
  });
  pcmSilentGain = audioContext.createGain();
  pcmSilentGain.gain.value = 0;
  liveAudioStartedAt = Date.now();
  pcmWorklet.port.onmessage = event => {
    if (sessionEnding || generation !== liveConnectionGeneration || liveTranscriptionSocket !== socket || socket.readyState !== WebSocket.OPEN || !event.data) return;
    // One second of queued PCM means the link cannot keep up. Do not grow a stale audio queue.
    if (socket.bufferedAmount > 32000) {
      updateAudioUi({ status: 'Live transcript delayed - reconnecting' });
      socket.close();
      return;
    }
    try { socket.send(event.data); } catch { socket.close(); }
  };
  pcmSource.connect(pcmWorklet);
  pcmWorklet.connect(pcmSilentGain);
  pcmSilentGain.connect(audioContext.destination);
}

function transcriptionKeyterms(vocabulary) {
  const terms = [];
  const seen = new Set();
  const encoder = new TextEncoder();
  let bytes = 0;
  // A conservative UTF-8 budget leaves headroom under the provider's token cap.
  for (const value of ['Truveil', ...(Array.isArray(vocabulary) ? vocabulary.slice(0, 100) : [])]) {
    if (typeof value !== 'string') continue;
    const term = value.normalize('NFC').replace(/\s+/g, ' ').trim();
    const key = term.toLowerCase();
    const size = encoder.encode(term).length + 1;
    if (!term || term.length > 80 || /[\u0000-\u001f\u007f]/.test(term) || seen.has(key) || bytes + size > 320) continue;
    terms.push(term);
    seen.add(key);
    bytes += size;
    if (terms.length === 30) break;
  }
  return terms;
}

function liveGrantDelay() {
  const now = Date.now();
  liveGrantRequests = liveGrantRequests.filter(request => now - request.at < LIVE_GRANT_WINDOW_MS);
  return Math.max(0,
    liveLastGrantAt === null ? 0 : liveLastGrantAt + LIVE_GRANT_COOLDOWN_MS - now,
    liveGrantRequests.length < 3 ? 0 : liveGrantRequests.at(-3).at + LIVE_GRANT_WINDOW_MS - now);
}

function scheduleLiveTranscriptionRetry(delay) {
  if (sessionEnding || audioFallbackActive || !activeConnection || liveReconnectTimer) return;
  const generation = liveConnectionGeneration;
  const owner = activeConnection;
  liveRetryAt = Date.now() + delay;
  demoSpeechUnavailable = true;
  $('captionState').textContent = 'Live captions unavailable';
  setTaviGuidance('sessionGuide', 'Live captions are unavailable while the connection retries. Keep Secure open.');
  $('retrySpeechBtn').hidden = false;
  liveReconnectTimer = setTimeout(() => {
    if (sessionEnding || activeConnection !== owner || generation !== liveConnectionGeneration) return;
    liveReconnectTimer = null;
    liveRetryAt = 0;
    return startLiveTranscription().catch(() => {
      if (!sessionEnding && activeConnection === owner) failLiveTranscription('WS_CONNECT_FAILED');
    });
  }, delay);
  updateAudioUi();
}

function failLiveTranscription(code, { retryable = true, closeCode, waitMs = 0 } = {}) {
  if (sessionEnding || !activeConnection) return;
  const messages = {
    GRANT_UNAVAILABLE: 'speech authorization service unavailable',
    GRANT_TIMEOUT: 'speech authorization timed out',
    GRANT_THROTTLED: 'speech authorization is temporarily limited',
    GRANT_NOT_CONFIGURED: 'speech service is not configured',
    GRANT_BUDGET_EXHAUSTED: 'speech authorization limit reached',
    SESSION_NOT_ACTIVE: 'waiting for an active interview',
    PROVIDER_ERROR: 'speech service reported an error',
    WS_CONNECT_FAILED: 'speech connection could not start',
    WS_CONNECT_TIMEOUT: 'speech connection timed out',
    WS_CLOSED: 'speech connection closed',
    PCM_START_FAILED: 'microphone streaming could not start',
    TRANSCRIPT_STALLED: 'speech recognition stopped responding'
  };
  const safeCloseCode = Number.isInteger(closeCode) &&
    [1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015].includes(closeCode) ? closeCode : null;
  liveCaptionFailure = { code, message: (messages[code] || 'speech connection unavailable') + (safeCloseCode ? ` (${safeCloseCode})` : '') };
  flushLiveFinal('stream_disconnected');
  stopLiveTranscription();
  liveReconnectAttempts++;
  liveStreamEpoch++;
  liveUtteranceId = 0;
  liveFinalSegments = [];
  liveFinalKeys.clear();
  liveFinalEndSeconds = -1;
  liveLatestResultEnd = -1;
  liveAudioStartedAt = 0;
  lastInterimText = '';
  liveSegmentMaxRms = 0;
  liveSegmentMaxPeak = 0;
  if (retryable && liveReconnectAttempts <= LIVE_MAX_RETRIES) {
    scheduleLiveTranscriptionRetry(Math.max(900 * liveReconnectAttempts, liveGrantDelay(), waitMs));
  } else {
    startAudioFallback(code);
  }
}

async function startLiveTranscription() {
  if (sessionEnding || audioFallbackActive || !activeConnection || liveTokenPending || liveReconnectTimer || liveTranscriptionSocket) return;
  if (!window.truveil.getTranscriptionToken) {
    failLiveTranscription('GRANT_NOT_CONFIGURED', { retryable: false });
    return;
  }
  const delay = liveGrantDelay();
  if (delay) {
    scheduleLiveTranscriptionRetry(delay);
    return;
  }

  stopLiveTranscription();
  demoSpeechUnavailable = false;
  $('retrySpeechBtn').hidden = true;
  $('captionState').textContent = liveReconnectAttempts ? 'Reconnecting' : 'Connecting';
  setTaviGuidance('sessionGuide', 'Captions are connecting. Keep Secure open.');
  const generation = liveConnectionGeneration;
  const owner = activeConnection;
  liveAttemptStartedAt = Date.now();
  liveTokenPending = true;
  updateAudioUi({ status: liveReconnectAttempts ? 'Reconnecting live transcript' : 'Connecting live transcript' });
  const request = { at: Date.now() };
  liveGrantRequests.push(request);
  liveStartupTimer = setTimeout(() => {
    if (!sessionEnding && activeConnection === owner && generation === liveConnectionGeneration && liveTokenPending) {
      failLiveTranscription('GRANT_TIMEOUT', { retryable: false });
    }
  }, 12000);
  let tokenResult;
  try {
    tokenResult = await window.truveil.getTranscriptionToken();
  } catch (error) {
    tokenResult = { ok: false, error: error?.message };
  } finally {
    // The relay reserved its grant before this response, so settlement is a conservative cooldown anchor.
    request.at = Date.now();
    liveLastGrantAt = request.at;
    liveTokenPending = false;
  }
  if (sessionEnding || audioFallbackActive || !activeConnection || generation !== liveConnectionGeneration) {
    if (!sessionEnding && activeConnection && !audioFallbackActive) {
      if (demoSpeechUnavailable) updateAudioUi();
      else if (interviewStarted) scheduleLiveTranscriptionRetry(liveGrantDelay());
    }
    return;
  }
  clearTimeout(liveStartupTimer);
  liveStartupTimer = null;
  if (!tokenResult?.ok || typeof tokenResult.accessToken !== 'string' || !tokenResult.accessToken || tokenResult.accessToken.length > 8192) {
    const error = typeof tokenResult?.error === 'string' ? tokenResult.error.toLowerCase() : '';
    if (/not configured|unavailable in this build/.test(error)) failLiveTranscription('GRANT_NOT_CONFIGURED', { retryable: false });
    else if (/exhausted|lifetime/.test(error)) failLiveTranscription('GRANT_BUDGET_EXHAUSTED', { retryable: false });
    else if (/wait for|ended|active.*required|closed/.test(error)) failLiveTranscription('SESSION_NOT_ACTIVE', { retryable: false });
    else if (/throttled|budget|limit/.test(error)) failLiveTranscription('GRANT_THROTTLED', { waitMs: LIVE_GRANT_WINDOW_MS });
    else failLiveTranscription('GRANT_UNAVAILABLE');
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
    mip_opt_out: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true'
  });
  transcriptionKeyterms(activeConnection.technicalVocabulary).forEach(term => params.append('keyterm', term));
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  try {
    liveTranscriptionSocket = new WebSocket(url, ['bearer', tokenResult.accessToken]);
    liveTranscriptionSocket.binaryType = 'arraybuffer';
  } catch {
    failLiveTranscription('WS_CONNECT_FAILED');
    return;
  }

  const socket = liveTranscriptionSocket;
  const isCurrent = () => !sessionEnding && !audioFallbackActive && liveTranscriptionSocket === socket && generation === liveConnectionGeneration;
  liveStartupTimer = setTimeout(() => {
    if (isCurrent()) failLiveTranscription('WS_CONNECT_TIMEOUT');
  }, 12000);
  socket.onopen = () => {
    if (!isCurrent()) return;
    liveStreamReady = true;
    liveAttemptStartedAt = Date.now();
    clearTimeout(liveStartupTimer);
    liveStartupTimer = setTimeout(() => {
      if (isCurrent()) failLiveTranscription('PCM_START_FAILED', { retryable: false });
    }, 12000);
    updateAudioUi({ status: 'Live transcript connected' });
    startPcmStream().then(() => {
      if (!isCurrent()) return;
      clearTimeout(liveStartupTimer);
      liveStartupTimer = null;
      if (['Connecting', 'Reconnecting'].includes($('captionState').textContent)) $('captionState').textContent = 'Listening';
      setTaviGuidance('sessionGuide', 'Keep Secure open and use your normal calling app.');
      updateAudioUi();
    }).catch(() => {
      if (!isCurrent()) return;
      failLiveTranscription('PCM_START_FAILED', { retryable: false });
    });
    liveKeepAliveTimer = setInterval(() => {
      if (isCurrent() && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'KeepAlive' })); }
        catch { if (isCurrent()) failLiveTranscription('WS_CONNECT_FAILED'); }
      }
    }, 4000);
  };
  socket.onmessage = event => {
    if (!isCurrent()) return;
    try {
      const message = JSON.parse(String(event.data || '{}'));
      if (message.type === 'Error') {
        failLiveTranscription('PROVIDER_ERROR');
        return;
      }
      if (message.type === 'SpeechStarted') {
        updateAudioUi({ status: 'Hearing speech' });
        return;
      }
      if (message.type === 'UtteranceEnd') {
        if (Number(message.last_word_end) === -1) return;
        if (!Number.isFinite(message.last_word_end) || message.last_word_end + 0.001 < liveLatestResultEnd) return;
        flushLiveFinal('utterance_end');
        return;
      }
      const alternative = message.channel?.alternatives?.[0];
      const text = String(alternative?.transcript || '').replace(/\s+/g, ' ').trim();
      if (message.type !== 'Results' || !alternative) return;
      const hasRange = Number.isFinite(message.start) && message.start >= 0 && Number.isFinite(message.duration) && message.duration >= 0;
      const rangeEnd = hasRange ? message.start + message.duration : undefined;
      // Provider ranges identify retransmissions; text equality does not identify speech.
      const key = Number.isFinite(message.start) && Number.isFinite(message.duration)
        ? `${message.start}:${message.duration}` : null;
      if (text && message.is_final && key && liveFinalKeys.has(key)) return;
      if (!message.is_final && !message.speech_final && hasRange && rangeEnd <= liveFinalEndSeconds + 0.001) return;
      if (text) {
        lastProviderResultAt = Date.now();
        liveReconnectAttempts = 0;
        liveCaptionFailure = null;
      }
      const wordEnds = (Array.isArray(alternative.words) ? alternative.words : [])
        .filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start).map(word => word.end);
      const recognizedEnd = wordEnds.length ? Math.max(...wordEnds) : rangeEnd;
      if (text && Number.isFinite(recognizedEnd)) liveLatestResultEnd = Math.max(liveLatestResultEnd, recognizedEnd);
      if (text && message.is_final) {
        if (key) {
          liveFinalKeys.add(key);
          if (liveFinalKeys.size > 256) liveFinalKeys.delete(liveFinalKeys.values().next().value);
        }
        const summary = summarizeLiveSegments([{ text, confidence: alternative.confidence, words: alternative.words, start: message.start, duration: message.duration }], liveAudioStartedAt);
        const energy = capturedSpeechEnergy(summary.startedAt, summary.endedAt);
        publishLiveTranscript({
          ...summary, ...energy, qualityReason: summary.qualityReason || energy.qualityReason,
          interim: false, source: 'deepgram-nova-3-direct',
          segmentId: `live-${liveStreamEpoch}-${key || `untimed-${liveCaptionRevision + 1}`}`,
          revision: ++liveCaptionRevision, streamEpoch: liveStreamEpoch, utteranceId: liveUtteranceId,
          finalReason: message.speech_final ? 'speech_final' : 'segment_final',
          timestamp: summary.endedAt || Date.now()
        });
        if (hasRange) liveFinalEndSeconds = Math.max(liveFinalEndSeconds, rangeEnd);
        lastFinalTranscriptAt = Date.now();
        liveSegmentMaxRms = 0;
        liveSegmentMaxPeak = 0;
      }
      if (message.speech_final) {
        flushLiveFinal('speech_final');
        return;
      }
      if (message.is_final || (hasRange && rangeEnd <= liveFinalEndSeconds + 0.001)) return;
      const summary = summarizeLiveSegments([{ text, confidence: alternative.confidence, words: alternative.words, start: message.start, duration: message.duration }], liveAudioStartedAt);
      publishLiveTranscript({
        ...summary,
        interim: true,
        source: 'deepgram-nova-3-direct',
        captionClear: !summary.text,
        segmentId: `live-${liveStreamEpoch}-draft-${message.start ?? liveUtteranceId}`,
        revision: ++liveCaptionRevision,
        streamEpoch: liveStreamEpoch,
        utteranceId: liveUtteranceId
      });
    } catch {}
  };
  socket.onerror = () => { if (isCurrent()) failLiveTranscription('WS_CONNECT_FAILED'); };
  socket.onclose = event => {
    if (!isCurrent()) return;
    failLiveTranscription('WS_CLOSED', { closeCode: event?.code });
  };
}

function stopTranscriptStreaming() {
  stopLiveTranscription();
  demoSpeechUnavailable = false;
  liveCaptionFailure = null;
  $('retrySpeechBtn').hidden = true;
  for (const timer of finalRelayRetries) clearTimeout(timer);
  finalRelayRetries.clear();
  liveEnergySamples = [];
  $('captionDraft').textContent = '';
  $('captionState').textContent = 'Stopped';
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
  transcriptBuffer = [];
  transcriptBufferStartedAt = 0;
  clearInterval(transcriptWatchdogTimer);
  transcriptWatchdogTimer = null;
  if (audioLevelTimer) clearInterval(audioLevelTimer);
  audioLevelTimer = null;
  try { audioContext?.close().catch(() => {}); } catch {}
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
  const message = document.createElement('span');
  message.textContent = text;
  const time = document.createElement('span');
  time.className = 'ff-time';
  time.textContent = fmtTime(Date.now());
  el.appendChild(message);
  el.appendChild(time);
  feed.prepend(el);
}

function renderPolicy(policy = {}) {
  const blocked = Array.isArray(policy.blocked_sites) ? policy.blocked_sites : [];
  const summary = $('policySummary');
  const text = $('blockedSitesText');
  if (!summary || !text) return;

  if (policy.blocking_mode === 'none' || !blocked.length) {
    text.textContent = 'All apps and websites are allowed for this interview.';
  } else {
    const label = blocked.length === 1 ? 'Restricted destination' : 'Restricted destinations';
    text.textContent = `${label}: ${blocked.slice(0, 8).join(', ')}${blocked.length > 8 ? ', and more' : ''}.`;
  }
  summary.hidden = false;
}

async function finishSession(message, { disconnected = false } = {}) {
  if (sessionEnding) return;
  sessionEnding = true;
  clearInterval(timerInterval);
  stopTranscriptStreaming();
  stopAudio();
  sessionStart = null;
  pendingSessionStart = false;
  browserSharingPermitted = false;
  $('browserPairingCode').value = '';
  $('browserPairing').hidden = true;
  $('pairBrowserBtn').disabled = true;
  $('stopBrowserBtn').disabled = true;
  setStatus(disconnected ? 'warn' : null, disconnected ? 'Disconnected' : 'Complete');
  $('endedBadge').textContent = disconnected ? 'SESSION DISCONNECTED' : 'SESSION ENDED';
  $('endedTitle').textContent = disconnected ? 'Connection lost' : 'Thank you';
  setTaviGuidance('endedDescription', disconnected
    ? 'Your microphone and local monitoring have stopped. Contact your interviewer before rejoining.'
    : 'Your microphone and local monitoring have stopped. You can close this window now.');
  if (message) toast(message, 'info');
  showScreen('ended');
}

window.truveil.onTranscriptCaption?.(renderCaption);

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
  setStatus('warn', 'Restricted activity observed');
});

window.truveil.onSessionPolicyUpdated((policy = {}) => {
  renderPolicy(policy);
  logEvent('Interview policy synced', 'info', { visible: false });
});

window.truveil.onRemoteSessionEnded(() => {
  finishSession('Your recruiter ended the session.');
});

window.truveil.onSessionStarted(() => {
  if (joiningSession && !sessionEnding) pendingSessionStart = true;
  beginActiveInterview();
});

window.truveil.onSessionDisconnected(() => {
  finishSession('The session connection was lost. Local capture has stopped.', { disconnected: true });
});

window.truveil.onInviteCode((code) => {
  if (!code || activeConnection) return;
  sessionCodeInput.value = sessionPresentation.displayCode(code);
  sessionCodeInput.dispatchEvent(new Event('input'));
  sessionCodeInput.focus();
  toast(`Session code ${sessionPresentation.displayCode(code)} loaded from your invite.`, 'info');
});

window.truveil.onDemoInvite?.(invite => {
  if (activeConnection || joiningSession || !invite?.relayUrl) return;
  $('demoRelayInput').value = sessionPresentation.serverAddress(invite.relayUrl);
});

for (const id of ['sessionConsentInput','externalReviewConsentInput','tabObserveConsentInput','tabCloseConsentInput']) {
  $(id).addEventListener('change', async () => {
    if (id === 'tabObserveConsentInput') {
      $('tabCloseConsentInput').disabled = !$('tabObserveConsentInput').checked;
      if (!$('tabObserveConsentInput').checked) $('tabCloseConsentInput').checked = false;
    }
    if (joiningSession && !$(id).checked) {
      await finishSession('Permission withdrawn. Joining cancelled and local capture stopped.');
      await window.truveil.endSession().catch(() => {});
    }
  });
}
$('cancelJoinBtn').addEventListener('click', async () => {
  if (!joiningSession) return;
  await finishSession('Joining cancelled. Local capture has stopped.');
  await window.truveil.endSession().catch(() => {});
});
$('retrySpeechBtn').addEventListener('click', () => {
  if (!interviewStarted || sessionEnding || !activeConnection?.directSpeechOnly || liveTokenPending || liveReconnectTimer || liveTranscriptionSocket) return;
  liveReconnectAttempts = 0;
  void startLiveTranscription().catch(() => failLiveTranscription('WS_CONNECT_FAILED'));
});
$('openExtensionBtn').addEventListener('click', () => {
  window.truveil.openBrowserExtension().then(() => {
    if (sessionEnding || !browserSharingPermitted) return;
    setTaviGuidance('browserGuide', 'In Chrome or Edge Extensions, enable Developer mode and Load unpacked with this folder. Then choose Connect browser here.');
  }).catch(error => toast(error.message, 'error'));
});
$('pairBrowserBtn').addEventListener('click', async () => {
  if (!interviewStarted || sessionEnding || !browserSharingPermitted) return;
  const button = $('pairBrowserBtn');
  let issued = false;
  button.disabled = true;
  try {
    const info = await window.truveil.pairBrowser();
    if (sessionEnding || !browserSharingPermitted) return;
    $('browserPairingCode').value = info.pairingCode;
    issued = true;
    $('browserPairing').hidden = false;
    $('stopBrowserBtn').disabled = false;
    $('browserState').textContent = 'Waiting for the extension. Pair only your dedicated interview browser window.';
    setTaviGuidance('browserGuide', "In your interview window without personal tabs, open Truveil's extension. Paste the code, review permissions, then choose Share this window.");
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = issued || sessionEnding || !browserSharingPermitted; }
});
$('copyPairingBtn').addEventListener('click', async () => {
  try { await window.truveil.copyBrowserPairing(); toast('Pairing code copied. Keep it private.'); }
  catch (error) { toast(error.message, 'error'); }
});
$('stopBrowserBtn').addEventListener('click', async () => {
  browserSharingPermitted = false;
  $('pairBrowserBtn').disabled = true;
  $('browserPairingCode').value = '';
  $('browserPairing').hidden = true;
  try {
    await window.truveil.stopBrowserSharing();
    if (sessionEnding || taviBrowserPhase === 'unshared') return;
    $('browserState').textContent = 'Sharing stopped. Join a new session to grant permission again.';
    taviBrowserPhase = 'unshared';
    setTaviGuidance('browserGuide', 'Your browser window is no longer shared. Continue in your normal calling app.');
  }
  catch {
    if (sessionEnding || taviBrowserPhase === 'unshared') return;
    $('browserState').textContent = 'Could not confirm sharing stopped. End the session now.';
    setTaviGuidance('browserGuide', 'I could not confirm sharing stopped. End the session now.');
  }
  $('stopBrowserBtn').disabled = true;
});
window.truveil.onBrowserState?.(state => {
  if (sessionEnding) return;
  if (!state.observeConsent) {
    browserSharingPermitted = false;
    $('pairBrowserBtn').disabled = true;
    $('stopBrowserBtn').disabled = true;
  }
  $('browserState').textContent = state.connected
    ? `${state.tabs?.length || 0} shared tabs. Manual closing ${state.closeConsent ? 'permitted' : 'not permitted'}.`
    : 'Browser disconnected. No tabs available to the interviewer.';
  if (state.connected || !state.observeConsent) {
    $('browserPairingCode').value = '';
    $('browserPairing').hidden = true;
  }
  const phase = !state.observeConsent ? 'unshared' : state.connected ? 'connected' : 'disconnected';
  // Tab counts and revisions do not need a new spoken instruction.
  if (taviBrowserPhase !== phase) {
    taviBrowserPhase = phase;
    setTaviGuidance('browserGuide', phase === 'unshared'
      ? 'Your browser window is no longer shared. Continue in your normal calling app.'
      : phase === 'connected'
        ? 'Only your paired interview window is shared. Use Stop sharing here whenever you need to.'
        : 'Your browser window is disconnected. No tabs are available to the interviewer.');
  }
});
window.truveil.getDemoConfig?.().then(config => {
  if (!$('demoRelayInput').value) $('demoRelayInput').value = config?.relayUrl ? sessionPresentation.serverAddress(config.relayUrl) : '';
}).catch(() => {});

$('endBtn').addEventListener('click', async () => {
  if (sessionEnding) return;
  if (!confirm('End your secure session now? This will tell your recruiter the interview is finished.')) return;
  finishSession();
  try {
    const result = await window.truveil.endSession();
    if (!result?.ok) throw new Error(result?.error || 'Session end was not confirmed.');
  } catch {
    setStatus('warn', 'Stopped locally');
    toast('Capture stopped, but the recruiter could not be notified. Please contact your interviewer.', 'warn');
  }
});

$('quitBtn').addEventListener('click', () => {
  window.truveil.quit();
});

$('withdrawProviderConsentBtn')?.addEventListener('click', async () => {
  const button = $('withdrawProviderConsentBtn');
  button.disabled = true;
  try {
    const result = await window.truveil.withdrawExternalReview();
    if (!result?.ok) throw new Error();
    button.hidden = true;
    $('externalReviewState').textContent = 'External text review stopped. Checks already sent cannot be recalled.';
  } catch {
    $('externalReviewState').textContent = 'Permission is off locally, but the interviewer could not be notified. End the session to stop further sharing.';
  } finally { button.disabled = false; }
});

setStatus(null, 'Not started');
setupInstructionCarousel();
setTimeout(() => sessionCodeInput.focus(), 400);
