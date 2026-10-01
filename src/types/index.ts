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
  { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/favicon.ico' },
  { name: 'Lumin SDK', url: 'https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js' },
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
