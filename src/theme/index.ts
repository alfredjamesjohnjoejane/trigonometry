import { THEMES } from '../types/index.js';
import ST from '../storage/index.js';

let themePreviewing = false;
let themePreviewSnapshot: {
  primary: string;
  accent: string;
  accentDark: string;
  bodyBackground: string;
  bodyBackgroundSize: string;
} | null = null;
let themePreviewTimer: ReturnType<typeof setTimeout> | null = null;

export function applyTheme(theme: string): void {
  const t = THEMES[theme];
  if (!t) return;
  document.documentElement.style.setProperty('--primary', t.p);
  document.documentElement.style.setProperty('--accent', t.a);
  document.documentElement.style.setProperty('--accent-dark', t.a2);
  const isMono = theme === 'mono';
  document.documentElement.style.setProperty('--text-primary', isMono ? '#f0f0f0' : '#e0e0e0');
  document.documentElement.style.setProperty('--text-secondary', isMono ? '#999999' : '#888888');
  document.documentElement.style.setProperty('--bg-card', isMono ? '#111111' : '#1e1e1e');
  document.documentElement.style.setProperty('--bg-deep', isMono ? '#000000' : '#111111');
  document.documentElement.style.setProperty(
    '--border',
    isMono ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.12)'
  );
  ST.set('theme', theme);
  document
    .querySelectorAll('.td')
    .forEach(d =>
      (d as HTMLElement).classList.toggle('ton', (d as HTMLElement).dataset.t === theme)
    );
}

export function previewTheme(t: string): void {
  if (!THEMES[t]) return;
  if (themePreviewTimer) clearTimeout(themePreviewTimer);
  const r = document.documentElement;
  if (!themePreviewSnapshot) {
    themePreviewSnapshot = {
      primary: r.style.getPropertyValue('--primary'),
      accent: r.style.getPropertyValue('--accent'),
      accentDark: r.style.getPropertyValue('--accent-dark'),
      bodyBackground: document.body.style.background,
      bodyBackgroundSize: document.body.style.backgroundSize,
    };
  }
  themePreviewing = true;
  const th = THEMES[t];
  r.style.setProperty('--primary', th.p);
  r.style.setProperty('--accent', th.a);
  r.style.setProperty('--accent-dark', th.a2);
  document.body.style.background = th.bg;
  document.body.style.backgroundSize = '400% 400%';
  themePreviewTimer = setTimeout(endThemePreview, 1800);
}

export function endThemePreview(): void {
  if (!themePreviewing) return;
  if (themePreviewTimer) clearTimeout(themePreviewTimer);
  themePreviewTimer = null;
  themePreviewing = false;
  const r = document.documentElement;
  const s = themePreviewSnapshot;
  if (s) {
    r.style.setProperty('--primary', s.primary);
    r.style.setProperty('--accent', s.accent);
    r.style.setProperty('--accent-dark', s.accentDark);
    document.body.style.background = s.bodyBackground;
    document.body.style.backgroundSize = s.bodyBackgroundSize;
    themePreviewSnapshot = null;
  }
}

export function saveCustomTheme(): void {
  const p = (
    (document.getElementById('custom-primary') as HTMLInputElement | null)?.value || ''
  ).trim();
  const a = (
    (document.getElementById('custom-accent') as HTMLInputElement | null)?.value || ''
  ).trim();
  if (!/^#[0-9a-f]{6}$/i.test(p) || !/^#[0-9a-f]{6}$/i.test(a)) {
    showErrorToast('Use valid hex colors');
    return;
  }
  ST.set('customPrimary', p);
  ST.set('customAccent', a);
  applySavedCustomTheme();
  showErrorToast('Custom theme saved');
}

function readHex(key: string, fallback: string): string {
  const v = (ST.get(key) || '').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

export function applySavedCustomTheme(): void {
  // Re-validated on read: custom colors can also arrive via settings import,
  // which bypasses the save-time check. Unvalidated values would land in a
  // linear-gradient() style string (CSS injection).
  const p = readHex('customPrimary', '#888888');
  const a = readHex('customAccent', '#666666');
  document.documentElement.style.setProperty('--primary', p);
  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-dark', a);
  document.body.style.background = `linear-gradient(-45deg,#111,${p},${a},#111)`;
  document.body.style.backgroundSize = '400% 400%';
}

function showErrorToast(msg: string): void {
  const toast = document.getElementById('error-toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}
