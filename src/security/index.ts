const INSTALLED_FLAG = '__jhSecurityInstalled';
const STYLE_ELEMENT_ID = 'jh-security-styles';

// Ctrl/Cmd+Shift+<key> combos that open DevTools panels / command palette.
const DEVTOOLS_SHIFT_KEYS = new Set(['I', 'J', 'C', 'K', 'E', 'M', 'P']);
// Cmd+Opt+<key> DevTools combos on macOS.
const MAC_DEVTOOLS_KEYS = new Set(['I', 'J', 'C', 'U']);

export interface SecurityOptions {
  /** Run the DevTools-open deterrent (debugger timing + viewport check). Defaults to true. */
  deterrent?: boolean;
}

/** Element id of the PWA "install the app" gate. */
const GATE_ID = 'pwa-enforce-overlay';

/**
 * True for shortcuts that OPEN DevTools — F12, Ctrl/Cmd+Shift+<devtools> and
 * Cmd+Opt+<devtools>. Excludes the context menu, view-source and save-page,
 * which `isDevtoolsShortcut` blocks on top of this set.
 */
export function opensDevtools(e: KeyboardEvent): boolean {
  const key = (e.key ?? '').toUpperCase();
  const keyCode = (e as KeyboardEvent & { keyCode?: number }).keyCode ?? 0;

  if (e.key === 'F12' || keyCode === 123) return true;

  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (ctrlOrCmd && e.shiftKey && DEVTOOLS_SHIFT_KEYS.has(key)) return true;
  if (e.metaKey && e.altKey && MAC_DEVTOOLS_KEYS.has(key)) return true;

  return false;
}

/**
 * True while the PWA install gate is covering the page. The app behind it is
 * still locked, so there is nothing to protect there — and a gate that will
 * not go away has to be debuggable. Detection never throws: an error here
 * would fall back to "gate not visible" and keep blocking.
 */
export function isInstallGateVisible(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const gate = document.getElementById(GATE_ID);
    if (!gate) return false;
    const style = window.getComputedStyle(gate);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return style.opacity === '' || Number.parseFloat(style.opacity) !== 0;
  } catch {
    return false;
  }
}

/**
 * Pure matcher: returns true when the keyboard event is a well-known
 * DevTools / view-source / page-save shortcut.
 *
 * Blocked:
 * - F12, ContextMenu key, Shift+F10 (keyboard context menu)
 * - Ctrl/Cmd+Shift+I,J,C,K,E,M,P (inspect, console, element picker, command palette, …)
 * - Cmd+Opt+I,J,C,U (macOS DevTools)
 * - Ctrl/Cmd+U (view source), Ctrl/Cmd+S (save page)
 *
 * Deliberately NOT blocked: copy/paste/find (Ctrl+C/V/F/X/A),
 * print (Ctrl+P), refresh (F5/Ctrl+R)  -  blocking those breaks normal use.
 *
 * While the install gate is up, `handleSecurityKeydown` additionally lets the
 * DevTools openers through (see `opensDevtools`).
 */
export function isDevtoolsShortcut(e: KeyboardEvent): boolean {
  if (opensDevtools(e)) return true;

  const key = (e.key ?? '').toUpperCase();

  if (e.key === 'ContextMenu') return true;
  if (e.key === 'F10' && e.shiftKey) return true;

  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (ctrlOrCmd && !e.shiftKey && !e.altKey && (key === 'U' || key === 'S')) return true;

  return false;
}

function getSavedPanicKey(): string {
  try {
    return window.localStorage?.getItem('pk') || '`';
  } catch {
    return '`';
  }
}

/**
 * Capture-phase keydown handler. Returns true when the event was blocked.
 * A user-configured panic key without modifiers always wins so a custom
 * panic key can never be swallowed by this blocker.
 */
export function handleSecurityKeydown(e: KeyboardEvent): boolean {
  if (!isDevtoolsShortcut(e)) return false;
  // DevTools openers (F12, Ctrl/Cmd+Shift+I/J/C, …) go through while the PWA
  // install gate covers the page: the app is still locked behind it, so there
  // is nothing to protect yet, and a gate that will not dismiss must be
  // inspectable. Right-click / view-source / save stay blocked as usual.
  if (opensDevtools(e) && isInstallGateVisible()) return false;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === getSavedPanicKey()) {
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

export function handleSecurityContextMenu(e: Event): boolean {
  e.preventDefault();
  return true;
}

function injectSecurityStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = [
    'body{-webkit-touch-callout:none;}',
    'body{-webkit-user-select:none;user-select:none;}',
    'input,textarea,select,[contenteditable]{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;}',
    'img{-webkit-user-drag:none;user-drag:none;}',
  ].join('');
  document.head.appendChild(style);
}

function printConsoleWarning(): void {
  try {
    console.clear();
    console.warn('%cDevTools is disabled on this site.', 'font-size:16px;font-weight:bold;');
  } catch {
    // Console access can throw in locked-down contexts; ignore.
  }
}

/**
 * Passive deterrent: `debugger` only pauses when DevTools is actually open
 * (making stepping through the app painful), and a viewport-size check spots
 * docked DevTools. Never redirects or blanks the page  -  docked panels and
 * sidebars cause false positives with size checks, so this only clears the
 * console and warns.
 */
function startDevtoolsDeterrent(): void {
  printConsoleWarning();
  window.setInterval(() => {
    // Nothing to deter while the PWA install gate covers the page — and the
    // `debugger` pause / console wipe would make F12 useless exactly where it
    // is deliberately allowed.
    if (isInstallGateVisible()) return;
    const start = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    const elapsed = performance.now() - start;
    try {
      if (elapsed > 150) {
        console.clear();
        printConsoleWarning();
        return;
      }
      const widthDiff = window.outerWidth - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;
      if (widthDiff > 200 || heightDiff > 200) {
        console.clear();
        printConsoleWarning();
      }
    } catch {
      // Ignore measurement errors (e.g. restricted iframes).
    }
  }, 3000);
}

/**
 * Installs all client-side protections. Idempotent  -  safe to call twice
 * (e.g. once from the inline head script fallback and once from main.ts).
 * Must run in capture phase and as early as possible to beat other handlers.
 */
export function installDevtoolsProtection(options: SecurityOptions = {}): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;

  injectSecurityStyles();

  document.addEventListener('contextmenu', handleSecurityContextMenu, true);
  document.addEventListener('keydown', handleSecurityKeydown as unknown as EventListener, true);
  document.addEventListener(
    'dragstart',
    e => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'IMG' || target.closest?.('img'))) {
        e.preventDefault();
      }
    },
    true
  );

  if (options.deterrent !== false) startDevtoolsDeterrent();
}
