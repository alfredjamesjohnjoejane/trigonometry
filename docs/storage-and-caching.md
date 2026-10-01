# Storage & Caching

## localStorage Wrapper

**Module**: `src/storage/index.ts`

A safe wrapper around `localStorage` with error handling:

```ts
const ST = {
  get: (key: string): string | null,
  set: (key: string, value: string): void,
  remove: (key: string): void,
};
```

### Error Handling

- **`get`**: Returns `null` on any error (storage blocked, private mode)
- **`set`**: Catches `QuotaExceededError` and logs a warning instead of silently failing
- **`remove`**: Silently ignores errors

### Why a Wrapper?

Direct `localStorage` access can throw in:
- Private browsing modes (Safari)
- Blocked storage (iframe sandbox)
- Quota exceeded
- Corrupted data

The wrapper ensures the app never crashes due to storage issues.

## Storage Keys

| Key | Format | Description |
|-----|--------|-------------|
| `pk` | String | Panic key character |
| `panicUrl` | String | Panic redirect URL |
| `theme` | String | Theme name (mono/shadow/midnight) |
| `customPrimary` | Hex color | Custom primary color |
| `customAccent` | Hex color | Custom accent color |
| `cloakPreset` | String | Cloak preset name |
| `cloakTitle` | String | Custom cloak title |
| `cloakUrl` | String | Custom cloak URL |
| `cloakIcon` | String | Custom cloak icon |
| `sfx` | `'true'`/`'false'` | Sound effects toggle |
| `landingAnims` | `'true'`/`'false'` | Landing animations toggle |
| `timerVisible` | `'true'`/`'false'` | Timer display toggle |
| `favs` | JSON array | Favorite game URLs |
| `playCount` | Number (string) | Total games played |
| `playTime` | Number (string) | Total play time in seconds |
| `gamePlays` | JSON object | Per-game play counts |
| `gamePlayed` | JSON array | URLs of played games |
| `tosAgreed` | `'1'` | TOS agreement flag |
| `tosAgreedTimestamp` | Number (string) | TOS agreement timestamp |
| `tosHash` | String | TOS content hash |
| `settingsReminderSeen` | `'yes'` | Settings reminder shown |
| `jesherheadOriginalBase` | URL | Original base URL (for cloak) |

---

## IndexedDB Game Cache

**Module**: `src/cache/index.ts`

Game HTML is cached in IndexedDB for offline play and faster loading.

### Database Schema

```
Database: jesherhead_cache (version 2)
└── Object Store: games (keyPath: 'url')
    ├── Index: timestamp (non-unique)
    └── Entry: { url: string, html: string, timestamp: number }
```

### API

```ts
initCache(): Promise<IDBDatabase | null>
getCachedGame(url: string): Promise<string | null>
cacheGame(url: string, html: string): Promise<void>
clearGameCache(): Promise<void>
getCacheSize(): Promise<number>
updateCacheSizeDisplay(): Promise<void>
handleClearCache(): Promise<void>
enforceCacheLimit(): Promise<void>
```

### Memory Fallback

When IndexedDB is unavailable (private mode, blocked storage), a `Map` is used as an in-memory fallback:

```ts
const memoryFallback = new Map<string, CacheEntry>();
let useMemoryFallback = false;
```

### Cache Limits

- **Max entries**: 200 games (`MAX_CACHE_ENTRIES`)
- **Eviction**: Oldest entries (by timestamp) are removed when limit is exceeded
- **Enforcement**: Runs automatically after each cache write

### Cache Flow

```
Game Launch
    │
    ▼
getCachedGame(url)
    │
    ├── HIT → return cached HTML
    │
    └── MISS → fetch from network
              │
              ▼
           cacheGame(url, html)
              │
              ▼
           enforceCacheLimit() (async, fire-and-forget)
```

### Hang Guard

If `indexedDB.open()` neither succeeds, errors, nor blocks within 5 seconds, the cache falls back to memory:

```ts
const timer = setTimeout(() => done(null), 5000);
```

This prevents the app from hanging indefinitely in restricted environments.

---

## Service Worker Cache

**File**: `public/sw.js`

The service worker provides offline support and asset caching.

### Cache Names

| Cache | Purpose | Max Entries |
|-------|---------|-------------|
| `jesherhead-v{VERSION}` | Static assets + app shell | 500 |
| `jesherhead-images-v{VERSION}` | Game thumbnails | 1000 |

### Precached Assets

```
index.html
offline.html
urls.html
terms_of_service.txt
manifest.json
icon.png
data/games_merged.json
icons/icon-72x72.png through icon-512x512-maskable.png
```

### Fetch Strategies

| Content Type | Strategy | Reason |
|-------------|----------|--------|
| Game images (iili.io, jsdelivr) | Cache-first | Thumbnails rarely change |
| Static assets (icons) | Cache-first | Immutable |
| App shell (index.html, etc.) | Network-first with offline fallback | Must stay fresh |
| Game catalog (games_merged.json) | Network-first with offline fallback | Must stay fresh |
| Other requests | Network-first with offline fallback | Default strategy |

### Update Flow

1. **Install**: Precaches static assets (per-asset, one 404 doesn't fail all)
2. **Activate**: Deletes old caches, cleans up expired entries, claims clients
3. **No `skipWaiting()`**: The new worker waits until the user clicks "Update" in the toast

### Update Toast

The inline script in `index.html` manages the update UX:
- Registers SW immediately (not on window load)
- Checks for updates on registration, hourly, on tab focus, and on reconnect
- Shows a toast: "New version available!" with Update/Reload button
- On update: posts `SKIP_WAITING` to the waiting worker, then reloads on `controllerchange`
- Never auto-reloads (mid-game reloads would be worse than a toast)

### Cache Expiry

- **Max age**: 30 days (`CACHE_MAX_AGE`)
- **Cleanup**: Runs on activation, removes expired + excess entries
- **Date tracking**: `sw-cache-date` header added to each cached response
