/**
 * School-WiFi diagnostics for the "Test homepage failed to load" failure.
 *
 * Background: `initHomepageTest()` mounts the Lumin SDK homepage. On school
 * networks that failure is almost always one of:
 *   1. Captive portal / offline (same-origin fetches fail too)
 *   2. Content filter blocking cdn.jsdelivr.net (same-origin OK, CDN fails)
 *   3. Filter blocking Lumin's backend while the CDN itself loads
 *      (script loads, but `Lumin.init()` rejects)
 *   3b. Filter blocking the worker file (/v1/lumin.worker.js) while
 *      /api/v1/boot stays reachable (script + boot pass, but init
 *      fails with a Worker connection error)
 *   4. Slow/throttled WiFi (probes pass but take seconds)
 *   5. CSP / script-eval blocking (fetch passes, <script> or Lumin.init fails)
 *
 * This module runs a battery of probes, classifies each failure, guesses the
 * likely cause, and renders a copy-pasteable report so a failure observed at
 * school can be diagnosed later. Everything is DOM-only (no eval) and never
 * throws — diagnostics must work especially when the network is broken.
 */

import {
  CDN_TARGETS,
  LUMIN_BACKEND_TARGETS,
  LUMIN_CACHE_NAME,
  LUMIN_HANDSHAKE_ORIGINS,
  LUMIN_WORKER_FILE_TARGETS,
} from '../types/index.js';
import { luminInitSnapshot } from '../lumin-state/index.js';
import ST from '../storage/index.js';

export interface ProbeResult {
  name: string;
  url: string;
  method: string;
  ok: boolean;
  /** HTTP status when visible (CORS same-origin probes). Null for opaque no-cors / img / script probes. */
  httpStatus: number | null;
  ms: number | null;
  errorName: string | null;
  errorMessage: string | null;
  classification: string | null;
  note: string | null;
}

export interface EnvSnapshot {
  timestamp: string;
  href: string;
  protocol: string;
  host: string;
  userAgent: string;
  onLine: boolean;
  connectionType: string | null;
  effectiveType: string | null;
  downlink: number | null;
  rtt: number | null;
  saveData: boolean | null;
  cookiesEnabled: boolean;
  webdriver: boolean;
  hardwareConcurrency: number | null;
  language: string;
  csp: string | null;
  luminScriptPresent: boolean;
  luminScriptSrc: string | null;
  luminGlobal: string;
  serviceWorkerController: boolean;
}

export interface LuminAttempt {
  attempted: boolean;
  present: boolean;
  initType: string;
  ok: boolean;
  errorName: string | null;
  errorMessage: string | null;
  ms: number | null;
  /** URLs the SDK tried to fetch during init (captured by patching fetch). */
  luminFetchUrls: string[];
}

export interface DiagReport {
  version: number;
  createdAt: string;
  env: EnvSnapshot;
  probes: ProbeResult[];
  lumin: LuminAttempt;
  recentLogs: string[];
  likelyCause: string;
  checklist: string[];
}

const LAST_REPORT_KEY = 'luminDiagLast';
const MAX_LOGS = 120;
const recentLogs: string[] = [];
let logHookInstalled = false;

/** Keep the last ~120 console lines so a school failure includes context. */
export function installLogCapture(): void {
  if (logHookInstalled) return;
  logHookInstalled = true;
  try {
    const methods = ['log', 'warn', 'error', 'info'] as const;
    for (const m of methods) {
      const orig = console[m].bind(console);
      console[m] = (...args: unknown[]) => {
        try {
          pushLog(`[${m}] ` + args.map(stringifyLogArg).join(' '));
        } catch {
          /* never break the app for logging */
        }
        orig(...args);
      };
    }
    window.addEventListener('error', e => {
      pushLog(`[window.onerror] ${e.message} @ ${e.filename}:${e.lineno}`);
    });
    window.addEventListener('unhandledrejection', e => {
      pushLog(`[unhandledrejection] ${describeError(e.reason)}`);
    });
  } catch {
    /* ignore */
  }
}

function stringifyLogArg(a: unknown): string {
  if (typeof a === 'string') return a.slice(0, 500);
  if (a instanceof Error) return `${a.name}: ${a.message}`.slice(0, 500);
  try {
    return JSON.stringify(a)?.slice(0, 500) ?? String(a);
  } catch {
    return String(a).slice(0, 500);
  }
}

function pushLog(line: string): void {
  recentLogs.push(`${new Date().toISOString()} ${line}`.slice(0, 800));
  if (recentLogs.length > MAX_LOGS) recentLogs.splice(0, recentLogs.length - MAX_LOGS);
}

/** @internal — tests reset the ring buffer. */
export function _resetLogs(): void {
  recentLogs.length = 0;
  logHookInstalled = false;
}

export function describeError(err: unknown): string {
  if (err == null) return 'null';
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err.slice(0, 300);
  try {
    return JSON.stringify(err)?.slice(0, 300) ?? String(err);
  } catch {
    return String(err).slice(0, 300);
  }
}

/**
 * Classify a fetch/script failure into a school-WiFi-meaningful bucket.
 * Browsers deliberately hide cross-origin failure details (all TypeErrors),
 * so this combines the error, timing, and navigator.onLine into a best guess.
 */
export function classifyFailure(err: unknown, ms: number | null): string {
  const online = safeOnLine();
  if (err != null && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      if (ms != null && ms >= 7500) return 'timeout-slow-or-filtered';
      return 'timeout';
    }
  }
  if (!online) return 'offline';
  const msg = describeError(err).toLowerCase();
  if (msg.includes('content security policy') || msg.includes('csp') || msg.includes('refused'))
    return 'csp-blocked';
  if (msg.includes('cors')) return 'cors-or-filter';
  if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('typeerror'))
    return 'network-blocked-or-filtered';
  if (msg.includes('ssl') || msg.includes('tls') || msg.includes('cert'))
    return 'tls-inspection-or-cert';
  return 'network-blocked-or-filtered';
}

function safeOnLine(): boolean {
  try {
    return navigator.onLine;
  } catch {
    return true;
  }
}

function now(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function timeoutMs(opt: number | undefined, fallback: number): number {
  return typeof opt === 'number' && Number.isFinite(opt) && opt > 0 ? opt : fallback;
}

export function getEnvironmentSnapshot(): EnvSnapshot {
  let conn: Record<string, unknown> = {};
  try {
    conn =
      ((navigator as unknown as { connection?: Record<string, unknown> }).connection as Record<
        string,
        unknown
      >) ?? {};
  } catch {
    conn = {};
  }
  let csp: string | null = null;
  let scriptPresent = false;
  let scriptSrc: string | null = null;
  let luminGlobal = 'missing';
  try {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    csp = meta?.getAttribute('content')?.slice(0, 1200) ?? null;
  } catch {
    /* ignore */
  }
  try {
    const s =
      (document.getElementById('lumin-script') as HTMLScriptElement | null) ??
      (document.querySelector('script[id^="lumin-script"]') as HTMLScriptElement | null);
    scriptPresent = !!s;
    scriptSrc = s?.src ?? s?.getAttribute('src') ?? null;
  } catch {
    /* ignore */
  }
  try {
    const w = window as unknown as { Lumin?: unknown };
    if (w.Lumin == null) luminGlobal = 'missing';
    else if (typeof (w.Lumin as { init?: unknown }).init === 'function')
      luminGlobal = 'present-with-init';
    else luminGlobal = 'present-no-init';
  } catch {
    luminGlobal = 'unreadable';
  }
  let swController = false;
  try {
    swController = !!navigator.serviceWorker?.controller;
  } catch {
    swController = false;
  }
  return {
    timestamp: new Date().toISOString(),
    href: safeSlice(() => location.href, 500),
    protocol: safeSlice(() => location.protocol, 20),
    host: safeSlice(() => location.host, 200),
    userAgent: safeSlice(() => navigator.userAgent, 500),
    onLine: safeOnLine(),
    connectionType: typeof conn['type'] === 'string' ? (conn['type'] as string) : null,
    effectiveType:
      typeof conn['effectiveType'] === 'string' ? (conn['effectiveType'] as string) : null,
    downlink: typeof conn['downlink'] === 'number' ? (conn['downlink'] as number) : null,
    rtt: typeof conn['rtt'] === 'number' ? (conn['rtt'] as number) : null,
    saveData: typeof conn['saveData'] === 'boolean' ? (conn['saveData'] as boolean) : null,
    cookiesEnabled: safeBool(() => navigator.cookieEnabled),
    webdriver: safeBool(() => navigator.webdriver),
    hardwareConcurrency: safeNumber(() => navigator.hardwareConcurrency),
    language: safeSlice(() => navigator.language, 20),
    csp,
    luminScriptPresent: scriptPresent,
    luminScriptSrc: scriptSrc,
    luminGlobal,
    serviceWorkerController: swController,
  };
}

function safeSlice(fn: () => string, max: number): string {
  try {
    return String(fn()).slice(0, max);
  } catch {
    return 'unreadable';
  }
}

function safeBool(fn: () => boolean): boolean {
  try {
    return !!fn();
  } catch {
    return false;
  }
}

function safeNumber(fn: () => number): number | null {
  try {
    const v = fn();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** CORS fetch probe: exposes HTTP status, but fails on no-CORS hosts. */
export async function probeFetchCors(
  name: string,
  url: string,
  timeout = 8000
): Promise<ProbeResult> {
  const t = timeoutMs(timeout, 8000);
  const start = now();
  const base: ProbeResult = {
    name,
    url,
    method: 'fetch-cors',
    ok: false,
    httpStatus: null,
    ms: null,
    errorName: null,
    errorMessage: null,
    classification: null,
    note: null,
  };
  try {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), t);
    try {
      const res = await fetch(url, {
        signal: c.signal,
        cache: 'no-store',
        redirect: 'follow',
      });
      base.ms = Math.round(now() - start);
      base.httpStatus = res.status;
      // The SDK has to READ the body, so an unreadable body is a failure
      // even when the status is 200: a stale content-encoding header or a
      // filter page that looks like a script breaks Lumin.init ("domain
      // fetch failed") while a status-only probe stays green.
      let bodyOk = true;
      let bodyNote = '';
      try {
        const blob = await res.blob();
        bodyOk = blob.size > 0;
        if (!bodyOk) bodyNote = 'Empty body — the filter answered with a blank page';
      } catch (err) {
        bodyOk = false;
        bodyNote = `Body unreadable: ${describeError(err).slice(0, 120)}`;
      }
      base.ok = res.ok && bodyOk;
      base.classification = res.ok ? (bodyOk ? 'ok' : 'body-unreadable') : `http-${res.status}`;
      if (!bodyOk) {
        base.note = `${bodyNote}. The SDK has to read this body, so a 200 with an unreadable body still breaks Lumin.init.`;
      } else if (!res.ok && res.status >= 500) {
        base.note =
          'HTTP 5xx — many school filters answer blocked URLs with 503, so treat this as a block unless the same host answers elsewhere.';
      }
      if (res.status === 403 || res.status === 451)
        base.note = 'Forbidden — typical of a content filter block page';
      return base;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    base.ms = Math.round(now() - start);
    base.errorName = err instanceof Error ? err.name : typeof err;
    base.errorMessage = describeError(err).slice(0, 300);
    base.classification = classifyFailure(err, base.ms);
    base.note = hintForClassification(base.classification);
    return base;
  }
}

/** no-cors fetch probe: opaque response, but never false-fails on CORS. */
export async function probeFetchNoCors(
  name: string,
  url: string,
  timeout = 8000
): Promise<ProbeResult> {
  const t = timeoutMs(timeout, 8000);
  const start = now();
  const base: ProbeResult = {
    name,
    url,
    method: 'fetch-no-cors',
    ok: false,
    httpStatus: null,
    ms: null,
    errorName: null,
    errorMessage: null,
    classification: null,
    note: null,
  };
  try {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), t);
    try {
      await fetch(url, { signal: c.signal, mode: 'no-cors', cache: 'no-store' });
      base.ms = Math.round(now() - start);
      base.ok = true;
      base.classification = 'ok';
      return base;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    base.ms = Math.round(now() - start);
    base.errorName = err instanceof Error ? err.name : typeof err;
    base.errorMessage = describeError(err).slice(0, 300);
    base.classification = classifyFailure(err, base.ms);
    base.note = hintForClassification(base.classification);
    return base;
  }
}

/** Image probe: distinguishes "host reachable" from "script pipeline blocked". */
export function probeImage(name: string, url: string, timeout = 8000): Promise<ProbeResult> {
  const t = timeoutMs(timeout, 8000);
  const start = now();
  return new Promise(resolve => {
    const base: ProbeResult = {
      name,
      url,
      method: 'img',
      ok: false,
      httpStatus: null,
      ms: null,
      errorName: null,
      errorMessage: null,
      classification: null,
      note: null,
    };
    let done = false;
    const finish = (ok: boolean, err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      base.ms = Math.round(now() - start);
      base.ok = ok;
      if (ok) {
        base.classification = 'ok';
      } else {
        base.errorName = err instanceof Error ? err.name : 'ImageError';
        base.errorMessage = describeError(err ?? 'image failed to load').slice(0, 300);
        base.classification = classifyFailure(err ?? new TypeError('image failed'), base.ms);
        base.note = hintForClassification(base.classification);
      }
      // Prevent late network activity from holding the page.
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      resolve(base);
    };
    const timer = setTimeout(() => finish(false, new DOMException('timeout', 'AbortError')), t);
    const img = new Image();
    img.onload = () => finish(true);
    img.onerror = () => finish(false, new TypeError('image failed to load'));
    try {
      // Cache-bust so a school captive portal can't serve a stale 200.
      const sep = url.includes('?') ? '&' : '?';
      img.src = `${url}${sep}diag=${Date.now()}`;
    } catch (err) {
      finish(false, err);
    }
  });
}

function hintForClassification(c: string | null): string | null {
  switch (c) {
    case 'offline':
      return 'Browser reports offline — check WiFi / captive-portal login';
    case 'timeout':
    case 'timeout-slow-or-filtered':
      return 'Timed out — throttled WiFi or filter silently dropping requests';
    case 'csp-blocked':
      return 'Blocked by Content-Security-Policy, not the network';
    case 'tls-inspection-or-cert':
      return 'TLS/cert error — school MITM proxy with untrusted cert';
    case 'cors-or-filter':
    case 'network-blocked-or-filtered':
      return 'Unreachable — school DNS/filter likely blocking this host';
    default:
      return null;
  }
}

/**
 * The SDK's domain handshake probe.
 *
 * Before Lumin.init can work, the SDK proves that a backend domain is usable
 * by loading `<origin>/g/_iframe_probe` in a hidden iframe and waiting for
 * the `lumin-ok-frame` postMessage. A school filter that blocks that path
 * (or the host) kills the init with "Worker connection failed: domain fetch
 * failed" even though every fetch probe passes — the iframe handshake is the
 * one request no static probe covers.
 *
 * The SDK walks its domain list in order, so the probe does the same and
 * stops at the first domain that answers.
 */
export async function probeLuminDomainHandshake(
  origins: string[],
  timeout = 4000
): Promise<ProbeResult> {
  const start = now();
  const base: ProbeResult = {
    name: 'Lumin domain handshake',
    url: origins[0] ? `${origins[0].replace(/\/+$/, '')}/g/_iframe_probe` : '',
    method: 'iframe-message',
    ok: false,
    httpStatus: null,
    ms: null,
    errorName: null,
    errorMessage: null,
    classification: null,
    note: null,
  };
  const t = timeoutMs(timeout, 5000);
  for (const origin of origins) {
    const target = `${origin.replace(/\/+$/, '')}/g/_iframe_probe`;
    const attempt = await probeFrameMessage(target, t);
    if (attempt.ok) {
      base.ok = true;
      base.url = target;
      base.ms = Math.round(now() - start);
      base.classification = 'ok';
      base.note = `SDK handshake OK on ${new URL(target).hostname} (the iframe posted lumin-ok-frame).`;
      return base;
    }
  }
  base.ms = Math.round(now() - start);
  base.errorName = 'TimeoutError';
  base.errorMessage = 'no lumin-ok-frame message from any probed Lumin domain';
  base.classification = 'domain-handshake-blocked';
  base.note =
    'The SDK loads <domain>/g/_iframe_probe in a hidden iframe and waits for its postMessage. None of the probed domains answered, so Lumin.init fails with "domain fetch failed" even when the boot/worker fetches succeed. Allowlist the Lumin hosts for the school network.';
  return base;
}

/** Load a URL in a hidden iframe and wait for the SDK's handshake message. */
function probeFrameMessage(url: string, timeout: number): Promise<{ ok: boolean }> {
  return new Promise(resolve => {
    let settled = false;
    let iframe: HTMLIFrameElement | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        window.removeEventListener('message', onMessage);
      } catch {
        /* ignore */
      }
      try {
        iframe?.remove();
      } catch {
        /* ignore */
      }
      resolve({ ok });
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.data === 'lumin-ok-frame') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    try {
      window.addEventListener('message', onMessage);
      iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('tabindex', '-1');
      iframe.style.cssText =
        'position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0';
      iframe.src = url;
      document.body.appendChild(iframe);
    } catch {
      finish(false);
    }
  });
}

/**
 * What the service worker has cached for the Lumin SDK.
 *
 * The SDK script and — more important — its worker file live in a
 * version-independent Cache Storage bucket. On school WiFi the network copy
 * is often blocked, so the cached copy is what keeps the homepage alive.
 * The report has to say whether that copy is there.
 */
export async function probeLuminCache(): Promise<ProbeResult> {
  const start = now();
  const base: ProbeResult = {
    name: 'Lumin SW cache',
    url: LUMIN_CACHE_NAME,
    method: 'cache-storage',
    ok: false,
    httpStatus: null,
    ms: null,
    errorName: null,
    errorMessage: null,
    classification: null,
    note: null,
  };
  try {
    if (typeof caches === 'undefined' || typeof caches.open !== 'function') {
      base.errorName = 'CacheStorageUnavailable';
      base.errorMessage = 'Cache Storage is not available in this browser';
      base.classification = 'cache-unavailable';
      base.note = 'The service worker cannot keep a copy of the Lumin files.';
      base.ms = Math.round(now() - start);
      return base;
    }
    const cache = await caches.open(LUMIN_CACHE_NAME);
    const keys = await cache.keys();
    const urls = keys.map(k => k.url);
    const hasScript = urls.some(u => u.includes('lumin.min.js'));
    const hasWorker = urls.some(u => u.includes('lumin.worker'));
    base.ms = Math.round(now() - start);
    base.ok = hasScript || hasWorker;
    base.classification = base.ok ? 'ok' : 'cache-miss';
    base.note = base.ok
      ? `Cached Lumin files: ${urls.length} entr${urls.length === 1 ? 'y' : 'ies'} (SDK script: ${hasScript ? 'yes' : 'no'}, worker file: ${hasWorker ? 'yes' : 'no'}).`
      : `No Lumin files in "${LUMIN_CACHE_NAME}" yet (${urls.length} other entries). The SDK script and its worker file are fetched from the network on a cold cache.`;
    return base;
  } catch (err) {
    base.ms = Math.round(now() - start);
    base.errorName = err instanceof Error ? err.name : 'Error';
    base.errorMessage = describeError(err).slice(0, 200);
    base.classification = 'cache-error';
    return base;
  }
}

/** The default school-WiFi battery: same-origin + CDN + general-internet. */
export function defaultProbeList(): Array<{ name: string; url: string }> {
  const base = import.meta.env.BASE_URL || './';
  const list: Array<{ name: string; url: string }> = [
    { name: 'same-origin: catalog', url: `${base}data/games_merged.json` },
    { name: 'same-origin: tos', url: `${base}terms_of_service.txt` },
  ];
  for (const t of CDN_TARGETS) list.push({ name: `cdn: ${t.name}`, url: t.url });
  for (const t of LUMIN_BACKEND_TARGETS) list.push({ name: `backend: ${t.name}`, url: t.url });
  for (const t of LUMIN_WORKER_FILE_TARGETS) list.push({ name: `worker: ${t.name}`, url: t.url });
  list.push({ name: 'internet: google', url: 'https://www.google.com/favicon.ico' });
  return list;
}

/**
 * Backend boot-host probe. The bare /api/v1/boot path 404s without the
 * stub's ?t= token (verified 2026-10-14), so a plain fetch-cors probe would
 * report FAIL on a perfectly reachable host. Any HTTP status except a filter
 * block page (403/451) proves host+TLS+path are reachable — only a network
 * error (no status) means filtered/offline.
 */
export async function probeBackend(
  name: string,
  url: string,
  timeout = 8000
): Promise<ProbeResult> {
  const cors = await probeFetchCors(name, url, timeout);
  if (cors.ok) return cors;
  if (cors.httpStatus != null && cors.httpStatus !== 403 && cors.httpStatus !== 451) {
    cors.ok = true;
    cors.classification = `http-${cors.httpStatus}-reachable`;
    cors.note =
      'Host reachable (HTTP response without boot token — the stub appends ?t= at runtime). Filter is NOT blocking this host.';
    return cors;
  }
  return cors;
}

export async function runNetworkProbes(timeout = 8000): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  try {
    console.log(
      `[Diag] starting probe battery: ${defaultProbeList().length} targets, timeout=${timeout}ms`
    );
  } catch {
    /* ignore */
  }
  for (const p of defaultProbeList()) {
    // CORS first (gives HTTP status), no-cors fallback (tests reachability
    // without CORS noise). Sequential to avoid flooding throttled WiFi.
    // Backend boot hosts get the token-aware probe (bare path 404s by design).
    const cors = p.name.startsWith('backend:')
      ? await probeBackend(p.name, p.url, timeout)
      : await probeFetchCors(p.name, p.url, timeout);
    results.push(cors);
    try {
      console.log(
        `[Diag] probe ${cors.ok ? 'PASS' : 'FAIL'} ${cors.ms ?? '?'}ms${cors.httpStatus == null ? '' : ` http=${cors.httpStatus}`} ${cors.method} ${cors.name}${cors.classification ? ` [${cors.classification}]` : ''}${cors.ok ? '' : ` err=${cors.errorName ?? '?'}: ${(cors.errorMessage ?? '').slice(0, 100)}`}`
      );
    } catch {
      /* ignore */
    }
    if (!cors.ok && cors.httpStatus == null) {
      const noCors = await probeFetchNoCors(`${p.name} (no-cors)`, p.url, timeout);
      results.push(noCors);
      try {
        console.log(
          `[Diag] probe ${noCors.ok ? 'PASS' : 'FAIL'} ${noCors.ms ?? '?'}ms ${noCors.method} ${noCors.name}${noCors.classification ? ` [${noCors.classification}]` : ''}`
        );
      } catch {
        /* ignore */
      }
    }
  }
  // Favicon img probe: cheap host-reachability signal for the CDN filter case.
  const img = await probeImage('cdn: jsDelivr (img)', 'https://cdn.jsdelivr.net/favicon.ico');
  results.push(img);
  // Domain handshake: the one Lumin request that no fetch probe covers.
  const handshake = await probeLuminDomainHandshake(LUMIN_HANDSHAKE_ORIGINS);
  results.push(handshake);
  try {
    console.log(
      `[Diag] probe ${handshake.ok ? 'PASS' : 'FAIL'} ${handshake.ms ?? '?'}ms ${handshake.method} ${handshake.name}${handshake.classification ? ` [${handshake.classification}]` : ''}`
    );
  } catch {
    /* ignore */
  }
  // What the service worker kept for the SDK (the offline copy).
  const cacheRow = await probeLuminCache();
  results.push(cacheRow);
  try {
    console.log(
      `[Diag] probe ${cacheRow.ok ? 'PASS' : 'FAIL'} ${cacheRow.ms ?? '?'}ms ${cacheRow.method} ${cacheRow.name}${cacheRow.classification ? ` [${cacheRow.classification}]` : ''}`
    );
  } catch {
    /* ignore */
  }
  try {
    const pass = results.filter(r => r.ok).length;
    const luminRows = results.filter(r => r.name.includes('Lumin SDK'));
    const luminPass = luminRows.filter(r => r.ok).length;
    const backendRows = results.filter(r => r.name.startsWith('backend:'));
    const backendPass = backendRows.filter(r => r.ok).length;
    const workerRows = results.filter(r => r.name.startsWith('worker:'));
    const workerPass = workerRows.filter(r => r.ok).length;
    console.log(
      `[Diag] probe battery done: ${pass}/${results.length} pass, Lumin mirrors ${luminPass}/${luminRows.length} pass, backends ${backendPass}/${backendRows.length} pass, worker files ${workerPass}/${workerRows.length} pass`
    );
  } catch {
    /* ignore */
  }
  return results;
}

/** Attempt Lumin.init against a detached div so diagnosis never touches the UI. */
export async function probeLuminInit(timeout = 10000): Promise<LuminAttempt> {
  const w = window as unknown as { Lumin?: { init?: unknown } };
  const present = w.Lumin != null;
  const initType = typeof w.Lumin?.init;
  const scriptSrc = (() => {
    try {
      return (
        (document.getElementById('lumin-script') as HTMLScriptElement | null)?.src ??
        (document.querySelector('script[id^="lumin-script"]') as HTMLScriptElement | null)?.src ??
        null
      );
    } catch {
      return null;
    }
  })();
  const out: LuminAttempt = {
    attempted: false,
    present,
    initType,
    ok: false,
    errorName: null,
    errorMessage: null,
    ms: null,
    luminFetchUrls: [],
  };
  try {
    console.log(
      `[Diag] lumin probe: present=${present} initType=${initType} script=${scriptSrc ?? 'none'}`
    );
  } catch {
    /* ignore */
  }
  if (!present || typeof w.Lumin?.init !== 'function') {
    try {
      const attempts = (window as unknown as Record<string, unknown>).__luminMirrorAttempts;
      if (Array.isArray(attempts))
        console.log(`[Diag] mirror attempts on record: ${attempts.length}`);
    } catch {
      /* ignore */
    }
    return out;
  }
  // The Lumin SDK supports exactly ONE init per page load: a second init()
  // destroys the grid that is already rendered and then rejects with
  // "Worker connection failed: domain fetch failed". Probing init while the
  // homepage is using the SDK would therefore blank the games — report the
  // live state of the real init instead.
  const live = luminInitSnapshot();
  if (live.phase !== 'idle') {
    out.attempted = true;
    out.ok = live.phase === 'ok';
    out.errorName = live.errorName;
    out.errorMessage = live.errorMessage;
    out.ms = live.startedAt ? Math.max(0, Math.round(now() - live.startedAt)) : null;
    out.luminFetchUrls = live.fetchUrls;
    try {
      console.log(
        `[Diag] lumin.init skipped — the page already ran one (phase=${live.phase}, urls=${live.fetchUrls.length})`
      );
    } catch {
      /* ignore */
    }
    return out;
  }
  out.attempted = true;
  const start = now();
  const sandbox = document.createElement('div');
  // Capture every URL the SDK fetches during init so we can tell exactly
  // what is blocked on school WiFi (the SDK is obfuscated and fetches
  // dynamically constructed URLs that static probes cannot see).
  const fetchUrls: string[] = [];
  const origFetch = window.fetch.bind(window);
  try {
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const u =
          typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
        if (u) fetchUrls.push(u);
      } catch {
        /* ignore */
      }
      return origFetch(input, init);
    };
    const r = (w.Lumin as { init: (o: unknown) => unknown }).init({
      container: sandbox,
      theme: 'dark',
    });
    const t = timeoutMs(timeout, 10000);
    await Promise.race([
      Promise.resolve(r),
      new Promise((_, rej) => setTimeout(() => rej(new DOMException('timeout', 'AbortError')), t)),
    ]);
    out.ms = Math.round(now() - start);
    out.ok = true;
    try {
      console.log(`[Diag] lumin.init OK ${out.ms}ms`);
    } catch {
      /* ignore */
    }
  } catch (err) {
    out.ms = Math.round(now() - start);
    out.errorName = err instanceof Error ? err.name : typeof err;
    out.errorMessage = describeError(err).slice(0, 500);
    try {
      console.log(
        `[Diag] lumin.init FAIL ${out.ms}ms ${out.errorName}: ${(out.errorMessage ?? '').slice(0, 160)}`
      );
    } catch {
      /* ignore */
    }
  } finally {
    try {
      window.fetch = origFetch;
    } catch {
      /* ignore */
    }
    out.luminFetchUrls = fetchUrls;
    try {
      console.log(
        `[Diag] lumin.fetch urls: ${fetchUrls.length} ${fetchUrls.slice(0, 10).join(' ')}`
      );
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function guessLikelyCause(probes: ProbeResult[], lumin: LuminAttempt): string {
  const sameOrigin = probes.filter(p => p.name.startsWith('same-origin'));
  const cdn = probes.filter(p => p.name.startsWith('cdn:') && !p.name.includes('no-cors'));
  const sameOriginOk = sameOrigin.some(p => p.ok);
  const cdnOk = cdn.some(p => p.ok);
  const anyNoCorsOk = probes.some(p => p.name.includes('no-cors') && p.ok);
  const anyTimeout = probes.some(p => p.classification?.startsWith('timeout'));
  const slow = probes.some(p => p.ok && p.ms != null && p.ms > 3000);
  // Mirror-aware breakdown: all Lumin mirror probes share the
  // /gh/luminsdk/script path across jsDelivr POPs, so a split result means a
  // single-POP DNS block (fallback should save us) while all-fail means a
  // path/keyword filter (fallback cannot save us).
  const luminProbes = probes.filter(
    p => p.name.includes('Lumin SDK') && !p.name.includes('no-cors')
  );
  const luminOk = luminProbes.filter(p => p.ok);
  const luminFail = luminProbes.filter(p => !p.ok);
  const faviconOk = probes.some(p => p.name === 'cdn: jsDelivr' && p.ok);
  // Backend boot hosts the stub fetches at Lumin.init time (decoded 2026-10-14).
  // Script mirrors can all pass while these all fail — then the script loads
  // but init can never succeed, no matter how many POPs we add. The ok check
  // intentionally includes no-cors rows: a bare-path cors quirk must never
  // read as a backend wall when the host is demonstrably reachable.
  const backendProbes = probes.filter(
    p => p.name.startsWith('backend:') && !p.name.includes('no-cors')
  );
  const backendAnyOk = probes.some(p => p.name.startsWith('backend:') && p.ok);

  if (!sameOriginOk && !cdnOk)
    return 'OFFLINE-or-captive-portal: this site itself is unreachable. Join WiFi / complete the login page, then retry.';
  if (sameOriginOk && !cdnOk && !anyNoCorsOk)
    return 'SCHOOL-FILTER blocking cdn.jsdelivr.net: site loads but the game CDN is unreachable. Allowlist cdn.jsdelivr.net (and Lumin hosts) or use another network.';
  if (
    sameOriginOk &&
    backendProbes.length > 0 &&
    !backendAnyOk &&
    (lumin.present || luminOk.length > 0)
  )
    return 'LUMIN-BACKEND-BLOCKED: the script loads but ALL backend boot hosts fail, including the worker proxy. Boot fetches are routed via the proxy with direct fallback — if the proxy row also fails, the proxy host itself is filtered. Allowlist the worker origin or a.luminsdk.com/api/v1/boot, or use another network.';
  const workerProbes = probes.filter(
    p => p.name.startsWith('worker:') && !p.name.includes('no-cors')
  );
  const workerAnyOk = probes.some(p => p.name.startsWith('worker:') && p.ok);
  // The SDK's domain handshake: it loads <origin>/g/_iframe_probe in a hidden
  // iframe and waits for a postMessage before it talks to the backend. This
  // request bypasses every fetch-based proxy in the page, so a filter that
  // blocks it fails the init even when the boot/worker rows are green.
  const handshake = probes.find(p => p.name === 'Lumin domain handshake');
  const handshakeOk = handshake?.ok === true;
  if (sameOriginOk && handshake && !handshakeOk)
    return 'LUMIN-DOMAIN-HANDSHAKE-BLOCKED: the script loads and the boot/worker fetches work, but the SDK cannot complete its domain handshake (it loads <domain>/g/_iframe_probe in a hidden iframe and waits for a postMessage). No probed domain answered, so Lumin.init fails with "Worker connection failed: domain fetch failed". Allowlist the Lumin hosts for the school network (the whole host, not just /api/v1/boot).';
  if (sameOriginOk && workerProbes.length > 0 && !workerAnyOk && lumin.present && backendAnyOk)
    return 'LUMIN-WORKER-BLOCKED: the script and backend boot hosts load, but ALL /v1/lumin.worker.js file fetches fail, including the worker proxy. Lumin.init fetches the worker file before creating its Worker ("Worker connection failed: domain fetch failed"). Worker fetches are routed via the /lumin/worker proxy with direct fallback — if the proxy row also fails, the proxy host itself is filtered. Allowlist the worker origin, or use another network.';
  // A rejected Lumin.init is a more specific signal than a mirror split, so it
  // outranks the mirror branches below: the script demonstrably loaded and
  // executed (e.g. via the same-origin vendor copy, which is not a probed
  // mirror), and init still failed. The usual cause is the SDK's domain
  // handshake (see the row above) or a blocked worker-file fetch.
  if (lumin.present && lumin.attempted && !lumin.ok)
    return `LUMIN-INIT failed (${lumin.errorName ?? 'unknown'}): script loaded but init rejected. Check the "Lumin domain handshake" row (the SDK loads <domain>/g/_iframe_probe in a hidden iframe) and the worker-file rows — a filter on either one kills the init. Note: the SDK allows only ONE init per page load, so a retry needs a page reload. Error: ${(lumin.errorMessage ?? '').slice(0, 160)}`;
  if (sameOriginOk && luminProbes.length > 1 && luminOk.length > 0 && luminFail.length > 0)
    return `PARTIAL-MIRROR-BLOCK: ${luminOk.length}/${luminProbes.length} Lumin mirrors reachable (${luminOk.map(p => p.name).join(', ')}). The loader fallback should have tried the working one — if the page still fails, the script loaded but did not execute (adblock/CSP). Retry, then check the mirror rows + console.`;
  if (sameOriginOk && (faviconOk || anyNoCorsOk) && luminProbes.length > 0 && luminOk.length === 0)
    return 'FILTER-ON-LUMIN-PATH: jsDelivr host reachable but ALL Lumin mirrors fail. The filter is blocking the /gh/luminsdk/script path (or the `luminsdk` keyword) on every POP — CDN fallback cannot help. The same-origin vendor copy (vendor/lumin.min.js), worker proxy (/lumin/script), and IDB last-good store should cover this; if none did, the vendor file is stale and the IDB store is empty.';
  if (sameOriginOk && (cdnOk || anyNoCorsOk) && !lumin.present)
    return 'SDK script blocked: CDN reachable but lumin.min.js did not execute. Suspect CSP/adblock/filter stripping the script — check the lumin-script probe and console.';
  if (anyTimeout || slow)
    return 'SLOW-or-throttled WiFi: probes pass but time out / take seconds. Retry on a faster network or wait and press Retry.';
  if (sameOriginOk && (cdnOk || anyNoCorsOk) && lumin.ok)
    return 'HEALTHY at probe time: everything passed now. The earlier failure was transient (filter hiccup / slow WiFi). Press Retry.';
  return 'MIXED results: compare same-origin vs CDN rows below. Same-origin OK + CDN fail = filter. Both fail = offline/portal.';
}

export function buildChecklist(report: DiagReport): string[] {
  const luminProbes = report.probes.filter(
    p => p.name.includes('Lumin SDK') && !p.name.includes('no-cors')
  );
  const luminOk = luminProbes.filter(p => p.ok).length;
  const backendProbes = report.probes.filter(
    p => p.name.startsWith('backend:') && !p.name.includes('no-cors')
  );
  const backendOk = backendProbes.filter(p => p.ok).length;
  const workerProbes = report.probes.filter(
    p => p.name.startsWith('worker:') && !p.name.includes('no-cors')
  );
  const workerOk = workerProbes.filter(p => p.ok).length;
  const handshake = report.probes.find(p => p.name === 'Lumin domain handshake');
  return [
    `1. Browser online flag: ${report.env.onLine ? 'ONLINE' : 'OFFLINE'} — if OFFLINE, rejoin WiFi / accept the captive portal.`,
    `2. Same-origin rows OK but CDN rows fail => school filter is blocking jsdelivr. Ask IT to allowlist cdn.jsdelivr.net + fastly/gcore/testingcf.jsdelivr.net + the worker proxy. Mirrors passing now: ${luminOk}/${luminProbes.length}.`,
    '3. ALL Lumin mirrors fail but favicon passes => filter blocks the /gh/luminsdk/script path itself; the same-origin vendor copy (vendor/lumin.min.js), worker proxy (/lumin/script), and IDB last-good store are the fix — check they appear in the mirror rows.',
    `4. Script loads but backend rows all fail => Lumin boot hosts are filtered (backends passing now: ${backendOk}/${backendProbes.length}). The worker proxy row (/lumin/boot) should pass first; if it fails too, allowlist the worker origin or a.luminsdk.com/api/v1/boot.`,
    `5. Script + backends pass but worker-file rows all fail => the /v1/lumin.worker.js path is filtered (worker files passing now: ${workerOk}/${workerProbes.length}). The /lumin/worker proxy row should pass first; the page now routes worker fetches through it automatically — if it fails too, allowlist the worker origin.`,
    `6. "Lumin domain handshake" row ${handshake ? (handshake.ok ? 'PASSED' : 'FAILED') : 'missing'} => the SDK loads <domain>/g/_iframe_probe in a hidden iframe and waits for a postMessage before it can start. When this row fails, Lumin.init always fails with "domain fetch failed" even if every other row is green — allowlist the Lumin hosts for the school network.`,
    '7. lumin.min.js loads but Lumin.init rejects => Lumin backend, domain handshake or script-eval is blocked; copy the Lumin error line below for IT. Note: the SDK allows only ONE init per page load, so a retry means reloading the page.',
    '8. Timeouts (>7s) on every row => throttled WiFi; wait, move closer to AP, retry.',
    '9. Loader runs a staggered race (IDB last-good + vendor immediately, worker proxy ~1.2s, then POPs every 1.2s); only the FIRST mirror that loads the SDK initialises it — check console [HomepageTest]/[Diag] lines and window.__luminMirrorAttempts for the per-mirror [tag|fetch-blob|idb] breakdown.',
    '10. Press "Copy report" and paste it into the bug report so the failure can be diagnosed off-site.',
  ];
}

export function getMirrorAttemptsFromWindow(): Array<{
  url: string;
  tier?: 'tag' | 'fetch-blob' | 'idb';
  ok: boolean;
  ms: number | null;
  errorName: string | null;
  errorMessage: string | null;
}> {
  try {
    const w = window as unknown as Record<string, unknown>;
    const a = w.__luminMirrorAttempts;
    if (Array.isArray(a)) return a as never;
  } catch {
    /* ignore */
  }
  return [];
}

export async function runFullDiagnostics(timeout = 8000): Promise<DiagReport> {
  installLogCapture();
  const env = getEnvironmentSnapshot();
  try {
    console.log('[Diag] env:', {
      href: env.href,
      onLine: env.onLine,
      luminGlobal: env.luminGlobal,
      luminScript: env.luminScriptSrc,
      csp: env.csp?.slice(0, 120),
    });
  } catch {
    /* ignore */
  }
  const probes = await runNetworkProbes(timeout).catch((e): ProbeResult[] => [
    {
      name: 'probe-runner',
      url: '',
      method: 'internal',
      ok: false,
      httpStatus: null,
      ms: null,
      errorName: 'ProbeError',
      errorMessage: describeError(e).slice(0, 300),
      classification: 'probe-runner-failed',
      note: null,
    },
  ]);
  const lumin = await probeLuminInit().catch(
    (): LuminAttempt => ({
      attempted: true,
      present: false,
      initType: 'unknown',
      ok: false,
      errorName: 'ProbeError',
      errorMessage: describeError('lumin probe crashed').slice(0, 300),
      ms: null,
      luminFetchUrls: [],
    })
  );
  try {
    console.log('[Diag] lumin result:', {
      attempted: lumin.attempted,
      present: lumin.present,
      ok: lumin.ok,
      err: lumin.errorName
        ? `${lumin.errorName}: ${(lumin.errorMessage ?? '').slice(0, 120)}`
        : null,
      ms: lumin.ms,
    });
  } catch {
    /* ignore */
  }
  const mirrorLines = getMirrorAttemptsFromWindow().map(
    a =>
      `[mirror] ${a.ok ? 'OK' : 'FAIL'} [${a.tier ?? 'tag'}] ${a.ms ?? '?'}ms ${a.url} ${a.errorName ?? ''} ${(a.errorMessage ?? '').slice(0, 160)}`
  );
  const partial: DiagReport = {
    version: 1,
    createdAt: new Date().toISOString(),
    env,
    probes,
    lumin,
    recentLogs: [...mirrorLines, ...recentLogs].slice(-40),
    likelyCause: '',
    checklist: [],
  };
  partial.likelyCause = guessLikelyCause(probes, lumin);
  partial.checklist = buildChecklist(partial);
  saveLastReport(partial);
  try {
    console.log('[Diag] likely cause:', partial.likelyCause);
    console.log('[Diag] full report saved; use Copy report to export.');
  } catch {
    /* ignore */
  }
  return partial;
}

export function formatReportText(r: DiagReport): string {
  const lines: string[] = [];
  lines.push('=== jesherhead school-wifi diagnostic report ===');
  lines.push(`created: ${r.createdAt}`);
  lines.push(`page: ${r.env.href}`);
  lines.push(`ua: ${r.env.userAgent}`);
  lines.push(
    `online: ${r.env.onLine} | conn: ${r.env.effectiveType ?? '?'} ` +
      `downlink=${r.env.downlink ?? '?'} rtt=${r.env.rtt ?? '?'} saveData=${r.env.saveData ?? '?'}`
  );
  lines.push(`lumin: global=${r.env.luminGlobal} script=${r.env.luminScriptSrc ?? 'none'}`);
  lines.push(`sw-controller: ${r.env.serviceWorkerController}`);
  lines.push(`csp: ${(r.env.csp ?? 'none').slice(0, 200)}`);
  lines.push('');
  lines.push(`LIKELY CAUSE: ${r.likelyCause}`);
  lines.push('');
  const luminRows = r.probes.filter(p => p.name.includes('Lumin SDK'));
  if (luminRows.length) {
    const okRows = luminRows.filter(p => p.ok);
    lines.push(`--- lumin mirrors (${okRows.length}/${luminRows.length} reachable) ---`);
    for (const p of luminRows) {
      lines.push(`${p.ok ? 'PASS' : 'FAIL'} ${p.ms ?? '?'}ms ${p.method} ${p.name}`);
    }
    lines.push('');
  }
  const backendRows = r.probes.filter(p => p.name.startsWith('backend:'));
  if (backendRows.length) {
    const okRows = backendRows.filter(p => p.ok);
    lines.push(`--- lumin backends (${okRows.length}/${backendRows.length} reachable) ---`);
    for (const p of backendRows) {
      lines.push(`${p.ok ? 'PASS' : 'FAIL'} ${p.ms ?? '?'}ms ${p.method} ${p.name}`);
    }
    lines.push('');
  }
  const workerRows = r.probes.filter(p => p.name.startsWith('worker:'));
  if (workerRows.length) {
    const okRows = workerRows.filter(p => p.ok);
    lines.push(`--- lumin worker files (${okRows.length}/${workerRows.length} reachable) ---`);
    for (const p of workerRows) {
      lines.push(`${p.ok ? 'PASS' : 'FAIL'} ${p.ms ?? '?'}ms ${p.method} ${p.name}`);
    }
    lines.push('');
  }
  if (r.lumin.luminFetchUrls && r.lumin.luminFetchUrls.length) {
    lines.push('--- lumin.init fetch urls ---');
    for (const u of r.lumin.luminFetchUrls) lines.push(`fetch: ${u}`);
    lines.push('');
  }
  lines.push('--- probes ---');
  for (const p of r.probes) {
    const status = p.ok ? 'PASS' : 'FAIL';
    const ms = p.ms == null ? '?' : `${p.ms}ms`;
    const http = p.httpStatus == null ? '' : ` http=${p.httpStatus}`;
    const cls = p.classification ? ` [${p.classification}]` : '';
    const err = p.ok ? '' : ` err=${p.errorName ?? '?'}: ${(p.errorMessage ?? '').slice(0, 140)}`;
    lines.push(`${status} ${ms}${http} ${p.method} ${p.name}${cls}${err}`);
    if (p.note) lines.push(`     note: ${p.note}`);
  }
  lines.push('');
  lines.push('--- lumin.init ---');
  lines.push(
    `attempted=${r.lumin.attempted} present=${r.lumin.present} ok=${r.lumin.ok} ` +
      `err=${r.lumin.errorName ?? '-'}: ${(r.lumin.errorMessage ?? '').slice(0, 200)}`
  );
  lines.push('');
  lines.push('--- checklist ---');
  for (const c of r.checklist) lines.push(c);
  lines.push('');
  lines.push('--- recent console (last 40) ---');
  if (!r.recentLogs.length) lines.push('(no captured logs)');
  for (const l of r.recentLogs) lines.push(l.slice(0, 400));
  lines.push('=== end report ===');
  return lines.join('\n');
}

export function saveLastReport(r: DiagReport): void {
  try {
    ST.set(LAST_REPORT_KEY, JSON.stringify(r).slice(0, 60_000));
  } catch {
    /* storage may be blocked at school — non-fatal */
  }
}

export function loadLastReport(): DiagReport | null {
  try {
    const raw = ST.get(LAST_REPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiagReport;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.probes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function copyReportText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to prompt */
  }
  try {
    prompt('Copy this diagnostic report:', text.slice(0, 8000));
    return true;
  } catch {
    return false;
  }
}

export function downloadReportText(text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jesherhead-diag-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    /* ignore */
  }
}

/** Floating diagnostics overlay. Built with DOM APIs so CSP-safe. */
export function showDiagnosticsPanel(report?: DiagReport): HTMLElement {
  installLogCapture();
  const existing = document.getElementById('diag-overlay');
  if (existing) existing.remove();
  const data = report ?? loadLastReport();

  const overlay = document.createElement('div');
  overlay.id = 'diag-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:100050;background:rgba(0,0,0,.78);' +
    'display:flex;align-items:center;justify-content:center;padding:16px;';

  const card = document.createElement('div');
  card.style.cssText =
    'width:min(720px,96vw);max-height:88vh;overflow:auto;background:#151515;color:#e0e0e0;' +
    'border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:22px;' +
    'font-family:Segoe UI,system-ui,sans-serif;box-shadow:0 30px 90px rgba(0,0,0,.7)';

  const title = document.createElement('h2');
  title.style.cssText = 'margin:0 0 4px;font-size:1.25rem';
  title.textContent = '🔍 Network diagnostics';
  const sub = document.createElement('p');
  sub.style.cssText = 'margin:0 0 12px;color:#999;font-size:.85rem;line-height:1.5';
  sub.textContent =
    'For the school-WiFi "homepage failed to load" case. Run this ON the school network, then Copy or Download the report.';

  const status = document.createElement('div');
  status.style.cssText =
    'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);' +
    'border-radius:12px;padding:12px;font-size:.85rem;margin-bottom:12px;line-height:1.6';
  status.textContent = data
    ? `Last report ${data.createdAt} — ${data.likelyCause}`
    : 'No report yet — press "Run diagnostics".';

  const pre = document.createElement('pre');
  pre.style.cssText =
    'background:#000;border:1px solid rgba(255,255,255,.12);border-radius:12px;' +
    'padding:12px;font-size:.72rem;line-height:1.55;white-space:pre-wrap;word-break:break-word;' +
    'max-height:38vh;overflow:auto;color:#ccc;margin:0 0 12px';
  pre.textContent = data
    ? formatReportText(data)
    : 'Press "Run diagnostics". Probes take ~10-30s on slow school WiFi.';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

  const mkBtn = (label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'background:#444;color:#fff;border:none;border-radius:10px;' +
      'padding:10px 16px;font-weight:700;cursor:pointer;font-size:.85rem';
    return b;
  };
  const runBtn = mkBtn('▶ Run diagnostics');
  const copyBtn = mkBtn('📋 Copy report');
  const dlBtn = mkBtn('⬇ Download');
  const closeBtn = mkBtn('✕ Close');
  closeBtn.style.background = 'rgba(255,255,255,.08)';

  let current: DiagReport | null = data;
  runBtn.addEventListener('click', () => {
    runBtn.textContent = '⏳ Running… (10-30s)';
    runBtn.setAttribute('disabled', '');
    status.textContent = 'Probing same-origin, CDN, and Lumin… leave this tab open.';
    void runFullDiagnostics().then(r => {
      current = r;
      status.textContent = `Finished ${r.createdAt} — ${r.likelyCause}`;
      pre.textContent = formatReportText(r);
      runBtn.textContent = '▶ Re-run';
      runBtn.removeAttribute('disabled');
    });
  });
  copyBtn.addEventListener('click', () => {
    if (!current) {
      status.textContent = 'Nothing to copy yet — run diagnostics first.';
      return;
    }
    void copyReportText(formatReportText(current)).then(ok => {
      status.textContent = ok
        ? 'Report copied — paste it into the bug report.'
        : 'Copy failed — select the text manually.';
    });
  });
  dlBtn.addEventListener('click', () => {
    if (!current) {
      status.textContent = 'Nothing to download yet — run diagnostics first.';
      return;
    }
    downloadReportText(formatReportText(current));
    status.textContent = 'Report downloaded.';
  });
  closeBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  row.append(runBtn, copyBtn, dlBtn, closeBtn);
  card.append(title, sub, status, pre, row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return overlay;
}

/** Global handles for use from the console / buttons at school. */
export function installDiagGlobals(): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    w.showDiagnostics = () => showDiagnosticsPanel();
    w.runDiagnostics = () => runFullDiagnostics();
    w.copyDiagnostics = async () => {
      const r = await runFullDiagnostics();
      await copyReportText(formatReportText(r));
      return r.likelyCause;
    };
    w.diagReport = () => loadLastReport();
  } catch {
    /* ignore */
  }
}
