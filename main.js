const { app, BrowserWindow, globalShortcut, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Get session ID from command line args or env
const sessionId = process.argv.find(a => a.startsWith('--session='))?.split('=')[1]
  || process.env.SESSION_ID;

let mainWindow;
let blocker;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 800,
    fullscreen: false,
    kiosk: false,
    alwaysOnTop: false,
    closable: true,
    minimizable: true,
    maximizable: true,
    resizable: true,
    frame: true,
    skipTaskbar: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('session-id', sessionId);
  });

  // Block ALL escape shortcuts
  globalShortcut.registerAll([
    'Alt+F4',
    'CommandOrControl+W',
    'CommandOrControl+Q',
    'CommandOrControl+Tab',
    'Alt+Tab',
    'Meta+Tab',
    'Meta+D',
    'CommandOrControl+Alt+Delete',
    'F11',
    'Escape',
    'CommandOrControl+R',
    'F5',
    'CommandOrControl+Shift+I',    // DevTools
    'CommandOrControl+Shift+J',    // DevTools
    'CommandOrControl+Shift+C',    // DevTools
    'F12'
  ], () => {
    // Blocked — report attempt
    mainWindow.webContents.send('escape-attempt');
    return false;
  });

  // Prevent sleep during interview
  blocker = powerSaveBlocker.start('prevent-display-sleep');
}

// Override close behavior completely
app.on('before-quit', (e) => {
  if (!global.sessionEnded) {
    e.preventDefault();
    mainWindow.webContents.send('close-attempted');
  }
});

app.whenReady().then(() => {
  createWindow();

  // Start window scanner
  const scanner = require('./src/lockdown/scanner');
  scanner.start(sessionId, mainWindow);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (blocker !== undefined) powerSaveBlocker.stop(blocker);
});

// IPC: session ended by recruiter
ipcMain.on('session-ended', () => {
  global.sessionEnded = true;
  globalShortcut.unregisterAll();
  app.quit();
});
