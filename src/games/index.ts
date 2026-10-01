import type { Game } from '../types/index.js';
import ST from '../storage/index.js';
import { getCachedGame, cacheGame } from '../cache/index.js';
import {
  buildGameIframeHtml,
  getTestPageHtml,
  showTooltip,
  hideTooltip,
  isSafeHttpUrl,
  escapeHtml,
  showErrorToast,
} from '../utils/index.js';
import { openAboutBlankShell, appendShellIframe } from '../cloak/index.js';
import { trackGamePlay } from '../analytics/index.js';

// Sandboxed without allow-same-origin / allow-top-navigation: cached
// third-party game HTML must never read hub localStorage or the parent DOM.
const GAME_FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

function readFavs(): string[] {
  try {
    const parsed: unknown = JSON.parse(ST.get('favs') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

const GAME_TAB_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48dGV4dCB5PSIuOWVtIiBmb250LXNpemU9IjkwIj7wn46A8L3RleHQ+PC9zdmc+';

let GAMES: Game[] = [];
let GAMES_READY = false;
let GAMES_ERR: string | null = null;
let _gamesPromise: Promise<void> | null = null;

let currentCat = 'all';
let currentSort = 'name';
let searchTerm = '';
let currentGameUrl = '';
let launchSeq = 0;

function readPlayCounts(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(ST.get('gamePlays') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function writePlayCounts(counts: Record<string, number>): void {
  try {
    const entries = Object.entries(counts).slice(-1000);
    ST.set('gamePlays', JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
}

const GH = 'https://cdn.jsdelivr.net/gh/gn-math/html@main';
const GH3 = 'https://cdn.jsdelivr.net/gh/3kh0/3kh0-lite@main';

async function loadGames(): Promise<void> {
  if (_gamesPromise) return _gamesPromise;
  _gamesPromise = (async () => {
    const maxRetries = 3;
    const baseDelay = 500;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(import.meta.env.BASE_URL + 'data/games_merged.json');
        if (!res.ok) throw new Error('Failed to load games');
        const data = await res.json();
        const savedCounts = readPlayCounts();
        const playedSet = new Set<string>();
        try {
          const played: unknown = JSON.parse(ST.get('gamePlayed') || '[]');
          if (Array.isArray(played)) {
            for (const v of played) if (typeof v === 'string') playedSet.add(v);
          }
        } catch {
          /* ignore */
        }
        GAMES = (data as Record<string, unknown>[]).map(g => {
          const rec = g as Record<string, unknown>;
          const url = typeof rec['u'] === 'string' ? (rec['u'] as string) : '';
          return {
            ...rec,
            plays: savedCounts[url] || 0,
            rating: 0,
            played: playedSet.has(url),
          } as Game;
        });
        GAMES_READY = true;
        GAMES_ERR = null;
        return;
      } catch (e) {
        if (attempt === maxRetries) {
          console.error('Failed to load games after retries:', e);
          GAMES_ERR = 'Failed to load game catalog';
          GAMES_READY = false;
          _gamesPromise = null;
          throw e;
        }
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  })();
  return _gamesPromise;
}

function isHtmlSourceUrl(url: string): boolean {
  return (
    url.startsWith(GH) ||
    url.startsWith(GH3) ||
    /\.html?(?:[?#].*)?$/i.test(url) ||
    /\/index\.html?(?:[?#].*)?$/i.test(url)
  );
}

function shouldOpenInNewTab(url: string): boolean {
  return url === 'https://csclub.uwaterloo.ca/~s23adhik/myPosts/imposter.html';
}

// Opens a game in an about:blank popup with a Back/Reload toolbar. Built
// with DOM APIs only (see openAboutBlankShell): document.write on the new
// tab would re-URL it to this page's URL in current Chrome. Returns false
// when the popup was blocked so callers can fall back.
function openGameShellTab(url: string, name: string): boolean {
  const shell = openAboutBlankShell(name, GAME_TAB_ICON);
  if (!shell) return false;
  const d = shell.doc;
  const css = d.createElement('style');
  css.textContent =
    '.tb{height:54px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:rgba(0,0,0,.85);border-bottom:1px solid rgba(255,255,255,.12);color:#e0e0e0;font-family:Segoe UI,system-ui,sans-serif}.ttl{font-weight:800;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.acts{display:flex;gap:10px;align-items:center}.tb button{border:none;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer;font-family:inherit}.back{background:#555;color:#111}.reload{background:#444;color:#fff}';
  d.head.appendChild(css);
  const hubUrl = location.href.split('#')[0] ?? location.href;
  const bar = d.createElement('div');
  bar.className = 'tb';
  const back = d.createElement('button');
  back.className = 'back';
  back.textContent = '← Back to Hub';
  const ttl = d.createElement('div');
  ttl.className = 'ttl';
  ttl.textContent = name;
  const acts = d.createElement('div');
  acts.className = 'acts';
  const reload = d.createElement('button');
  reload.className = 'reload';
  reload.textContent = '↻ Reload';
  back.onclick = () => {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.focus();
        shell.win.close();
        return;
      }
    } catch {
      /* opener inaccessible — fall through to in-tab hub */
    }
    // Opener is gone: reuse this tab for the hub instead of stranding it.
    if (frame) frame.src = hubUrl;
  };
  reload.onclick = () => {
    if (frame) frame.src = url;
  };
  acts.appendChild(reload);
  bar.appendChild(back);
  bar.appendChild(ttl);
  bar.appendChild(acts);
  d.body.appendChild(bar);
  const frame = appendShellIframe(shell, { src: url });
  if (!frame) {
    try {
      shell.win.close();
    } catch {
      /* ignore */
    }
    return false;
  }
  // Shrink the fullscreen shell iframe to sit below the 54px toolbar.
  frame.style.height = 'calc(100% - 54px)';
  try {
    shell.win.focus();
  } catch {
    /* ignore */
  }
  return true;
}

function openDirectGameTab(url: string): void {
  try {
    const game = GAMES.find(g => g.u === url) || { n: 'Game' };
    if (openGameShellTab(url, game.n)) return;
  } catch {
    /* fall through to direct open */
  }
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (w) w.opener = null;
  } catch {
    /* popup blocked */
  }
}

function showDirectLaunchOverlay(name: string, _url: string): void {
  const frame = document.getElementById('gf') as HTMLIFrameElement | null;
  if (!frame) return;
  frame.src = '';
  // Escape the catalog-supplied name: a poisoned catalog entry must not
  // become stored HTML injection inside the overlay document.
  const safeName = escapeHtml(name);
  frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>html,body{margin:0;height:100%;background:#000;color:#e0e0e0;font-family:Segoe UI,system-ui,sans-serif;overflow:hidden}body{position:relative}.bg{position:absolute;inset:0;background:radial-gradient(circle at 50% 20%,rgba(255,255,255,.06),transparent 35%),radial-gradient(circle at 80% 80%,rgba(255,255,255,.05),transparent 30%),linear-gradient(180deg,#111 0%,#000 100%)}.wrap{position:relative;z-index:1;height:100%;display:flex;align-items:center;justify-content:center;padding:28px}.panel{width:min(1100px,100%);height:min(78vh,760px);border:1px solid rgba(255,255,255,.12);border-radius:18px;background:linear-gradient(180deg,rgba(0,0,0,.85),rgba(0,0,0,.94));box-shadow:0 20px 60px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}.bar{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)}.title{font-size:15px;font-weight:800;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%}.pill{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#ccc;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:6px 10px;border-radius:999px}.stage{flex:1;display:flex;align-items:center;justify-content:center;padding:28px}.inner{text-align:center;max-width:640px}.spinner{width:64px;height:64px;border-radius:50%;border:4px solid rgba(255,255,255,.12);border-top-color:#e0e0e0;margin:0 auto 18px;animation:spin 1s linear infinite}.headline{font-size:28px;font-weight:900;margin-bottom:10px}.sub{font-size:15px;line-height:1.6;color:#aaa;margin-bottom:22px}.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.btn{display:inline-block;padding:12px 22px;border-radius:12px;background:#444;color:#fff;text-decoration:none;font-weight:700;cursor:pointer;border:none}.btn:hover{background:#555}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="bg"></div><div class="wrap"><div class="panel"><div class="bar"><span class="title">${safeName}</span><span class="pill">NEW TAB</span></div><div class="stage"><div class="inner"><div class="spinner"></div><div class="headline">Opening in new tab…</div><div class="sub">If it doesn't open automatically, check your popup blocker.</div><div class="actions"><button class="btn" onclick="window.close()">Close</button></div></div></div></div></div></body></html>`;
}

async function launchGame(url: string, name: string): Promise<void> {
  const go = document.getElementById('go');
  if (!go) return;
  // Staleness token: launching B while A is still fetching must not let A's
  // slower response overwrite B.
  const myLaunch = ++launchSeq;
  currentGameUrl = url;
  trackGamePlay(name, url);
  const gt = document.getElementById('gt');
  if (gt) gt.textContent = '🎮 ' + name;
  let playCount = parseInt(ST.get('playCount') || '0', 10);
  if (!Number.isFinite(playCount) || playCount < 0) playCount = 0;
  playCount++;
  ST.set('playCount', playCount.toString());
  const game = GAMES.find(g => g.u === url);
  if (game) {
    game.plays++;
    game.played = true;
    const counts = readPlayCounts();
    counts[url] = game.plays;
    writePlayCounts(counts);
    try {
      const played: unknown = JSON.parse(ST.get('gamePlayed') || '[]');
      const arr = Array.isArray(played) ? played.filter(v => typeof v === 'string') : [];
      if (!arr.includes(url)) {
        arr.push(url);
        ST.set('gamePlayed', JSON.stringify(arr.slice(-1000)));
      }
    } catch {
      /* ignore */
    }
  }

  if (shouldOpenInNewTab(url)) {
    showDirectLaunchOverlay(name, url);
    openDirectGameTab(url);
    return;
  }

  const frame = document.getElementById('gf') as HTMLIFrameElement | null;
  if (!frame) return;
  frame.setAttribute('sandbox', GAME_FRAME_SANDBOX);
  // Keep storage-access: games/SDKs use requestStorageAccess() for saves and
  // the browser gates it on user activation, so removing it only breaks games.
  frame.setAttribute('allow', 'storage-access *; autoplay; fullscreen');
  frame.src = '';
  frame.srcdoc = '';

  if (url === '__TEST_LUMIN__') {
    try {
      const rawCached = await getCachedGame('__TEST_LUMIN__');
      // Discard stale entries cached while the SDK URL pointed at a 404ing
      // @1 pin — otherwise the broken page persists in IndexedDB forever.
      const cached = rawCached && !rawCached.includes('script@1/') ? rawCached : null;
      if (myLaunch !== launchSeq || !document.getElementById('go')?.classList) return;
      const testHtml = cached || getTestPageHtml();
      if (!cached) {
        await cacheGame('__TEST_LUMIN__', testHtml);
        console.log('[Game Cache] Cached Lumen SDK test page');
      }
      if (myLaunch !== launchSeq) return;
      // Don't inject into a closed overlay.
      if (
        !document.getElementById('go')?.classList.contains('act') &&
        go !== document.getElementById('go')
      )
        return;
      frame.srcdoc = testHtml;
      go.classList.add('act');
    } catch {
      if (myLaunch !== launchSeq) return;
      frame.srcdoc = getTestPageHtml();
      go.classList.add('act');
    }
    return;
  }

  if (isHtmlSourceUrl(url)) {
    const { buildRenderableHtml } = await import('./html.js');
    if (myLaunch !== launchSeq) return;
    try {
      const html = await buildRenderableHtml(url);
      if (myLaunch !== launchSeq) return;
      // Overlay may have been closed mid-fetch — don't inject into hidden frame.
      if (!document.body.contains(frame)) return;
      frame.srcdoc = html;
    } catch {
      if (myLaunch !== launchSeq) return;
      if (!document.body.contains(frame)) return;
      frame.srcdoc = buildGameIframeHtml(url);
    }
  } else {
    frame.srcdoc = buildGameIframeHtml(url);
  }
  go.classList.add('act');
}

function closeGame(): void {
  const go = document.getElementById('go');
  if (go) go.classList.remove('act');
  const frame = document.getElementById('gf') as HTMLIFrameElement | null;
  if (frame) {
    frame.src = '';
    frame.srcdoc = '';
  }
}

async function openGameTab(): Promise<void> {
  if (!currentGameUrl) return;
  const gt = document.getElementById('gt');
  const rawName = gt ? gt.textContent : '';
  const name = rawName ? rawName.replace('🎮 ', '') : 'Game';
  if (currentGameUrl === '__TEST_LUMIN__') {
    // Open synchronously to keep the click gesture; fill in once loaded.
    const shell = openAboutBlankShell('Test', GAME_TAB_ICON);
    if (!shell) {
      showErrorToast('Allow popups to open game in new tab');
      return;
    }
    const myLaunch = launchSeq;
    try {
      const rawCached = await getCachedGame('__TEST_LUMIN__');
      // Discard stale entries cached while the SDK URL pointed at @1 (404).
      const cached = rawCached && !rawCached.includes('script@1/') ? rawCached : null;
      if (myLaunch !== launchSeq) {
        try {
          shell.win.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const testHtml = cached || getTestPageHtml();
      if (!cached) {
        await cacheGame('__TEST_LUMIN__', testHtml);
      }
      if (shell.win.closed) return;
      if (!appendShellIframe(shell, { srcdoc: testHtml })) {
        try {
          shell.win.close();
        } catch {
          /* ignore */
        }
      } else {
        try {
          shell.win.focus();
        } catch {
          /* ignore */
        }
      }
    } catch {
      try {
        shell.win.close();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  try {
    if (openGameShellTab(currentGameUrl, name)) return;
  } catch {
    /* fall through to direct open below */
  }
  if (!isSafeHttpUrl(currentGameUrl)) {
    showErrorToast('Blocked unsafe game URL');
    return;
  }
  try {
    const w = window.open(currentGameUrl, '_blank', 'noopener,noreferrer');
    if (w) w.opener = null;
    else showErrorToast('Allow popups to open game in new tab');
  } catch {
    showErrorToast('Allow popups to open game in new tab');
  }
}

function renderGames(): void {
  const grid = document.getElementById('gg');
  if (!grid) return;

  if (GAMES_ERR) {
    grid.innerHTML = `<div style="color:var(--text-secondary);text-align:center;padding:80px;grid-column:1/-1">⚠️ ${GAMES_ERR}</div>`;
    return;
  }

  if (!GAMES_READY) {
    return;
  }

  const favs = readFavs();
  let list = GAMES.filter(g => {
    if (currentCat === 'favs') return favs.includes(g.u);
    if (currentCat === '2player') return g.p >= 2;
    if (currentCat !== 'all') return g.c === currentCat;
    return true;
  });

  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    list = list.filter(
      g => g.n.toLowerCase().includes(term) || (g.d && g.d.toLowerCase().includes(term))
    );
  }

  if (currentSort === 'plays') {
    list.sort((a, b) => b.plays - a.plays);
  } else {
    list.sort((a, b) => a.n.localeCompare(b.n));
  }

  const gameCount = document.getElementById('game-count');
  if (gameCount) gameCount.textContent = list.length + ' games';

  // Clear previous cards: without this every filter/sort/search appends a
  // second copy of the grid.
  grid.replaceChildren();

  if (!list.length) {
    grid.innerHTML =
      '<div style="color:var(--text-secondary);text-align:center;padding:80px;grid-column:1/-1">No games found</div>';
    return;
  }

  // Build off-DOM in a fragment to avoid a layout per card on large catalogs.
  const fragment = document.createDocumentFragment();

  list.forEach(g => {
    const card = document.createElement('div');
    card.className = 'card';

    // Accept same-origin relative thumbnails; only absolute URLs need the
    // public-http safety check. Broken entries get no image and no launch.
    const imgSrc = g.i || '';
    const imgOk =
      imgSrc &&
      (imgSrc.startsWith('/') || imgSrc.startsWith('./') || !/^[a-z][a-z0-9+.-]*:/i.test(imgSrc)
        ? true
        : isSafeHttpUrl(imgSrc));
    if (imgOk) {
      const img = document.createElement('img');
      img.className = 'cbg';
      img.src = imgSrc;
      img.loading = 'lazy';
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
      });
      card.appendChild(img);
    }

    const cover = document.createElement('div');
    cover.className = 'cov';
    const playBtn = document.createElement('button');
    playBtn.className = 'pb';
    playBtn.textContent = g.broken ? 'Blocked' : 'Play';
    if (g.broken) playBtn.setAttribute('disabled', '');
    else
      playBtn.addEventListener('click', e => {
        e.stopPropagation();
        void launchGame(g.u, g.n);
      });
    cover.appendChild(playBtn);
    card.appendChild(cover);

    if (g.broken) {
      const badge = document.createElement('div');
      badge.className = 'bbdg';
      badge.textContent = 'BLOCKED';
      card.appendChild(badge);
      card.setAttribute('aria-disabled', 'true');
      // Blocked cards are display-only: no launch, no tilt, no tooltip.
      fragment.appendChild(card);
      return;
    }

    // Throttle tilt via rAF: unthrottled style writes jank on large catalogs.
    let tiltQueued = false;
    card.addEventListener('mousemove', e => {
      if (tiltQueued) return;
      tiltQueued = true;
      const cx = e.clientX;
      const cy = e.clientY;
      requestAnimationFrame(() => {
        tiltQueued = false;
        const r = card.getBoundingClientRect();
        card.style.transform = `perspective(1000px) rotateX(${(cy - r.top - r.height / 2) / 10}deg) rotateY(${(r.left + r.width / 2 - cx) / 10}deg) scale(1.02)`;
      });
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
      hideTooltip();
    });
    card.addEventListener('mouseenter', e => {
      if (g.d) showTooltip(e as MouseEvent, g.d);
    });
    card.addEventListener('click', () => {
      void launchGame(g.u, g.n);
    });
    fragment.appendChild(card);
  });
  grid.appendChild(fragment);
}

function sortGames(type: string, btn: HTMLElement): void {
  currentSort = type;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGames();
}

function filterCat(cat: string, btn: HTMLElement): void {
  currentCat = cat;
  document.querySelectorAll('.ctb').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  renderGames();
}

function randomGame(): void {
  const favs = readFavs();
  const a = GAMES.filter(g => {
    if (g.broken) return false;
    if (currentCat === 'favs') return favs.includes(g.u);
    if (currentCat === '2player') return g.p >= 2;
    if (currentCat !== 'all') return g.c === currentCat;
    return true;
  });
  if (a.length) {
    const g = a[Math.floor(Math.random() * a.length)];
    if (g && !g.broken) void launchGame(g.u, g.n);
  }
}

function searchGames(t: string): void {
  searchTerm = t;
  renderGames();
}

export {
  loadGames,
  renderGames,
  launchGame,
  closeGame,
  openGameTab,
  filterCat,
  sortGames,
  randomGame,
  searchGames,
};
