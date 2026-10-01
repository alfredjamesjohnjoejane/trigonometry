import { BLOCKED_PORTED_DOMAIN } from '../types/index.js';

export function isBlockedPortedUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    // Compare hostnames exactly so a URL that merely contains the blocked
    // domain as a query param is not over-blocked.
    const blockedHost = new URL('https://' + BLOCKED_PORTED_DOMAIN).hostname.toLowerCase();
    const u = new URL(url, window.location.origin);
    if (u.hostname.toLowerCase() === blockedHost) return true;
  } catch {
    // Fall through to substring check for non-parseable relative strings.
  }
  return url.includes(BLOCKED_PORTED_DOMAIN);
}

export function sanitizePortedUrl(url: string | null | undefined): string | null | undefined {
  if (url == null) return url;
  const s = String(url);
  return isBlockedPortedUrl(s) ? '/' : url;
}

export function scrubPortedLinks(): void {
  document
    .querySelectorAll('a[href],iframe[src],form[action],meta[http-equiv="refresh"]')
    .forEach(el => {
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (isBlockedPortedUrl(href) || isBlockedPortedUrl((el as HTMLAnchorElement).href)) {
          el.setAttribute('href', '/');
        }
      } else if (el.tagName === 'IFRAME') {
        const src = el.getAttribute('src') || '';
        if (isBlockedPortedUrl(src)) {
          el.setAttribute('src', '/');
        }
      } else if (el.tagName === 'FORM') {
        const action = el.getAttribute('action') || '';
        if (isBlockedPortedUrl(action) || isBlockedPortedUrl((el as HTMLFormElement).action)) {
          el.setAttribute('action', '/');
        }
      } else if (el.tagName === 'META') {
        const content = el.getAttribute('content') || '';
        if (isBlockedPortedUrl(content)) {
          el.remove();
        }
      }
    });
}

export function setupBlockedUrlGuards(): void {
  const __origWindowOpen = window.open.bind(window);
  window.open = function (url: string | URL | undefined, target?: string, features?: string) {
    const merged = [features, 'noopener,noreferrer'].filter(Boolean).join(',');
    return __origWindowOpen(
      sanitizePortedUrl(url as string) as string | URL | undefined,
      target,
      merged
    );
  };

  try {
    const __locAssign = window.location.assign.bind(window.location);
    const __locReplace = window.location.replace.bind(window.location);
    Location.prototype.assign = function (url: string | URL) {
      return __locAssign(sanitizePortedUrl(url as string) as string | URL);
    };
    Location.prototype.replace = function (url: string | URL) {
      return __locReplace(sanitizePortedUrl(url as string) as string | URL);
    };
  } catch (e) {}

  document.addEventListener(
    'click',
    e => {
      const a =
        (e.target as HTMLElement | null) && (e.target as HTMLElement).closest
          ? (e.target as HTMLElement).closest('a[href]')
          : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (isBlockedPortedUrl(href) || isBlockedPortedUrl((a as HTMLAnchorElement).href)) {
        e.preventDefault();
        window.location.href = '/';
      }
    },
    true
  );

  document.addEventListener(
    'submit',
    e => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const action = form.getAttribute('action') || '';
      if (isBlockedPortedUrl(action) || isBlockedPortedUrl(form.action)) {
        e.preventDefault();
        window.location.href = '/';
      }
    },
    true
  );

  document.addEventListener('DOMContentLoaded', scrubPortedLinks);
  // Debounced observer: scrubbing the whole document on every mutation
  // caused O(n^2) re-scans when rendering the 1000+ card grid. Batch via
  // requestAnimationFrame so a burst of inserts scrubs once.
  let scrubQueued = false;
  const queueScrub = () => {
    if (scrubQueued) return;
    scrubQueued = true;
    const run = () => {
      scrubQueued = false;
      try {
        scrubPortedLinks();
      } catch {
        /* ignore */
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  };
  new MutationObserver(queueScrub).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export function decodeMediaOS(b64: string): string {
  return decodeURIComponent(
    atob(b64)
      .split('')
      .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
}

/** Escape a string for safe interpolation into HTML text content. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, c => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/** Escape a string for safe interpolation into an HTML attribute. */
export function escapeAttr(value: string): string {
  return String(value).replace(/[&<>"']/g, c => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/**
 * Returns true only for public http(s) URLs. Rejects javascript:, data:,
 * blob:, credentials-in-URL, and non-routable hosts so user-controlled
 * strings (game catalog, panic/cloak URLs, imports) can never become
 * script execution or intranet probes.
 */
export function isSafeHttpUrl(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|30|31)\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return false;
  }
  return true;
}

export function buildGameIframeHtml(url: string): string {
  const safe = isSafeHttpUrl(url) ? url : '/';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:#000}iframe{width:100%;height:100%;border:none;background:#000}</style></head><body><iframe src="${escapeAttr(safe)}" allow="storage-access *; autoplay; fullscreen"></iframe></body></html>`;
}

// Lumin SDK has no version tags (jsdelivr versions API returns []), so @latest
// is the only working ref. Verified 2026-09-21: @1 404s, @latest 200s. If the
// repo ever publishes tags, pin here and add the SRI hash alongside.
export const LUMIN_SDK_URL = 'https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js';
export const LUMIN_SDK_SRI = '';

export function getTestPageHtml(): string {
  const integrity = LUMIN_SDK_SRI ? ` integrity="${LUMIN_SDK_SRI}" crossorigin="anonymous"` : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>html,body{margin:0;width:100%;min-height:100%;overflow:auto;background:#111}body{font-family:Segoe UI,system-ui,sans-serif}#games{width:100%;min-height:100vh;background:#111}</style></head><body><div id="games"></div><script src="${LUMIN_SDK_URL}"${integrity}></script><script>Lumin.init({container:document.getElementById("games"),theme:"dark"});</script></body></html>`;
}

export function showErrorToast(msg: string): void {
  const toast = document.getElementById('error-toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

export function showTooltip(e: MouseEvent, text: string): void {
  const t = document.getElementById('tooltip');
  if (t) {
    t.textContent = text;
    t.classList.add('show');
    t.style.left = Math.min(e.clientX + 15, window.innerWidth - 300) + 'px';
    t.style.top = Math.min(e.clientY + 15, window.innerHeight - 100) + 'px';
  }
}

export function hideTooltip(): void {
  const t = document.getElementById('tooltip');
  if (t) t.classList.remove('show');
}
