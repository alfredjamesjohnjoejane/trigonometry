import { CDN_TARGETS } from '../types/index.js';
import type { StatusResult } from '../types/index.js';
import {
  loadGames,
  renderGames,
  closeGame,
  filterCat,
  sortGames,
  randomGame,
  searchGames,
  launchGame,
  openGameTab,
} from '../games/index.js';
import {
  showSettingsPage,
  showGamesPage,
  openPanicSetup,
  openCloakSetup,
  resetHubSettings,
  toggleLandingAnims,
} from '../settings/index.js';
import { handleClearCache } from '../cache/index.js';
import { openAboutBlankShell, appendShellIframe, openLandingInAboutBlank } from '../cloak/index.js';
import {
  decodeMediaOS,
  showErrorToast,
  escapeHtml,
  LUMIN_SDK_URL,
  LUMIN_SDK_SRI,
} from '../utils/index.js';
import { MEDIAOS_BASE64 } from '../mediaos/page.js';
import ST from '../storage/index.js';

const MEDIA_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48dGV4dCB5PSIuOWVtIiBmb250LXNpemU9IjkwIj7iiJ48L3RleHQ+PC9zdmc+';

let isOnline = navigator.onLine;
// Shared install prompt: main.ts captures beforeinstallprompt on window,
// ui reads it here. Module-local stays as fallback for tests.
let deferredPrompt: Event | null = null;

function setDeferredPrompt(e: Event | null): void {
  deferredPrompt = e;
  try {
    (window as unknown as { deferredPrompt?: Event | null }).deferredPrompt = e;
  } catch {
    /* ignore */
  }
}

function getDeferredPrompt(): Event | null {
  if (deferredPrompt) return deferredPrompt;
  try {
    return (window as unknown as { deferredPrompt?: Event | null }).deferredPrompt || null;
  } catch {
    return null;
  }
}
let gamesOnline = true;
let checkInProgress = false;
let playTimerStarted = false;

/** Landing hash router (#settings). Called on load and hashchange. */
function initViewFromHash(): void {
  if (location.hash === '#settings') showSettingsPage();
}

function setRandomLandingText(): void {
  const subtext = document.getElementById('landing-subtext');
  if (subtext) {
    const isDih = Math.random() < 0.001;
    subtext.textContent = isDih ? 'The best HammerHeadHub dih' : 'The best HammerHeadHub fork';
  }
}

function showInfoPopup(): void {
  const modal = document.getElementById('info-modal');
  if (modal) modal.classList.add('open');
}

function closeInfoPopup(): void {
  const modal = document.getElementById('info-modal');
  if (modal) modal.classList.remove('open');
}

function computeTOSHash(text: string): string {
  // FNV-1a over the FULL text: the old first-200-chars + length fingerprint
  // missed edits past the prefix, silently treating a revised TOS as agreed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + ':' + text.length;
}

function renderTosText(container: HTMLElement, text: string): void {
  // textContent, never innerHTML: TOS is fetched text and must not parse as
  // HTML even if the response is ever poisoned or served from a stale cache.
  container.replaceChildren();
  const pre = document.createElement('pre');
  pre.style.cssText =
    'color:var(--text-secondary);font-size:.875rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;';
  pre.textContent = text;
  container.appendChild(pre);
}

function showTOSPopup(): void {
  const modal = document.getElementById('tos-modal');
  if (!modal) return;

  // Load TOS content first to compute hash
  fetch('terms_of_service.txt')
    .then(res => {
      if (!res.ok) throw new Error('TOS fetch failed: ' + res.status);
      return res.text();
    })
    .then(currentText => {
      const currentHash = computeTOSHash(currentText);
      const isStillAgreed = isTosAgreementValid(currentHash);

      const container = document.getElementById('tos-content');
      if (container) renderTosText(container, currentText);

      if (isStillAgreed) {
        // TOS still valid - no need to show modal
        modal.classList.remove('open');
        return;
      }

      // Show the modal (either first time or TOS changed).
      // Intentionally NOT dismissable via backdrop click: the user must
      // explicitly click "I Agree" or "Decline". Swallow backdrop clicks
      // so clicking off does nothing.
      modal.classList.add('open');
      modal.onclick = e => {
        e.stopPropagation();
      };
    })
    .catch(() => {
      const container = document.getElementById('tos-content');
      if (container) {
        container.textContent = 'Terms of Service agreement not available.';
      }
      // If we can't load the TOS, still show the modal to be safe
      const modal = document.getElementById('tos-modal');
      if (modal) modal.classList.add('open');
    });
}

function closeTOSPopup(): void {
  const modal = document.getElementById('tos-modal');
  if (modal) modal.classList.remove('open');
}

function showTOSViewer(): void {
  const modal = document.getElementById('tos-viewer-modal');
  if (!modal) return;

  // Manual view (landing page "⚖ TOS" button) IS dismissable via backdrop
  // click  -  unlike the first-visit agreement gate in showTOSPopup.
  modal.onclick = e => {
    if (e.target === modal) {
      closeTOSViewer();
    }
  };

  // Load TOS content
  fetch('terms_of_service.txt')
    .then(res => {
      if (!res.ok) throw new Error('TOS fetch failed: ' + res.status);
      return res.text();
    })
    .then(text => {
      const container = document.getElementById('tos-viewer-content');
      if (container) renderTosText(container, text);
    })
    .catch(() => {
      const container = document.getElementById('tos-viewer-content');
      if (container) {
        container.textContent = 'Terms of Service not available.';
      }
    });

  modal.classList.add('open');
}

function closeTOSViewer(): void {
  const modal = document.getElementById('tos-viewer-modal');
  if (modal) modal.classList.remove('open');
}

function showDCMAInfo(): void {
  const modal =
    document.getElementById('dcma-viewer-modal') || document.getElementById('dmca-viewer-modal');
  if (!modal) return;
  // Dismiss on backdrop click, like the TOS viewer. Do not touch the
  // underlying page visibility: this is an overlay only.
  modal.onclick = e => {
    if (e.target === modal) {
      closeDCMAViewer();
    }
  };
  modal.classList.add('open');
}

function closeDCMAViewer(): void {
  const modal =
    document.getElementById('dcma-viewer-modal') || document.getElementById('dmca-viewer-modal');
  if (modal) modal.classList.remove('open');
}

function acknowledgeTOS(): void {
  // Fetch latest TOS to compute hash
  fetch('terms_of_service.txt')
    .then(res => {
      if (!res.ok) throw new Error('TOS fetch failed: ' + res.status);
      return res.text();
    })
    .then(text => {
      localStorage.setItem('tosAgreed', '1');
      localStorage.setItem('tosAgreedTimestamp', Date.now().toString());
      localStorage.setItem('tosHash', computeTOSHash(text));
      closeTOSPopup();
      // Landing page remains visible - user can click "Continue →" to enter hub
      // or stay on the landing page. Do not auto-hide or show main content here;
      // the normal landing page "Continue →" flow will handle entering the hub.
    })
    .catch(() => {
      // Even if we can't fetch, still store agreement
      localStorage.setItem('tosAgreed', '1');
      localStorage.setItem('tosAgreedTimestamp', Date.now().toString());
      localStorage.setItem('tosHash', '0');
      closeTOSPopup();
      // Landing page remains visible
    });
}

function declineTOS(): void {
  // window.close() is a no-op unless this tab was script-opened, which leaves
  // the user staring at a dead-end modal. Explain instead of pretending.
  const container = document.getElementById('tos-content');
  if (container) {
    container.replaceChildren();
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--text-secondary);font-size:.875rem;line-height:1.6;';
    p.textContent =
      'You declined the Terms of Service, so the hub stays locked. Close this tab, or click I Agree to continue.';
    container.appendChild(p);
  }
}

function openUrlInAboutBlank(url: string, title = 'New Tab'): void {
  // Built with DOM APIs only (see openAboutBlankShell): document.write on
  // the new tab would re-URL it to this page's URL in current Chrome.
  const shell = openAboutBlankShell(title, MEDIA_ICON);
  if (!shell) return;
  const d = shell.doc;
  const css = d.createElement('style');
  css.textContent =
    '.tb{height:54px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:rgba(0,0,0,.85);border-bottom:1px solid rgba(255,255,255,.12);color:#e0e0e0;font-family:Segoe UI,system-ui,sans-serif}.ttl{font-weight:800;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.acts{display:flex;gap:10px;align-items:center}.tb button{border:none;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer;font-family:inherit}.back{background:#555;color:#111}.newtab{background:#444;color:#fff}.close{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.12)}';
  d.head.appendChild(css);
  const hubUrl = location.href.split('#')[0] ?? location.href;
  const bar = d.createElement('div');
  bar.className = 'tb';
  const back = d.createElement('button');
  back.className = 'back';
  back.textContent = '← Back';
  const ttl = d.createElement('div');
  ttl.className = 'ttl';
  ttl.textContent = title;
  const acts = d.createElement('div');
  acts.className = 'acts';
  const newtab = d.createElement('button');
  newtab.className = 'newtab';
  newtab.textContent = '↗ New Tab';
  const close = d.createElement('button');
  close.className = 'close';
  close.textContent = '✕ Close';
  back.onclick = () => {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.focus();
        shell.win.close();
        return;
      }
    } catch {
      /* opener inaccessible — fall through */
    }
    // Opener is gone: reuse this tab for the hub instead of stranding it.
    if (frame) frame.src = hubUrl;
  };
  newtab.onclick = () => openUrlInAboutBlank(url, title);
  close.onclick = () => shell.win.close();
  acts.appendChild(newtab);
  acts.appendChild(close);
  bar.appendChild(back);
  bar.appendChild(ttl);
  bar.appendChild(acts);
  d.body.appendChild(bar);
  const frame = appendShellIframe(shell, { src: url });
  if (!frame) {
    try {
      shell.win.close();
    } catch (e) {}
    return;
  }
  // Shrink the fullscreen shell iframe to sit below the 54px toolbar.
  frame.style.height = 'calc(100% - 54px)';
  try {
    shell.win.focus();
  } catch (e) {}
}

async function openMedia1(): Promise<void> {
  // window.open must run synchronously in the click handler  -  decode MediaOS
  // synchronously (decodeMediaOS is a pure sync function) and place the full
  // page directly as an iframe src (data URL). Using document.open/write on the
  // new tab would re-URL it to this page's URL in current Chrome, so DOM-only
  // construction with iframe src is required.
  const shell = openAboutBlankShell('🎬 Media', MEDIA_ICON);
  if (!shell) {
    showMediaPopupBlocked();
    return;
  }
  // Decode MediaOS synchronously
  const mediaHtml = decodeMediaOS(MEDIAOS_BASE64);
  // Embed the decoded page as an iframe src data URL so content loads immediately.
  // The decoded page is self-contained; scripts run inside the iframe with no
  // parent URL navigation, so the tab stays on about:blank. The ENTIRE document
  // is percent-encoded (the old code appended an encoded blob inside a raw
  // <html> wrapper, which rendered as literal text).
  const frame = appendShellIframe(shell, {
    src: 'data:text/html;charset=utf-8,' + encodeURIComponent(mediaHtml),
  });
  if (!frame) {
    showMediaPopupBlocked();
    return;
  }
  // Shrink the fullscreen shell iframe to sit below the 54px toolbar.
  frame.style.height = 'calc(100% - 54px)';
  try {
    shell.win.focus();
  } catch (e) {}
}
function showMediaPopupBlocked(): void {
  const toast = document.getElementById('error-toast');
  if (toast) {
    toast.textContent = 'Allow popups to open Media';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

async function pingTarget(name: string, url: string): Promise<StatusResult> {
  const start = performance.now();
  try {
    // Reachability probe only: hosts like jsdelivr serve
    // favicons WITHOUT CORS headers, so a default (cors-mode) fetch throws
    // "blocked by CORS policy" + "ERR_FAILED 304" console spam even though
    // the host is up. A single no-cors + no-store fetch never triggers CORS
    // errors and never revalidates cache (no 304s): resolve = reachable,
    // reject/timeout = down. Opaque responses can't expose status codes, but
    // for a CDN up/down check reachability is exactly what we want.
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    try {
      await fetch(url, { signal: c.signal, mode: 'no-cors', cache: 'no-store' });
      return { name, status: 'pass', ms: Math.round(performance.now() - start) };
    } finally {
      clearTimeout(t);
    }
  } catch {
    return { name, status: 'fail', ms: null };
  }
}

async function checkGameStatus(_showToast = true): Promise<void> {
  if (checkInProgress) {
    if (_showToast) showErrorToast('Status check already in progress');
    return;
  }
  checkInProgress = true;
  const placeholderTime = Date.now();
  try {
    updateStatusPlaceholder();

    // Concurrent pings: the old sequential loop took up to 15s on timeouts.
    const settled = await Promise.allSettled(CDN_TARGETS.map(t => pingTarget(t.name, t.url)));
    const results: StatusResult[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { name: CDN_TARGETS[i]?.name ?? 'unknown', status: 'fail' as const, ms: null }
    );

    gamesOnline = results.some(r => r.status === 'pass');

    const elapsed = Date.now() - placeholderTime;
    if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));

    const passCount = results.filter(r => r.status === 'pass').length;
    const failCount = results.length - passCount;
    const parts = results.map(r =>
      r.status === 'pass' ? `${r.name} ✓ (${r.ms}ms)` : `${r.name} ✗`
    );
    const statusLine = gamesOnline
      ? `✅ Online (${passCount}/${results.length} CDNs reachable)`
      : `❌ Offline (${failCount}/${results.length} CDNs unreachable)`;

    setStatusDisplays(`${statusLine} · ${parts.join(' · ')}`, gamesOnline ? 'online' : 'offline');
    updateStatusDisplay(results, gamesOnline);

    if (gamesOnline) {
      hideMaintenance();
    } else {
      showMaintenance();
    }
  } finally {
    checkInProgress = false;
  }
}

function updateStatusPlaceholder(): void {
  const el = document.getElementById('status-results');
  if (!el) return;
  const total = CDN_TARGETS.length;
  el.innerHTML = `<div style="margin-top:12px;padding:14px;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid var(--border);font-size:.875rem">
    <div style="font-weight:700;margin-bottom:10px;color:var(--text-secondary)">?/${total} CDNs reachable</div>
    ${CDN_TARGETS.map(
      t => `<div style="display:flex;justify-content:space-between;padding:4px 0;color:var(--text-secondary);border-bottom:1px solid rgba(255,255,255,.05)">
      <span>${escapeHtml(t.name)}</span>
      <span style="font-weight:600;color:var(--text-secondary)">⏳ ping</span>
    </div>`
    ).join('')}
  </div>`;
}

function updateStatusDisplay(results: StatusResult[], online: boolean): void {
  const el = document.getElementById('status-results');
  if (!el) return;
  const passCount = results.filter(r => r.status === 'pass').length;
  const total = results.length;
  const label = online
    ? `✅ Online (${passCount}/${total} CDNs reachable)`
    : `❌ Offline (${total - passCount}/${total} CDNs unreachable)`;
  el.innerHTML = `<div style="margin-top:12px;padding:14px;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid var(--border);font-size:.875rem">
    <div style="font-weight:700;margin-bottom:10px;color:${online ? '#4caf50' : '#f44336'}">${escapeHtml(label)}</div>
    ${results
      .map(
        r => `<div style="display:flex;justify-content:space-between;padding:4px 0;color:var(--text-secondary);border-bottom:1px solid rgba(255,255,255,.05)">
      <span>${escapeHtml(r.name)}</span>
      <span style="font-weight:600;color:${r.status === 'pass' ? '#4caf50' : '#f44336'}">${r.status === 'pass' ? `✓ ${r.ms}ms` : '✗'}</span>
    </div>`
      )
      .join('')}
  </div>`;
}

function showMaintenance(): void {
  const maintPage = document.getElementById('maintenance-page');
  if (maintPage) maintPage.classList.add('active');
}

function hideMaintenance(): void {
  const maintPage = document.getElementById('maintenance-page');
  if (maintPage) maintPage.classList.remove('active');
}

function setStatusDisplays(text: string, state: string): void {
  const statusEl = document.getElementById('maint-status');
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = `maint-status ${state}`;
  }
}

let pendingLandingChoice: string | null = null;

function showLandingChoice(action: string, label: string): void {
  if (action === 'settings') {
    showSettingsPage();
    return;
  }
  if (action === 'media') {
    runLandingActionHere('media');
    return;
  }
  pendingLandingChoice = action;
  const modal = document.getElementById('landing-choice-modal');
  const title = document.getElementById('landing-choice-title');
  if (title)
    title.textContent = label === 'Continue' ? 'Continue?' : 'Open ' + (label || 'this') + '?';
  if (modal) modal.classList.add('open');
}

function closeLandingChoice(): void {
  const modal = document.getElementById('landing-choice-modal');
  if (modal) modal.classList.remove('open');
}

function runLandingChoice(openNewTab: boolean): void {
  const action = pendingLandingChoice;
  closeLandingChoice();
  if (!action) return;
  if (openNewTab) {
    openLandingActionInNewTab(action);
    return;
  }
  runLandingActionHere(action);
}

function runLandingActionHere(action: string): void {
  if (action === 'hub') enterHub();
  else if (action === 'settings') showSettingsPage();
  else if (action === 'media') openMedia1();
}

function openLandingActionInNewTab(action: string): void {
  if (action === 'media') {
    openUrlInAboutBlank('https://cinemaos.live', '🎬 Media');
    return;
  }
  const shell = openAboutBlankShell(document.title || 'New Tab', MEDIA_ICON);
  if (!shell) {
    const toast = document.getElementById('error-toast');
    if (toast) {
      toast.textContent = 'Allow popups to open new tab';
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }
    return;
  }
  // Iframe the live site instead of document.write-ing a DOM copy (which
  // re-URLs the new tab in current Chrome). Lands on the landing page;
  // click Continue there to enter the hub.
  if (!appendShellIframe(shell, { src: location.href.split('#')[0] })) {
    try {
      shell.win.close();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    shell.win.focus();
  } catch {
    /* ignore */
  }
}

function isTosAgreementValid(currentHash: string): boolean {
  const tosAgreed = ST.get('tosAgreed');
  const tosTimestamp = ST.get('tosAgreedTimestamp');
  const storedHash = ST.get('tosHash');
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const ts = tosTimestamp ? parseInt(tosTimestamp, 10) : NaN;
  return Boolean(
    tosAgreed &&
    storedHash &&
    Number.isFinite(ts) &&
    Date.now() - ts < SEVEN_DAYS &&
    storedHash === currentHash
  );
}

async function enterHub(): Promise<void> {
  // Load TOS content to check hash. A failed fetch must NOT silently enter
  // the hub: fall through to the TOS gate, which shows the modal safely.
  let currentHash: string | null = null;
  try {
    const tosRes = await fetch('terms_of_service.txt');
    if (!tosRes.ok) throw new Error('TOS fetch failed: ' + tosRes.status);
    currentHash = computeTOSHash(await tosRes.text());
  } catch {
    showTOSPopup();
    return;
  }

  const isStillAgreed = currentHash != null && isTosAgreementValid(currentHash);

  if (isStillAgreed) {
    // TOS still valid - proceed to hub. Catalog failure must surface instead
    // of leaving the landing page with no feedback.
    try {
      await loadGames();
    } catch {
      showErrorToast('Could not load game catalog. Check connection and retry.');
      return;
    }
    const lp = document.getElementById('lp');
    if (lp) lp.style.display = 'none';
    const settingsWrap = document.getElementById('settings-wrap');
    if (settingsWrap) {
      settingsWrap.style.display = 'none';
      location.hash = '';
    }
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.style.display = 'block';
    initHomepageTest();
    return;
  }

  // TOS changed or not agreed - show popup
  showTOSPopup();
}

function goMainHomepage(): void {
  closeGame();
  const settingsWrap = document.getElementById('settings-wrap');
  if (settingsWrap) {
    settingsWrap.style.display = 'none';
    location.hash = '';
  }
  const mainContent = document.getElementById('main-content');
  if (mainContent) mainContent.style.display = 'none';
  const lp = document.getElementById('lp');
  if (lp) lp.style.display = 'flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startPlayTimer(): void {
  if (playTimerStarted) return;
  playTimerStarted = true;
  const initial = parseInt(ST.get('playTime') || '0', 10);
  let totalPlayTime = Number.isFinite(initial) && initial >= 0 ? initial : 0;
  const persist = () => {
    ST.set('playTime', totalPlayTime.toString());
  };
  // Persist on hide/close: the old 60s cadence silently dropped up to a
  // minute of play time when the tab closed early.
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persist();
  });
  setInterval(() => {
    // Don't count while hidden.
    if (document.hidden) return;
    totalPlayTime++;
    if (totalPlayTime % 15 === 0) persist();
    const h = Math.floor(totalPlayTime / 3600);
    const m = Math.floor((totalPlayTime % 3600) / 60);
    const timerDisplay = document.getElementById('timer-display');
    const totalTime = document.getElementById('total-time');
    if (timerDisplay) timerDisplay.textContent = `${h}:${m.toString().padStart(2, '0')}`;
    if (totalTime) totalTime.textContent = `Total: ${h}h ${m}m`;
  }, 1000);
}

function initHomepageTest(): void {
  const mount = document.getElementById('test-homepage-games');
  if (!mount) return;
  if (mount.dataset.ready === '1') return;
  mount.dataset.ready = '1';
  const fail = () => {
    mount.dataset.ready = '0';
    mount.textContent = '';
    const div = document.createElement('div');
    div.style.cssText = 'color:#e0e0e0;padding:24px;text-align:center';
    div.textContent = 'Test homepage failed to load';
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.style.cssText =
      'margin-top:12px;background:#444;color:#fff;border:none;border-radius:10px;padding:8px 16px;cursor:pointer';
    retry.addEventListener('click', () => {
      mount.dataset.ready = '';
      initHomepageTest();
    });
    div.appendChild(document.createElement('br'));
    div.appendChild(retry);
    mount.appendChild(div);
  };
  const start = () => {
    // Lumin.init returns a promise that rejects when the SDK boot fails
    // (e.g. its fetched-code Function() evaluation is blocked). Catch async
    // rejections too — try/catch alone left a silent empty mount.
    try {
      const r = (window as unknown as { Lumin?: { init: (o: unknown) => unknown } }).Lumin?.init({
        container: mount,
        theme: 'dark',
      });
      Promise.resolve(r).catch(() => fail());
    } catch {
      fail();
    }
  };
  const w = window as unknown as { Lumin?: { init: (o: unknown) => void } };
  if (w.Lumin && typeof w.Lumin.init === 'function') {
    start();
    return;
  }
  const existing = document.getElementById('lumin-script');
  if (existing) {
    existing.addEventListener('load', start, { once: true });
    existing.addEventListener('error', fail, { once: true });
    return;
  }
  const s = document.createElement('script');
  s.id = 'lumin-script';
  s.src = LUMIN_SDK_URL;
  if (LUMIN_SDK_SRI) {
    s.integrity = LUMIN_SDK_SRI;
    s.crossOrigin = 'anonymous';
  }
  s.onload = start;
  s.onerror = fail;
  document.body.appendChild(s);
}

function installPWA(): void {
  const prompt = getDeferredPrompt();
  if (prompt) {
    try {
      (prompt as unknown as { prompt: () => void }).prompt();
    } catch {
      /* ignore */
    }
    setDeferredPrompt(null);
  }
}

function isStandaloneMode(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function enforcePWAOverlay(): void {
  const overlay = document.getElementById('pwa-enforce-overlay');
  if (!overlay) return;

  if (isStandaloneMode()) {
    // Running as installed PWA — hide the enforcement overlay
    overlay.style.display = 'none';
    return;
  }

  // Not standalone — ensure overlay is visible (it's visible by default in HTML,
  // but this handles cases where something else hid it)
  overlay.style.display = 'flex';

  // Detect iOS
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const iosEl = document.getElementById('pwa-enforce-ios');
  const installBtn = document.getElementById('pwa-enforce-install-btn') as HTMLButtonElement | null;

  if (isIOS && iosEl) {
    iosEl.style.display = 'block';
    if (installBtn) installBtn.style.display = 'none';
  } else if (iosEl) {
    iosEl.style.display = 'none';
  }

  // Try to trigger install prompt automatically
  const prompt = getDeferredPrompt();
  if (prompt && installBtn) {
    installBtn.onclick = () => {
      try {
        (prompt as unknown as { prompt: () => void }).prompt();
      } catch {
        const errEl = document.getElementById('pwa-enforce-error');
        if (errEl) {
          errEl.textContent = 'Install failed. Use browser menu (⋮) → Install app.';
          errEl.style.display = 'block';
        }
      }
    };
  }

  // === STRICT ENFORCEMENT LAYERS ===

  // Layer 1: MutationObserver — re-show overlay if anyone tries to hide/remove it
  const observer = new MutationObserver(_mutations => {
    if (!isStandaloneMode()) {
      // Check if overlay was hidden or removed
      const isHidden =
        overlay.style.display === 'none' ||
        overlay.style.visibility === 'hidden' ||
        overlay.style.opacity === '0';
      const isRemoved = !document.body.contains(overlay);

      if (isHidden || isRemoved) {
        // Re-attach if removed
        if (isRemoved) {
          document.body.appendChild(overlay);
        }
        // Force show
        overlay.style.display = 'flex';
        overlay.style.visibility = 'visible';
        overlay.style.opacity = '1';
        overlay.style.zIndex = '999999';
      }
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(document.body, { childList: true, subtree: true });

  // Layer 2: Visual blocker — ensure overlay stays on top and blocks interaction
  // The HTML already has z-index: 999999, but add a style to prevent any z-index conflicts
  const style = document.createElement('style');
  style.textContent = `
    #pwa-enforce-overlay {
      z-index: 999999 !important;
    }
    #pwa-enforce-overlay * {
      pointer-events: auto !important;
    }
  `;
  document.head.appendChild(style);

  // Layer 3: Resize listener — re-check standalone mode on resize
  window.addEventListener('resize', () => {
    if (!isStandaloneMode()) {
      overlay.style.display = 'flex';
      overlay.style.visibility = 'visible';
      overlay.style.opacity = '1';
    } else {
      overlay.style.display = 'none';
    }
  });

  // Layer 4: Periodic check — catch any edge cases (tab restore, etc.)
  const interval = setInterval(() => {
    if (!isStandaloneMode()) {
      overlay.style.display = 'flex';
      overlay.style.visibility = 'visible';
      overlay.style.opacity = '1';
      if (!document.body.contains(overlay)) {
        document.body.appendChild(overlay);
      }
    } else {
      overlay.style.display = 'none';
      clearInterval(interval);
    }
  }, 2000);
}

function checkPWAInstallAvailability(): void {
  const isStandalone = isStandaloneMode();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const btn = document.getElementById('pwa-install-btn');
  const msg = document.getElementById('pwa-installed-msg');
  const prompt = getDeferredPrompt();
  if (!isStandalone && !isIOS && btn && !prompt) {
    btn.style.display = 'block';
    btn.textContent = 'Open browser menu → Install jesherhead';
    btn.onclick = () => {
      const toast = document.getElementById('error-toast');
      if (toast) {
        toast.textContent = 'Use browser menu (⋮) → Install jesherhead';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
      }
    };
  }
  if (isStandalone && msg) {
    msg.style.display = 'block';
    if (btn) btn.style.display = 'none';
  }
}

function updateOnlineStatus(): void {
  isOnline = navigator.onLine;
  const offlineOverlay = document.getElementById('offline-overlay');
  if (offlineOverlay) {
    offlineOverlay.style.display = isOnline ? 'none' : 'flex';
  }
  renderGames();
}

function openCloak(): void {
  openLandingInAboutBlank();
}

// NOTE: the old duplicate panic/Escape handler (`handleKeys`) was removed.
// It fired the panic redirect while typing in inputs, ignored the user's
// configured panic URL, and duplicated src/panic/index.ts `handlePanicKey`
// (which is the one actually bound in main.ts). Escape-to-close for the
// game overlay is handled by the overlay's own controls.
(window as unknown as Record<string, unknown>).showInfoPopup = showInfoPopup;
(window as unknown as Record<string, unknown>).closeInfoPopup = closeInfoPopup;
(window as unknown as Record<string, unknown>).showTOSPopup = showTOSPopup;
(window as unknown as Record<string, unknown>).closeTOSPopup = closeTOSPopup;
(window as unknown as Record<string, unknown>).showTOSViewer = showTOSViewer;
(window as unknown as Record<string, unknown>).closeTOSViewer = closeTOSViewer;
(window as unknown as Record<string, unknown>).acknowledgeTOS = acknowledgeTOS;
(window as unknown as Record<string, unknown>).declineTOS = declineTOS;
(window as unknown as Record<string, unknown>).showDCMAInfo = showDCMAInfo;
(window as unknown as Record<string, unknown>).showDMCAInfo = showDCMAInfo;
(window as unknown as Record<string, unknown>).closeDCMAViewer = closeDCMAViewer;
(window as unknown as Record<string, unknown>).closeDMCAViewer = closeDCMAViewer;
(window as unknown as Record<string, unknown>).showLandingChoice = showLandingChoice;
(window as unknown as Record<string, unknown>).closeLandingChoice = closeLandingChoice;
(window as unknown as Record<string, unknown>).runLandingChoice = runLandingChoice;
(window as unknown as Record<string, unknown>).enterHub = enterHub;
(window as unknown as Record<string, unknown>).openMedia1 = openMedia1;
(window as unknown as Record<string, unknown>).openCloak = openCloak;
(window as unknown as Record<string, unknown>).openProxy = () => {
  import('./apps.js').then(m => m.openProxy());
};
(window as unknown as Record<string, unknown>).openCinemaOS = () => {
  import('./apps.js').then(m => m.openCinemaOS());
};
(window as unknown as Record<string, unknown>).renderGames = renderGames;
(window as unknown as Record<string, unknown>).filterCat = filterCat;
(window as unknown as Record<string, unknown>).sortGames = sortGames;
(window as unknown as Record<string, unknown>).randomGame = randomGame;
(window as unknown as Record<string, unknown>).searchGames = searchGames;
(window as unknown as Record<string, unknown>).launchGame = launchGame;
(window as unknown as Record<string, unknown>).closeGame = closeGame;
(window as unknown as Record<string, unknown>).openGameTab = openGameTab;
(window as unknown as Record<string, unknown>).goMainHomepage = goMainHomepage;
(window as unknown as Record<string, unknown>).showSettingsPage = showSettingsPage;
(window as unknown as Record<string, unknown>).showGamesPage = showGamesPage;
(window as unknown as Record<string, unknown>).checkGameStatus = checkGameStatus;
(window as unknown as Record<string, unknown>).openPanicSetup = openPanicSetup;
(window as unknown as Record<string, unknown>).openCloakSetup = openCloakSetup;
(window as unknown as Record<string, unknown>).resetHubSettings = resetHubSettings;
(window as unknown as Record<string, unknown>).toggleLandingAnims = toggleLandingAnims;
(window as unknown as Record<string, unknown>).handleClearCache = handleClearCache;
(window as unknown as Record<string, unknown>).installPWA = installPWA;
// Bridges required by main.ts (previously missing, so online/PWA/landing
// init silently no-opped via `?.()`).
(window as unknown as Record<string, unknown>).updateOnlineStatus = updateOnlineStatus;
(window as unknown as Record<string, unknown>).checkPWAInstallAvailability =
  checkPWAInstallAvailability;
(window as unknown as Record<string, unknown>).setRandomLandingText = setRandomLandingText;
(window as unknown as Record<string, unknown>).initHomepageTest = initHomepageTest;
(window as unknown as Record<string, unknown>).initViewFromHash = initViewFromHash;
(window as unknown as Record<string, unknown>).startPlayTimer = startPlayTimer;
(window as unknown as Record<string, unknown>).setDeferredPrompt = setDeferredPrompt;

export {
  setRandomLandingText,
  showInfoPopup,
  closeInfoPopup,
  showTOSPopup,
  closeTOSPopup,
  showTOSViewer,
  closeTOSViewer,
  showDCMAInfo,
  closeDCMAViewer,
  acknowledgeTOS,
  declineTOS,
  showLandingChoice,
  closeLandingChoice,
  runLandingChoice,
  enterHub,
  openMedia1,
  openCloak,
  checkGameStatus,
  goMainHomepage,
  startPlayTimer,
  initHomepageTest,
  initViewFromHash,
  installPWA,
  checkPWAInstallAvailability,
  enforcePWAOverlay,
  isStandaloneMode,
  updateOnlineStatus,
  setDeferredPrompt,
};
