import ST from '../storage/index.js';
import { applyTheme } from '../theme/index.js';
import { initPanicKey } from '../panic/index.js';
import { updateCacheSizeDisplay } from '../cache/index.js';
import { isSafeHttpUrl } from '../utils/index.js';

export function loadSettings(): void {
  const sfxEnabled = ST.get('sfx') === 'true';
  if (sfxEnabled) {
    const st = document.getElementById('sfx-toggle');
    if (st) st.classList.add('active');
  }
  const theme = ST.get('theme');
  if (theme) applyTheme(theme);
  const ct = document.getElementById('cloak-title') as HTMLInputElement | null;
  const cu = document.getElementById('cloak-url') as HTMLInputElement | null;
  const ci = document.getElementById('cloak-icon') as HTMLInputElement | null;
  if (ct) ct.value = ST.get('cloakTitle') || 'Google Classroom';
  if (cu) cu.value = ST.get('cloakUrl') || 'https://classroom.google.com/';
  if (ci) ci.value = ST.get('cloakIcon') || 'icon.png';

  syncLandingAnims();

  // One-time migration: the old "cloak marketplace links" toggle was removed.
  // Stale clients may still have cloakMarketplace in localStorage; drop it so
  // a cached urls.html copy can never read it back and cloak links again.
  ST.remove('cloakMarketplace');
  // Removed feature: onlinegames.io toggle was deleted. Purge the stale key
  // so old clients self-heal without clearing data.
  ST.remove('onlineGames');

  initPanicKey();
}

/** Landing animations are on unless the user explicitly disabled them. */
function landingAnimsEnabled(): boolean {
  return ST.get('landingAnims') !== 'false';
}

function syncLandingAnims(): void {
  const enabled = landingAnimsEnabled();
  const toggle = document.getElementById('landing-anims-toggle');
  if (toggle) toggle.classList.toggle('active', enabled);
  const lp = document.getElementById('lp');
  if (lp) lp.classList.toggle('anim-off', !enabled);
}

export function toggleLandingAnims(): void {
  ST.set('landingAnims', landingAnimsEnabled() ? 'false' : 'true');
  syncLandingAnims();
}

export function toggleCloakMarketplace(): void {
  // Removed feature: cloaking marketplace links was deleted. Keep this stub
  // (it is referenced by old cached HTML) as a no-op that also purges the
  // stale localStorage key so old clients self-heal without clearing data.
  ST.remove('cloakMarketplace');
}

export function switchTab(tab: string, btn: HTMLElement): void {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.classList.add('active');
}

export function openPanicSetup(): void {
  showSettingsPage();
  setTimeout(() => (document.getElementById('panic-key') as HTMLInputElement | null)?.focus(), 120);
}

export function openCloakSetup(): void {
  showSettingsPage();
  setTimeout(
    () => (document.getElementById('cloak-title') as HTMLInputElement | null)?.focus(),
    120
  );
}

export function resetHubSettings(): void {
  if (!confirm('Reset all settings?')) return;
  [
    'pk',
    'panicUrl',
    'theme',
    'customPrimary',
    'customAccent',
    'cloakPreset',
    'cloakTitle',
    'cloakUrl',
    'cloakIcon',
    'sfx',
    'landingAnims',
    'timerVisible',
    'favs',
    'playCount',
    'playTime',
  ].forEach(k => {
    ST.remove(k);
  });
  // Also purge removed keys if a stale client set them.
  ST.remove('cloakMarketplace');
  ST.remove('onlineGames');
  showErrorToast('Settings reset');
  setTimeout(() => location.reload(), 450);
}

export function showSettingsReminder(): void {
  if (ST.get('settingsReminderSeen') === 'yes') return;
  ST.set('settingsReminderSeen', 'yes');
  const m = document.createElement('div');
  m.className = 'settings-reminder';
  const card = document.createElement('div');
  card.className = 'settings-reminder-card';
  const h = document.createElement('h2');
  h.textContent = '⚙️ Check Settings';
  const p = document.createElement('p');
  p.textContent = 'New cloak, panic key, theme, and quick menu options are in Settings.';
  const actions = document.createElement('div');
  actions.className = 'settings-reminder-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'sap';
  openBtn.textContent = 'Open Settings';
  openBtn.addEventListener('click', () => {
    m.remove();
    showSettingsPage();
  });
  const laterBtn = document.createElement('button');
  laterBtn.className = 'sap';
  laterBtn.textContent = 'Later';
  laterBtn.addEventListener('click', () => m.remove());
  actions.append(openBtn, laterBtn);
  card.append(h, p, actions);
  m.appendChild(card);
  document.body.appendChild(m);
}

export function showSettingsPage(): void {
  location.hash = 'settings';
  const settingsWrap = document.getElementById('settings-wrap');
  if (settingsWrap) {
    settingsWrap.style.display = 'flex';
    settingsWrap.style.position = 'fixed';
    settingsWrap.style.inset = '0';
    settingsWrap.style.zIndex = '99999';
  }
  const lp = document.getElementById('lp');
  if (lp) lp.style.display = 'none';
  const mainContent = document.getElementById('main-content');
  if (mainContent) mainContent.style.display = 'none';
  updateCacheSizeDisplay();
  document.body.style.overflow = 'hidden';
}

export function showGamesPage(): void {
  location.hash = '';
  const settingsWrap = document.getElementById('settings-wrap');
  if (settingsWrap) settingsWrap.style.display = 'none';
  const lp = document.getElementById('lp');
  if (lp) lp.style.display = 'none';
  const mainContent = document.getElementById('main-content');
  if (mainContent) mainContent.style.display = 'block';
  document.body.style.overflow = '';
}

export function closeDataModal(): void {
  const m = document.getElementById('data-modal');
  if (m) m.style.display = 'none';
}

function readFavs(): string[] {
  try {
    const parsed: unknown = JSON.parse(ST.get('favs') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function readCount(key: string): number {
  const n = parseInt(ST.get(key) || '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function encodeSettings(data: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeSettings(code: string): unknown {
  const trimmed = code.trim();
  // Cap import size before atob/JSON.parse: a pasted multi-MB string would
  // otherwise block the main thread (client-side DoS via paste).
  if (!trimmed || trimmed.length > 1_000_000) throw new Error('Import code too large');
  const bin = atob(trimmed);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function exportData(): void {
  const favs = readFavs();
  const playCount = readCount('playCount');
  const totalPlayTime = readCount('playTime');
  const data = {
    version: 2,
    favs,
    playCount,
    totalPlayTime,
    settings: {
      pk: ST.get('pk') || '`',
      panicUrl: ST.get('panicUrl') || 'https://www.google.com',
      sfx: ST.get('sfx') || 'false',
      landingAnims: ST.get('landingAnims') || 'true',
      theme: ST.get('theme'),
      customPrimary: ST.get('customPrimary'),
      customAccent: ST.get('customAccent'),
      cloakPreset: ST.get('cloakPreset'),
      cloakTitle: ST.get('cloakTitle'),
      cloakUrl: ST.get('cloakUrl'),
      cloakIcon: ST.get('cloakIcon'),
    },
  };
  const txt = encodeSettings(data);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(txt)
      .then(() => showErrorToast('Settings code copied'))
      .catch(() => prompt('Copy this settings code:', txt));
  } else {
    prompt('Copy this settings code:', txt);
  }
}

// Only these settings keys may be restored from an import code. Anything
// else (including the removed cloakMarketplace and onlineGames flags) is
// dropped so a crafted code can never plant arbitrary localStorage entries.
const IMPORTABLE_SETTINGS_KEYS = new Set([
  'pk',
  'panicUrl',
  'sfx',
  'landingAnims',
  'theme',
  'customPrimary',
  'customAccent',
  'cloakPreset',
  'cloakTitle',
  'cloakUrl',
  'cloakIcon',
]);

function sanitizeImportedSetting(key: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.slice(0, 500);
  switch (key) {
    case 'panicUrl':
    case 'cloakUrl': {
      // Match runtime validation (isSafeHttpUrl): reject intranet,
      // credentialed, and non-http(s) URLs, not just the scheme prefix.
      const t = v.trim();
      if (!t && key === 'cloakUrl') return '';
      return isSafeHttpUrl(t) ? t : null;
    }
    case 'customPrimary':
    case 'customAccent':
      return /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null;
    case 'theme':
      return /^[a-z0-9_-]{1,32}$/i.test(v.trim()) ? v.trim() : null;
    case 'landingAnims':
      return v === 'true' || v === 'false' ? v : null;
    case 'pk':
      return v.slice(0, 16);
    default:
      return v;
  }
}

export function importData(): void {
  const box = document.getElementById('import-data') as HTMLInputElement | null;
  if (!box || !box.value.trim()) return;
  try {
    const data = decodeSettings(box.value) as {
      version?: unknown;
      favs?: unknown;
      playCount?: unknown;
      totalPlayTime?: unknown;
      settings?: unknown;
    };
    if (typeof data !== 'object' || data === null || data.version !== 2) {
      showErrorToast('Import code did not work');
      return;
    }
    if (Array.isArray(data.favs)) {
      const favs = data.favs.filter((v): v is string => typeof v === 'string').slice(0, 5000);
      ST.set('favs', JSON.stringify(favs));
    }
    if (data.playCount != null) {
      const playCount = parseInt(String(data.playCount), 10);
      ST.set(
        'playCount',
        (Number.isFinite(playCount) && playCount >= 0 ? playCount : 0).toString()
      );
    }
    if (data.totalPlayTime != null) {
      const totalPlayTime = parseInt(String(data.totalPlayTime), 10);
      ST.set(
        'playTime',
        (Number.isFinite(totalPlayTime) && totalPlayTime >= 0 ? totalPlayTime : 0).toString()
      );
    }
    if (typeof data.settings === 'object' && data.settings !== null) {
      for (const k of Object.keys(data.settings)) {
        if (!IMPORTABLE_SETTINGS_KEYS.has(k)) continue;
        const clean = sanitizeImportedSetting(k, (data.settings as Record<string, unknown>)[k]);
        if (clean != null) ST.set(k, clean);
      }
    }
    loadSettings();
    if (window.renderGames) window.renderGames();
    closeDataModal();
    showErrorToast('Data imported');
  } catch (e) {
    showErrorToast('Import code did not work');
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

declare global {
  interface Window {
    renderGames?: () => void;
  }
}
