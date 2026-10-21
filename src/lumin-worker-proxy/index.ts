import { LUMIN_WORKER_PROXY_URL } from '../types/index.js';

const INSTALLED_FLAG = '__luminWorkerProxyInstalled';
const ORIG_WORKER_KEY = '__luminWorkerProxyOrigWorker';
const WORKER_WRAPPED_FLAG = '__luminWorkerProxyWorkerWrapped';

function proxyHostname(): string | null {
  try {
    return new URL(LUMIN_WORKER_PROXY_URL).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True for the SDK's worker-code fetches (known boot host +
 * /v1/lumin.worker.js path). The SDK fetches one of these per boot host
 * during Lumin.init, before creating its Worker — on school WiFi this is the
 * request that fails with "Worker connection failed: domain fetch failed"
 * while the /api/v1/boot probes still pass.
 */
export function isLuminWorkerUrl(raw: string): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const base =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost/';
    const u = new URL(raw, base);
    if (!u.pathname.includes('/v1/lumin.worker.js')) return false;
    const proxy = proxyHostname();
    if (proxy && u.hostname.toLowerCase() === proxy) return false;
    // Match any cross-origin /v1/lumin.worker.js URL, not just known hosts.
    // Lumin.init decodes worker URLs from the boot response at runtime and may
    // fetch them from hosts not in LUMIN_WORKER_FILE_TARGETS. School filters
    // that block those unlisted hosts cause "Worker connection failed: domain
    // fetch failed" even while fetch probes to known hosts pass. Routing every
    // cross-origin worker fetch through the proxy keeps all worker traffic on
    // the resilient route. Same-origin URLs are left alone (they're not subject
    // to domain-based school filtering).
    const pageHost =
      typeof window !== 'undefined' && window.location?.hostname
        ? window.location.hostname.toLowerCase()
        : '';
    return u.hostname.toLowerCase() !== pageHost;
  } catch {
    return false;
  }
}

/** Rewrite a direct worker fetch to the proxy, preserving any query. */
export function toWorkerFileUrl(raw: string): string {
  const u = new URL(raw);
  return LUMIN_WORKER_PROXY_URL + (u.search || '');
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
 * Route the SDK's worker-code fetches through the worker proxy (which rotates
 * upstreams server-side), falling back to the direct URL if the proxy itself
 * is unreachable. Idempotent. Must run before any Lumin.init call, alongside
 * installLuminBootProxy.
 *
 * Covers three creation paths: window.fetch, XMLHttpRequest, and
 * `new Worker(url)`. The Worker patch matters because a direct
 * `new Worker('https://a.luminsdk.com/v1/lumin.worker.js')` bypasses fetch
 * patching entirely — its network load fails on filtered school WiFi with
 * "Worker connection failed: domain fetch failed" even while fetch probes
 * to the same host pass.
 */
export function installLuminWorkerProxy(): boolean {
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
      if (raw && isLuminWorkerUrl(raw)) {
        const proxyUrl = toWorkerFileUrl(raw);
        const proxyInit: RequestInit = { ...(init ?? {}) };
        // Fall back to the direct URL on proxy network failure AND on HTTP
        // errors: the /lumin/worker edge route only exists after the Cloudflare
        // worker is redeployed, and an old edge serving 404/502 must not mask
        // the SDK's own direct-host rotation.
        return origFetch(proxyUrl, proxyInit).then(
          res => (res.ok ? res : origFetch(input, init)),
          () => origFetch(input, init)
        );
      }
      return origFetch(input, init);
    };
    w[INSTALLED_FLAG] = true;
    (w.__luminWorkerProxyOrigFetch as unknown) = origFetch;
    window.fetch = patchedFetch as typeof window.fetch;
    installWorkerConstructorPatch();
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
            if (isLuminWorkerUrl(raw)) {
              url = toWorkerFileUrl(raw) as unknown as string | URL;
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

/** Rewrite direct `new Worker(luminUrl)` loads to the proxy (see above). */
function installWorkerConstructorPatch(): void {
  try {
    const w = window as unknown as Record<string, unknown> & {
      Worker?: new (url: string | URL, opts?: WorkerOptions) => Worker;
    };
    const Orig = w.Worker;
    if (typeof Orig !== 'function') return;
    if ((Orig as unknown as Record<string, unknown>)[WORKER_WRAPPED_FLAG] === true) return;
    const Wrapped = function (this: unknown, url: string | URL, opts?: WorkerOptions): Worker {
      let out: string | URL = url;
      try {
        const raw = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
        if (isLuminWorkerUrl(raw)) out = toWorkerFileUrl(raw);
      } catch {
        /* keep original */
      }
      return new Orig(out, opts);
    } as unknown as typeof Worker;
    try {
      Wrapped.prototype = Orig.prototype;
      Object.defineProperty(Wrapped, WORKER_WRAPPED_FLAG, { value: true });
    } catch {
      /* best-effort */
    }
    w[ORIG_WORKER_KEY] = Orig;
    w.Worker = Wrapped;
  } catch {
    /* Worker patch is best-effort */
  }
}

/** @internal - restore originals for tests */
export function _uninstallLuminWorkerProxy(): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    const orig = w.__luminWorkerProxyOrigFetch as typeof window.fetch | undefined;
    if (orig) window.fetch = orig;
    delete w[INSTALLED_FLAG];
    delete w.__luminWorkerProxyOrigFetch;
    const origWorker = w[ORIG_WORKER_KEY] as typeof window.Worker | undefined;
    if (origWorker) {
      window.Worker = origWorker;
    } else {
      try {
        const cur = window.Worker as unknown as Record<string, unknown> | undefined;
        if (cur && cur[WORKER_WRAPPED_FLAG] === true) {
          delete (window as unknown as Record<string, unknown>).Worker;
        }
      } catch {
        /* ignore */
      }
    }
    delete w[ORIG_WORKER_KEY];
  } catch {
    /* ignore */
  }
}
