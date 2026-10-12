/**
 * School-WiFi diagnostics for the "Test homepage failed to load" failure.
 *
 * Background: `initHomepageTest()` mounts the Lumin SDK homepage. On school
 * networks that failure is almost always one of:
 *   1. Captive portal / offline (same-origin fetches fail too)
 *   2. Content filter blocking cdn.jsdelivr.net (same-origin OK, CDN fails)
 *   3. Filter blocking Lumin's backend while the CDN itself loads
 *      (script loads, but `Lumin.init()` rejects)
 *   4. Slow/throttled WiFi (probes pass but take seconds)
 *   5. CSP / script-eval blocking (fetch passes, <script> or Lumin.init fails)
 *
 * This module runs a battery of probes, classifies each failure, guesses the
 * likely cause, and renders a copy-pasteable report so a failure observed at
 * school can be diagnosed later. Everything is DOM-only (no eval) and never
 * throws — diagnostics must work especially when the network is broken.
 */

import { CDN_TARGETS } from '../types/index.js';
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
    const s = document.getElementById('lumin-script') as HTMLScriptElement | null;
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
      // Drain one byte so captive portals that hang the body still resolve.
      try {
        await res.blob();
      } catch {
        /* body unreadable — status is still signal */
      }
      base.ok = res.ok;
      base.classification = res.ok ? 'ok' : `http-${res.status}`;
      if (!res.ok && res.status >= 500) base.note = 'CDN/server error, not a school filter';
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

/** The default school-WiFi battery: same-origin + CDN + general-internet. */
export function defaultProbeList(): Array<{ name: string; url: string }> {
  const base = import.meta.env.BASE_URL || './';
  const list: Array<{ name: string; url: string }> = [
    { name: 'same-origin: catalog', url: `${base}data/games_merged.json` },
    { name: 'same-origin: tos', url: `${base}terms_of_service.txt` },
  ];
  for (const t of CDN_TARGETS) list.push({ name: `cdn: ${t.name}`, url: t.url });
  list.push({ name: 'internet: google', url: 'https://www.google.com/favicon.ico' });
  return list;
}

export async function runNetworkProbes(timeout = 8000): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const p of defaultProbeList()) {
    // CORS first (gives HTTP status), no-cors fallback (tests reachability
    // without CORS noise). Sequential to avoid flooding throttled WiFi.
    const cors = await probeFetchCors(p.name, p.url, timeout);
    results.push(cors);
    if (!cors.ok && cors.httpStatus == null) {
      results.push(await probeFetchNoCors(`${p.name} (no-cors)`, p.url, timeout));
    }
  }
  // Favicon img probe: cheap host-reachability signal for the CDN filter case.
  results.push(await probeImage('cdn: jsDelivr (img)', 'https://cdn.jsdelivr.net/favicon.ico'));
  return results;
}

/** Attempt Lumin.init against a detached div so diagnosis never touches the UI. */
export async function probeLuminInit(timeout = 10000): Promise<LuminAttempt> {
  const w = window as unknown as { Lumin?: { init?: unknown } };
  const present = w.Lumin != null;
  const initType = typeof w.Lumin?.init;
  const out: LuminAttempt = {
    attempted: false,
    present,
    initType,
    ok: false,
    errorName: null,
    errorMessage: null,
    ms: null,
  };
  if (!present || typeof w.Lumin?.init !== 'function') return out;
  out.attempted = true;
  const start = now();
  const sandbox = document.createElement('div');
  try {
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
  } catch (err) {
    out.ms = Math.round(now() - start);
    out.errorName = err instanceof Error ? err.name : typeof err;
    out.errorMessage = describeError(err).slice(0, 500);
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

  if (!sameOriginOk && !cdnOk)
    return 'OFFLINE-or-captive-portal: this site itself is unreachable. Join WiFi / complete the login page, then retry.';
  if (sameOriginOk && !cdnOk && !anyNoCorsOk)
    return 'SCHOOL-FILTER blocking cdn.jsdelivr.net: site loads but the game CDN is unreachable. Allowlist cdn.jsdelivr.net (and Lumin hosts) or use another network.';
  if (sameOriginOk && (cdnOk || anyNoCorsOk) && !lumin.present)
    return 'SDK script blocked: CDN reachable but lumin.min.js did not execute. Suspect CSP/adblock/filter stripping the script — check the lumin-script probe and console.';
  if (lumin.present && lumin.attempted && !lumin.ok)
    return `LUMIN-INIT failed (${lumin.errorName ?? 'unknown'}): script loaded but init rejected. Likely Lumin backend blocked or Function()-eval blocked. Error: ${(lumin.errorMessage ?? '').slice(0, 160)}`;
  if (anyTimeout || slow)
    return 'SLOW-or-throttled WiFi: probes pass but time out / take seconds. Retry on a faster network or wait and press Retry.';
  if (sameOriginOk && (cdnOk || anyNoCorsOk) && lumin.ok)
    return 'HEALTHY at probe time: everything passed now. The earlier failure was transient (filter hiccup / slow WiFi). Press Retry.';
  return 'MIXED results: compare same-origin vs CDN rows below. Same-origin OK + CDN fail = filter. Both fail = offline/portal.';
}

export function buildChecklist(report: DiagReport): string[] {
  return [
    `1. Browser online flag: ${report.env.onLine ? 'ONLINE' : 'OFFLINE'} — if OFFLINE, rejoin WiFi / accept the captive portal.`,
    '2. Same-origin rows OK but CDN rows fail => school filter is blocking jsdelivr. Ask IT to allowlist cdn.jsdelivr.net.',
    '3. lumin.min.js loads but Lumin.init rejects => Lumin backend or script-eval is blocked; copy the Lumin error line below for IT.',
    '4. Timeouts (>7s) on every row => throttled WiFi; wait, move closer to AP, retry.',
    '5. Press "Copy report" and paste it into the bug report so the failure can be diagnosed off-site.',
  ];
}

export async function runFullDiagnostics(timeout = 8000): Promise<DiagReport> {
  installLogCapture();
  const env = getEnvironmentSnapshot();
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
    })
  );
  const partial: DiagReport = {
    version: 1,
    createdAt: new Date().toISOString(),
    env,
    probes,
    lumin,
    recentLogs: [...recentLogs].slice(-40),
    likelyCause: '',
    checklist: [],
  };
  partial.likelyCause = guessLikelyCause(probes, lumin);
  partial.checklist = buildChecklist(partial);
  saveLastReport(partial);
  try {
    console.log('[Diag] likely cause:', partial.likelyCause);
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
  lines.push('');
  lines.push(`LIKELY CAUSE: ${r.likelyCause}`);
  lines.push('');
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
