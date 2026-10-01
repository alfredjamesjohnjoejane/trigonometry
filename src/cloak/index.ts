import {
  HAMMER_TITLE,
  HAMMER_ICON,
  FAVICON_TYPES,
  CLOAK_PRESETS,
  normalizeCloakUrl,
} from '../types/index.js';
import ST from '../storage/index.js';
import { isSafeHttpUrl } from '../utils/index.js';

const DEFAULT_CLOAK = {
  title: 'Google Classroom',
  url: 'https://classroom.google.com/',
  icon: 'https://ssl.gstatic.com/classroom/favicon.png',
};

function faviconFromUrl(url: string): string {
  const normalized = normalizeCloakUrl(url) || DEFAULT_CLOAK.url;
  return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(normalized)}`;
}

function isSafeFaviconUrl(href: string): boolean {
  if (!href) return false;
  const v = href.trim();
  if (v.startsWith('data:image/')) return true;
  // Relative icon paths (icon.png) are same-origin and safe.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return true;
  return isSafeHttpUrl(v);
}

function setFavicon(href: string): void {
  const safeHref = isSafeFaviconUrl(href) ? href : HAMMER_ICON;
  let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!icon) {
    icon = document.createElement('link');
    icon.rel = 'icon';
    document.head.appendChild(icon);
  }
  icon.href = safeHref || HAMMER_ICON;
  // Google s2 URLs (...?sz=64&domain_url=...) have no file extension — skip
  // type inference for query-string favicons instead of setting type="".
  try {
    const parsed = new URL(icon.href, window.location.origin);
    if (parsed.search) {
      icon.removeAttribute('type');
      return;
    }
    const ext = (parsed.pathname.split('.').pop() || '').toLowerCase();
    const mapped = FAVICON_TYPES[ext];
    if (mapped) icon.type = mapped;
    else icon.removeAttribute('type');
  } catch {
    icon.removeAttribute('type');
  }
}

function getCloakSettings() {
  const rawTitle = (ST.get('cloakTitle') || '').trim();
  const rawUrl = normalizeCloakUrl(ST.get('cloakUrl'));
  const rawIcon = (ST.get('cloakIcon') || '').trim();
  // Empty URL = cloak disabled ("normal" preset). Invalid URLs fall back to
  // the Classroom default instead of becoming open redirects/intranet probes.
  const url = !rawUrl ? '' : isSafeHttpUrl(rawUrl) ? rawUrl : DEFAULT_CLOAK.url;
  return {
    title: rawTitle || (url ? DEFAULT_CLOAK.title : HAMMER_TITLE),
    url,
    icon: rawIcon && isSafeFaviconUrl(rawIcon) ? rawIcon : url ? DEFAULT_CLOAK.icon : HAMMER_ICON,
  };
}

// Cloak only after the tab has actually lost focus once. On initial load
// document.hasFocus() is false until interaction, which used to show the
// decoy title on the active hub tab.
let cloakArmed = false;

export function updateCloakTabState(): void {
  const c = getCloakSettings();
  if (!c.url) {
    document.title = HAMMER_TITLE;
    setFavicon(HAMMER_ICON);
    return;
  }
  const blurred = !document.hasFocus() || document.hidden;
  const showDecoy = cloakArmed && blurred;
  document.title = showDecoy ? c.title : HAMMER_TITLE;
  setFavicon(showDecoy ? c.icon : HAMMER_ICON);
}

export function installCloakFocusHandlers(): void {
  const arm = () => {
    cloakArmed = true;
    updateCloakTabState();
  };
  window.addEventListener('blur', arm);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) arm();
    else updateCloakTabState();
  });
  window.addEventListener('focus', updateCloakTabState);
  updateCloakTabState();
}

export function saveCustomCloak(): void {
  const title =
    ((document.getElementById('cloak-title') as HTMLInputElement | null)?.value || '').trim() ||
    'Google Classroom';
  const rawUrl =
    (document.getElementById('cloak-url') as HTMLInputElement | null)?.value ||
    'https://classroom.google.com/';
  const url = normalizeCloakUrl(rawUrl);
  if (url && !isSafeHttpUrl(url)) {
    showErrorToast('Cloak URL blocked: use a public http(s) URL');
    return;
  }
  const rawIcon = (
    (document.getElementById('cloak-icon') as HTMLInputElement | null)?.value || ''
  ).trim();
  const icon = rawIcon
    ? isSafeFaviconUrl(rawIcon)
      ? rawIcon
      : faviconFromUrl(url || DEFAULT_CLOAK.url)
    : faviconFromUrl(url || DEFAULT_CLOAK.url);
  ST.set('cloakTitle', title);
  ST.set('cloakUrl', url);
  ST.set('cloakIcon', icon);
  ST.set('cloakPreset', 'custom');
  updateCloakTabState();
  showErrorToast('Cloak saved');
}

export function applyCloakPreset(type: keyof typeof CLOAK_PRESETS, silent = false): void {
  const p = CLOAK_PRESETS[type] || CLOAK_PRESETS.classroom;
  ST.set('cloakPreset', type);
  ST.set('cloakTitle', p[0]);
  ST.set('cloakUrl', p[1]);
  ST.set('cloakIcon', p[2]);
  const ct = document.getElementById('cloak-title') as HTMLInputElement | null;
  const cu = document.getElementById('cloak-url') as HTMLInputElement | null;
  const ci = document.getElementById('cloak-icon') as HTMLInputElement | null;
  if (ct) ct.value = p[0];
  if (cu) cu.value = p[1];
  if (ci) ci.value = p[2];
  updateCloakTabState();
  if (!silent) showErrorToast(type === 'normal' ? 'Cloak reset' : 'Cloak preset saved');
}

function showErrorToast(msg: string): void {
  const toast = document.getElementById('error-toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

export interface AboutBlankShell {
  win: Window;
  doc: Document;
}

// Opens a true about:blank popup and dresses it via DOM APIs only.
// IMPORTANT: never use document.open()/write() on the new window  -  in
// current Chrome that re-URLs the tab to this page's URL almost instantly.
// DOM manipulation never navigates, so the tab stays on about:blank.
// Must be called synchronously from a user gesture (no await before it).
export function openAboutBlankShell(title: string, icon: string): AboutBlankShell | null {
  let w: Window | null = null;
  try {
    w = window.open('about:blank', '_blank', 'noopener,noreferrer');
  } catch {
    w = null;
  }
  if (!w) return null;
  try {
    if (w.opener) {
      try {
        (w as Window & { opener?: null }).opener = null;
      } catch {
        /* ignore */
      }
    }
    const d = w.document;
    d.title = title;
    let iconEl = d.querySelector("link[rel='icon']");
    if (!iconEl) {
      iconEl = d.createElement('link');
      iconEl.setAttribute('rel', 'icon');
      d.head.appendChild(iconEl);
    }
    iconEl.setAttribute('href', isSafeFaviconUrl(icon) ? icon : HAMMER_ICON);
    if (!d.querySelector('style[data-cloak-shell]')) {
      const st = d.createElement('style');
      st.setAttribute('data-cloak-shell', '1');
      st.textContent =
        'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{width:100%;height:100%;border:none;background:#000}';
      d.head.appendChild(st);
    }
    if (d.body) d.body.style.margin = '0';
  } catch {
    try {
      w.close();
    } catch {
      /* ignore */
    }
    return null;
  }
  return { win: w, doc: w.document };
}

// Appends a fullscreen iframe to a shell. `src` navigates only the iframe
// (parent URL untouched); `srcdoc` renders inline HTML (scripts run) with
// no parsing in the outer document, so no escaping is needed.
//
// Every frame is sandboxed: `srcdoc` content (cached third-party game HTML,
// proxy/cinema shells) must never gain same-origin access to the hub, where
// it could read localStorage or the parent DOM. `allow-same-origin` is
// deliberately omitted; games that need origin-keyed storage still work via
// `allow-storage-access-by-user-activation` where the browser grants it.
export function appendShellIframe(
  shell: AboutBlankShell,
  opts: { src?: string; srcdoc?: string }
): HTMLIFrameElement | null {
  try {
    const f = shell.doc.createElement('iframe');
    if (opts.src != null) f.src = opts.src;
    if (opts.srcdoc != null) f.srcdoc = opts.srcdoc;
    // NOTE: do not set allowFullscreen (allowfullscreen attr): when both it
    // and allow="... fullscreen" are present Chrome logs "Allow attribute
    // will take precedence over 'allowfullscreen'". The allow token alone
    // already grants fullscreen.
    // Sandboxed without allow-same-origin / allow-top-navigation so inlined
    // third-party HTML cannot touch the opener or navigate the shell.
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
    // Keep storage-access (browser gates it on user activation): dropping it
    // breaks game saves with no security benefit.
    f.setAttribute('allow', 'storage-access *; autoplay; fullscreen');
    shell.doc.body.appendChild(f);
    return f;
  } catch (e) {
    return null;
  }
}

export function openLandingInAboutBlank(): void {
  // A file:// page has an opaque origin, so a blank window could not load
  // anything. Cloak requires the site served over http(s).
  if (location.protocol === 'file:') {
    showErrorToast('Cloak needs http(s): use npm run dev or the deployed link');
    return;
  }
  const c = getCloakSettings();
  // Embed the live site in a full-window iframe. The iframe performs a real
  // navigation to this page, so all HTML/JS/CSS loads and runs exactly as
  // normal  -  while the top-level tab stays on about:blank with the decoy
  // title and icon. (Writing page HTML into the new tab via document.write
  // is what flipped its URL back to the real one, so the shell is built
  // with DOM APIs only  -  see openAboutBlankShell.)
  // Strip any hash so the cloak always lands on the landing page.
  const siteUrl = location.href.split('#')[0] ?? location.href;
  const shell = openAboutBlankShell(c.title, c.icon);
  if (!shell) {
    showErrorToast('Allow popups to open cloak');
    return;
  }
  if (!appendShellIframe(shell, { src: siteUrl })) {
    showErrorToast('Cloak blocked by browser: allow popups and retry');
    try {
      shell.win.close();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    shell.win.focus();
  } catch (_e) {}
  // Leave no trace: turn this tab into the decoy page. Empty URL means the
  // "normal" preset (no cloak) — stay on the hub instead of redirecting.
  if (!c.url) return;
  if (!isSafeHttpUrl(c.url)) return;
  setTimeout(() => {
    try {
      location.replace(c.url);
    } catch (e) {
      try {
        location.href = c.url;
      } catch (_e) {}
    }
  }, 300);
}

export { normalizeCloakUrl };
