import {
  LUMIN_BACKEND_TARGETS,
  LUMIN_WORKER_BOOT_URL,
  LUMIN_WORKER_ORIGIN,
} from '../types/index.js';
import { LUMIN_PROXY_ORIGINS } from '../types/index.js';

const INSTALLED_FLAG = '__luminBootProxyInstalled';
const URL_REWRITE_FLAG = '__luminUrlRewriteInstalled';

function bootHostnames(): Set<string> {
  const hosts = new Set<string>();
  for (const t of LUMIN_BACKEND_TARGETS) {
    try {
      hosts.add(new URL(t.url).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

function workerHostname(): string | null {
  try {
    return new URL(LUMIN_WORKER_BOOT_URL).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True for the SDK's domain-handshake documents.
 *
 * Before Lumin.init can start, the SDK proves a backend domain is usable by
 * fetching AND loading `/g/_iframe_probe` (and a `/g/<session>/__lumin_canary/`
 * page) and waiting for a postMessage. Those requests live under `/g/`, NOT
 * under the boot API path, so they must not be rewritten to the boot route —
 * that route appends the path to `/api/v1/boot` and answers 404, which kills
 * one of the SDK's two reachability channels.
 */
export function isLuminProbeUrl(raw: string): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const base =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost/';
    const u = new URL(raw, base);
    const worker = workerHostname();
    if (worker && u.hostname.toLowerCase() === worker) return false;
    if (!bootHostnames().has(u.hostname.toLowerCase())) return false;
    return u.pathname.startsWith('/g/');
  } catch {
    return false;
  }
}

/** True for direct SDK fetches to any Lumin boot hostname, any path. The VM
 * the SDK runs after boot can request other paths on these hosts (not just
 * /api/v1/boot), and school filters that silently drop those requests leave
 * Lumin.init hanging forever. Proxying every path on these hostnames keeps
 * every Lumin request on the resilient route. */
export function isLuminBootUrl(raw: string): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const base =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost/';
    const u = new URL(raw, base);
    const worker = workerHostname();
    if (worker && u.hostname.toLowerCase() === worker) return false;
    if (!bootHostnames().has(u.hostname.toLowerCase())) return false;
    // The handshake documents have their own route (see isLuminProbeUrl).
    return !u.pathname.startsWith('/g/');
  } catch {
    return false;
  }
}

/** Rewrite a direct boot URL to the worker proxy, preserving path + query. */
export function toWorkerBootUrl(raw: string): string {
  const u = new URL(raw);
  return LUMIN_WORKER_BOOT_URL + u.pathname + (u.search || '');
}

/**
 * The two handshake documents, byte-for-byte what the Lumin hosts serve.
 * The SDK only needs the postMessage; answering them locally keeps one of
 * its two reachability channels alive when a school filter blocks the hosts.
 */
const LUMIN_PROBE_HTML =
  '<!doctype html><meta charset=utf-8><title>lumin</title><script>try{parent.postMessage("lumin-ok-frame","*")}catch(e){}</script>';

/** Canary answer: echoes the nonce the SDK put in the query string. */
function luminCanaryHtml(nonce: string): string {
  return (
    '<!doctype html><html><head><meta charset=utf-8><title>lumin</title><script>' +
    '(function(){try{var m=(window.location.search||"").match(/[?&]__lp=([^&]+)/);' +
    'var n=m?decodeURIComponent(m[1]):"";if(window.parent&&window.parent!==window){' +
    `window.parent.postMessage({__lumin:"frame-ok",game:"__lumin_canary",nonce:${JSON.stringify(
      nonce
    )}},"*");}}catch(e){}})();</script></head><body></body></html>`
  );
}

/** Local answer for a handshake document the network could not deliver. */
export function luminHandshakeResponse(url: URL): Response {
  const canary = url.pathname.endsWith('/__lumin_canary/');
  const nonce = url.searchParams.get('__lp') || '';
  const body = canary ? luminCanaryHtml(nonce) : LUMIN_PROBE_HTML;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Lumin-Handshake': 'local',
    },
  });
}

/** Try the network first, but never wait longer than this for the answer. */
const LUMIN_HANDSHAKE_TIMEOUT_MS = 2000;

const SHIM_FLAG = '__luminHandshakeShimInstalled';
const originalSrc = new WeakMap<HTMLIFrameElement, string>();

/** Hosts that serve the SDK's backend (and therefore its handshake pages). */
function handshakeHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const t of LUMIN_BACKEND_TARGETS) {
    try {
      hosts.add(new URL(t.url).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

/** The handshake document of a Lumin domain, or null. */
export function luminHandshakeUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const base =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost/';
    const u = new URL(raw, base);
    if (!handshakeHosts().has(u.hostname.toLowerCase())) return null;
    if (!u.pathname.startsWith('/g/')) return null;
    if (u.pathname === '/g/_iframe_probe' || u.pathname.endsWith('/__lumin_canary/')) return u;
    return null;
  } catch {
    return null;
  }
}

/** Blob URL with the same content the upstream handshake page serves. */
function handshakeBlobUrl(u: URL): string {
  const canary = u.pathname.endsWith('/__lumin_canary/');
  const nonce = u.searchParams.get('__lp') || '';
  const html = canary ? luminCanaryHtml(nonce) : LUMIN_PROBE_HTML;
  try {
    return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  } catch {
    return 'about:blank';
  }
}

/**
 * Deliver the handshake message the SDK waits for.
 *
 * The SDK checks the ORIGIN of the message (it has to be the Lumin domain),
 * so a blob: frame cannot deliver it: a blob inherits the page's origin.
 * The page therefore posts the message itself, with the Lumin origin, as a
 * synthetic MessageEvent.
 */
function deliverHandshakeMessage(u: URL, iframe: HTMLIFrameElement): void {
  const origin = u.origin;
  const data = u.pathname.endsWith('/__lumin_canary/')
    ? { __lumin: 'frame-ok', game: '__lumin_canary', nonce: u.searchParams.get('__lp') || '' }
    : 'lumin-ok-frame';
  const send = (): void => {
    try {
      const source = (iframe.contentWindow ?? null) as unknown as MessageEventSource;
      window.dispatchEvent(
        new MessageEvent('message', { data, origin, source, bubbles: false, cancelable: false })
      );
    } catch {
      /* ignore */
    }
  };
  // The SDK attaches its listener before it loads the probe, but the order is
  // not guaranteed — send now, when the frame loaded, and once more shortly
  // after. A duplicate message is harmless.
  send();
  try {
    iframe.addEventListener('load', send, { once: true });
  } catch {
    /* ignore */
  }
  try {
    setTimeout(send, 400);
  } catch {
    /* ignore */
  }
}

/**
 * Answer the SDK's domain handshake from the page.
 *
 * The SDK proves that a backend domain is usable by loading a hidden iframe
 * (`<domain>/g/_iframe_probe`, then a `<domain>/g/<session>/__lumin_canary/`
 * page) and waiting for a postMessage. Those are cross-origin DOCUMENT
 * requests: a school filter that blocks the Lumin hosts kills them, and the
 * init then fails with "Worker connection failed: domain fetch failed" on
 * every domain — even though the boot API and the worker file are reachable.
 *
 * The handshake pages carry no data, they only post a message. So the page
 * can serve them itself: the iframe src is rewritten to a blob: URL with the
 * same content. The game data still comes from the real backend — only the
 * reachability probe is answered locally.
 */
export function installLuminHandshakeShim(): boolean {
  try {
    const w = window as unknown as Record<string, unknown>;
    if (w[SHIM_FLAG] === true) return true;
    const proto = window.HTMLIFrameElement?.prototype;
    if (!proto) return false;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc?.get || !desc?.set) return false;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: HTMLIFrameElement): string {
        return originalSrc.get(this) ?? desc.get!.call(this);
      },
      set(this: HTMLIFrameElement, value: string): void {
        originalSrc.set(this, value);
        const u = luminHandshakeUrl(value);
        if (!u) {
          desc.set!.call(this, value);
          return;
        }
        desc.set!.call(this, handshakeBlobUrl(u));
        deliverHandshakeMessage(u, this);
      },
    });
    // Some code paths use setAttribute('src', ...) instead of the property.
    const origSetAttribute = proto.setAttribute;
    proto.setAttribute = function (this: HTMLIFrameElement, name: string, value: string) {
      if (String(name).toLowerCase() === 'src') {
        const u = luminHandshakeUrl(String(value));
        if (u) {
          originalSrc.set(this, String(value));
          origSetAttribute.call(this, 'src', handshakeBlobUrl(u));
          deliverHandshakeMessage(u, this);
          return;
        }
      }
      return origSetAttribute.call(this, name, value);
    } as typeof proto.setAttribute;
    w[SHIM_FLAG] = true;
    return true;
  } catch {
    return false;
  }
}

/** Rewrite an absolute URL on a proxied origin to /lumin/x/<origin>/<path>. */
function toProxyUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!LUMIN_PROXY_ORIGINS.includes(u.hostname.toLowerCase())) return null;
    return `${LUMIN_WORKER_ORIGIN}/lumin/x/${u.hostname.toLowerCase()}${u.pathname}${u.search || ''}`;
  } catch {
    return null;
  }
}

/** The Lumin origin each proxied iframe was really loaded from. */
const proxiedFrameOrigins = new WeakMap<HTMLIFrameElement, string>();
/** Fast path: the WindowProxy a message came from -> its real origin. */
const reoriginatedSources = new WeakMap<object, string>();
let messageReoriginInstalled = false;

function rememberProxiedOrigin(iframe: HTMLIFrameElement, rawUrl: string): void {
  try {
    proxiedFrameOrigins.set(iframe, new URL(rawUrl).origin);
  } catch {
    /* ignore */
  }
}

/**
 * Re-stamp messages from proxied game frames with their original Lumin origin.
 *
 * The SDK creates the game as `<domain>/g/...` and only accepts the
 * `{__lumin:"frame-ok", ...}` readiness handshake when the message comes from
 * that domain. Because the frame is loaded through the worker proxy, its
 * messages carry the worker's origin instead: the SDK rejects every candidate
 * domain, deletes the hidden probe and retries the next host forever — the
 * game never becomes visible. The page can restore the expected origin because
 * it knows which origin each rewritten frame stands for (the proxy URL encodes
 * it). The original message is stopped and re-dispatched with the Lumin origin,
 * the same trick the /g/_iframe_probe answer uses.
 */
function installMessageReorigin(): void {
  if (messageReoriginInstalled) return;
  messageReoriginInstalled = true;
  window.addEventListener(
    'message',
    (event: MessageEvent) => {
      try {
        if (event.origin !== LUMIN_WORKER_ORIGIN) return;
        const source = event.source as unknown as object | null;
        if (!source) return;
        let origin = reoriginatedSources.get(source);
        if (!origin) {
          for (const frame of Array.from(document.querySelectorAll('iframe'))) {
            if (frame.contentWindow !== event.source) continue;
            const real = proxiedFrameOrigins.get(frame);
            if (real) {
              origin = real;
              reoriginatedSources.set(source, real);
            }
            break;
          }
        }
        if (!origin) return;
        event.stopImmediatePropagation();
        window.dispatchEvent(
          new MessageEvent('message', {
            data: event.data,
            origin,
            source: event.source,
            bubbles: false,
            cancelable: false,
          })
        );
      } catch {
        /* message plumbing must never break the page */
      }
    },
    true
  );
}

/**
 * Rewrite Lumin game URLs to the worker proxy so every resource the game
 * player loads stays on the single origin the school allows.
 *
 * The SDK creates the game as a cross-origin iframe
 * (`<domain>/g/<session>/<game>/`) and navigates/loads game assets from the
 * Lumin domains. A school filter may block those origins or the /g/ game
 * paths even while /api/v1/boot stays reachable. Rewriting iframe src,
 * location navigations and window.open targets to
 * /lumin/x/<origin>/<path> routes every resource through the worker proxy
 * (server-side fetch on Cloudflare, so the school filter never sees the
 * original host). Proxied HTML rewrites absolute URLs on the proxy too, so
 * the game's subresources stay on the proxy as well.
 */
export function installLuminUrlRewrite(): boolean {
  try {
    const w = window as unknown as Record<string, unknown>;
    if (w[URL_REWRITE_FLAG] === true) return true;

    const proto = window.HTMLIFrameElement?.prototype;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (desc?.get && desc?.set) {
        const descSet = desc.set;
        Object.defineProperty(proto, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get(this: HTMLIFrameElement): string {
            return desc.get!.call(this);
          },
          set(this: HTMLIFrameElement, value: string) {
            const u = luminHandshakeUrl(value);
            if (u) {
              // Handshake page: answer locally (same as installLuminHandshakeShim).
              descSet.call(this, handshakeBlobUrl(u));
              deliverHandshakeMessage(u, this);
              return;
            }
            const rewritten = toProxyUrl(value);
            if (rewritten) {
              // Load the proxied game document directly. The worker strips
              // upstream frame restrictions (no X-Frame-Options on the proxied
              // HTML), so the frame can embed it. Keeping it a real document is
              // essential: srcdoc copies have about:srcdoc as their URL and the
              // browser refuses a cross-origin <base>, so every relative game
              // asset resolved against the hub origin and 404'd — the game
              // never rendered.
              rememberProxiedOrigin(this, value);
              descSet.call(this, rewritten);
              return;
            }
            descSet.call(this, value);
          },
        });
      }
      // Some code paths use setAttribute('src', ...) instead of the property.
      const origSetAttribute = proto.setAttribute;
      proto.setAttribute = function (this: HTMLIFrameElement, name: string, value: string) {
        if (String(name).toLowerCase() === 'src') {
          const u = luminHandshakeUrl(String(value));
          if (u) {
            origSetAttribute.call(this, 'src', handshakeBlobUrl(u));
            deliverHandshakeMessage(u, this);
            return;
          }
          const rewritten = toProxyUrl(String(value));
          if (rewritten) {
            // Load the proxied document directly (see the src setter above):
            // the proxy strips X-Frame-Options, and a real document keeps the
            // proxied URL as its base URI so relative assets resolve correctly.
            rememberProxiedOrigin(this, String(value));
            origSetAttribute.call(this, 'src', rewritten);
            return;
          }
        }
        return origSetAttribute.call(this, name, value);
      } as typeof proto.setAttribute;
    }

    // location.href = ... and location.assign/replace.
    const locProto = Location.prototype;
    const hrefDesc = Object.getOwnPropertyDescriptor(locProto, 'href');
    if (hrefDesc?.set) {
      Object.defineProperty(locProto, 'href', {
        configurable: true,
        enumerable: hrefDesc.enumerable,
        get: hrefDesc.get,
        set(this: Location, v: string) {
          const rewritten = toProxyUrl(v);
          hrefDesc.set!.call(this, rewritten != null ? rewritten : v);
        },
      });
    }
    const locAssign = Location.prototype.assign;
    Location.prototype.assign = function (this: Location, v: string) {
      const rewritten = toProxyUrl(v);
      locAssign.call(this, rewritten != null ? rewritten : v);
    };
    const locReplace = Location.prototype.replace;
    Location.prototype.replace = function (this: Location, v: string) {
      const rewritten = toProxyUrl(v);
      locReplace.call(this, rewritten != null ? rewritten : v);
    };

    // window.open.
    const origOpen = w.open;
    if (typeof origOpen === 'function') {
      w.open = function (this: Window, url?: string, target?: string, features?: string) {
        const rewritten = toProxyUrl(url ?? '');
        return origOpen.call(w, rewritten != null ? rewritten : url, target, features);
      };
    }

    // Game frames are proxied, so their readiness messages arrive with the
    // worker origin; restore the Lumin origin the SDK validates against.
    installMessageReorigin();

    w[URL_REWRITE_FLAG] = true;
    return true;
  } catch {
    return false;
  }
}

function extractUrl(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    return null;
  } catch {
    return null;
  }
}

/**
 * Route the SDK stub's boot fetches through the worker proxy (which rotates
 * upstreams server-side), falling back to the direct URL if the proxy itself
 * is unreachable. Idempotent. Must run before any Lumin.init call.
 */
export function installLuminBootProxy(): boolean {
  try {
    const w = window as unknown as Record<string, unknown>;
    if (w[INSTALLED_FLAG] === true) return true;
    if (typeof window.fetch !== 'function') return false;
    const origFetch = window.fetch.bind(window);
    const patchedFetch = function (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      const raw = extractUrl(input);
      if (raw && isLuminProbeUrl(raw)) {
        // Handshake document: keep it off the boot route (that route would
        // answer 404) and answer it ourselves when the network cannot.
        // The SDK treats a failed handshake as "this domain is unreachable"
        // and gives up on it — with a filter in front of the Lumin hosts
        // that killed the whole init ("domain fetch failed").
        const u = new URL(raw);
        const local = (): Response => luminHandshakeResponse(u);
        const network = origFetch(raw, init).then(
          res => (res.ok ? res : local()),
          () => local()
        );
        return Promise.race([
          network,
          new Promise<Response>(resolve => {
            setTimeout(() => resolve(local()), LUMIN_HANDSHAKE_TIMEOUT_MS);
          }),
        ]);
      }
      if (raw && isLuminBootUrl(raw)) {
        const proxyUrl = toWorkerBootUrl(raw);
        const proxyInit: RequestInit = { ...(init ?? {}) };
        return origFetch(proxyUrl, proxyInit).catch(() => origFetch(input, init));
      }
      return origFetch(input, init);
    };
    w[INSTALLED_FLAG] = true;
    (w.__luminBootProxyOrigFetch as unknown) = origFetch;
    window.fetch = patchedFetch as typeof window.fetch;
    // The handshake pages are cross-origin documents: the fetch patch above
    // cannot help them, so the iframe src is answered locally.
    try {
      installLuminHandshakeShim();
    } catch {
      /* best-effort */
    }
    // Rewrite Lumin game URLs (iframe srcs, location navigations,
    // window.open targets) to the worker proxy so game resources never hit
    // potentially-filtered origins directly.
    try {
      installLuminUrlRewrite();
    } catch {
      /* best-effort */
    }
    try {
      const XHR = window.XMLHttpRequest;
      if (typeof XHR !== 'undefined' && XHR.prototype?.open) {
        const origOpen = XHR.prototype.open;
        XHR.prototype.open = function (
          method: string,
          url: string | URL,
          ...rest: unknown[]
        ): void {
          try {
            const raw = String(url);
            if (isLuminBootUrl(raw)) {
              url = toWorkerBootUrl(raw) as unknown as string | URL;
            }
          } catch {
            /* keep original */
          }
          (origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest] as unknown[]);
        };
      }
    } catch {
      /* XHR patch is best-effort */
    }
    return true;
  } catch {
    return false;
  }
}

/** @internal - restore originals for tests */
export function _uninstallLuminBootProxy(): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    const orig = w.__luminBootProxyOrigFetch as typeof window.fetch | undefined;
    if (orig) window.fetch = orig;
    delete w[INSTALLED_FLAG];
    delete w.__luminBootProxyOrigFetch;
  } catch {
    /* ignore */
  }
}
