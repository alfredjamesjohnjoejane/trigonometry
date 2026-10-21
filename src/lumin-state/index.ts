/**
 * Single-init guard for the Lumin SDK.
 *
 * The SDK is a page-wide singleton: `Lumin.init()` may be called only once.
 * A second call destroys the instance that is already rendering (its grid
 * disappears from the page) and the replacement instance then rejects with
 * "Worker connection failed: domain fetch failed". Once an init has failed,
 * every later init fails the same way — recovering needs a page reload, not
 * another `init()` call.
 *
 * The homepage loader races several script mirrors (same-origin vendor copy,
 * worker proxy, jsDelivr POPs, IndexedDB last-good copy). Every mirror that
 * finishes loading used to call `Lumin.init()` on its own, so the mirror that
 * won the race rendered the grid and the next mirror tore it down again —
 * which is why the homepage showed "Test homepage failed to load" on every
 * network, school WiFi included.
 *
 * This module keeps the "claim the init slot" decision in one place so the
 * loader and the diagnostics panel agree on it. The diagnostics panel must
 * not start a second init either: that would wipe a working grid.
 */

export type LuminInitPhase = 'idle' | 'loading' | 'ok' | 'failed';

export interface LuminInitSnapshot {
  phase: LuminInitPhase;
  /** Epoch ms of the claimed init, or null when nothing started yet. */
  startedAt: number | null;
  errorName: string | null;
  errorMessage: string | null;
  /** How many init attempts were claimed (always 0 or 1 in practice). */
  attempts: number;
  /** URLs the SDK fetched while the init was running (diagnostics aid). */
  fetchUrls: string[];
}

const state: LuminInitSnapshot = {
  phase: 'idle',
  startedAt: null,
  errorName: null,
  errorMessage: null,
  attempts: 0,
  fetchUrls: [],
};

let promise: Promise<boolean> | null = null;

/** Current init state (a copy — callers must not mutate it). */
export function luminInitSnapshot(): LuminInitSnapshot {
  return { ...state, fetchUrls: [...state.fetchUrls] };
}

/** Record a URL the SDK fetched during init (capped, deduped). */
export function recordLuminFetchUrl(url: string): void {
  if (!url || state.fetchUrls.length >= 40) return;
  if (state.fetchUrls.includes(url)) return;
  state.fetchUrls.push(url);
}

/** The promise of the claimed init, or null when no init was started. */
export function luminInitPromise(): Promise<boolean> | null {
  return promise;
}

/**
 * Claim the one-and-only init slot.
 *
 * @returns true when the caller may call `Lumin.init()`; false when an init
 *          already started (another mirror won, or diagnostics already ran).
 */
export function claimLuminInit(): boolean {
  if (state.phase !== 'idle') return false;
  state.phase = 'loading';
  state.startedAt = Date.now();
  state.attempts += 1;
  state.fetchUrls = [];
  return true;
}

/** Remember the promise of the claimed init so other modules can await it. */
export function setLuminInitPromise(p: Promise<boolean>): void {
  promise = p;
}

/** The init finished successfully — the grid is rendered. */
export function markLuminInitOk(): void {
  if (state.phase === 'loading') state.phase = 'ok';
}

/** The init failed; the error is kept for the diagnostics report. */
export function markLuminInitFailed(err: unknown): void {
  state.phase = 'failed';
  state.errorName = err instanceof Error ? err.name : typeof err;
  state.errorMessage = err instanceof Error ? err.message : err == null ? '' : String(err);
}

/** True while an init is running or after it succeeded. */
export function luminInitInFlight(): boolean {
  return state.phase === 'loading' || state.phase === 'ok';
}

/** @internal - reset for tests */
export function _resetLuminState(): void {
  state.phase = 'idle';
  state.startedAt = null;
  state.errorName = null;
  state.errorMessage = null;
  state.attempts = 0;
  state.fetchUrls = [];
  promise = null;
}
