export interface Game {
  n: string;
  c: string;
  u: string;
  i?: string;
  d?: string;
  p: number;
  src: string;
  broken?: boolean;
  plays: number;
  rating: number;
  played: boolean;
}

export interface Theme {
  p: string;
  a: string;
  a2: string;
  bg: string;
}

export interface CloakSettings {
  title: string;
  url: string;
  icon: string;
}

export interface PanicSettings {
  key: string;
  url: string;
}

export interface ExportData {
  version: number;
  favs: string[];
  playCount: number;
  totalPlayTime: number;
  settings: {
    pk: string;
    panicUrl: string;
    sfx: string;
    theme?: string;
    customPrimary?: string;
    customAccent?: string;
    cloakPreset?: string;
    cloakTitle?: string;
    cloakUrl?: string;
    cloakIcon?: string;
  };
}

export interface CDNTarget {
  name: string;
  url: string;
}

export interface StatusResult {
  name: string;
  status: 'checking' | 'pass' | 'fail';
  ms: number | null;
}

export interface Commit {
  message: string;
  date: string;
}

export interface CacheEntry {
  url: string;
  html: string;
  timestamp: number;
}

export const THEMES: Record<string, Theme> = {
  mono: {
    p: '#ffffff',
    a: '#cccccc',
    a2: '#888888',
    bg: 'linear-gradient(-45deg,#000000,#0d0d0d,#1a1a1a,#262626,#000000)',
  },
  shadow: {
    p: '#a0aec0',
    a: '#718096',
    a2: '#4a5568',
    bg: 'linear-gradient(-45deg,#0f1419,#1a202c,#2d3748,#4a5568,#0f1419)',
  },
  midnight: {
    p: '#cbd5e1',
    a: '#64748b',
    a2: '#1e293b',
    bg: 'linear-gradient(-45deg,#020617,#0f172a,#1e293b,#334155,#020617)',
  },
};

export const GRADIENTS = [
  'linear-gradient(145deg,#2a2a2a,#3d3d3d)',
  'linear-gradient(145deg,#1a1a1a,#333)',
  'linear-gradient(145deg,#222,#444)',
  'linear-gradient(145deg,#2e2e2e,#3a3a3a)',
  'linear-gradient(145deg,#353535,#454545)',
  'linear-gradient(145deg,#262626,#3b3b3b)',
  'linear-gradient(145deg,#2c2c2c,#404040)',
  'linear-gradient(145deg,#2f2f2f,#424242)',
  'linear-gradient(145deg,#282828,#3c3c3c)',
  'linear-gradient(145deg,#1e1e1e,#333)',
];

export const CDN_TARGETS: CDNTarget[] = [
  // NOTE: this must be a CORS-enabled file (sends ACAO:*). The old
  // /favicon.ico target sends no ACAO header, so its fetch-cors probe failed
  // on every network — including healthy ones — and every report grew a
  // bogus "school filter blocks jsDelivr" row.
  { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js' },
  { name: 'Lumin SDK', url: 'https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js' },
  {
    name: 'Lumin SDK (fastly)',
    url: 'https://fastly.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js',
  },
  {
    name: 'Lumin SDK (gcore)',
    url: 'https://gcore.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js',
  },
  {
    name: 'Lumin SDK (testingcf)',
    url: 'https://testingcf.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js',
  },
  {
    name: 'Lumin SDK (worker proxy)',
    url: 'https://url-marketplace.jesherhaed.workers.dev/lumin/script',
  },
];

// Worker proxy origin (Cloudflare). No `luminsdk` substring, so it survives
// keyword/path filters that kill every jsDelivr POP. Served with CORS + 1h
// edge cache by worker/src/index.js /lumin/*.
export const LUMIN_WORKER_ORIGIN = 'https://url-marketplace.jesherhaed.workers.dev';
export const LUMIN_WORKER_SCRIPT_URL = `${LUMIN_WORKER_ORIGIN}/lumin/script`;
export const LUMIN_WORKER_BOOT_URL = `${LUMIN_WORKER_ORIGIN}/lumin/boot`;
// Lumin worker hosts (observed 2026-10-14: after a successful boot fetch,
// Lumin.init fetches /v1/lumin.worker.js from each boot host in turn, then
// creates its Worker. School filters that 503 the jsDelivr SDK path can also
// block this path while leaving /api/v1/boot reachable — that is the
// LUMIN-WORKER-BLOCKED case: script loads, boot hosts pass, init still fails
// with "Worker connection failed: domain fetch failed").
// Probed by diagnostics; the client fetch/XHR patch in
// src/lumin-worker-proxy routes these through the worker proxy below.
export const LUMIN_WORKER_FILE_TARGETS: CDNTarget[] = [
  {
    name: 'Lumin worker (proxy)',
    url: 'https://url-marketplace.jesherhaed.workers.dev/lumin/worker',
  },
  { name: 'Lumin worker (primary)', url: 'https://a.luminsdk.com/v1/lumin.worker.js' },
  { name: 'Lumin worker (mirror 1)', url: 'https://drkesten.com/v1/lumin.worker.js' },
  { name: 'Lumin worker (mirror 2)', url: 'https://milpagan.org/v1/lumin.worker.js' },
  {
    name: 'Lumin worker (mirror 3)',
    url: 'https://catholicrebuttals.com/v1/lumin.worker.js',
  },
  {
    name: 'Lumin worker (mirror 4)',
    url: 'https://instructure-ramen.hpsschools.org/v1/lumin.worker.js',
  },
];

export const LUMIN_WORKER_PROXY_URL = `${LUMIN_WORKER_ORIGIN}/lumin/worker`;

// Domains the Lumin SDK tries, in order, for its domain handshake (it loads
// <origin>/g/_iframe_probe in a hidden iframe and waits for a postMessage).
// The SDK walks this list until one answers, so the diagnostics probe does
// the same. Mirrors of the same list live in the boot response.
export const LUMIN_HANDSHAKE_ORIGINS: string[] = [
  'https://a.luminsdk.com',
  'https://drkesten.com',
  'https://milpagan.org',
];

// Cache Storage bucket the service worker keeps the Lumin SDK script and its
// worker file in (version-independent, so it survives deploys).
export const LUMIN_CACHE_NAME = 'jesherhead-lumin-v1';

// Lumin backend boot hosts (decoded from the stub; all serve identical JSON).
// Probed by diagnostics only — not part of the games-online ping, since the
// catalog can be browsable while Lumin init is blocked.
export const LUMIN_BACKEND_TARGETS: CDNTarget[] = [
  {
    name: 'Lumin backend (worker proxy)',
    url: 'https://url-marketplace.jesherhaed.workers.dev/lumin/boot',
  },
  { name: 'Lumin backend (primary)', url: 'https://a.luminsdk.com/api/v1/boot' },
  { name: 'Lumin backend (mirror 1)', url: 'https://drkesten.com/api/v1/boot' },
  { name: 'Lumin backend (mirror 2)', url: 'https://milpagan.org/api/v1/boot' },
  { name: 'Lumin backend (mirror 3)', url: 'https://catholicrebuttals.com/api/v1/boot' },
  { name: 'Lumin backend (mirror 4)', url: 'https://instructure-ramen.hpsschools.org/api/v1/boot' },
];

export const CLOAK_PRESETS = {
  classroom: [
    'Google Classroom',
    'https://classroom.google.com/',
    'https://ssl.gstatic.com/classroom/favicon.png',
  ],
  docs: [
    'Google Docs',
    'https://docs.google.com/document/u/0/',
    'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
  ],
  drive: [
    'Google Drive',
    'https://drive.google.com/',
    'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png',
  ],
  // "normal" means no cloak: empty URL disables decoy title/redirect.
  normal: ['jesherhead', '', 'icon.png'],
} as const;

export const FAVICON_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  gif: 'image/gif',
};

export const HAMMER_TITLE = 'jesherhead';
export const HAMMER_ICON = 'icon.png';

export const BLOCKED_PORTED_DOMAIN = 'sites.google.com/auburnsd.org/jesherheadgames';

export const DB_NAME = 'jesherhead_cache';
export const DB_VERSION = 2;
export const GAME_STORE = 'games';
export const MAX_CACHE_ENTRIES = 200;

export function normalizeCloakUrl(url: string | null | undefined): string {
  const u = (url || '').trim();
  // Empty means "no cloak" — callers treat '' as disabled. Never invent a
  // decoy URL here or "reset cloak" silently re-cloaks to Classroom.
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) return 'https://' + u;
  return u;
}
