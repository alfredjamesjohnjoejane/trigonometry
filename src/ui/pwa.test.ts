import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  enforcePWAOverlay,
  checkPWAInstallAvailability,
  setDeferredPrompt,
  stopPWAEnforcement,
} from './index.js';

/**
 * The PWA gate (`#pwa-enforce-overlay`) is visible by default in the HTML, so
 * if boot never runs — or if no install signal is ever recognised — the page
 * stays blocked *even after the app has been installed*. These tests drive the
 * real boot path (src/main.ts) and assert the gate drops for every install
 * signal the app can receive.
 */

const FIXTURE = `
  <div id="pwa-enforce-overlay" style="position:fixed;inset:0;z-index:999999;background:#111;display:flex;">
    <a id="pwa-enforce-install-btn" href="#" style="display:block">How to Install</a>
    <div id="pwa-enforce-ios" style="display:none"></div>
  </div>
  <button id="pwa-install-btn" style="display:none">Add to Home Screen</button>
  <p id="pwa-installed-msg" style="display:none">✅ Added to home screen</p>
  <div id="error-toast"></div>
`;

const gate = () => document.getElementById('pwa-enforce-overlay') as HTMLElement;
const installBtn = () => document.getElementById('pwa-install-btn') as HTMLButtonElement;
const installedMsg = () => document.getElementById('pwa-installed-msg') as HTMLElement;

function mockDisplayMode(standalone: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: standalone && query.includes('display-mode'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Puts the page back into the "fresh load, not installed" state. */
function resetGate(): void {
  localStorage.clear();
  setDeferredPrompt(null);
  mockDisplayMode(false);
  gate().style.display = 'flex';
  gate().style.visibility = 'visible';
  gate().style.opacity = '1';
  installedMsg().style.display = 'none';
  enforcePWAOverlay();
  checkPWAInstallAvailability();
}

async function flush(): Promise<void> {
  // MutationObserver callbacks are microtasks; promise chains need a tick.
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeAll(async () => {
  document.body.innerHTML = FIXTURE;
  mockDisplayMode(false);
  localStorage.clear();
  // jsdom has no network: reject everything so boot's fetches stay local.
  window.fetch = vi.fn(() => Promise.reject(new Error('offline in tests'))) as typeof window.fetch;

  // jsdom's document is already `complete` here, so this import exercises the
  // "module evaluated after DOMContentLoaded" path: boot must still run.
  await import('../main.js');
});

beforeEach(() => {
  resetGate();
});

afterAll(() => {
  // Detach the enforcement observer/interval so nothing fires during teardown.
  stopPWAEnforcement();
});

describe('PWA install gate', () => {
  it('boots and raises the gate even when DOMContentLoaded already fired', () => {
    // boot() ran synchronously at import time (jsdom never dispatches
    // DOMContentLoaded after the test file evaluates).
    expect(document.getElementById('offline-overlay')).not.toBeNull();
    expect(gate().style.display).toBe('flex');
    expect(installBtn().style.display).toBe('block');
    expect(installBtn().textContent).toContain('Open browser menu');
  });

  it('still blocks manual attempts to hide the gate while not installed', async () => {
    gate().style.display = 'none';
    await flush();
    expect(gate().style.display).toBe('flex');
  });

  it('uses the native prompt when beforeinstallprompt arrives after boot', async () => {
    let promptCalls = 0;
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: () => {
          promptCalls++;
        },
        userChoice: Promise.resolve({ outcome: 'accepted', platform: 'test' }),
      })
    );
    await flush();

    // Boot installed the menu-hint handler because no prompt existed yet;
    // receiving a prompt afterwards must rewire the button to installPWA().
    installBtn().click();
    await flush();

    expect(promptCalls).toBe(1);
    expect(gate().style.display).toBe('none');
    expect(localStorage.getItem('pwaInstalled')).toBe('1');
    expect(installedMsg().style.display).toBe('block');
    expect(installBtn().style.display).toBe('none');
  });

  it('drops the gate on appinstalled and remembers the install', async () => {
    expect(gate().style.display).toBe('flex');

    window.dispatchEvent(new Event('appinstalled'));
    await flush();

    expect(gate().style.display).toBe('none');
    expect(localStorage.getItem('pwaInstalled')).toBe('1');
    expect(installedMsg().style.display).toBe('block');
    expect(installBtn().style.display).toBe('none');

    // Enforcement must stop watching the gate after the install: unrelated DOM
    // activity must not bring the "install the app" screen back.
    document.body.appendChild(document.createElement('span'));
    await flush();
    expect(gate().style.display).toBe('none');
  });

  it('never raises the gate again once the install flag is persisted', () => {
    localStorage.setItem('pwaInstalled', '1');
    enforcePWAOverlay();
    expect(gate().style.display).toBe('none');
    checkPWAInstallAvailability();
    expect(gate().style.display).toBe('none');
    expect(installedMsg().style.display).toBe('block');
    expect(installBtn().style.display).toBe('none');
  });

  it('detects a standalone launch (installed app window) and persists it', () => {
    mockDisplayMode(true);

    enforcePWAOverlay();

    expect(gate().style.display).toBe('none');
    expect(localStorage.getItem('pwaInstalled')).toBe('1');
    expect(installedMsg().style.display).toBe('block');
    expect(installBtn().style.display).toBe('none');
  });

  it('keeps the gate up in a normal browser tab', () => {
    enforcePWAOverlay();
    checkPWAInstallAvailability();
    expect(gate().style.display).toBe('flex');
    expect(localStorage.getItem('pwaInstalled')).toBeNull();
  });

  it('leaves DevTools (F12) usable while the gate is up, blocks it after', async () => {
    expect(gate().style.display).toBe('flex');

    const onGate = new KeyboardEvent('keydown', { key: 'F12', cancelable: true, bubbles: true });
    document.dispatchEvent(onGate);
    expect(onGate.defaultPrevented).toBe(false);

    window.dispatchEvent(new Event('appinstalled'));
    await flush();
    expect(gate().style.display).toBe('none');

    const installed = new KeyboardEvent('keydown', { key: 'F12', cancelable: true, bubbles: true });
    document.dispatchEvent(installed);
    expect(installed.defaultPrevented).toBe(true);
  });
});
