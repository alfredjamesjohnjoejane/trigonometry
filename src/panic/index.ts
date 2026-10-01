import ST from '../storage/index.js';
import { isSafeHttpUrl } from '../utils/index.js';

export const DEFAULT_PANIC_URL = 'https://www.google.com';

/** User-supplied panic URL, restricted to public http(s) so a crafted
 *  settings import can never turn the panic key into script execution. */
export function resolvePanicUrl(raw: string | null): string {
  if (typeof raw === 'string' && isSafeHttpUrl(raw)) return raw.trim();
  return DEFAULT_PANIC_URL;
}

export function initPanicKey(): void {
  const p = ST.get('pk') || '`';
  const pk = document.getElementById('panic-key') as HTMLInputElement | null;
  if (pk) pk.value = p;
  const pu = document.getElementById('panic-url') as HTMLInputElement | null;
  if (pu) pu.value = ST.get('panicUrl') || 'https://www.google.com';
}

export function applyPanicPreset(key: string, url: string): void {
  const pk = document.getElementById('panic-key') as HTMLInputElement | null;
  const pu = document.getElementById('panic-url') as HTMLInputElement | null;
  if (pk) pk.value = key;
  if (pu) pu.value = url;
  savePanicKey();
}

export function savePanicKey(): void {
  const pk = document.getElementById('panic-key') as HTMLInputElement | null;
  const pu = document.getElementById('panic-url') as HTMLInputElement | null;
  const v = (pk && pk.value ? pk.value.trim() : '`') || '`';
  const u = resolvePanicUrl(pu && pu.value ? pu.value.trim() : null);
  ST.set('pk', v);
  ST.set('panicUrl', u);
  if (pk) pk.value = v;
  if (pu) pu.value = u;
  showErrorToast('Panic settings saved');
}

export function handlePanicKey(e: KeyboardEvent): void {
  const saved = ST.get('pk') || '`';
  const target = e.target;
  const typing =
    target &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target as HTMLElement).isContentEditable);
  if (typing) return;
  if (e.key === saved) {
    e.preventDefault();
    e.stopPropagation();
    const u = resolvePanicUrl(ST.get('panicUrl'));
    try {
      window.location.replace(u);
    } catch (err) {
      window.location.href = u;
    }
  }
}

export function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function showErrorToast(msg: string): void {
  const toast = document.getElementById('error-toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}
