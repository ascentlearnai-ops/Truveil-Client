// Run in renderer process — monitors all browser-level cheat signals

window.setupEventMonitors = function(reportFlag) {
  // Window loses focus (candidate switched away)
  window.addEventListener('blur', () => {
    reportFlag({
      type: 'WINDOW_BLUR',
      detail: 'Interview window lost focus — candidate may have switched applications',
      severity: 'MEDIUM'
    });
  });

  // Visibility change (tab switch or minimize)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      reportFlag({
        type: 'VISIBILITY_LOST',
        detail: 'Interview tab hidden — candidate switched tab or minimized',
        severity: 'MEDIUM'
      });
    }
  });

  // Clipboard paste — candidate may be pasting AI-generated content
  document.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    reportFlag({
      type: 'CLIPBOARD_PASTE',
      detail: `Clipboard paste detected (${text.length} chars)`,
      severity: 'HIGH',
      pasteLength: text.length
    });
  });

  // DevTools detection via console timing trick
  let devToolsOpen = false;
  const devToolsCheck = () => {
    const threshold = 160;
    if (window.outerWidth - window.innerWidth > threshold ||
        window.outerHeight - window.innerHeight > threshold) {
      if (!devToolsOpen) {
        devToolsOpen = true;
        reportFlag({
          type: 'DEVTOOLS_OPENED',
          detail: 'Browser DevTools detected open — possible attempt to inspect or modify session',
          severity: 'HIGH'
        });
      }
    } else {
      devToolsOpen = false;
    }
  };
  setInterval(devToolsCheck, 3000);

  // Multiple monitors detection
  if (window.screen.isExtended !== undefined && window.screen.isExtended) {
    reportFlag({
      type: 'MULTIPLE_MONITORS',
      detail: 'Multiple monitors detected — candidate may be reading content on secondary screen',
      severity: 'MEDIUM'
    });
  }

  // Keyboard shortcut escape attempts reported from main process
  window.truveil?.onEscapeAttempt(() => {
    reportFlag({
      type: 'KEYBOARD_ESCAPE',
      detail: 'Candidate attempted keyboard shortcut to exit secure session',
      severity: 'LOW'
    });
  });
}
