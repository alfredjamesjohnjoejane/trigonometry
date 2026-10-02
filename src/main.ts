import './utils/index.js';
import './ui/index.js';
import { installDevtoolsProtection } from './security/index.js';
import { initAnalytics } from './analytics/index.js';
import { handlePanicKey } from './panic/index.js';
import { installCloakFocusHandlers } from './cloak/index.js';
import { loadSettings } from './settings/index.js';
import { loadGames } from './games/index.js';
import {
  updateOnlineStatus,
  checkPWAInstallAvailability,
  enforcePWAOverlay,
  setRandomLandingText,
  showTOSPopup,
  initHomepageTest,
  initViewFromHash,
  startPlayTimer,
  checkGameStatus,
  setDeferredPrompt,
  markAppInstalled,
  syncPWAInstallUI,
} from './ui/index.js';
import { setupBlockedUrlGuards, scrubPortedLinks, showErrorToast } from './utils/index.js';

// Install as early as possible (module evaluation, before DOMContentLoaded)
// so shortcuts / right-click are blocked from the first paint.
installDevtoolsProtection();
initAnalytics();

// Install-signal listeners live at module scope, NOT inside the boot handler:
// `beforeinstallprompt` can fire while the document is still parsing and
// `appinstalled` can arrive before boot completes. Deferring them to
// DOMContentLoaded loses the event — and with it the only signal that tells
// this page the install already happened.
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  setDeferredPrompt(e);
  // The boot path wires the button to the menu hint when no prompt exists;
  // re-run it now that a native prompt is available so the button actually
  // calls installPWA() instead of showing instructions.
  checkPWAInstallAvailability();
});

window.addEventListener('appinstalled', () => {
  setDeferredPrompt(null);
  markAppInstalled();
  // Hides the gate, stops enforcement and swaps the install button for the
  // "Added to home screen" confirmation.
  syncPWAInstallUI();
  showErrorToast('App installed!');
});

let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;

  // Evaluate the install gate FIRST: it is visible by default in the HTML, so
  // any failure in the unrelated setup below must never be able to leave the
  // "install the app" screen stuck open (this is exactly what happens after a
  // user installs the app if the gate is never re-evaluated).
  enforcePWAOverlay();
  checkPWAInstallAvailability();

  setupBlockedUrlGuards();
  scrubPortedLinks();

  const offlineOverlay = document.createElement('div');
  offlineOverlay.id = 'offline-overlay';
  offlineOverlay.style.cssText =
    'position:fixed;inset:0;background:rgba(17,17,17,0.95);z-index:99999;display:flex;align-items:center;justify-content:center;color:#e0e0e0;font-family:Segoe UI,system-ui,sans-serif;display:none;';
  offlineOverlay.innerHTML =
    '<div style="text-align:center;padding:2rem;max-width:500px"><div style="font-size:4rem;margin-bottom:1rem">📵</div><div><h1 style="font-size:2rem;margin-bottom:1rem">You\'re Offline</h1><p style="color:#888;margin-bottom:2rem;line-height:1.6">No internet connection. Game library is unavailable.<br>Reconnect to browse and play games.</p><button onclick="window.location.reload()" style="background:#424242;color:#fff;border:none;border-radius:50px;padding:1rem 2rem;font-size:1rem;font-weight:600;cursor:pointer">Retry</button></div>';
  document.body.appendChild(offlineOverlay);

  window.addEventListener('online', () => updateOnlineStatus());
  window.addEventListener('offline', () => updateOnlineStatus());
  updateOnlineStatus();

  setRandomLandingText();
  showTOSPopup();
  initHomepageTest();
  initViewFromHash();
  window.addEventListener('hashchange', initViewFromHash);
}

// Boot even if this module evaluated after DOMContentLoaded already fired
// (late/dynamic injection, tests, bfcache-less restores). Waiting on an event
// that has already been dispatched would leave the install gate up forever.
// Direct calls are guarded: inside an event listener an exception is isolated
// by the dispatcher, but at module scope it would abort evaluation entirely.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  try {
    boot();
  } catch (err) {
    console.error('[Boot] init failed:', err);
  }
}

function onPageLoad(): void {
  try {
    if (
      window.location.origin !== 'null' &&
      window.location.href !== 'about:blank' &&
      !window.location.href.startsWith('file:')
    ) {
      const base =
        window.location.origin +
        window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
      try {
        localStorage.setItem('jesherheadOriginalBase', base);
      } catch {
        /* blocked storage — non-fatal */
      }
    }
  } catch {
    /* ignore */
  }

  loadGames().catch(err => {
    console.error('[Boot] catalog load failed:', err);
    showErrorToast('Could not load game catalog. Check connection and retry.');
  });
  try {
    // Running inside the cloak iframe: hide the cloak button (no nested cloaks).
    if (window.self !== window.top) document.body.classList.add('cloaked-window');
  } catch {
    /* cross-origin iframe — ignore */
  }
  const lp = document.getElementById('lp');
  if (lp && location.hash !== '#settings') lp.style.display = 'flex';
  loadSettings();
  installCloakFocusHandlers();
  startPlayTimer();
  document.addEventListener('keydown', handlePanicKey, true);
  void checkGameStatus(true);
  setInterval(() => {
    void checkGameStatus(false);
  }, 300000);
}

if (document.readyState === 'complete') {
  try {
    onPageLoad();
  } catch (err) {
    console.error('[Boot] load handler failed:', err);
  }
} else {
  window.addEventListener('load', onPageLoad, { once: true });
}
