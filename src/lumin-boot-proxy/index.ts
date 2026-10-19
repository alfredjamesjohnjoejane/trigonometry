import { LUMIN_BACKEND_TARGETS, LUMIN_WORKER_BOOT_URL } from '../types/index.js';

const INSTALLED_FLAG = '__luminBootProxyInstalled';

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
    return bootHostnames().has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Rewrite a direct boot URL to the worker proxy, preserving path + query. */
export function toWorkerBootUrl(raw: string): string {
  const u = new URL(raw);
  return LUMIN_WORKER_BOOT_URL + u.pathname + (u.search || '');
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
