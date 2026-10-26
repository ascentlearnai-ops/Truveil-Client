const { app, BrowserWindow, ipcMain, globalShortcut, powerSaveBlocker, screen, shell, clipboard } = require('electron');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const runtimeConfig = require('./src/config/runtime-config.json');
const OverlayScanner = require('./src/lockdown/scanner');
const {
  assessTranscript,
  isRecentDuplicate,
  transcriptFingerprint
} = require('./src/transcription/quality');

let mainWindow;
let blocker;
let monitoring = false;
let activeSession = null;
let supabase = null;
let realtimeChannel = null;
let pendingInviteCode = null;
let policyScanInterval = null;
let lastBlockingKey = null;
let lastForegroundKey = null;
let lastClosedTarget = null;
let joiningSession = false;
let cleanupPromise = null;
let sessionGeneration = 0;
let sessionStatusInterval = null;
let sessionStatusRequest = null;
const recentFinalTranscripts = [];
let pendingDemoRelay = null;
let tabBridge = null;
let tabPairingInfo = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWithRetry(operation, { attempts = 3, baseDelayMs = 650 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await delay(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function isStorageConflict(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  return status === 409 || message.includes('already exists') || message.includes('duplicate');
}

const DEFAULT_POLICY = {
  allowed_apps: ['TruveilSecure', 'Zoom', 'Microsoft Teams', 'Google Chrome', 'Microsoft Edge'],
  allowed_sites: ['meet.google.com', 'zoom.us', 'teams.microsoft.com'],
  blocked_sites: [
    'chatgpt.com',
    'claude.ai',
    'gemini.google.com',
    'copilot.microsoft.com',
    'perplexity.ai',
    'poe.com',
    'you.com',
    'phind.com',
    'interviewcoder',
    'interview coder',
    'cluely',
    'finalround',
    'lockedin',
    'parakeet',
    'leetcode wizard',
    'ultracode',
    'interview copilot'
  ],
  blocking_mode: 'warn_refocus'
};

function normalizeList(value, fallback = []) {
  if (value == null) return fallback;
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  const cleaned = items.map(item => String(item).trim()).filter(Boolean);
  return cleaned;
}

function normalizePolicy(session = {}) {
  return {
    allowed_apps: normalizeList(session.allowed_apps || session.allowedApps, DEFAULT_POLICY.allowed_apps),
    allowed_sites: normalizeList(session.allowed_sites || session.allowedSites, DEFAULT_POLICY.allowed_sites),
    blocked_sites: normalizeList(session.blocked_sites || session.blockedSites, DEFAULT_POLICY.blocked_sites),
    blocking_mode: session.blocking_mode || session.blockingMode || DEFAULT_POLICY.blocking_mode
  };
}

function isPolicySchemaError(error) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return text.includes('allowed_apps')
    || text.includes('allowed_sites')
    || text.includes('blocked_sites')
    || text.includes('blocking_mode')
    || text.includes('schema cache')
    || text.includes('column');
}

function siteTerms(site) {
  const clean = String(site || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const first = clean.split('.')[0];
  return Array.from(new Set([clean, first].filter(term => term && term.length >= 3)));
}

function normalizeUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return '';
}

function hostFromUrl(value = '') {
  try {
    const url = new URL(normalizeUrl(value));
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function textMatchesSite(site, fields = []) {
  const terms = siteTerms(site);
  return terms.some(term => fields.some(field => String(field || '').toLowerCase().includes(term)));
}

function policyMatch(policyItems = [], fields = []) {
  return (policyItems || []).find(site => textMatchesSite(site, fields));
}

function hostPolicyMatch(policyItems = [], host = '') {
  return policyItems.find(site => {
    const domain = hostFromUrl(String(site));
    return domain && (host === domain || host.endsWith('.' + domain));
  });
}

function extractInviteCode(value = '') {
  const text = String(value);
  const direct = text.match(/\b(?:TRV-[A-Z2-7]{16}|TRV-[A-Z0-9]{6}|DEMO-[A-Z2-9]{16})\b/i);
  if (direct) return direct[0].toUpperCase();

  try {
    const url = new URL(text);
    const fromQuery = url.searchParams.get('code');
    if (fromQuery && /^TRV-[A-Z0-9]{6}$/i.test(fromQuery)) return fromQuery.toUpperCase();
  } catch {}

  return null;
}

let pendingDemoInvite = null;
function captureDemoInvite(value) {
  pendingDemoInvite = null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'truveil:' || !['demo', 'session'].includes(url.hostname)) return;
    const code = url.searchParams.get('code') || '';
    if (!/^(?:DEMO-[A-Z2-9]{16}|TRV-[A-Z2-7]{16})$/i.test(code)) return;
    const { normalizeRelayUrl } = require('./src/demo/relay-client');
    pendingDemoInvite = { code: require('./src/session/presentation').displayCode(code.toUpperCase()), relayUrl: normalizeRelayUrl(url.searchParams.get('relay')) };
  } catch {}
}

function captureInviteCodeFromArgv(argv = []) {
  for (const arg of argv) {
    const code = extractInviteCode(arg);
    if (code) {
      captureDemoInvite(arg);
      pendingInviteCode = code;
      return code;
    }
  }
  return null;
}

function sendInviteCode(code = pendingInviteCode) {
  if (!code || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('invite-code', code);
  if (pendingDemoInvite?.code === require('./src/session/presentation').displayCode(code)) mainWindow.webContents.send('demo:invite', pendingDemoInvite);
}

function getConfig() {
  const supabaseUrl = runtimeConfig.supabaseUrl || process.env.TRUVEIL_SUPABASE_URL || '';
  return {
    apiBaseUrl: runtimeConfig.apiBaseUrl || process.env.TRUVEIL_API_BASE_URL || 'http://localhost:3001',
    supabaseUrl,
    supabaseAnonKey: runtimeConfig.supabaseAnonKey || process.env.TRUVEIL_SUPABASE_ANON_KEY || '',
    functionsBaseUrl: supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1` : ''
  };
}

function getSupabase() {
  if (activeSession?.demo || pendingDemoRelay) return null;
  if (supabase) return supabase;

  const { supabaseUrl, supabaseAnonKey } = getConfig();
  if (supabaseUrl.includes('dummy.supabase.co') || supabaseAnonKey === 'dummy') {
    if (!app.isPackaged) return null;
    throw new Error('Truveil realtime is using placeholder Supabase settings. Rebuild with real Supabase URL and anon key.');
  }
  if (!supabaseUrl || !supabaseAnonKey) {
    if (!app.isPackaged) return null;
    throw new Error('Truveil realtime is not configured for this build.');
  }

  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
    realtime: {
      transport: WebSocket,
      params: { eventsPerSecond: 10 }
    }
  });
  return supabase;
}

async function ensureAnonymousAuth() {
  const client = getSupabase();
  if (!client) return null;
  const { data: existing } = await client.auth.getSession();
  if (existing.session?.access_token) return existing.session;
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    const message = String(error.message || '');
    if (/anonymous/i.test(message) || /disabled/i.test(message)) {
      throw new Error('Candidate sign-in failed because Supabase Anonymous sign-ins are disabled. Enable Authentication > Providers > Anonymous in Supabase, then create a fresh TRV session code.');
    }
    throw new Error(`Candidate sign-in failed: ${message}`);
  }
  return data.session;
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1100, width - 80),
    height: Math.min(760, height - 80),
    minWidth: 760,
    minHeight: 560,
    icon: path.join(__dirname, 'assets/truveil.ico'),
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'default' : 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));

  // Only the consent policies may leave the app, in the system browser.
  const privacyUrls = new Set([
    'https://www.pangram.com/data-privacy',
    'https://openrouter.ai/privacy'
  ]);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (privacyUrls.has(url)) {
      void shell.openExternal(url).catch(() => console.warn('Could not open the provider privacy policy.'));
    }
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (!String(url || '').startsWith('file://')) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    sendInviteCode();
  });

  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb, details = {}) => {
    const requested = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    cb(permission === 'media' && requested.length > 0 && requested.every(type => type === 'audio'));
  });

  mainWindow.on('blur', () => {
    if (!monitoring || activeSession?.demo) return;
    mainWindow.webContents.send('focus-lost');
    publishCandidateEvent('focus_lost', { severity: 'medium' });
  });

  mainWindow.on('focus', () => {
    if (!monitoring || activeSession?.demo) return;
    mainWindow.webContents.send('focus-gained');
    publishCandidateEvent('focus_gained', { severity: 'low' });
  });
}

async function fetchSessionFromApi(sessionCode) {
  const { apiBaseUrl } = getConfig();
  if (!apiBaseUrl) return null;

  const url = `${apiBaseUrl.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionCode)}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Session lookup failed (${response.status})`);
  return response.json();
}

async function joinSessionThroughFunction(sessionCode, candidateName) {
  const { functionsBaseUrl, supabaseAnonKey } = getConfig();
  if (!functionsBaseUrl || !supabaseAnonKey) return null;
  const authSession = await ensureAnonymousAuth();
  const bearerToken = authSession?.access_token;
  if (!bearerToken) throw new Error('Candidate sign-in failed before session join.');
  const response = await fetch(`${functionsBaseUrl}/candidate-join`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ joinCode: sessionCode, candidateName })
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Session join failed (${response.status})`);
  return body;
}

async function validateSession(sessionCode, candidateName) {
  try {
    const joined = await joinSessionThroughFunction(sessionCode, candidateName);
    if (joined?.session) return { ...joined.session, sessionToken: joined.sessionToken, secureJoin: true };
  } catch (err) {
    console.warn('[Truveil] secure candidate join unavailable:', err.message);
  }

  const apiSession = await fetchSessionFromApi(sessionCode).catch((err) => {
    console.warn('[Truveil] API session lookup failed:', err.message);
    return null;
  });
  if (apiSession) return { ...apiSession, secureJoin: false };

  const client = getSupabase();
  if (!client) throw new Error('Session service is not configured. Ask the interviewer to rebuild the app with Supabase settings.');
  const { data, error } = await client
    .from('sessions')
    .select('*')
    .eq('id', sessionCode)
    .maybeSingle();
  if (error) throw new Error(`Session lookup failed: ${error.message}`);
  if (!data) throw new Error('Session not found. Check the code your recruiter sent you.');
  return { ...data, secureJoin: false };
}

function sessionChannelName(sessionId) {
  return `truveil-session:${sessionId}`;
}

function isTerminalSessionStatus(status) {
  return ['completed', 'cancelled', 'interrupted'].includes(status);
}

async function refreshSessionStatus(session) {
  if (activeSession !== session || sessionStatusRequest) return;
  const client = getSupabase();
  if (!client) return;
  const controller = new AbortController();
  sessionStatusRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const { data, error } = await client.from('sessions').select('status')
      .eq(session.internalId ? 'internal_id' : 'id', session.internalId || session.sessionCode)
      .abortSignal(controller.signal).maybeSingle();
    if (activeSession !== session) return;
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Session is no longer accessible.');
    if (isTerminalSessionStatus(data.status)) {
      await endSession({ remote: true });
    } else if (data.status === 'active') {
      await activateMonitoring();
    }
  } finally {
    clearTimeout(timeout);
    if (sessionStatusRequest === controller) sessionStatusRequest = null;
  }
}

function startSessionStatusPolling(session) {
  sessionStatusInterval = setInterval(() => {
    refreshSessionStatus(session).catch(err => {
      console.warn('[Truveil] session status check failed:', err.message);
      if (activeSession === session) cleanupSession({ disconnected: true });
    });
  }, 3000);
}

async function joinRealtimeSession(sessionId) {
  const client = getSupabase();
  if (!client && !app.isPackaged) return;
  if (realtimeChannel) await client.removeChannel(realtimeChannel);
  const session = activeSession;
  const isCurrent = () => activeSession === session && realtimeChannel === channel;

  const channel = client
    .channel(sessionChannelName(sessionId), {
      config: { private: Boolean(activeSession?.internalId), broadcast: { self: false, ack: true }, presence: { key: 'candidate' } }
    })
    .on('presence', { event: 'join' }, ({ key, newPresences = [] }) => {
      if (isCurrent() && session.ready && key === 'recruiter' && newPresences.some(presence => presence.role === 'recruiter')) {
        return publishCandidateEvent('candidate_ready', { severity: 'low' });
      }
    })
    .on('broadcast', { event: 'session_started' }, async () => {
      if (!isCurrent()) return;
      await activateMonitoring();
    })
    .on('broadcast', { event: 'audio_chunk_status' }, ({ payload }) => {
      if (!isCurrent() || !monitoring || payload?.sessionId !== session.sessionCode) return;
      if (!['transcribed', 'transcribed_deleted'].includes(payload.status)) return;
      if (typeof payload.chunkId !== 'string' || payload.chunkId.length > 240
        || !payload.chunkId.startsWith(`${session.sessionCode}-${session.transcriptInstanceId}-`)) return;
      if (typeof payload.transcript !== 'string' || !payload.transcript.trim() || payload.transcript.length > 16000) return;
      session.receivedAudioCaptions ||= new Set();
      if (session.receivedAudioCaptions.has(payload.chunkId)) return;
      session.receivedAudioCaptions.add(payload.chunkId);
      if (session.receivedAudioCaptions.size > 2000) session.receivedAudioCaptions.delete(session.receivedAudioCaptions.values().next().value);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transcript-caption', {
        text: payload.transcript, interim: false, segmentId: payload.chunkId,
        captionStreamId: session.transcriptInstanceId,
        streamEpoch: session.fallbackCaptionEpoch ??= (session.captionEpoch || 0) + 1,
        revision: session.captionRevision = (session.captionRevision || 0) + 1,
        sequence: Number.isSafeInteger(payload.sequence) ? payload.sequence : undefined,
        // Status time is delivery time, not capture time; order backup chunks by sequence.
        timestamp: undefined,
        qualityReason: 'backup-transcription'
      });
    })
    .on('broadcast', { event: 'session_ended' }, () => isCurrent() && endSession({ remote: true }))
    .on('broadcast', { event: 'recruiter_end_session' }, () => isCurrent() && endSession({ remote: true }))
    .on('broadcast', { event: 'session_policy' }, ({ payload }) => {
      if (!isCurrent() || payload?.sessionId !== session.sessionCode) return;
      activeSession.policy = normalizePolicy(payload.policy || {});
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-policy-updated', activeSession.policy);
      }
    })
    .on('broadcast', { event: 'recruiter_action' }, ({ payload }) => {
      if (!isCurrent() || !monitoring) return;
      handleRecruiterAction(payload || {}).catch((err) => {
        console.warn('[Truveil] recruiter action failed:', err.message);
      });
    })
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `internal_id=eq.${sessionId}` },
      (payload) => {
        if (!isCurrent()) return;
        if (payload.new?.status === 'active') return activateMonitoring();
        if (isTerminalSessionStatus(payload.new?.status)) {
          return endSession({ remote: true });
        }
      }
    );
  realtimeChannel = channel;

  await new Promise((resolve, reject) => {
    let subscribed = false;
    const timeout = setTimeout(() => reject(new Error('Timed out joining Truveil realtime session.')), 12000);
    channel.subscribe((status) => {
      if (!isCurrent()) return;
      if (status === 'SUBSCRIBED') {
        // Readiness comes only from this renderer's consent/preflight join, never a DB status.
        if (subscribed && session.ready) publishCandidateEvent('candidate_ready', { severity: 'low' });
        subscribed = true;
        clearTimeout(timeout);
        resolve();
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timeout);
        if (subscribed) {
          cleanupSession({ disconnected: true });
        } else {
          reject(new Error(`Could not join Truveil realtime session (${status}).`));
        }
      }
    });
  });

  if (!isCurrent()) throw new Error('Session ended while joining.');
  const tracked = await channel.track({ role: 'candidate', joinedAt: Date.now() });
  if (tracked !== 'ok') throw new Error(`Candidate presence failed (${tracked}).`);
}

async function sendRealtime(channel, event, payload) {
  const status = await channel.send({ type: 'broadcast', event, payload });
  if (status !== 'ok') throw new Error(`Realtime delivery failed (${status}).`);
}

async function publishCandidateEvent(type, metadata = {}, session = activeSession, channel = realtimeChannel) {
  if (!session || !channel) return { ok: false, error: 'No active realtime session.' };

  const payload = {
    type,
    sessionId: session.sessionCode,
    candidateName: session.candidateName,
    timestamp: Date.now(),
    ...metadata,
    ...(['candidate_ready', 'candidate_review_consent'].includes(type) ? {
      externalReviewConsent: { version: 'external-review-v1', enabled: session.externalReviewConsent === true }
    } : {})
  };

  try {
    await sendRealtime(channel, 'candidate_event', payload);
    return { ok: true };
  } catch (err) {
    console.warn('[Truveil] realtime event failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function publishCandidateTranscript({ text, timestamp, durationMs, sequence, segmentId, revision, streamEpoch, utteranceId, finalReason, source, interim, captionClear, transcriptConfidence, startedAt, endedAt, wordCount, lowConfidenceWordRatio, confidenceKnown, qualityReason, rms, peak }) {
  if (!activeSession || !realtimeChannel) return { ok: false, error: 'No active realtime session.' };
  const session = activeSession;
  const channel = realtimeChannel;
  if (typeof text !== 'string' || text.length > 16000) return { ok: false, error: 'Invalid transcript text.' };
  const explicitClear = captionClear === true && interim === true && !text.trim();

  const assessed = assessTranscript({
    text,
    confidence: transcriptConfidence,
    interim: Boolean(interim),
    rms,
    peak,
    source
  });
  if (!assessed.accepted && !text.trim() && !explicitClear) return { ok: true, skipped: true, reason: assessed.reason };
  // A rejected recognition must clear its earlier draft, never become checker evidence.
  const discardedReason = explicitClear ? null : !assessed.accepted ? assessed.reason : null;
  const clearCaption = explicitClear || Boolean(discardedReason);
  if (clearCaption) interim = true;
  const cleanText = clearCaption ? '' : assessed.text;
  const eventTimestamp = timestamp || Date.now();
  const localIdentity = typeof segmentId === 'string' && segmentId && segmentId.length <= 180
    ? segmentId
    : Number.isFinite(streamEpoch) && Number.isFinite(utteranceId) ? `${streamEpoch}:${utteranceId}` : null;
  const identity = localIdentity ? `${session.transcriptInstanceId}:${localIdentity}` : null;
  const duplicate = identity
    ? recentFinalTranscripts.some(item => item.identity === identity)
    : isRecentDuplicate(cleanText, recentFinalTranscripts.filter(item => !item.identity), eventTimestamp);
  if (!interim && duplicate) {
    return { ok: true, skipped: true, reason: 'duplicate-final' };
  }
  session.captionInFlight ||= new Map();
  if (!interim && identity && session.captionInFlight.has(identity)) return session.captionInFlight.get(identity);
  const captionRevision = Number.isSafeInteger(revision) && revision > 0 ? revision : (session.captionRevision || 0) + 1;
  session.captionRevision = Math.max(session.captionRevision || 0, captionRevision);
  const captionEpoch = Number.isSafeInteger(streamEpoch) && streamEpoch >= 0 ? streamEpoch : session.captionEpoch || 0;
  session.captionEpoch = Math.max(session.captionEpoch || 0, captionEpoch);

  const payload = {
    type: 'candidate_transcript',
    sessionId: activeSession.sessionCode,
    candidateName: activeSession.candidateName,
    text: cleanText,
    timestamp: eventTimestamp,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    sequence: Number.isFinite(Number(sequence)) ? Math.max(0, Number(sequence)) : undefined,
    segmentId: identity || `${session.transcriptInstanceId}:sequence:${Number(sequence || 0)}`,
    revision: captionRevision,
    captionStreamId: session.transcriptInstanceId,
    captionClear: clearCaption,
    streamEpoch: captionEpoch,
    utteranceId: Number.isFinite(Number(utteranceId)) ? Number(utteranceId) : undefined,
    finalReason: finalReason || (interim ? 'interim' : 'speech_final'),
    source: source || 'candidate-transcript',
    interim: Boolean(interim),
    transcriptConfidence: assessed.confidence,
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined,
    endedAt: Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? endedAt : undefined,
    wordCount: Number.isInteger(wordCount) && wordCount >= 0 ? wordCount : assessed.words,
    lowConfidenceWordRatio: typeof lowConfidenceWordRatio === 'number' && lowConfidenceWordRatio >= 0 && lowConfidenceWordRatio <= 1 ? lowConfidenceWordRatio : undefined,
    confidenceKnown: assessed.confidence !== undefined && confidenceKnown !== false,
    qualityReason: assessed.qualityReason || (typeof qualityReason === 'string' && qualityReason !== 'ok' ? qualityReason.slice(0, 80) : null),
    rms: Number.isFinite(Number(rms)) ? Number(rms) : undefined,
    peak: Number.isFinite(Number(peak)) ? Number(peak) : undefined
  };

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transcript-caption', payload);
  let resolveDelivery;
  const delivery = new Promise(resolve => { resolveDelivery = resolve; });
  if (!interim && identity) session.captionInFlight.set(identity, delivery);
  try {
    await sendRealtime(channel, 'candidate_transcript', payload);
    if (activeSession !== session || realtimeChannel !== channel) {
      const cancelled = { ok: false, error: 'Session ended before transcript delivery completed.' };
      resolveDelivery(cancelled);
      return cancelled;
    }
    if (!interim && activeSession === session) {
      recentFinalTranscripts.push({ identity, fingerprint: transcriptFingerprint(cleanText), timestamp: eventTimestamp });
      while (recentFinalTranscripts.length > 2000) recentFinalTranscripts.shift();
    }
    const result = discardedReason ? { ok: true, skipped: true, reason: discardedReason } : { ok: true };
    resolveDelivery(result);
    return result;
  } catch (err) {
    console.warn('[Truveil] transcript publish failed:', err.message);
    const result = { ok: false, error: err.message };
    resolveDelivery(result);
    return result;
  } finally {
    if (!interim && identity && session.captionInFlight.get(identity) === delivery) session.captionInFlight.delete(identity);
  }
}

async function publishCandidateAudioLevel(data = {}) {
  if (!activeSession || !realtimeChannel) return { ok: false, error: 'No active realtime session.' };

  const payload = {
    type: 'candidate_audio_level',
    sessionId: activeSession.sessionCode,
    candidateName: activeSession.candidateName,
    rms: Math.max(0, Math.min(1, Number(data.rms) || 0)),
    peak: Math.max(0, Math.min(1, Number(data.peak) || 0)),
    timestamp: data.timestamp || Date.now()
  };

  try {
    await sendRealtime(realtimeChannel, 'candidate_audio_level', payload);
    return { ok: true };
  } catch (err) {
    console.warn('[Truveil] audio level publish failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function uploadCandidateAudioChunk(data = {}) {
  if (activeSession?.demo) return { ok: false, error: 'This session uses live captions only. Reconnect the speech service; backup audio upload is disabled.' };
  if (!activeSession || !realtimeChannel) return { ok: false, error: 'No active realtime session.' };
  const session = activeSession;
  const channel = realtimeChannel;
  const isCurrent = () => activeSession === session && realtimeChannel === channel;
  const cancelled = { ok: false, error: 'Session ended before audio delivery completed.' };

  const client = getSupabase();
  if (!client) return { ok: false, error: 'Supabase audio storage is not configured.' };

  const rawAudio = data.arrayBuffer;
  if (!rawAudio) return { ok: false, error: 'Audio chunk was empty.' };

  let buffer;
  if (Buffer.isBuffer(rawAudio)) {
    buffer = rawAudio;
  } else if (rawAudio instanceof ArrayBuffer) {
    buffer = Buffer.from(rawAudio);
  } else if (ArrayBuffer.isView(rawAudio)) {
    buffer = Buffer.from(rawAudio.buffer, rawAudio.byteOffset, rawAudio.byteLength);
  } else {
    return { ok: false, error: 'Unsupported audio chunk payload.' };
  }
  if (buffer.byteLength < 128) return { ok: true, skipped: true };

  if (session.sessionToken) {
    const { functionsBaseUrl, supabaseAnonKey } = getConfig();
    try {
      const response = await fetch(`${functionsBaseUrl}/transcribe-chunk`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${supabaseAnonKey}`,
          'x-session-token': session.sessionToken,
          'content-type': String(data.mimeType || 'audio/webm').split(';')[0]
        },
        body: buffer
      });
      const result = await response.json().catch(() => ({}));
      if (!isCurrent()) return cancelled;
      if (!response.ok) throw new Error(result.error || `Fallback transcription failed (${response.status})`);
      if (result.text) {
        const delivered = await publishCandidateTranscript({
          text: result.text,
          timestamp: data.timestamp || Date.now(),
          durationMs: data.durationMs,
          sequence: data.sequence,
          segmentId: `fallback-${Number(data.sequence || 0)}-${data.timestamp || Date.now()}`,
          finalReason: 'fallback_chunk',
          streamEpoch: session.fallbackCaptionEpoch ??= (session.captionEpoch || 0) + 1,
          source: result.source || 'secure-chunk-fallback',
          transcriptConfidence: result.confidence,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          wordCount: result.wordCount,
          lowConfidenceWordRatio: result.lowConfidenceWordRatio,
          confidenceKnown: result.confidenceKnown,
          qualityReason: result.qualityReason,
          rms: data.rms,
          peak: data.peak
        });
        return { ...delivered, source: result.source || 'secure-chunk-fallback' };
      }
      return { ok: true, skipped: !result.text, source: result.source || 'secure-chunk-fallback' };
    } catch (err) {
      if (!isCurrent()) return cancelled;
      console.warn('[Truveil] secure fallback transcription failed:', err.message);
      await publishCandidateEvent('audio_secure_transcribe_failed', {
        severity: 'low',
        error: err.message,
        fallback: 'storage'
      });
      // Continue to storage-backed fallback so the admin app can transcribe the segment.
    }
  }
  if (!isCurrent()) return cancelled;

  const sequence = Math.max(0, Number(data.sequence) || 0);
  const timestamp = data.timestamp || Date.now();
  const mimeType = String(data.mimeType || 'audio/webm;codecs=opus');
  const storageContentType = mimeType.split(';')[0] || 'audio/webm';
  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
  const chunkId = `${session.sessionCode}-${session.transcriptInstanceId}-${String(sequence).padStart(5, '0')}-${timestamp}`;
  const storagePath = `${session.sessionCode}/${session.transcriptInstanceId}-${String(sequence).padStart(5, '0')}-${timestamp}.${extension}`;
  const durationMs = Math.max(0, Math.round(Number(data.durationMs) || 0));
  const peak = Math.max(0, Math.min(1, Number(data.peak) || 0));
  const rms = Math.max(0, Math.min(1, Number(data.rms) || 0));

  try {
    await runWithRetry(async () => {
      if (!isCurrent()) throw new Error(cancelled.error);
      const upload = await client.storage
        .from('session-audio')
        .upload(storagePath, buffer, {
          contentType: storageContentType,
          upsert: false
        });

      if (upload.error && !isStorageConflict(upload.error)) throw new Error(upload.error.message);
      return upload;
    });
    if (!isCurrent()) return cancelled;

    const row = {
      id: chunkId,
      session_id: session.sessionCode,
      storage_path: storagePath,
      sequence,
      duration_ms: durationMs,
      mime_type: mimeType,
      size_bytes: buffer.byteLength,
      peak,
      rms,
      status: 'uploaded'
    };

    const insert = await client.from('audio_chunks').upsert(row, { onConflict: 'id' });
    if (insert.error) {
      console.warn('[Truveil] audio metadata insert failed:', insert.error.message);
      await client.storage.from('session-audio').remove([storagePath]).catch(() => {});
      throw new Error(`Audio metadata insert failed: ${insert.error.message}`);
    }
    if (!isCurrent()) return cancelled;

    const payload = {
      type: 'candidate_audio_chunk',
      sessionId: session.sessionCode,
      candidateName: session.candidateName,
      chunkId,
      storagePath,
      sequence,
      durationMs,
      startedAt: Number.isFinite(data.startedAt) && data.startedAt > 0 ? data.startedAt : undefined,
      endedAt: Number.isFinite(data.startedAt) && Number.isFinite(data.endedAt) && data.endedAt >= data.startedAt ? data.endedAt : undefined,
      mimeType,
      sizeBytes: buffer.byteLength,
      peak,
      rms,
      timestamp
    };

    await runWithRetry(async () => {
      if (!isCurrent()) throw new Error(cancelled.error);
      await sendRealtime(channel, 'candidate_audio_chunk', payload);
    }, { attempts: 2, baseDelayMs: 500 });
    return { ok: true, chunkId, storagePath, sizeBytes: buffer.byteLength };
  } catch (err) {
    if (!isCurrent()) return cancelled;
    console.warn('[Truveil] audio chunk upload failed:', err.message);
    await publishCandidateEvent('audio_upload_failed', { severity: 'medium', sequence, error: err.message });
    return { ok: false, error: err.message };
  }
}

async function updateSessionStatus(status, patch = {}, session = activeSession) {
  if (session?.demo) return;
  if (!session) return;
  try {
    if (session.sessionToken) {
      const { functionsBaseUrl, supabaseAnonKey } = getConfig();
      const response = await fetch(`${functionsBaseUrl}/candidate-state`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${supabaseAnonKey}`,
          'x-session-token': session.sessionToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ status, patch })
      });
      if (response.ok) return;
    }
    const client = getSupabase();
    if (!client) return;
    const result = await client
      .from('sessions')
      .update({
        status,
        ...patch
      })
      .eq('id', session.sessionCode);
    if (result.error) throw new Error(result.error.message);
  } catch (err) {
    console.warn('[Truveil] session status update failed:', err.message);
    throw err;
  }
}

function registerSessionShortcuts() {
  globalShortcut.registerAll([
    'Alt+F4',
    'CommandOrControl+W',
    'CommandOrControl+Q',
    'F11'
  ], () => {
    if (mainWindow) mainWindow.webContents.send('shortcut-blocked');
    publishCandidateEvent('shortcut_blocked', { severity: 'medium' });
  });
}

function getForegroundWindowInfo() {
  if (process.platform !== 'win32') return Promise.resolve(null);

  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$hwnd = [ForegroundWindow]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][ForegroundWindow]::GetWindowText($hwnd, $sb, $sb.Capacity)
$pidValue = 0
[void][ForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
$processName = ""
try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
$detectedUrl = ""
if ($processName -match '^(chrome|msedge|firefox|brave|opera)$') {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($root) {
      $editCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
      )
      $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
      foreach ($edit in $edits) {
        try {
          $valuePattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $value = [string]$valuePattern.Current.Value
          if ($value -match '^(https?://|[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})(/|$)') {
            $detectedUrl = $value
            break
          }
        } catch {}
      }
    }
  } catch {}
}
[pscustomobject]@{ processName = $processName; title = $sb.ToString(); detectedUrl = $detectedUrl; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
  `.trim();

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
      timeout: 4000,
      windowsHide: true
    }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        const detectedUrl = normalizeUrl(parsed.detectedUrl);
        const detectedHost = hostFromUrl(detectedUrl);
        resolve({
          processName: parsed.processName || '',
          title: parsed.title || '',
          detectedUrl,
          detectedHost,
          detectionSource: detectedHost ? 'url' : parsed.title ? 'title' : 'process',
          timestamp: Number(parsed.timestamp) || Date.now()
        });
      } catch {
        resolve(null);
      }
    });
  });
}

function evaluateForegroundPolicy(info, policy) {
  if (policy?.blocking_mode === 'none') return { allowed: true, detectionSource: 'process' };
  if (!info || !info.processName) return { allowed: true, detectionSource: 'process' };

  const processName = String(info.processName || '').toLowerCase();
  const title = String(info.title || info.windowTitle || '').toLowerCase();
  const detectedUrl = String(info.detectedUrl || '').toLowerCase();
  const detectedHost = String(info.detectedHost || hostFromUrl(info.detectedUrl)).toLowerCase();
  const urlFields = [detectedHost, detectedUrl].filter(Boolean);
  const titleFields = [title, processName].filter(Boolean);
  const ownNames = ['truveilsecure', 'electron'];
  if (ownNames.some(name => processName.includes(name) || title.includes('truveil secure'))) {
    return { allowed: true, detectionSource: 'process' };
  }

  const blockedSite = detectedHost ? hostPolicyMatch(policy.blocked_sites, detectedHost) : policyMatch(policy.blocked_sites, titleFields);
  if (blockedSite) {
    return {
      allowed: false,
      matchedRule: blockedSite,
      detectionSource: detectedHost ? 'url' : title ? 'title' : 'process',
      reason: 'Restricted website is blocked by this interview policy.'
    };
  }

  const appAllowed = policy.allowed_apps.some(app => {
    const clean = String(app).toLowerCase().replace(/\.exe$/, '');
    return clean && (processName.includes(clean) || title.includes(clean));
  });
  if (appAllowed) return { allowed: true, detectionSource: 'process' };

  const allowedSite = detectedHost ? hostPolicyMatch(policy.allowed_sites, detectedHost) : policyMatch(policy.allowed_sites, titleFields);
  if (allowedSite) return { allowed: true, detectionSource: detectedHost ? 'url' : 'title' };

  return {
    allowed: true,
    unlisted: true,
    matchedRule: 'unlisted app/site',
    detectionSource: detectedHost ? 'url' : title ? 'title' : 'process',
    reason: 'Foreground destination is observed but is not a known restricted AI tool.'
  };
}

function isBrowserProcess(processName = '') {
  return /^(chrome|msedge|firefox|brave|opera)$/i.test(String(processName || '').trim());
}

function foregroundKey(info = {}) {
  return [
    info.processName || '',
    info.detectedHost || info.detectedUrl || '',
    info.title || info.windowTitle || ''
  ].join(':').toLowerCase();
}

function targetMatchesInfo(target = {}, info = {}) {
  const values = [
    info.processName,
    info.title,
    info.windowTitle,
    info.detectedHost,
    info.detectedUrl
  ].filter(Boolean).map(value => String(value).toLowerCase());
  const requested = [
    target.processName,
    target.windowTitle,
    target.detectedHost,
    target.detectedUrl,
    target.matchedRule
  ].filter(Boolean).map(value => String(value).toLowerCase());
  return requested.some(value => values.some(field => field.includes(value) || value.includes(field)));
}

function closeForegroundRestrictedTarget(info = {}, decision = {}) {
  // Foreground observations cannot safely identify a browser tab to close.
  return Promise.resolve(false);
}

async function warnAndRefocus(info, decision = {}) {
  if (!monitoring || !activeSession || !mainWindow || mainWindow.isDestroyed()) return;
  const session = activeSession;

  const key = `${info?.processName || ''}:${info?.title || ''}:${info?.detectedHost || info?.detectedUrl || ''}`;
  if (key && key === lastBlockingKey) return;
  lastBlockingKey = key;

  const closedRestrictedTarget = await closeForegroundRestrictedTarget(info, decision);
  if (!monitoring || activeSession !== session || mainWindow.isDestroyed()) return;
  if (closedRestrictedTarget) lastClosedTarget = { ...info, closedAt: Date.now() };
  const payload = {
    severity: 'high',
    processName: info?.processName || 'Unknown app',
    windowTitle: info?.title || 'Unknown window',
    detectedUrl: info?.detectedUrl || '',
    detectedHost: info?.detectedHost || '',
    matchedRule: decision.matchedRule || '',
    detectionSource: decision.detectionSource || info?.detectionSource || 'process',
    closedRestrictedTarget,
    reason: decision.reason || 'Foreground app or website is blocked by this interview policy.'
  };

  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 1200);
  mainWindow.webContents.send('blocking-warning', payload);
  await publishCandidateEvent('blocking_warning', payload);
}

async function handleRecruiterAction(payload = {}) {
  if (!monitoring || !activeSession || payload.sessionId !== activeSession.sessionCode) return;
  const session = activeSession;
  const action = String(payload.action || '');
  const target = payload.target || {};
  if (session.demo) {
    if (action !== 'close_tab' || typeof payload.commandId !== 'string' || payload.commandId.length > 80) return;
    session.tabCommands ||= new Set();
    if (session.tabCommands.has(payload.commandId) || session.tabCommands.size >= 500) return;
    session.tabCommands.add(payload.commandId);
    let result = { status: 'denied' };
    if (session.tabObserveConsent && session.tabCloseConsent && tabBridge) {
      try { result = await tabBridge.closeTab(target); } catch { result = { status: 'failed' }; }
    }
    if (activeSession === session && monitoring) await publishCandidateEvent('browser_tab_close_result', { commandId: payload.commandId, result });
    return;
  }

  if (action === 'allow_target') {
    const policy = normalizePolicy(activeSession.policy);
    const host = String(target.detectedHost || hostFromUrl(target.detectedUrl) || '').trim();
    const processName = String(target.processName || '').trim();
    if (host && !policy.allowed_sites.includes(host)) policy.allowed_sites.push(host);
    if (host) policy.blocked_sites = policy.blocked_sites.filter(item => !textMatchesSite(item, [host]));
    if (!host && processName && !policy.allowed_apps.includes(processName)) policy.allowed_apps.push(processName);
    activeSession.policy = policy;
    mainWindow?.webContents.send('session-policy-updated', policy);
    await publishCandidateEvent('recruiter_allowed_target', { severity: 'low', ...target });
    return;
  }

  if (action === 'reopen_target') {
    const url = normalizeUrl(target.detectedUrl || target.detectedHost || lastClosedTarget?.detectedUrl || lastClosedTarget?.detectedHost);
    if (url) {
      await shell.openExternal(url);
      await publishCandidateEvent('recruiter_reopened_target', { severity: 'low', ...target, detectedUrl: url });
    }
    return;
  }

  if (action === 'close_target') {
    await publishCandidateEvent('recruiter_close_target_missed', { severity: 'low', reason: 'Exact-tab sharing is required.' });
  }
}

async function activateMonitoring() {
  if (!activeSession || monitoring) return;
  monitoring = true;
  if (activeSession.demo || activeSession.policy?.blocking_mode === 'none') {
    // Keep consented speech running behind calling apps, without holding the display on.
    try { blocker = powerSaveBlocker.start('prevent-app-suspension'); } catch {}
  }
  if (activeSession.demo) {
    mainWindow?.webContents.send('session-started');
    return;
  }
  if (activeSession.policy?.blocking_mode === 'none') {
    mainWindow?.webContents.send('session-started');
    await publishCandidateEvent('candidate_connected', { severity: 'low' });
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(true);
    mainWindow.show();
    mainWindow.focus();
  }
  try { blocker = powerSaveBlocker.start('prevent-display-sleep'); } catch {}
  try { registerSessionShortcuts(); } catch {}
  startPolicyMonitor();
  startOverlayScanner();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session-started');
  await publishCandidateEvent('candidate_connected', { severity: 'low' });
}

function startPolicyMonitor() {
  stopPolicyMonitor();
  if (activeSession?.policy?.blocking_mode === 'none') return;
  policyScanInterval = setInterval(async () => {
    if (!monitoring || !activeSession?.policy) return;
    const session = activeSession;
    const info = await getForegroundWindowInfo();
    if (!info || !monitoring || activeSession !== session) return;
    const decision = evaluateForegroundPolicy(info, session.policy);

    const key = foregroundKey(info);
    if (key && key !== lastForegroundKey) {
      lastForegroundKey = key;
      await publishCandidateEvent('foreground_changed', {
        severity: decision.allowed ? 'low' : 'medium',
        processName: info.processName || 'Unknown app',
        windowTitle: info.title || 'Unknown window',
        detectedUrl: info.detectedUrl || '',
        detectedHost: info.detectedHost || '',
        matchedRule: decision.matchedRule || '',
        detectionSource: decision.detectionSource || info.detectionSource || 'process',
        policyDecision: decision.allowed ? 'allowed' : 'restricted'
      });
    }
    if (!monitoring || activeSession !== session) return;

    if (decision.allowed) {
      lastBlockingKey = null;
      return;
    }
    await warnAndRefocus(info, decision);
  }, 1000);
}

function stopPolicyMonitor() {
  if (policyScanInterval) clearInterval(policyScanInterval);
  policyScanInterval = null;
  lastBlockingKey = null;
  lastForegroundKey = null;
}

function startOverlayScanner() {
  if (!activeSession || activeSession.demo || activeSession.policy?.blocking_mode === 'none') return;
  OverlayScanner.start(activeSession.sessionCode, mainWindow, (detection) => {
    publishCandidateEvent('overlay_detected', {
      severity: detection.severity || 'critical',
      processName: detection.processName || 'hidden-overlay',
      windowTitle: detection.windowTitle || 'Unknown hidden window',
      processId: detection.processId || 0,
      matchedRule: detection.matchedRule || detection.type || 'hidden overlay',
      detectionSource: detection.type === 'WDA_EXCLUDEFROMCAPTURE' ? 'screen-capture-affinity' : 'process',
      reason: detection.flag?.detail || 'Hidden overlay or screen-capture-excluded window detected.',
      captureAffinity: detection.captureAffinity || 0
    });
  });
}

function stopOverlayScanner() {
  try { OverlayScanner.stop(); } catch {}
}

function cleanupSession({ remote = false, quit = false, status = 'interrupted', failedJoin = false, disconnected = false } = {}) {
  if (cleanupPromise) return cleanupPromise.then(result => { if (quit) app.quit(); return result; });
  const sessionToClose = activeSession;
  const channelToClose = realtimeChannel;
  // Invalidate callbacks before any network work; local privacy cannot depend on delivery.
  sessionGeneration++;
  activeSession = null;
  realtimeChannel = null;
  const pendingRelay = pendingDemoRelay;
  pendingDemoRelay = null;
  const bridgeCleanup = tabBridge?.stop();
  tabBridge = null;
  tabPairingInfo = null;
  mainWindow?.webContents.send('browser:state', { connected: false, tabs: [] });
  if (pendingRelay && pendingRelay !== channelToClose) pendingRelay.close();
  clearInterval(sessionStatusInterval);
  sessionStatusInterval = null;
  sessionStatusRequest?.abort();
  sessionStatusRequest = null;
  monitoring = false;
  recentFinalTranscripts.length = 0;
  lastClosedTarget = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setFullScreen(false); } catch {}
    try { mainWindow.setAlwaysOnTop(false); } catch {}
    if (disconnected) mainWindow.webContents.send('session-disconnected');
    else if (remote) mainWindow.webContents.send('remote-session-ended');
  }

  try { globalShortcut.unregisterAll(); } catch {}
  stopPolicyMonitor();
  stopOverlayScanner();
  try {
    if (blocker !== undefined) powerSaveBlocker.stop(blocker);
  } catch {}
  blocker = undefined;

  cleanupPromise = (async () => {
    let result = { ok: true };
    await bridgeCleanup;
    if (sessionToClose && !failedJoin && !disconnected) {
      await publishCandidateEvent(remote ? 'session_ended_remote' : `candidate_${status}`, {
        severity: status === 'completed' || remote ? 'low' : 'medium'
      }, sessionToClose, channelToClose);
      if (!remote) {
        try {
          await updateSessionStatus(status, { ended_at: new Date().toISOString() }, sessionToClose);
        } catch (err) {
          result = { ok: false, error: err.message };
        }
      }
    }
    if (channelToClose) {
      if (sessionToClose?.demo) {
        try { if (!disconnected) await channelToClose.end(); } catch {}
        channelToClose.close();
      } else {
        try { await getSupabase()?.removeChannel(channelToClose); } catch {}
      }
    }
    return result;
  })().finally(() => {
    cleanupPromise = null;
    if (quit) app.quit();
  });
  return cleanupPromise;
}

async function endSession(options = {}) {
  return cleanupSession({ status: 'interrupted', ...options });
}

if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('truveil', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('truveil');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const code = captureInviteCodeFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      sendInviteCode(code);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    const code = extractInviteCode(url);
    if (code) {
      captureDemoInvite(url);
      pendingInviteCode = code;
      sendInviteCode(code);
    }
  });
}

captureInviteCodeFromArgv(process.argv);

if (gotSingleInstanceLock) {
  app.whenReady().then(createWindow);
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
app.on('window-all-closed', () => app.quit());

async function joinDemoSession(data) {
  data = { ...data, sessionCode: require('./src/session/presentation').wireCode(data.sessionCode) };
  const { DemoRelayClient, normalizeRelayUrl } = require('./src/demo/relay-client');
  const generation = sessionGeneration;
  joiningSession = true;
  let channel;
  try {
    const url = normalizeRelayUrl(data.relayUrl || process.env.TRUVEIL_DEMO_RELAY_URL || runtimeConfig.demoRelayUrl || '');
    channel = new DemoRelayClient({ url });
    pendingDemoRelay = channel;
    channel.on('closed', () => {
      if (pendingDemoRelay === channel || realtimeChannel === channel) void cleanupSession({ disconnected: true });
    });
    channel.on('event', ({ event, payload }) => {
      if (realtimeChannel !== channel || !activeSession?.demo || payload?.sessionId !== activeSession.sessionCode) return;
      if (event === 'session_started') void activateMonitoring();
      if (event === 'session_ended') void endSession({ remote: true });
      if (event === 'session_policy') {
        activeSession.policy = normalizePolicy(payload.policy || {});
        mainWindow?.webContents.send('session-policy-updated', activeSession.policy);
      }
      if (event === 'recruiter_action') void handleRecruiterAction(payload).catch(() => {});
    });
    const room = await channel.join({ code: data.sessionCode.toUpperCase(), name: String(data.candidateName || '').trim(),
      consentConfirmed: true, microphoneReady: true, externalReviewConsent: data.externalReviewConsent === true,
      tabObserveConsent: data.tabObserveConsent === true, tabCloseConsent: data.tabObserveConsent === true && data.tabCloseConsent === true });
    if (generation !== sessionGeneration) throw new Error('Demo join was cancelled.');
    activeSession = { demo: true, transcriptInstanceId: randomUUID(), sessionCode: data.sessionCode.toUpperCase(),
      candidateName: String(data.candidateName || '').trim(), policy: normalizePolicy(room.details?.policy || {}), ready: true,
      externalReviewConsent: data.externalReviewConsent === true, tabObserveConsent: data.tabObserveConsent === true,
      tabCloseConsent: data.tabObserveConsent === true && data.tabCloseConsent === true };
    realtimeChannel = channel;
    pendingDemoRelay = null;
    const ready = await publishCandidateEvent('candidate_ready', { severity: 'low' });
    if (!ready.ok) throw new Error(ready.error);
    if (generation !== sessionGeneration || !activeSession) throw new Error('Demo join was cancelled.');
    return { ok: true, demo: true, directSpeechOnly: true, sessionCode: activeSession.sessionCode, candidateName: activeSession.candidateName,
      policy: activeSession.policy, waitingForInterviewer: !monitoring, technicalVocabulary: room.details?.technicalVocabulary || [] };
  } catch (error) {
    channel?.close();
    if (generation === sessionGeneration) await cleanupSession({ failedJoin: true });
    return { ok: false, error: error.message || 'Could not join demo.' };
  } finally { joiningSession = false; }
}

ipcMain.handle('demo:config', () => ({ enabled: true, relayUrl: process.env.TRUVEIL_DEMO_RELAY_URL || runtimeConfig.demoRelayUrl || '' }));
ipcMain.handle('browser:copy-pairing', () => {
  if (!activeSession?.demo || !monitoring || !activeSession.tabObserveConsent || !tabPairingInfo?.pairingCode) throw new Error('No active browser pairing.');
  clipboard.writeText(tabPairingInfo.pairingCode);
  return { ok: true };
});
ipcMain.handle('browser:open-extension', async () => {
  const error = await shell.openPath(path.join(app.isPackaged ? process.resourcesPath : __dirname, 'browser-extension'));
  if (error) throw new Error('Could not open the browser extension folder.');
  return { ok: true };
});
ipcMain.handle('browser:pair', async () => {
  const owner = activeSession;
  if (!owner?.demo || !monitoring || !owner.tabObserveConsent) throw new Error('Start an interview with browser-sharing consent first.');
  const { TabBridge } = require('./src/browser/tab-bridge');
  if (tabBridge) throw new Error('Browser sharing is already paired or pending. Stop sharing before starting a new session.');
  let initialized = false;
  const bridge = new TabBridge({ onUpdate: state => {
    if (!initialized || activeSession !== owner || tabBridge !== bridge || !monitoring) return;
    if (state.connected || !state.observeConsent) tabPairingInfo = null;
    if (!state.observeConsent) { owner.tabObserveConsent = false; owner.tabCloseConsent = false; }
    else if (state.connected && !state.closeConsent) owner.tabCloseConsent = false;
    mainWindow?.webContents.send('browser:state', state);
    void publishCandidateEvent('browser_tabs', { state });
  } });
  tabBridge = bridge;
  let info;
  try {
    info = await bridge.start({ sessionId: owner.sessionCode, observeConsent: true, closeConsent: owner.tabCloseConsent,
      protectedHosts: ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com'] });
  } catch (error) {
    await bridge.stop();
    if (tabBridge === bridge) tabBridge = null;
    throw error;
  }
  if (activeSession !== owner || tabBridge !== bridge || !monitoring) { bridge.stop(); throw new Error('Session ended.'); }
  initialized = true;
  tabPairingInfo = info;
  return info;
});
ipcMain.handle('browser:stop', async () => {
  if (activeSession) { activeSession.tabObserveConsent = false; activeSession.tabCloseConsent = false; }
  const cleanup = tabBridge?.stop();
  tabBridge = null;
  tabPairingInfo = null;
  const state = { connected: false, observeConsent: false, closeConsent: false, tabs: [], events: [] };
  mainWindow?.webContents.send('browser:state', state);
  if (activeSession?.demo) await publishCandidateEvent('browser_tabs', { state });
  await cleanup;
  return { ok: true };
});
ipcMain.handle('session:start', async (_, { sessionCode, candidateName, consentConfirmed, microphoneReady, externalReviewConsent, relayUrl, tabObserveConsent, tabCloseConsent } = {}) => {
  if (joiningSession || activeSession || cleanupPromise) return { ok: false, error: 'A session is already joining, active, or ending.' };
  if (consentConfirmed !== true || microphoneReady !== true) return { ok: false, error: 'Consent and microphone preflight are required before joining.' };
  if (/^(?:DEMO-[A-Z2-9]{16}|TRV-[A-Z2-7]{16})$/i.test(sessionCode || '')) {
    return joinDemoSession({ sessionCode, candidateName, externalReviewConsent, relayUrl, tabObserveConsent, tabCloseConsent });
  }
  if (!sessionCode || !/^TRV-[A-Z0-9]{6}$/i.test(sessionCode)) {
    return { ok: false, error: 'Please enter a valid session code like TRV-8FR2XP.' };
  }

  const normalizedCode = sessionCode.toUpperCase();
  const normalizedName = (candidateName || '').trim();
  const generation = sessionGeneration;
  joiningSession = true;

  try {
    const session = await validateSession(normalizedCode, normalizedName);
    if (generation !== sessionGeneration) throw new Error('Session join was cancelled.');
    if (!session) {
      return { ok: false, error: 'Session not found. Check the code your recruiter sent you.' };
    }
    if (isTerminalSessionStatus(session.status)) {
      return { ok: false, error: 'This interview session has already ended.' };
    }

    activeSession = {
      transcriptInstanceId: randomUUID(),
      sessionCode: normalizedCode,
      candidateName: normalizedName,
      externalReviewConsent: externalReviewConsent === true,
      policy: normalizePolicy(session),
      sessionToken: session.sessionToken || '',
      internalId: session.internal_id || '',
      secureJoin: Boolean(session.secureJoin),
      ready: false
    };
    await joinRealtimeSession(activeSession.internalId || normalizedCode);
    if (generation !== sessionGeneration || !activeSession) throw new Error('Session ended while joining.');
    await refreshSessionStatus(activeSession);
    if (generation !== sessionGeneration || !activeSession) throw new Error('Session ended while joining.');
    if (session.status !== 'active' && !monitoring) await updateSessionStatus('candidate_ready');
    if (generation !== sessionGeneration || !activeSession) throw new Error('Session ended while joining.');
    activeSession.ready = true;
    const readiness = await publishCandidateEvent('candidate_ready', { severity: 'low' });
    if (!readiness.ok) throw new Error(readiness.error);
    if (generation !== sessionGeneration || !activeSession) throw new Error('Session ended while joining.');
    startSessionStatusPolling(activeSession);
    if (session.status === 'active') await activateMonitoring();
    if (generation !== sessionGeneration || !activeSession) throw new Error('Session ended while joining.');

    return {
      ok: true,
      sessionCode: normalizedCode,
      candidateName: normalizedName,
      policy: activeSession.policy,
      secureJoin: activeSession.secureJoin,
      waitingForInterviewer: !monitoring,
      technicalVocabulary: session.technical_vocabulary || []
    };
  } catch (err) {
    if (generation === sessionGeneration) await cleanupSession({ failedJoin: true });
    return { ok: false, error: err.message || 'Could not start session.' };
  } finally {
    joiningSession = false;
  }
});

ipcMain.handle('provider-review:withdraw', async () => {
  if (!activeSession) return { ok: false, error: 'No active interview.' };
  activeSession.externalReviewConsent = false;
  return publishCandidateEvent('candidate_review_consent', { severity: 'low' });
});

ipcMain.handle('transcription:token', async () => {
  if (activeSession?.demo) {
    if (!monitoring || !realtimeChannel) return { ok: false, error: 'Wait for the host to start the interview.' };
    const owner = activeSession;
    try {
      const token = await realtimeChannel.token();
      return activeSession === owner && monitoring ? token : { ok: false, error: 'Demo ended.' };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  if (!activeSession?.sessionToken) return { ok: false, error: 'No secure session token.' };
  const { functionsBaseUrl, supabaseAnonKey } = getConfig();
  if (!functionsBaseUrl || !supabaseAnonKey) return { ok: false, error: 'Transcription service is not configured.' };
  const response = await fetch(`${functionsBaseUrl}/transcription-token`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${supabaseAnonKey}`,
      'x-session-token': activeSession.sessionToken,
      'content-type': 'application/json'
    },
    body: '{}'
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: body.error || `Token request failed (${response.status})` };
  return { ok: true, accessToken: body.accessToken, expiresIn: body.expiresIn };
});

ipcMain.handle('session:transcript', async (_, data) => publishCandidateTranscript(data || {}));

ipcMain.handle('audio:chunk', async (_, data) => uploadCandidateAudioChunk(data || {}));

ipcMain.handle('audio:level', async (_, data) => publishCandidateAudioLevel(data || {}));

ipcMain.handle('session:end', async () => endSession());

ipcMain.handle('app:quit', async () => {
  await cleanupSession({ quit: true });
  return { ok: true };
});

app.on('before-quit', async (event) => {
  if (!activeSession) return;
  event.preventDefault();
  await cleanupSession({ quit: true });
});
