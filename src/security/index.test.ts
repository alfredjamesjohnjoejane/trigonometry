import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isDevtoolsShortcut,
  opensDevtools,
  isInstallGateVisible,
  handleSecurityKeydown,
  handleSecurityContextMenu,
  installDevtoolsProtection,
} from './index.js';

function keyEvent(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', init);
  if (init.keyCode !== undefined) {
    Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  }
  return e;
}

describe('isDevtoolsShortcut', () => {
  it('blocks F12 (key and keyCode)', () => {
    expect(isDevtoolsShortcut(keyEvent({ key: 'F12' }))).toBe(true);
    expect(isDevtoolsShortcut(keyEvent({ key: 'F12', keyCode: 123 }))).toBe(true);
  });

  it('blocks Ctrl/Cmd+Shift devtools combos', () => {
    for (const k of ['I', 'J', 'C', 'K', 'E', 'M', 'P']) {
      expect(isDevtoolsShortcut(keyEvent({ key: k, ctrlKey: true, shiftKey: true }))).toBe(true);
      expect(
        isDevtoolsShortcut(keyEvent({ key: k.toLowerCase(), metaKey: true, shiftKey: true }))
      ).toBe(true);
    }
  });

  it('blocks Cmd+Opt devtools combos on macOS', () => {
    for (const k of ['I', 'J', 'C', 'U']) {
      expect(isDevtoolsShortcut(keyEvent({ key: k, metaKey: true, altKey: true }))).toBe(true);
    }
  });

  it('blocks view-source and save-page shortcuts', () => {
    expect(isDevtoolsShortcut(keyEvent({ key: 'u', ctrlKey: true }))).toBe(true);
    expect(isDevtoolsShortcut(keyEvent({ key: 'U', metaKey: true }))).toBe(true);
    expect(isDevtoolsShortcut(keyEvent({ key: 's', ctrlKey: true }))).toBe(true);
  });

  it('blocks keyboard context-menu triggers', () => {
    expect(isDevtoolsShortcut(keyEvent({ key: 'ContextMenu' }))).toBe(true);
    expect(isDevtoolsShortcut(keyEvent({ key: 'F10', shiftKey: true }))).toBe(true);
  });

  it('allows normal typing and harmless shortcuts', () => {
    expect(isDevtoolsShortcut(keyEvent({ key: 'a' }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'Enter' }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'Escape' }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: '`' }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'c', ctrlKey: true }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'v', ctrlKey: true }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'f', ctrlKey: true }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'p', ctrlKey: true }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'F5' }))).toBe(false);
    expect(isDevtoolsShortcut(keyEvent({ key: 'F10' }))).toBe(false);
  });
});

describe('handleSecurityKeydown', () => {
  it('prevents default and stops propagation for blocked shortcuts', () => {
    const e = keyEvent({ key: 'F12', cancelable: true });
    let stopped = false;
    e.stopPropagation = () => {
      stopped = true;
    };
    expect(handleSecurityKeydown(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(stopped).toBe(true);
  });

  it('ignores normal keys', () => {
    const e = keyEvent({ key: 'a', cancelable: true });
    expect(handleSecurityKeydown(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('handleSecurityContextMenu', () => {
  it('prevents the menu', () => {
    const e = new Event('contextmenu', { cancelable: true });
    expect(handleSecurityContextMenu(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('installDevtoolsProtection', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__jhSecurityInstalled;
    document.getElementById('jh-security-styles')?.remove();
  });

  it('is idempotent and blocks contextmenu once installed', () => {
    installDevtoolsProtection({ deterrent: false });
    installDevtoolsProtection({ deterrent: false });
    expect(document.getElementById('jh-security-styles')).not.toBeNull();

    const e = new Event('contextmenu', { cancelable: true, bubbles: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('blocks F12 keydown via the installed listener', () => {
    installDevtoolsProtection({ deterrent: false });
    const e = new KeyboardEvent('keydown', { key: 'F12', cancelable: true, bubbles: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('install gate exemption', () => {
  function showGate(style = 'display:flex'): void {
    const gate = document.createElement('div');
    gate.id = 'pwa-enforce-overlay';
    gate.setAttribute('style', style);
    document.body.appendChild(gate);
  }

  afterEach(() => {
    document.getElementById('pwa-enforce-overlay')?.remove();
  });

  it('recognises when the install gate covers the page', () => {
    expect(isInstallGateVisible()).toBe(false);
    showGate();
    expect(isInstallGateVisible()).toBe(true);
    document.getElementById('pwa-enforce-overlay')!.style.display = 'none';
    expect(isInstallGateVisible()).toBe(false);
  });

  it('allows F12 and other DevTools openers while the gate is visible', () => {
    showGate();
    expect(isInstallGateVisible()).toBe(true);

    const f12 = keyEvent({ key: 'F12', cancelable: true });
    expect(opensDevtools(f12)).toBe(true);
    expect(handleSecurityKeydown(f12)).toBe(false);
    expect(f12.defaultPrevented).toBe(false);

    for (const combo of [
      { key: 'I', ctrlKey: true, shiftKey: true },
      { key: 'j', ctrlKey: true, shiftKey: true },
      { key: 'C', metaKey: true, shiftKey: true },
      { key: 'i', metaKey: true, altKey: true },
    ]) {
      const e = keyEvent({ ...combo, cancelable: true });
      expect(handleSecurityKeydown(e)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it('keeps blocking F12 once the gate is gone (installed / standalone)', () => {
    showGate('display:none');
    expect(isInstallGateVisible()).toBe(false);

    const e = keyEvent({ key: 'F12', cancelable: true });
    expect(handleSecurityKeydown(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it('still blocks context menu and view-source while the gate is visible', () => {
    showGate();

    const menu = keyEvent({ key: 'ContextMenu', cancelable: true });
    expect(handleSecurityKeydown(menu)).toBe(true);
    expect(menu.defaultPrevented).toBe(true);

    const viewSource = keyEvent({ key: 'u', ctrlKey: true, cancelable: true });
    expect(handleSecurityKeydown(viewSource)).toBe(true);
    expect(viewSource.defaultPrevented).toBe(true);
  });
});
