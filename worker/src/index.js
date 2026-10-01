// URL Marketplace worker: anonymous submit/feedback -> GitHub Issues.
// The GitHub token lives ONLY here as a Worker secret, never in the page.
//
// Endpoints:
//   GET  /list                 -> open marketplace issues (newest first, max 100)
//   POST /submit   {url,description?,category?} -> create one issue per URL (409 if duplicate)
//   POST /feedback {id,status}  -> move issue to status label + log a comment
//   POST /react    {id,type,remove?,voter?} -> switchable emoji vote (one per browser)
//   POST /report   {id,reason}  -> flag issue for manual review (label + comment)
//   POST /admin/login {user,pass} -> admin session token (rate-limited)
//   GET  /admin/list            -> ALL marketplace issues incl. closed (auth)
//   GET  /admin/reports         -> open needs-review issues (auth)
//   POST /admin/status {id,status} -> set status, keeps review flag (auth)
//   POST /admin/remove {id,reopen?} -> close (or reopen) an issue (auth)
//   POST /admin/clear-report {id} -> drop needs-review flag (auth)
//   POST /admin/mode {mode}    -> normal | readonly | off kill switch (auth)
//   GET  /notice                -> public admin announcement ({notice} or null)
//   GET  /admin/notice          -> current announcement incl. hidden (auth)
//   POST /admin/notice {text,visible} -> set announcement text + visibility (auth)
//
// Required Worker secret: GITHUB_TOKEN (fine-grained PAT, this repo only,
//   Repository permissions -> Issues: Read and write)
// Required KV binding: RL (rate limits)
// Optional Worker secret: SAFE_BROWSING_KEY (Google Safe Browsing API v4 key,
//   restricted to the Safe Browsing API). When set, every submitted URL is
//   also screened for malware/phishing/unwanted software; when unset or the
//   API errors, submissions skip that live check (fail-open) but the static
//   adult/binary denylists below are still always enforced.
// Admin panel secrets (all three required to enable admin endpoints):
//   ADMIN_USER (plain username), ADMIN_PASS_HASH (hex SHA-256 of the password),
//   ADMIN_SECRET (long random string used to sign session tokens).
//   Generate the hash with: echo -n 'your-password' | sha256sum

const OWNER = 'jesherhead';
const REPO = 'jesherhead';
const LABEL = 'marketplace-url';
const MAX_ITEMS = 100;
const DESCRIPTION_MAX_LEN = 50;

// Descriptions are plain short text: no links, no profanity/sexual content.
// Matched as whole words only (never substrings), so e.g. "class" or
// "password" are NOT flagged by the "ass" entry.
const DESCRIPTION_BANNED_WORDS = new Set([
  'fuck', 'fucker', 'fucking', 'fucked', 'shit', 'shitty', 'bitch', 'bitches',
  'cunt', 'dick', 'dickhead', 'cock', 'cocksucker', 'pussy', 'tits', 'titties',
  'boobs', 'boob', 'porn', 'porno', 'porns', 'hentai', 'xxx', 'slut', 'sluts',
  'whore', 'whores', 'escort', 'escorts', 'nude', 'nudes', 'nudity', 'naked',
  'sex', 'sexy', 'masturbate', 'orgasm', 'cum', 'cumming', 'dildo', 'blowjob',
  'handjob', 'anal', 'milf', 'incest', 'bestiality', 'asshole', 'bastard',
  'nigga', 'nigger', 'faggot', 'retard',
]);

// Catches http(s)://..., www...., and bare domains like foo.com/page.
const DESCRIPTION_LINK_PATTERN =
  /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|co|dev|app|gg|xyz|site|online|store|info|biz|me|tv|cc|to|ly|gl|tk|ml|ga|cf)\b)/i;

/**
 * Pure description screen. Exported for unit testing.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkDescription(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: true };
  if (DESCRIPTION_LINK_PATTERN.test(t)) {
    return { ok: false, reason: 'Links are not allowed in descriptions.' };
  }
  const words = t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (DESCRIPTION_BANNED_WORDS.has(w)) {
      return { ok: false, reason: 'That description contains blocked words.' };
    }
  }
  return { ok: true };
}
const SUBMIT_LIMIT_PER_HOUR = 20;
const ALLOWED_ORIGIN = 'https://jesherhead.github.io';

// PostHog reverse proxy upstream. Adblock lists block *.i.posthog.com, so
// the site (src/analytics/) points api_host at <worker>/ph instead, and this
// worker forwards to the real host. Must match the project's region:
// US Cloud -> https://us.i.posthog.com, EU Cloud -> https://eu.i.posthog.com.
const POSTHOG_UPSTREAM = 'https://us.i.posthog.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function gh(path, token, options = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'jesherhead-url-marketplace',
      ...(options.headers || {}),
    },
  });
  const rawText = await res.text();
  let body = null;
  try {
    body = JSON.parse(rawText);
  } catch (err) {
    body = null;
  }
  if (!res.ok) {
    const err = new Error('GitHub request failed: ' + res.status);
    err.upstream = res.status;
    // Keep upstream body server-side only (console) — public responses map
    // to generic messages below so GitHub internals never leak to clients.
    try {
      console.error('[worker] GitHub error', res.status, (rawText || '').slice(0, 300));
    } catch (_e) {}
    err.upstreamMessage = null;
    throw err;
  }
  return body;
}

function parseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 500);
  if (!/^https?:\/\/.+/i.test(trimmed)) return null;
  let u;
  try {
    u = new URL(trimmed);
  } catch (err) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Reject credentialed URLs (https://user:pass@host/): classic phishing shape
  // with no legitimate use in a link marketplace.
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  // Reject non-routable targets: localhost, intranet, link-local, metadata.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|30|31)\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return null;
  }
  u.hostname = host;
  u.hash = '';
  return u.toString();
}

// Canonical form used only for duplicate comparison.
function canonicalUrl(siteUrl) {
  return siteUrl.toLowerCase().replace(/\/+$/, '') || siteUrl.toLowerCase();
}

// ---- Submission safety filters ----
// Static, high-precision denylists enforced on every /submit (the worker is
// the source of truth; the marketplace page mirrors these for instant
// feedback). Host labels match whole dot-separated DNS labels only — never
// substrings — so e.g. "essex.com" is NOT flagged by the "sex" label.
/* FILTER-LISTS-START */
const ADULT_TLDS = new Set(['xxx', 'adult', 'porn', 'sex', 'sexy']);

// Well-known adult domains (exact host or any subdomain matches).
const BLOCKED_DOMAINS = new Set([
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
  'youporn.com', 'youjizz.com', 'tube8.com', 'spankbang.com', 'spankwire.com',
  'keezmovies.com', 'tnaflix.com', 'empaflix.com', 'eporner.com', 'pornhd.com',
  'pornone.com', 'porn.com', 'beeg.com', '4tube.com', 'drtuber.com', 'fux.com',
  'hclips.com', 'vporn.com', 'upornia.com', 'txxx.com', 'nudevista.com',
  'pornoxo.com', 'brazzers.com', 'bangbros.com', 'realitykings.com',
  'naughtyamerica.com', 'mofos.com', 'teamskeet.com', 'blacked.com',
  'tushy.com', 'vixen.com', 'twistys.com', 'penthouse.com', 'playboy.com',
  'hustler.com', 'onlyfans.com', 'fansly.com', 'manyvids.com',
  'clips4sale.com', 'chaturbate.com', 'myfreecams.com', 'livejasmin.com',
  'streamate.com', 'camsoda.com', 'bongacams.com', 'stripchat.com',
  'xlovecam.com', 'cam4.com', 'nhentai.net', 'hanime.tv',
  'hentaifoundry.com', 'e621.net', 'motherless.com', 'efukt.com',
  'literotica.com',
]);

// Flagged only when a FULL hostname label equals one of these.
const ADULT_LABELS = new Set([
  'porn', 'porno', 'porns', 'porntube', 'sextube', 'hentaitube', 'xxx',
  'hentai', 'sex', 'sexy', 'adult', 'escort', 'escorts', 'camgirl',
  'camgirls', 'nude', 'nudes', 'boobs', 'milf',
]);

// Direct executable downloads are a classic malware vector; the marketplace
// is for site links, not binaries.
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'apk', 'apks', 'xapk', 'dmg', 'pkg', 'scr', 'bat', 'cmd',
  'com', 'pif', 'ps1', 'vbs', 'msc',
]);
/* FILTER-LISTS-END */

/**
 * Pure static safety screen. Exported for unit testing.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkUrlSafety(siteUrl) {
  let u;
  try {
    u = new URL(siteUrl);
  } catch (err) {
    return { ok: false, reason: 'Provide a valid public http(s) URL.' };
  }
  const host = u.hostname.toLowerCase();
  const labels = host.split('.');
  if (ADULT_TLDS.has(labels[labels.length - 1])) {
    return { ok: false, reason: 'Adult sites are not allowed in this marketplace.' };
  }
  for (const d of BLOCKED_DOMAINS) {
    if (host === d || host.endsWith('.' + d)) {
      return { ok: false, reason: 'That site is on the blocklist.' };
    }
  }
  if (labels.some((l) => ADULT_LABELS.has(l))) {
    return { ok: false, reason: 'Adult sites are not allowed in this marketplace.' };
  }
  const ext = u.pathname.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (ext && BLOCKED_EXTENSIONS.has(ext[1])) {
    return { ok: false, reason: 'Direct app/binary downloads are not allowed — submit the site instead.' };
  }
  return { ok: true };
}

function sbCacheKey(siteUrl) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < siteUrl.length; i++) {
    h1 ^= siteUrl.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return 'sb:' + (h1 >>> 0).toString(36);
}

/**
 * Live Google Safe Browsing v4 screen for malware/phishing/unwanted
 * software. Fail-open (returns ok) when no key is configured, KV is
 * unavailable, or the API errors — the static denylists above still apply.
 */
async function checkSafeBrowsing(siteUrl, env) {
  const key = env && env.SAFE_BROWSING_KEY;
  if (!key) return { ok: true, skipped: true };
  const cacheKey = sbCacheKey(siteUrl);
  try {
    if (env.RL) {
      const cached = await env.RL.get(cacheKey);
      if (cached === 'bad') return { ok: false, reason: 'That URL was flagged as unsafe (malware/phishing).' };
      if (cached === 'ok') return { ok: true, cached: true };
    }
  } catch (err) {}
  let data = null;
  try {
    const res = await fetch(
      'https://safebrowsing.googleapis.com/v4/threatMatches:find?key=' + encodeURIComponent(key),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'jesherhead-marketplace', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url: siteUrl }],
          },
        }),
      }
    );
    if (!res.ok) return { ok: true, skipped: true };
    data = await res.json().catch(() => null);
  } catch (err) {
    return { ok: true, skipped: true };
  }
  const matches = data && Array.isArray(data.matches) ? data.matches : [];
  try {
    if (env.RL) {
      await env.RL.put(cacheKey, matches.length ? 'bad' : 'ok', { expirationTtl: 3600 });
    }
  } catch (err) {}
  if (matches.length) {
    const types = [...new Set(matches.map((m) => m.threatType).filter(Boolean))].join(', ');
    return { ok: false, reason: 'That URL was flagged as unsafe' + (types ? ' (' + types + ')' : '') + '.' };
  }
  return { ok: true };
}

function parseStatus(raw) {
  return raw === 'working' || raw === 'blocked' ? raw : null;
}

// Submit-time category picker: ai | games | media. Anything else means
// "no category" (older entries and skipped picks show no icon).
function parseCategory(raw) {
  return raw === 'ai' || raw === 'games' || raw === 'media' ? raw : '';
}

function issueToEntry(issue, tallyOverride) {
  const body = issue.body || '';
  const urlMatch = body.match(/^URL:[ \t]*(.+)[ \t]*$/m);
  const descMatch = body.match(/^Description:[ \t]*(.*)[ \t]*$/m);
  const catMatch = body.match(/^Category:[ \t]*([a-z]*)[ \t]*$/m);
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  // Vote tallies live in KV (see getTally): every IP gets its own vote, so
  // counts can grow past 1. GitHub issue reactions are NOT the tally — all
  // marketplace votes used to be cast as the single token user, and GitHub
  // de-duplicates those ("Reaction exists", no increment), which collapsed
  // every same-emoji vote into a max of 1 and made votes look unsaved.
  // tallyOverride (from KV) wins; otherwise fall back to the GitHub baseline
  // (used once to seed the tally, then ignored).
  const baseline = issue.reactions || {};
  const t = tallyOverride || {};
  const num = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    id: issue.number,
    url: urlMatch ? urlMatch[1].trim() : issue.title.replace(/^Site:\s*/, ''),
    description: descMatch ? descMatch[1].trim().slice(0, DESCRIPTION_MAX_LEN) : '',
    category: parseCategory(catMatch ? catMatch[1].trim() : ''),
    status: labels.includes('status:blocked') ? 'blocked' : 'working',
    submittedAt: issue.created_at,
    reactions: {
      thumbsup: t.thumbsup != null ? num(t.thumbsup) : num(baseline['+1']),
      thumbsdown: t.thumbsdown != null ? num(t.thumbsdown) : num(baseline['-1']),
      fire: t.fire != null ? num(t.fire) : num(baseline.hooray),
      redx: t.redx != null ? num(t.redx) : num(baseline.confused),
    },
  };
}

// Only these four vote buttons exist on the page. 'heart' was a legacy type
// (same +2 weight as fire); it is no longer accepted — old heart tallies are
// folded into fire when a tally is first seeded so no historical votes vanish.
const REACTION_TYPES = ['thumbsup', 'thumbsdown', 'fire', 'redx'];
function isReactionType(t) {
  return REACTION_TYPES.includes(t);
}
// Per-browser voter id (generated once on the page, stored in localStorage +
// cookie). Lets distinct people behind one shared IP/NAT each hold their own
// vote. Old clients that don't send one fall back to the IP key below.
export function parseVoterId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) return null;
  return v;
}
function tallyKey(id) {
  return 'tally:' + id;
}
function cleanTally(raw) {
  const out = { thumbsup: 0, thumbsdown: 0, fire: 0, redx: 0 };
  if (raw && typeof raw === 'object') {
    for (const k of REACTION_TYPES) {
      const n = parseInt(raw[k], 10);
      out[k] = Number.isFinite(n) && n > 0 ? n : 0;
    }
    // Fold legacy heart votes into fire (same weight) instead of dropping them.
    const heart = parseInt(raw.heart, 10);
    if (Number.isFinite(heart) && heart > 0) out.fire += heart;
  }
  return out;
}
function baselineTally(issue) {
  const r = (issue && issue.reactions) || {};
  return cleanTally({
    thumbsup: r['+1'],
    thumbsdown: r['-1'],
    fire: r.hooray,
    redx: r.confused,
    heart: r.heart,
  });
}
// Load the KV tally for an issue, seeding it once from the GitHub baseline
// (which includes any pre-tally votes) so counts never reset to zero.
async function getTally(env, id, issue) {
  try {
    const raw = await env.RL.get(tallyKey(id), 'json');
    if (raw && typeof raw === 'object') return cleanTally(raw);
  } catch (err) {}
  const seeded = baselineTally(issue);
  try {
    await env.RL.put(tallyKey(id), JSON.stringify(seeded));
  } catch (err) {}
  return seeded;
}
async function putTally(env, id, tally) {
  try {
    await env.RL.put(tallyKey(id), JSON.stringify(cleanTally(tally)));
  } catch (err) {}
}
// Entries for /list and /admin/list with KV tallies applied.
async function entriesWithTallies(issues, env) {
  return Promise.all(
    (Array.isArray(issues) ? issues : []).map(async (issue) => {
      const tally = await getTally(env, issue.number, issue);
      return issueToEntry(issue, tally);
    })
  );
}
const LIST_CACHE_KEY = 'list:v1';
const LIST_CACHE_TTL = 60;

async function listIssues(token, useCache, env) {
  if (useCache && env && env.RL) {
    try {
      const cached = await env.RL.get(LIST_CACHE_KEY, 'json');
      if (cached) return cached;
    } catch (err) {}
  }
  const body = await gh(
    `/repos/${OWNER}/${REPO}/issues?labels=${LABEL}&state=open&per_page=100`,
    token
  );
  const issues = Array.isArray(body) ? body : [];
  if (useCache && env && env.RL) {
    try {
      await env.RL.put(LIST_CACHE_KEY, JSON.stringify(issues), { expirationTtl: LIST_CACHE_TTL });
    } catch (err) {}
  }
  return issues;
}

async function invalidateListCache(env) {
  try {
    await env.RL.delete(LIST_CACHE_KEY);
  } catch (err) {}
}

async function ensureLabels(token) {
  for (const [name, color] of [[LABEL, '0e8a16'], ['status:working', '0e8a16'], ['status:blocked', 'b60205'], ['needs-review', 'e99695']]) {
    try {
      await gh(`/repos/${OWNER}/${REPO}/labels`, token, {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
    } catch (err) {
      // 422 = already exists, safe to ignore. Re-throw auth/permission
      // errors (401/403/404) so a bad GITHUB_TOKEN surfaces instead of
      // silently failing later.
      if (err.upstream === 422 || err.upstream == null) continue;
      throw err;
    }
  }
}

// Best-effort client identity for rate-limit and vote keys. Prefers the
// Cloudflare client IP, falls back to the first X-Forwarded-For hop. Never
// returns a bare 'unknown' shared by every header-less request (one shared
// bucket lets a single client eat the quota for everyone on a direct-worker
// route) — mixes in a User-Agent hash so such clients at least shard.
function clientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  const xff = (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  const ip = (cfIp || xff || '').trim();
  if (ip) return ip;
  const ua = request.headers.get('User-Agent') || 'no-ua';
  let h = 0x811c9dc5;
  for (let i = 0; i < ua.length; i++) {
    h ^= ua.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'unknown-' + (h >>> 0).toString(36);
}

async function checkRateLimit(env, request, cost = 1, keyPrefix = 'rl:', limit = SUBMIT_LIMIT_PER_HOUR) {
  // Composite key (IP + UA hash) so header-less direct-worker requests don't
  // share one bucket, and rotating UA alone doesn't mint a fresh IP bucket.
  // Note: KV read-then-write is non-atomic (TOCTOU burst bypass under
  // concurrency) — acceptable for best-effort abuse dampening, not a cap.
  const ua = request.headers.get('User-Agent') || 'no-ua';
  let uh = 0x811c9dc5;
  for (let i = 0; i < Math.min(ua.length, 200); i++) {
    uh ^= ua.charCodeAt(i);
    uh = Math.imul(uh, 0x01000193);
  }
  const key = keyPrefix + clientIp(request) + ':' + (uh >>> 0).toString(36);
  let current = 0;
  try {
    current = parseInt((await env.RL.get(key)) || '0', 10) || 0;
  } catch (err) {
    current = 0;
  }
  if (current >= limit) return false;
  try {
    await env.RL.put(key, String(current + cost), { expirationTtl: 3600 });
  } catch (err) {
    // Fail closed on KV errors for mutating endpoints? No — fail open to
    // avoid bricking the marketplace when KV hiccups; limits are dampeners.
  }
  return true;
}

// Votes are cheap and frequent (browsing + tapping several cards), so they
// get their own generous bucket. Without this, the shared 20/hour submit
// bucket silently rejected votes and the page showed them as saved locally
// while the server never recorded them.
const VOTE_LIMIT_PER_HOUR = 200;

// ---- Admin auth (HMAC-signed session tokens, 12h expiry) ----

const ADMIN_TOKEN_TTL = 12 * 3600 * 1000;
const ADMIN_FAIL_LIMIT = 10;

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function adminEnabled(env) {
  return Boolean(env.ADMIN_USER && env.ADMIN_PASS_HASH && env.ADMIN_SECRET);
}

async function mintAdminToken(env) {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ u: env.ADMIN_USER, exp: Date.now() + ADMIN_TOKEN_TTL }))
  );
  const sig = await hmacSign(env.ADMIN_SECRET, payload);
  return payload + '.' + sig;
}

async function verifyAdminToken(request, env) {
  if (!adminEnabled(env)) return null;
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expect = await hmacSign(env.ADMIN_SECRET, payload);
  if (!safeEqual(sig, expect)) return null;
  let data = null;
  try {
    data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch (err) {
    return null;
  }
  if (!data || !safeEqual(String(data.u || ''), String(env.ADMIN_USER || '')) || typeof data.exp !== 'number' || Date.now() > data.exp) {
    return null;
  }
  return data.u;
}

// Kill-switch mode stored in KV: 'normal' | 'readonly' | 'off'.
async function getMode(env) {
  try {
    const m = await env.RL.get('marketplace:mode');
    if (m === 'readonly' || m === 'off') return m;
  } catch (err) {}
  return 'normal';
}

// Admin announcement ("info thingy") stored in KV as JSON:
//   { text: string (max 500), visible: boolean, updatedAt: number }.
// Public readers only ever see it when visible is true and text is non-empty.
const NOTICE_KEY = 'marketplace:notice';
const NOTICE_MAX_LEN = 500;

async function getNotice(env) {
  try {
    const raw = await env.RL.get(NOTICE_KEY, 'json');
    if (!raw || typeof raw.text !== 'string') return { text: '', visible: false, updatedAt: 0 };
    return {
      text: raw.text.slice(0, NOTICE_MAX_LEN),
      visible: raw.visible === true,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch (err) {
    return { text: '', visible: false, updatedAt: 0 };
  }
}

function publicNotice(notice) {
  if (notice && notice.visible && notice.text) {
    return { text: notice.text, updatedAt: notice.updatedAt };
  }
  return null;
}

function modeGate(mode) {
  if (mode === 'off') return { error: 'Marketplace is temporarily unavailable.', disabled: true };
  if (mode === 'readonly') return { error: 'Marketplace is read-only right now.' };
  return null;
}

// GET/POST /ph/<posthog-path> -> POSTHOG_UPSTREAM/<posthog-path>.
// Reverse proxy so the browser never talks to adblock-listed PostHog hosts:
// method, query, headers and body pass through untouched, and marketplace
// CORS headers are added to the response. Never rate-limited and never
// gated on marketplace config — analytics must not depend on it.
async function proxyPosthog(request, url) {
  const upstreamPath = url.pathname.replace(/^\/ph/, '') || '/';
  const target = new URL(upstreamPath + url.search, POSTHOG_UPSTREAM);
  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.delete('host');
  let res;
  try {
    res = await fetch(target.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
  } catch (err) {
    return json({ error: 'Upstream request failed.' }, 502);
  }
  const outHeaders = new Headers(res.headers);
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) outHeaders.set(k, v);
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // /ph/* — PostHog reverse proxy (see proxyPosthog). Handled before the
    // GITHUB_TOKEN check so analytics never depends on marketplace config.
    // (OPTIONS already returned above via the global CORS preflight.)
    if (url.pathname === '/ph' || url.pathname.startsWith('/ph/')) {
      return proxyPosthog(request, url);
    }

    const token = env.GITHUB_TOKEN;
    if (!token) return json({ error: 'Server misconfigured: GITHUB_TOKEN missing.' }, 500);

    try {
      // GET /list — public entries, newest first (KV-cached for 60s).
      // Always reports the kill-switch mode so the page can adapt.
      // Lightly rate-limited: unthrottled polling here fans out to the GitHub
      // API on every cache miss and can exhaust the token quota.
      if (url.pathname === '/list' && request.method === 'GET') {
        if (!(await checkRateLimit(env, request, 1, 'rllist:', 300))) {
          return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
        }
        const mode = await getMode(env);
        if (mode === 'off') return json({ entries: [], mode, disabled: true, notice: publicNotice(await getNotice(env)) }, 503);
        const issues = await listIssues(token, true, env);
        const entries = await entriesWithTallies(issues.slice(0, MAX_ITEMS), env);
        return json({ entries, mode, notice: publicNotice(await getNotice(env)) });
      }

      // GET /notice — public admin announcement (null when hidden/unset).
      if (url.pathname === '/notice' && request.method === 'GET') {
        const mode = await getMode(env);
        return json({ notice: publicNotice(await getNotice(env)), mode });
      }

      // POST /submit — one issue per URL.
      if (url.pathname === '/submit' && request.method === 'POST') {
        const mode = await getMode(env);
        const gate = modeGate(mode);
        if (gate) return json({ ...gate, mode }, 503);
        if (!(await checkRateLimit(env, request))) {
          return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
        }
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const siteUrl = parseUrl(payload.url);
        // Submissions carry no status; everything starts as working and the
        // community flips it via feedback or down-votes.
        const status = 'working';
        if (!siteUrl) return json({ error: 'Provide a valid public http(s) URL.' }, 400);
        // Optional short description shown under the URL (plain text, max 50).
        const description =
          typeof payload.description === 'string'
            ? payload.description.trim().slice(0, DESCRIPTION_MAX_LEN)
            : '';
        // Optional tile icon category (ai | games | media, else no icon).
        const category = parseCategory(typeof payload.category === 'string' ? payload.category.trim() : '');

        // Content safety: static adult/binary denylists, then live Safe
        // Browsing screen (when a key is configured).
        const safety = checkUrlSafety(siteUrl);
        if (!safety.ok) return json({ error: safety.reason }, 403);
        const descCheck = checkDescription(description);
        if (!descCheck.ok) return json({ error: descCheck.reason }, 403);
        const sb = await checkSafeBrowsing(siteUrl, env);
        if (!sb.ok) return json({ error: sb.reason }, 403);

        await ensureLabels(token);
        const issues = await listIssues(token, false, env);
        if (issues.length >= MAX_ITEMS) {
          return json({ error: 'Marketplace is full (100 items).' }, 403);
        }
        const duplicate = issues
          .map(issueToEntry)
          .find((e) => canonicalUrl(e.url) === canonicalUrl(siteUrl));
        if (duplicate) return json({ error: 'URL already listed.', entry: duplicate }, 409);

        let hostname = siteUrl;
        try {
          hostname = new URL(siteUrl).hostname;
        } catch (err) {}
        let created;
        try {
          created = await gh(`/repos/${OWNER}/${REPO}/issues`, token, {
            method: 'POST',
            body: JSON.stringify({
              title: 'Site: ' + hostname,
              body: 'URL: ' + siteUrl + '\nDescription: ' + description + '\nCategory: ' + category + '\nStatus: ' + status + '\nSubmitted: ' + new Date().toISOString(),
              labels: [LABEL, 'status:' + status],
            }),
          });
        } catch (err) {
          return json({ error: 'GitHub rejected the submission.' }, 502);
        }
        await invalidateListCache(env);
        return json({ entry: issueToEntry(created) }, 201);
      }

      // POST /feedback — public reports can only flag an entry as blocked
      // (plus a comment). Flipping to 'working' is admin-only via
      // /admin/status, so unauthenticated callers can't whitewash entries.
      if (url.pathname === '/feedback' && request.method === 'POST') {
        const mode = await getMode(env);
        const gate = modeGate(mode);
        if (gate) return json({ ...gate, mode }, 503);
        if (!(await checkRateLimit(env, request))) {
          return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
        }
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const id = parseInt(payload.id, 10);
        const status = parseStatus(payload.status);
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid issue id.' }, 400);
        if (status !== 'blocked') return json({ error: "Public reports may only flag 'blocked'." }, 400);

        await ensureLabels(token);
        let updated;
        try {
          updated = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token, {
            method: 'PATCH',
            body: JSON.stringify({ labels: [LABEL, 'status:' + status] }),
          });
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        await gh(`/repos/${OWNER}/${REPO}/issues/${id}/comments`, token, {
          method: 'POST',
          body: JSON.stringify({ body: 'Status reported: ' + status }),
        });
        await invalidateListCache(env);
        return json({ entry: issueToEntry(updated, await getTally(env, id, updated)) });
      }

      // POST /react {id, type, remove?, voter?} — switchable emoji vote
      // (one per browser voter id, legacy fallback one per IP).
      // type: thumbsup (+1pt), thumbsdown (-1pt), fire (+2pts), redx (-5pts).
      // Counts are KV tallies (one real count per voter), NOT GitHub issue
      // reactions. Sending a different type switches the vote (the previous
      // tally is decremented), sending {remove:true} clears it, and
      // re-sending the same type is a 409.
      if (url.pathname === '/react' && request.method === 'POST') {
        const mode = await getMode(env);
        const gate = modeGate(mode);
        if (gate) return json({ ...gate, mode }, 503);
        if (!(await checkRateLimit(env, request, 1, 'rlvote:', VOTE_LIMIT_PER_HOUR))) {
          return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
        }
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const id = parseInt(payload.id, 10);
        const remove = payload.remove === true;
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid issue id.' }, 400);
        if (!isReactionType(payload.type)) return json({ error: 'Invalid reaction type.' }, 400);

        // Verify the issue exists and is a marketplace entry before touching
        // any vote state, so votes can't be recorded against stray issue ids.
        let issue;
        try {
          issue = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token);
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        const issueLabels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
        if (!issueLabels.includes(LABEL)) return json({ error: 'Not a marketplace entry.' }, 404);
        if (issue.state === 'closed') return json({ error: 'This entry was removed.' }, 410);

        const ip = clientIp(request);
        // Prefer the per-browser voter id so people sharing one public IP
        // (school/work/mobile NAT) don't overwrite each other's votes. The
        // IP-scoped keys remain only for old page versions that send no id.
        const voterId = parseVoterId(payload.voter);
        const scope = voterId ? 'vid:' + voterId : ip;
        const voteKey = 'vote:' + scope + ':' + id;
        const reactKey = (t) => 'react:' + scope + ':' + id + ':' + t;
        let current = null;
        try {
          current = await env.RL.get(voteKey);
        } catch (err) {}
        if (!current || !isReactionType(current)) {
          // Migrate legacy per-type keys to the single current-vote key.
          // Legacy 'heart' votes fold into 'fire' (same weight).
          // NOTE: only same-scope keys are consulted — never another
          // voter's IP-shared key — so one person's vote can't be adopted
          // (and then decremented away) as someone else's "switch".
          current = null;
          for (const t of [...REACTION_TYPES, 'heart']) {
            try {
              if (await env.RL.get(reactKey(t))) {
                current = t === 'heart' ? 'fire' : t;
                break;
              }
            } catch (err) {}
          }
          if (current) {
            try {
              await env.RL.put(voteKey, current, { expirationTtl: 2592000 });
            } catch (err) {}
          }
        }

        const tally = await getTally(env, id, issue);
        if (remove) {
          if (!current) return json({ error: 'No vote to remove.' }, 409);
          tally[current] = Math.max(0, (tally[current] || 0) - 1);
          await putTally(env, id, tally);
          try {
            await env.RL.delete(voteKey);
            await env.RL.delete(reactKey(current));
          } catch (err) {}
          await invalidateListCache(env);
          return json({ ok: true, entry: issueToEntry(issue, tally) });
        }

        if (current === payload.type) {
          return json({ error: 'You already reacted to this one.' }, 409);
        }
        if (current && current !== payload.type) {
          // Switch: move one count from the previous type to the new one.
          tally[current] = Math.max(0, (tally[current] || 0) - 1);
          try {
            await env.RL.delete(reactKey(current));
          } catch (err) {}
        }
        tally[payload.type] = (tally[payload.type] || 0) + 1;
        try {
          await env.RL.put(voteKey, payload.type, { expirationTtl: 2592000 });
          await env.RL.put(reactKey(payload.type), '1', { expirationTtl: 2592000 });
        } catch (err) {}
        await putTally(env, id, tally);
        await invalidateListCache(env);
        return json({ entry: issueToEntry(issue, tally) });
      }

      // POST /report {id, reason?} — flag a URL for manual owner review.
      // Adds the needs-review label (preserving existing labels) and logs a
      // comment with the reporter's reason. One report per IP per issue.
      if (url.pathname === '/report' && request.method === 'POST') {
        const mode = await getMode(env);
        const gate = modeGate(mode);
        if (gate) return json({ ...gate, mode }, 503);
        if (!(await checkRateLimit(env, request))) {
          return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
        }
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const id = parseInt(payload.id, 10);
        const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 500) : '';
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid issue id.' }, 400);

        const ip = clientIp(request);
        const reportKey = 'report:' + ip + ':' + id;
        try {
          if (await env.RL.get(reportKey)) {
            return json({ error: 'You already reported this one.' }, 409);
          }
        } catch (err) {}

        await ensureLabels(token);
        let issue;
        try {
          issue = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token);
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        const currentLabels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
        if (!currentLabels.includes(LABEL)) return json({ error: 'Not a marketplace entry.' }, 404);
        const nextLabels = currentLabels.includes('needs-review')
          ? currentLabels
          : [...currentLabels, 'needs-review'];
        try {
          await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token, {
            method: 'PATCH',
            body: JSON.stringify({ labels: nextLabels }),
          });
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        await gh(`/repos/${OWNER}/${REPO}/issues/${id}/comments`, token, {
          method: 'POST',
          body: JSON.stringify({
            body: '🚩 Reported for manual review.\nReason: ' + (reason || '(no reason given)') + '\nReported: ' + new Date().toISOString(),
          }),
        });
        try {
          await env.RL.put(reportKey, '1', { expirationTtl: 2592000 });
        } catch (err) {}
        await invalidateListCache(env);
        return json({ ok: true });
      }

      // ---- Admin panel (all endpoints below require a valid admin token) ----

      // POST /admin/login {user, pass} — strict rate limit, returns a 12h token.
      if (url.pathname === '/admin/login' && request.method === 'POST') {
        if (!adminEnabled(env)) return json({ error: 'Admin panel is not configured.' }, 501);
        const ip = clientIp(request);
        const failKey = 'adminfail:' + ip;
        let fails = 0;
        try {
          fails = parseInt((await env.RL.get(failKey)) || '0', 10) || 0;
        } catch (err) {}
        if (fails >= ADMIN_FAIL_LIMIT) {
          return json({ error: 'Too many login attempts. Try again later.' }, 429);
        }
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const passHash = await sha256Hex(typeof payload.pass === 'string' ? payload.pass : '');
        // Constant-time compare for both fields so the user check isn't a
        // string-compare oracle. Failure message stays generic (no 404-vs-401
        // distinction beyond the rate-limit 429).
        const userOk = safeEqual(String(payload.user || ''), String(env.ADMIN_USER || ''));
        const passOk = safeEqual(passHash, String(env.ADMIN_PASS_HASH || ''));
        if (!userOk || !passOk) {
          try {
            await env.RL.put(failKey, String(fails + 1), { expirationTtl: 3600 });
          } catch (err) {}
          return json({ error: 'Invalid credentials.' }, 401);
        }
        try {
          await env.RL.delete(failKey);
        } catch (err) {}
        const token = await mintAdminToken(env);
        return json({ token, expiresAt: Date.now() + ADMIN_TOKEN_TTL });
      }

      // Everything below requires admin auth.
      const adminUser = await verifyAdminToken(request, env);
      const needsAdmin =
        url.pathname === '/admin/list' ||
        url.pathname === '/admin/reports' ||
        url.pathname === '/admin/status' ||
        url.pathname === '/admin/remove' ||
        url.pathname === '/admin/clear-report' ||
        url.pathname === '/admin/notice' ||
        url.pathname === '/admin/mode';
      if (needsAdmin && !adminUser) {
        return json({ error: adminEnabled(env) ? 'Admin login required.' : 'Admin panel is not configured.' }, 401);
      }

      // GET /admin/list — every marketplace issue incl. closed (for restore).
      if (url.pathname === '/admin/list' && request.method === 'GET') {
        const body = await gh(
          `/repos/${OWNER}/${REPO}/issues?labels=${LABEL}&state=all&per_page=100`,
          token
        );
        const all = Array.isArray(body) ? body : [];
        const withTallies = await entriesWithTallies(all.slice(0, MAX_ITEMS), env);
        return json({
          entries: withTallies.map((entry, i) => ({ ...entry, closed: all[i].state === 'closed' })),
          mode: await getMode(env),
        });
      }

      // GET /admin/reports — open issues flagged needs-review.
      if (url.pathname === '/admin/reports' && request.method === 'GET') {
        const issues = await listIssues(token, false, env);
        const flagged = issues
          .filter((issue) =>
            (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).includes('needs-review')
          );
        return json({ entries: await entriesWithTallies(flagged, env) });
      }

      // POST /admin/status {id, status} — set status, keeps the review flag.
      if (url.pathname === '/admin/status' && request.method === 'POST') {
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const id = parseInt(payload.id, 10);
        const status = parseStatus(payload.status);
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid issue id.' }, 400);
        if (!status) return json({ error: "Status must be 'working' or 'blocked'." }, 400);
        await ensureLabels(token);
        let issue;
        try {
          issue = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token);
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
        if (!labels.includes(LABEL)) return json({ error: 'Not a marketplace entry.' }, 404);
        const next = labels.filter((l) => l !== 'status:working' && l !== 'status:blocked');
        next.push(LABEL, 'status:' + status);
        let updated;
        try {
          updated = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token, {
            method: 'PATCH',
            body: JSON.stringify({ labels: [...new Set(next)] }),
          });
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        await gh(`/repos/${OWNER}/${REPO}/issues/${id}/comments`, token, {
          method: 'POST',
          body: JSON.stringify({ body: 'Admin (' + adminUser + ') set status: ' + status }),
        });
        await invalidateListCache(env);
        return json({ entry: issueToEntry(updated, await getTally(env, id, updated)) });
      }

      // POST /admin/remove {id, reopen?} — close an issue (removes it from
      // /list) or reopen a closed one. Issues cannot be deleted via the API.
      if (url.pathname === '/admin/remove' && request.method === 'POST') {
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const id = parseInt(payload.id, 10);
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid issue id.' }, 400);
        const reopen = payload.reopen === true;
        let updated;
        try {
          updated = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token, {
            method: 'PATCH',
            body: JSON.stringify({ state: reopen ? 'open' : 'closed' }),
          });
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        await gh(`/repos/${OWNER}/${REPO}/issues/${id}/comments`, token, {
          method: 'POST',
          body: JSON.stringify({ body: reopen ? 'Admin (' + adminUser + ') reopened this entry.' : 'Admin (' + adminUser + ') removed this entry.' }),
        });
        await invalidateListCache(env);
        return json({ ok: true, closed: updated.state === 'closed' });
      }

      // POST /admin/clear-report {id} — drop the needs-review flag.
      if (url.pathname === '/admin/clear-report' && request.method === 'POST') {
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const id = parseInt(payload.id, 10);
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid issue id.' }, 400);
        let issue;
        try {
          issue = await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token);
        } catch (err) {
          if (err.upstream === 404) return json({ error: 'Issue not found.' }, 404);
          return json({ error: 'Upstream request failed.' }, 502);
        }
        const labels = (issue.labels || [])
          .map((l) => (typeof l === 'string' ? l : l.name))
          .filter((l) => l !== 'needs-review');
        await gh(`/repos/${OWNER}/${REPO}/issues/${id}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ labels }),
        });
        await gh(`/repos/${OWNER}/${REPO}/issues/${id}/comments`, token, {
          method: 'POST',
          body: JSON.stringify({ body: 'Admin (' + adminUser + ') cleared the review flag.' }),
        });
        await invalidateListCache(env);
        return json({ ok: true });
      }

      // GET /admin/notice — current announcement including hidden text.
      if (url.pathname === '/admin/notice' && request.method === 'GET') {
        return json({ notice: await getNotice(env) });
      }

      // POST /admin/notice {text, visible} — edit the info banner text and
      // show/hide it. Empty text auto-hides. Max 500 chars, plain text only
      // (the page renders it escaped, no HTML).
      if (url.pathname === '/admin/notice' && request.method === 'POST') {
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, NOTICE_MAX_LEN) : '';
        const visible = payload.visible === true && text.length > 0;
        const notice = { text, visible, updatedAt: Date.now() };
        try {
          await env.RL.put(NOTICE_KEY, JSON.stringify(notice));
        } catch (err) {
          return json({ error: 'Could not store announcement.' }, 500);
        }
        return json({ notice });
      }

      // POST /admin/mode {mode} — kill switch: normal | readonly | off.
      if (url.pathname === '/admin/mode' && request.method === 'POST') {
        let payload = {};
        try {
          payload = await request.json();
        } catch (err) {
          return json({ error: 'Invalid JSON body.' }, 400);
        }
        const mode = payload.mode;
        if (mode !== 'normal' && mode !== 'readonly' && mode !== 'off') {
          return json({ error: "Mode must be 'normal', 'readonly', or 'off'." }, 400);
        }
        try {
          await env.RL.put('marketplace:mode', mode);
        } catch (err) {
          return json({ error: 'Could not store mode.' }, 500);
        }
        await invalidateListCache(env);
        return json({ mode });
      }

      return json({ error: 'Not found.' }, 404);
    } catch (err) {
      return json({ error: 'Upstream request failed.' }, 502);
    }
  },
};
