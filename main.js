const { app, BrowserWindow, ipcMain, globalShortcut, powerSaveBlocker, screen, shell } = require('electron');
const path = require('path');
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
const recentFinalTranscripts = [];

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
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  const cleaned = items.map(item => String(item).trim()).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
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

function extractInviteCode(value = '') {
  const text = String(value);
  const direct = text.match(/\bTRV-[A-Z0-9]{6}\b/i);
  if (direct) return direct[0].toUpperCase();

  try {
    const url = new URL(text);
    const fromQuery = url.searchParams.get('code');
    if (fromQuery && /^TRV-[A-Z0-9]{6}$/i.test(fromQuery)) return fromQuery.toUpperCase();
  } catch {}

  return null;
}

function captureInviteCodeFromArgv(argv = []) {
  for (const arg of argv) {
    const code = extractInviteCode(arg);
    if (code) {
      pendingInviteCode = code;
      return code;
    }
  }
  return null;
}

function sendInviteCode(code = pendingInviteCode) {
  if (!code || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('invite-code', code);
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
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#050507',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
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
    if (!monitoring) return;
    mainWindow.webContents.send('focus-lost');
    publishCandidateEvent('focus_lost', { severity: 'medium' });
  });

  mainWindow.on('focus', () => {
    if (!monitoring) return;
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
  const response = await fetch(`${functionsBaseUrl}/candidate-join`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${supabaseAnonKey}`,
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

async function joinRealtimeSession(sessionId) {
  const client = getSupabase();
  if (!client && !app.isPackaged) return;
  if (realtimeChannel) await client.removeChannel(realtimeChannel);

  realtimeChannel = client
    .channel(sessionChannelName(sessionId), {
      config: { private: false, broadcast: { self: false }, presence: { key: 'candidate' } }
    })
    .on('broadcast', { event: 'session_started' }, async () => {
      await activateMonitoring();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session-started');
    })
    .on('broadcast', { event: 'session_ended' }, () => endSession({ remote: true }))
    .on('broadcast', { event: 'recruiter_end_session' }, () => endSession({ remote: true }))
    .on('broadcast', { event: 'session_policy' }, ({ payload }) => {
      if (!activeSession || payload?.sessionId !== activeSession.sessionCode) return;
      activeSession.policy = normalizePolicy(payload.policy || {});
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-policy-updated', activeSession.policy);
      }
    })
    .on('broadcast', { event: 'recruiter_action' }, ({ payload }) => {
      handleRecruiterAction(payload || {}).catch((err) => {
        console.warn('[Truveil] recruiter action failed:', err.message);
      });
    })
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `internal_id=eq.${sessionId}` },
      (payload) => {
        if (payload.new?.status === 'completed' || payload.new?.status === 'interrupted') {
          endSession({ remote: true });
        }
      }
    );

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out joining Truveil realtime session.')), 12000);
    realtimeChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout);
        resolve();
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timeout);
        reject(new Error(`Could not join Truveil realtime session (${status}).`));
      }
    });
  });

  await realtimeChannel.track({ role: 'candidate', joinedAt: Date.now() });
}

async function publishCandidateEvent(type, metadata = {}) {
  if (!activeSession || !realtimeChannel) return;

  const payload = {
    type,
    sessionId: activeSession.sessionCode,
    candidateName: activeSession.candidateName,
    timestamp: Date.now(),
    ...metadata
  };

  try {
    await realtimeChannel.send({ type: 'broadcast', event: 'candidate_event', payload });
  } catch (err) {
    console.warn('[Truveil] realtime event failed:', err.message);
  }
}

async function publishCandidateTranscript({ text, timestamp, durationMs, sequence, segmentId, revision, streamEpoch, utteranceId, finalReason, source, interim, transcriptConfidence, rms, peak }) {
  if (!activeSession || !realtimeChannel) return { ok: false, error: 'No active realtime session.' };

  const assessed = assessTranscript({
    text,
    confidence: transcriptConfidence,
    interim: Boolean(interim),
    rms,
    peak,
    source
  });
  if (!assessed.accepted) return { ok: true, skipped: true, reason: assessed.reason };
  const cleanText = assessed.text;
  const eventTimestamp = timestamp || Date.now();
  if (!interim && isRecentDuplicate(cleanText, recentFinalTranscripts, eventTimestamp)) {
    return { ok: true, skipped: true, reason: 'duplicate-final' };
  }

  const payload = {
    type: 'candidate_transcript',
    sessionId: activeSession.sessionCode,
    candidateName: activeSession.candidateName,
    text: cleanText,
    timestamp: eventTimestamp,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    sequence: Number.isFinite(Number(sequence)) ? Math.max(0, Number(sequence)) : undefined,
    segmentId: segmentId || `${activeSession.sessionCode}-${Number(sequence || 0)}`,
    revision: Math.max(0, Number(revision) || 0),
    streamEpoch: Number.isFinite(Number(streamEpoch)) ? Number(streamEpoch) : undefined,
    utteranceId: Number.isFinite(Number(utteranceId)) ? Number(utteranceId) : undefined,
    finalReason: finalReason || (interim ? 'interim' : 'speech_final'),
    source: source || 'candidate-transcript',
    interim: Boolean(interim),
    transcriptConfidence: Number.isFinite(Number(transcriptConfidence)) ? Number(transcriptConfidence) : undefined,
    rms: Number.isFinite(Number(rms)) ? Number(rms) : undefined,
    peak: Number.isFinite(Number(peak)) ? Number(peak) : undefined
  };

  try {
    await realtimeChannel.send({ type: 'broadcast', event: 'candidate_transcript', payload });
    if (!interim) {
      recentFinalTranscripts.push({ fingerprint: transcriptFingerprint(cleanText), timestamp: eventTimestamp });
      while (recentFinalTranscripts.length > 30) recentFinalTranscripts.shift();
    }
    return { ok: true };
  } catch (err) {
    console.warn('[Truveil] transcript publish failed:', err.message);
    return { ok: false, error: err.message };
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
    await realtimeChannel.send({ type: 'broadcast', event: 'candidate_audio_level', payload });
    return { ok: true };
  } catch (err) {
    console.warn('[Truveil] audio level publish failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function uploadCandidateAudioChunk(data = {}) {
  if (!activeSession || !realtimeChannel) return { ok: false, error: 'No active realtime session.' };

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

  if (activeSession.sessionToken) {
    const { functionsBaseUrl, supabaseAnonKey } = getConfig();
    try {
      const response = await fetch(`${functionsBaseUrl}/transcribe-chunk`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${supabaseAnonKey}`,
          'x-session-token': activeSession.sessionToken,
          'content-type': String(data.mimeType || 'audio/webm').split(';')[0]
        },
        body: buffer
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Fallback transcription failed (${response.status})`);
      if (result.text) {
        await publishCandidateTranscript({
          text: result.text,
          timestamp: data.timestamp || Date.now(),
          durationMs: data.durationMs,
          sequence: data.sequence,
          segmentId: `fallback-${Number(data.sequence || 0)}-${data.timestamp || Date.now()}`,
          finalReason: 'fallback_chunk',
          source: result.source || 'secure-chunk-fallback',
          transcriptConfidence: result.confidence,
          rms: data.rms,
          peak: data.peak
        });
      }
      return { ok: true, skipped: !result.text, source: result.source || 'secure-chunk-fallback' };
    } catch (err) {
      console.warn('[Truveil] secure fallback transcription failed:', err.message);
      await publishCandidateEvent('audio_upload_failed', { severity: 'medium', error: err.message });
      return { ok: false, error: err.message };
    }
  }

  const sequence = Math.max(0, Number(data.sequence) || 0);
  const timestamp = data.timestamp || Date.now();
  const mimeType = String(data.mimeType || 'audio/webm;codecs=opus');
  const storageContentType = mimeType.split(';')[0] || 'audio/webm';
  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
  const chunkId = `${activeSession.sessionCode}-${String(sequence).padStart(5, '0')}-${timestamp}`;
  const storagePath = `${activeSession.sessionCode}/${String(sequence).padStart(5, '0')}-${timestamp}.${extension}`;
  const durationMs = Math.max(0, Math.round(Number(data.durationMs) || 0));
  const peak = Math.max(0, Math.min(1, Number(data.peak) || 0));
  const rms = Math.max(0, Math.min(1, Number(data.rms) || 0));

  try {
    await runWithRetry(async () => {
      const upload = await client.storage
        .from('session-audio')
        .upload(storagePath, buffer, {
          contentType: storageContentType,
          upsert: false
        });

      if (upload.error) throw new Error(upload.error.message);
      return upload;
    });

    const row = {
      id: chunkId,
      session_id: activeSession.sessionCode,
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
    if (insert.error) console.warn('[Truveil] audio metadata insert failed:', insert.error.message);

    const payload = {
      type: 'candidate_audio_chunk',
      sessionId: activeSession.sessionCode,
      candidateName: activeSession.candidateName,
      chunkId,
      storagePath,
      sequence,
      durationMs,
      mimeType,
      sizeBytes: buffer.byteLength,
      peak,
      rms,
      timestamp
    };

    await runWithRetry(async () => {
      await realtimeChannel.send({ type: 'broadcast', event: 'candidate_audio_chunk', payload });
    }, { attempts: 2, baseDelayMs: 500 });
    return { ok: true, chunkId, storagePath, sizeBytes: buffer.byteLength };
  } catch (err) {
    console.warn('[Truveil] audio chunk upload failed:', err.message);
    await publishCandidateEvent('audio_upload_failed', { severity: 'medium', sequence, error: err.message });
    return { ok: false, error: err.message };
  }
}

async function updateSessionStatus(status, patch = {}) {
  if (!activeSession) return;
  try {
    if (activeSession.sessionToken) {
      const { functionsBaseUrl, supabaseAnonKey } = getConfig();
      const response = await fetch(`${functionsBaseUrl}/candidate-state`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${supabaseAnonKey}`,
          'x-session-token': activeSession.sessionToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ status, patch })
      });
      if (response.ok) return;
    }
    const client = getSupabase();
    if (!client) return;
    await client
      .from('sessions')
      .update({
        status,
        ...patch
      })
      .eq('id', activeSession.sessionCode);
  } catch (err) {
    console.warn('[Truveil] session status update failed:', err.message);
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

  const blockedSite = policyMatch(policy.blocked_sites, urlFields) || (!detectedHost ? policyMatch(policy.blocked_sites, titleFields) : null);
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

  const allowedSite = policyMatch(policy.allowed_sites, urlFields) || (!detectedHost ? policyMatch(policy.allowed_sites, titleFields) : null);
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
  if (process.platform !== 'win32') return Promise.resolve(false);
  const matchedRule = String(decision.matchedRule || '').toLowerCase();
  const isUnlisted = matchedRule === 'unlisted app/site';
  const hasRestrictedTarget = Boolean(info.detectedHost || info.detectedUrl || (matchedRule && !isUnlisted));
  if (!hasRestrictedTarget || isUnlisted || !isBrowserProcess(info.processName)) return Promise.resolve(false);

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^w')
Start-Sleep -Milliseconds 180
  `.trim();

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
      timeout: 1500,
      windowsHide: true
    }, (error) => resolve(!error));
  });
}

async function warnAndRefocus(info, decision = {}) {
  if (!activeSession || !mainWindow || mainWindow.isDestroyed()) return;

  const key = `${info?.processName || ''}:${info?.title || ''}:${info?.detectedHost || info?.detectedUrl || ''}`;
  if (key && key === lastBlockingKey) return;
  lastBlockingKey = key;

  const closedRestrictedTarget = await closeForegroundRestrictedTarget(info, decision);
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
  if (!activeSession || payload.sessionId !== activeSession.sessionCode) return;
  const action = String(payload.action || '');
  const target = payload.target || {};

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
    const info = await getForegroundWindowInfo();
    if (!info || !targetMatchesInfo(target, info)) {
      await publishCandidateEvent('recruiter_close_target_missed', { severity: 'low', ...target });
      return;
    }
    const closed = await closeForegroundRestrictedTarget(info, {
      matchedRule: target.matchedRule || target.detectedHost || 'recruiter request'
    });
    if (closed) lastClosedTarget = { ...info, closedAt: Date.now() };
    mainWindow.show();
    mainWindow.focus();
    await publishCandidateEvent('recruiter_closed_target', {
      severity: 'medium',
      ...info,
      windowTitle: info.title,
      closedRestrictedTarget: closed
    });
  }
}

async function activateMonitoring() {
  if (!activeSession || monitoring) return;
  monitoring = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(true);
    mainWindow.show();
    mainWindow.focus();
  }
  try { blocker = powerSaveBlocker.start('prevent-display-sleep'); } catch {}
  try { registerSessionShortcuts(); } catch {}
  startPolicyMonitor();
  startOverlayScanner();
  await publishCandidateEvent('candidate_connected', { severity: 'low' });
}

function startPolicyMonitor() {
  stopPolicyMonitor();
  policyScanInterval = setInterval(async () => {
    if (!monitoring || !activeSession?.policy) return;
    const info = await getForegroundWindowInfo();
    const decision = evaluateForegroundPolicy(info, activeSession.policy);
    if (!info) return;

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
        policyDecision: decision.unlisted ? 'unlisted' : decision.allowed ? 'observed' : 'restricted'
      });
    }

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
  if (!activeSession) return;
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

async function cleanupSession({ remote = false, quit = false, status = 'interrupted' } = {}) {
  const sessionToClose = activeSession;
  monitoring = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setFullScreen(false); } catch {}
  }

  try { globalShortcut.unregisterAll(); } catch {}
  stopPolicyMonitor();
  stopOverlayScanner();
  try {
    if (blocker !== undefined) powerSaveBlocker.stop(blocker);
  } catch {}
  blocker = undefined;

  if (sessionToClose) {
    await publishCandidateEvent(remote ? 'session_ended_remote' : `candidate_${status}`, {
      severity: status === 'completed' || remote ? 'low' : 'medium'
    });
  }

  if (!remote && sessionToClose) {
    await updateSessionStatus(status, { ended_at: new Date().toISOString() });
  }

  if (realtimeChannel) {
    try { await getSupabase()?.removeChannel(realtimeChannel); } catch {}
    realtimeChannel = null;
  }

  activeSession = null;

  if (remote && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-session-ended');
  }

  if (quit) app.quit();
}

async function endSession(options = {}) {
  await cleanupSession({ status: 'completed', ...options });
  return { ok: true };
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
      pendingInviteCode = code;
      sendInviteCode(code);
    }
  });
}

captureInviteCodeFromArgv(process.argv);

if (gotSingleInstanceLock) {
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());

ipcMain.handle('session:start', async (_, { sessionCode, candidateName }) => {
  if (!sessionCode || !/^TRV-[A-Z0-9]{6}$/i.test(sessionCode)) {
    return { ok: false, error: 'Please enter a valid session code like TRV-8FR2XP.' };
  }

  const normalizedCode = sessionCode.toUpperCase();
  const normalizedName = (candidateName || '').trim();

  try {
    const session = await validateSession(normalizedCode, normalizedName);
    if (!session) {
      return { ok: false, error: 'Session not found. Check the code your recruiter sent you.' };
    }
    if (session.status === 'completed' || session.status === 'interrupted') {
      return { ok: false, error: 'This interview session has already ended.' };
    }

    activeSession = {
      sessionCode: normalizedCode,
      candidateName: normalizedName,
      policy: normalizePolicy(session),
      sessionToken: session.sessionToken || '',
      internalId: session.internal_id || '',
      secureJoin: Boolean(session.secureJoin)
    };
    await joinRealtimeSession(activeSession.internalId || normalizedCode);
    await updateSessionStatus('candidate_ready');
    await publishCandidateEvent('candidate_ready', { severity: 'low' });
    if (session.status === 'active') await activateMonitoring();

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
    await cleanupSession();
    return { ok: false, error: err.message || 'Could not start session.' };
  }
});

ipcMain.handle('transcription:token', async () => {
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
