// Scans for Interview Coder and similar stealth-assistance tools.
// Windows: detects windows excluded from screen capture.
// macOS: falls back to suspicious foreground app names.

const { execSync } = require('child_process');
const { EventEmitter } = require('events');

class WindowScanner extends EventEmitter {
  constructor() {
    super();
    this.knownSuspiciousApps = [
      'interview coder',
      'interviewcoder',
      'interview copilot',
      'ezzi',
      'shadecoder',
      'cluely',
      'finalround',
      'final round',
      'lockedin',
      'locked in',
      'parakeet',
      'leetcode wizard',
      'ultracode',
      'interview browser',
      'interviewbrowser',
      'interview solver',
      'copilot overlay',
      'codeassist'
    ];
  }

  detectWindows_Windows() {
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
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
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
        uint processId = 0;
        GetWindowThreadProcessId(hwnd, out processId);
        results.Add(processId.ToString() + ":::" + affinity.ToString() + ":::" + sb.ToString());
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
      const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, {
        timeout: 5000,
        windowsHide: true
      }).toString().trim();

      if (result) {
        return result.split('|||').filter(Boolean).map(raw => {
          const [pid, affinity, ...titleParts] = raw.split(':::');
          return {
          type: 'WDA_EXCLUDEFROMCAPTURE',
          processId: Number(pid) || 0,
          captureAffinity: Number(affinity) || 0,
          windowTitle: titleParts.join(':::') || 'Untitled hidden window',
          severity: 'critical'
          };
        });
      }
    } catch (err) {
      console.error('[Scanner] Windows scan error:', err.message);
    }
    return [];
  }

  detectWindows_Mac() {
    try {
      const script = `
        tell application "System Events"
          set appList to name of every process whose background only is false
          return appList
        end tell
      `;
      const result = execSync(`osascript -e '${script}'`, { timeout: 5000 }).toString().toLowerCase();
      const suspicious = this.knownSuspiciousApps.filter(app => result.includes(app));
      return suspicious.map(app => ({
        type: 'SUSPICIOUS_APP_RUNNING',
        windowTitle: app,
        severity: 'high'
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

function start(sessionId, mainWindow, onDetection) {
  stop();
  const scanner = new WindowScanner();

  scanInterval = setInterval(() => {
    const detections = scanner.scan();
    detections.forEach(detection => {
      const flag = {
        type: 'OVERLAY_DETECTED',
        detail: `Hidden overlay detected: "${detection.windowTitle}" - possible Interview Coder or AI assistant`,
        severity: detection.severity,
        timestamp: Date.now(),
        sessionId
      };
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('security-flag', flag);
      if (typeof onDetection === 'function') onDetection({ ...detection, flag });
    });
  }, 10000);
}

function stop() {
  if (scanInterval) clearInterval(scanInterval);
  scanInterval = null;
}

module.exports = { start, stop, WindowScanner };
