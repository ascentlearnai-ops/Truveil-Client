const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function timers() { let id = 0; const pending = new Map(); return { pending, setTimeout(fn, ms) { pending.set(++id, {fn, ms}); return id; }, clearTimeout(id) {pending.delete(id);}, setInterval(fn, ms) {pending.set(++id,{fn,ms});return id;}, clearInterval(id) {pending.delete(id);} }; }

function mainHarness(options = {}) {
  const handlers = new Map();
  const events = [];
  const updates = [];
  const channels = [];
  const removed = [];
  const sent = [];
  const externalUrls = [];
  const navigationHandlers = new Map();
  const windowHandlers = new Map();
  const windowOptions = [], powerStarts = [], powerStops = [];
  let openWindow;
  const clock = timers();
  const foreground = deferred();
  const window = {
    isDestroyed: () => false,
    setFullScreen() {}, show() {}, focus() {}, setAlwaysOnTop() {},
    loadFile() {}, once() {}, on(name, callback) {windowHandlers.set(name, callback);},
    webContents: {
      send: (...args) => { events.push(args); options.onEvent?.(...args); },
      setWindowOpenHandler: handler => { openWindow = handler; },
      on: (name, handler) => navigationHandlers.set(name, handler),
      session: { setPermissionRequestHandler() {} }
    }
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-auth-token' } } }),
      signInAnonymously: async () => { throw new Error('Unexpected auth request'); }
    },
    channel() {
      const callbacks = new Map();
      const channel = {
        callbacks,
        on(kind, filter, fn) { callbacks.set(filter.event === 'UPDATE' ? 'UPDATE' : filter.event, fn); return this; },
        subscribe(fn) { this.status = fn; if (!options.deferSubscribe) fn(options.subscribeStatus || 'SUBSCRIBED'); },
        track: async () => 'ok',
        send: async data => { sent.push(data); return options.send ? options.send(data) : 'ok'; }
      };
      channels.push(channel);
      return channel;
    },
    removeChannel: async channel => { removed.push(channel); },
    from: () => ({
      update: data => ({ eq: async () => { updates.push(data); return options.update ? options.update(data) : {}; } }),
      select: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: async () => options.statusRead ? options.statusRead() : { data: { status: options.sessionStatus || 'waiting' } } }) }) })
    })
  };
  const app = {
    isPackaged: false, setAsDefaultProtocolClient() {}, requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => ({ then() {} }), quit() {}
  };
  const context = vm.createContext({
    console: { warn() {} }, Buffer, URL, ArrayBuffer, AbortController, ...clock,
    fetch: (...args) => { if (options.fetch) return options.fetch(...args); throw new Error('Unexpected network request'); },
    __dirname: root,
    process: { argv: [], platform: 'win32', env: {} },
    require(name) {
      if (options.modules && Object.hasOwn(options.modules, name)) return options.modules[name];
      if (name === 'electron') return {
        app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        BrowserWindow: function (config) { windowOptions.push(config); return window; },
        screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 900 } }) },
        shell: { openExternal: async url => {
          externalUrls.push(url);
          if (options.openExternalError) throw new Error('Browser unavailable');
        } },
        globalShortcut: { registerAll() {}, unregisterAll() {} },
        powerSaveBlocker: {
          start(type) { powerStarts.push(type); if (options.powerError) throw new Error('Power API unavailable'); return 0; },
          stop(id) { powerStops.push(id); }
        }
      };
      if (name === 'path') return path;
      if (name === 'crypto') return require('node:crypto');
      if (name === 'child_process') return { execFile() { throw new Error('Real monitoring is forbidden in tests'); } };
      if (name === '@supabase/supabase-js') return { createClient: () => client };
      if (name === 'ws') return class {};
      if (name === './src/config/runtime-config.json') return { supabaseUrl: 'https://test.invalid', supabaseAnonKey: 'test' };
      if (name === './src/lockdown/scanner') return { start() {}, stop() {} };
      if (name === './src/transcription/quality') return require('../../src/transcription/quality');
      if (name === './src/session/presentation') return require('../../src/session/presentation');
      throw new Error(`Unexpected dependency: ${name}`);
    },
    testWindow: window,
    testSession: { status: options.sessionStatus || 'scheduled', internal_id: 'internal-test', ...options.session },
    testForeground: foreground.promise
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(root, 'main.js'), 'utf8'));
  run('mainWindow = testWindow; getForegroundWindowInfo = () => testForeground;');
  if (!options.realValidation) run('validateSession = async () => testSession;');
  const join = () => handlers.get('session:start')({}, { sessionCode: 'TRV-ABC123', candidateName: 'Test Candidate', consentConfirmed: true, microphoneReady: true });
  return { run, join, handlers, events, updates, channels, removed, sent, clock, foreground,
    externalUrls, navigationHandlers, windowHandlers, windowOptions, powerStarts, powerStops,
    openWindow: details => openWindow(details) };
}

module.exports = { mainHarness };

