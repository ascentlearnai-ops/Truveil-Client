const { app, BrowserWindow, ipcMain, globalShortcut, powerSaveBlocker, screen } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const runtimeConfig = require('./src/config/runtime-config.json');

let mainWindow;
let blocker;
let monitoring = false;
let activeSession = null;
let supabase = null;
let realtimeChannel = null;
let pendingInviteCode = null;
let policyScanInterval = null;
let lastBlockingKey = null;

const DEFAULT_POLICY = {
  allowed_apps: ['TruveilSecure', 'Zoom', 'Microsoft Teams', 'Google Chrome', 'Microsoft Edge'],
  allowed_sites: ['meet.google.com', 'zoom.us', 'teams.microsoft.com'],
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
    blocking_mode: session.blocking_mode || session.blockingMode || DEFAULT_POLICY.blocking_mode
  };
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
  return {
    apiBaseUrl: runtimeConfig.apiBaseUrl || process.env.TRUVEIL_API_BASE_URL || 'http://localhost:3001',
    supabaseUrl: runtimeConfig.supabaseUrl || process.env.TRUVEIL_SUPABASE_URL || '',
    supabaseAnonKey: runtimeConfig.supabaseAnonKey || process.env.TRUVEIL_SUPABASE_ANON_KEY || ''
  };
}

function getSupabase() {
  if (supabase) return supabase;

  const { supabaseUrl, supabaseAnonKey } = getConfig();
  if (!supabaseUrl || !supabaseAnonKey) {
    if (!app.isPackaged) return null;
    throw new Error('Truveil realtime is not configured for this build.');
  }

  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  return supabase;
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
      sandbox: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    sendInviteCode();
  });

  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
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

async function validateSession(sessionCode) {
  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from('sessions')
      .select('id,status,allowed_apps,allowed_sites,blocking_mode')
      .eq('id', sessionCode)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (data) return data;
  }

  try {
    return await fetchSessionFromApi(sessionCode);
  } catch (err) {
    console.warn('[Truveil] API session fallback failed:', err.message);
    return null;
  }
}

function sessionChannelName(sessionCode) {
  return `truveil-session:${sessionCode}`;
}

async function joinRealtimeSession(sessionCode) {
  const client = getSupabase();
  if (!client && !app.isPackaged) return;
  if (realtimeChannel) await client.removeChannel(realtimeChannel);

  realtimeChannel = client
    .channel(sessionChannelName(sessionCode), {
      config: { broadcast: { self: false }, presence: { key: 'candidate' } }
    })
    .on('broadcast', { event: 'session_ended' }, () => endSession({ remote: true }))
    .on('broadcast', { event: 'recruiter_end_session' }, () => endSession({ remote: true }))
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionCode}` },
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

async function publishCandidateTranscript({ text, timestamp }) {
  if (!activeSession || !realtimeChannel) return { ok: false, error: 'No active realtime session.' };

  const cleanText = String(text || '').trim();
  if (cleanText.length < 3) return { ok: true, skipped: true };

  const payload = {
    type: 'candidate_transcript',
    sessionId: activeSession.sessionCode,
    candidateName: activeSession.candidateName,
    text: cleanText,
    timestamp: timestamp || Date.now()
  };

  try {
    await realtimeChannel.send({ type: 'broadcast', event: 'candidate_transcript', payload });
    return { ok: true };
  } catch (err) {
    console.warn('[Truveil] transcript publish failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function updateSessionStatus(status, patch = {}) {
  if (!activeSession) return;
  try {
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
[pscustomobject]@{ processName = $processName; title = $sb.ToString() } | ConvertTo-Json -Compress
  `.trim();

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
      timeout: 4000,
      windowsHide: true
    }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function isForegroundAllowed(info, policy) {
  if (!info || !info.processName) return true;

  const processName = String(info.processName || '').toLowerCase();
  const title = String(info.title || '').toLowerCase();
  const combined = `${processName} ${title}`;
  const ownNames = ['truveilsecure', 'electron'];
  if (ownNames.some(name => processName.includes(name) || title.includes('truveil secure'))) return true;

  const appAllowed = policy.allowed_apps.some(app => {
    const clean = String(app).toLowerCase().replace(/\.exe$/, '');
    return clean && (processName.includes(clean) || title.includes(clean));
  });
  if (appAllowed) return true;

  return policy.allowed_sites.some(site => {
    const clean = String(site).toLowerCase();
    return clean && combined.includes(clean);
  });
}

async function warnAndRefocus(info, reason) {
  if (!activeSession || !mainWindow || mainWindow.isDestroyed()) return;

  const key = `${info?.processName || ''}:${info?.title || ''}`;
  if (key && key === lastBlockingKey) return;
  lastBlockingKey = key;

  const payload = {
    severity: 'high',
    processName: info?.processName || 'Unknown app',
    windowTitle: info?.title || 'Unknown window',
    reason
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

function startPolicyMonitor() {
  stopPolicyMonitor();
  policyScanInterval = setInterval(async () => {
    if (!monitoring || !activeSession?.policy) return;
    const info = await getForegroundWindowInfo();
    if (!info || isForegroundAllowed(info, activeSession.policy)) {
      lastBlockingKey = null;
      return;
    }
    await warnAndRefocus(info, 'Foreground app is not in the recruiter allowed list.');
  }, 2500);
}

function stopPolicyMonitor() {
  if (policyScanInterval) clearInterval(policyScanInterval);
  policyScanInterval = null;
  lastBlockingKey = null;
}

async function cleanupSession({ remote = false, quit = false, status = 'interrupted' } = {}) {
  const sessionToClose = activeSession;
  monitoring = false;

  try { globalShortcut.unregisterAll(); } catch {}
  stopPolicyMonitor();
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
    const session = await validateSession(normalizedCode);
    if (!session) {
      return { ok: false, error: 'Session not found. Check the code your recruiter sent you.' };
    }
    if (session.status === 'completed' || session.status === 'interrupted') {
      return { ok: false, error: 'This interview session has already ended.' };
    }

    activeSession = { sessionCode: normalizedCode, candidateName: normalizedName, policy: normalizePolicy(session) };
    await joinRealtimeSession(normalizedCode);

    monitoring = true;
    try { blocker = powerSaveBlocker.start('prevent-display-sleep'); } catch {}
    try { registerSessionShortcuts(); } catch {}
    startPolicyMonitor();

    await updateSessionStatus('active');
    await publishCandidateEvent('candidate_connected', { severity: 'low' });

    return { ok: true, sessionCode: normalizedCode, candidateName: normalizedName };
  } catch (err) {
    await cleanupSession();
    return { ok: false, error: err.message || 'Could not start session.' };
  }
});

ipcMain.handle('session:transcript', async (_, data) => publishCandidateTranscript(data || {}));

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
