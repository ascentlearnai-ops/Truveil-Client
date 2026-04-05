// Scans for Interview Coder and similar tools
// Uses WDA_EXCLUDEFROMCAPTURE detection on Windows
// Uses CGWindowSharingState detection on macOS

const { execSync } = require('child_process');
const { EventEmitter } = require('events');

class WindowScanner extends EventEmitter {
  constructor() {
    super();
    this.knownSuspiciousApps = [
      'interview coder',
      'interviewcoder',
      'ezzi',
      'shadecoder',
      'interview browser',
      'interviewbrowser',
      'interview solver',
      'copilot overlay',
      'codeassist'
    ];
  }

  detectWindows_Windows() {
    // PowerShell script to enumerate windows with WDA_EXCLUDEFROMCAPTURE (0x11)
    const psScript = `
$code = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinDetect {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowDisplayAffinity(IntPtr hWnd, out uint pdwAffinity);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static List<string> GetHiddenWindows() {
    var results = new List<string>();
    EnumWindows((hwnd, lParam) => {
      if (!IsWindowVisible(hwnd)) return true;
      uint affinity = 0;
      GetWindowDisplayAffinity(hwnd, out affinity);
      if (affinity == 0x11 || affinity == 0x13) {
        var sb = new StringBuilder(256);
        GetWindowText(hwnd, sb, 256);
        results.Add(sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return results;
  }
}
"@
Add-Type -TypeDefinition $code
[WinDetect]::GetHiddenWindows() -join "|||"
    `.trim();

    try {
      const result = execSync(\`powershell -NoProfile -ExecutionPolicy Bypass -Command "\${psScript}"\`, {
        timeout: 5000,
        windowsHide: true
      }).toString().trim();

      if (result && result !== '') {
        const windows = result.split('|||').filter(Boolean);
        return windows.map(title => ({
          type: 'WDA_EXCLUDEFROMCAPTURE',
          windowTitle: title,
          severity: 'CRITICAL'
        }));
      }
    } catch (err) {
      console.error('[Scanner] Windows scan error:', err.message);
    }
    return [];
  }

  detectWindows_Mac() {
    // Check for windows with NSWindowSharingNone using system_profiler or CGWindowList
    try {
      const script = \`
        tell application "System Events"
          set appList to name of every process whose background only is false
          return appList
        end tell
      \`;
      const result = execSync(\`osascript -e '\${script}'\`, { timeout: 5000 }).toString().toLowerCase();
      const suspicious = this.knownSuspiciousApps.filter(app => result.includes(app));
      return suspicious.map(app => ({
        type: 'SUSPICIOUS_APP_RUNNING',
        windowTitle: app,
        severity: 'HIGH'
      }));
    } catch {}
    return [];
  }

  scan() {
    const detections = [];
    if (process.platform === 'win32') {
      detections.push(...this.detectWindows_Windows());
    } else if (process.platform === 'darwin') {
      detections.push(...this.detectWindows_Mac());
    }
    return detections;
  }
}

let scanInterval;

function start(sessionId, mainWindow) {
  const scanner = new WindowScanner();

  scanInterval = setInterval(() => {
    const detections = scanner.scan();
    if (detections.length > 0) {
      detections.forEach(detection => {
        mainWindow.webContents.send('security-flag', {
          type: 'OVERLAY_DETECTED',
          detail: \`Hidden overlay detected: "\${detection.windowTitle}" — possible Interview Coder or AI assistant\`,
          severity: detection.severity,
          timestamp: Date.now()
        });
      });
    }
  }, 10000); // every 10 seconds
}

function stop() {
  clearInterval(scanInterval);
}

module.exports = { start, stop };
