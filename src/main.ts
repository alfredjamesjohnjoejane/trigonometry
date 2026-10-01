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
  setRandomLandingText,
  showTOSPopup,
  initHomepageTest,
  initViewFromHash,
  startPlayTimer,
  checkGameStatus,
  setDeferredPrompt,
} from './ui/index.js';
import { setupBlockedUrlGuards, scrubPortedLinks, showErrorToast } from './utils/index.js';

// Install as early as possible (module evaluation, before DOMContentLoaded)
// so shortcuts / right-click are blocked from the first paint.
installDevtoolsProtection();
initAnalytics();

document.addEventListener('DOMContentLoaded', () => {
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

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    setDeferredPrompt(e);
    const btn = document.getElementById('pwa-install-btn');
    if (btn) btn.style.display = 'block';
  });

  window.addEventListener('appinstalled', () => {
    const btn = document.getElementById('pwa-install-btn');
    const msg = document.getElementById('pwa-installed-msg');
    if (btn) btn.style.display = 'none';
    if (msg) msg.style.display = 'block';
    setDeferredPrompt(null);
    showErrorToast('App installed!');
  });

  checkPWAInstallAvailability();
  setRandomLandingText();
  showTOSPopup();
  initHomepageTest();
  initViewFromHash();
  window.addEventListener('hashchange', initViewFromHash);
});

window.addEventListener('load', () => {
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
});
